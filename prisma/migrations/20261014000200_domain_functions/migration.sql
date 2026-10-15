-- ═══════════════════════════════════════════════════════════════════════════
-- Funciones de dominio: correlativos, FEFO, recepción de lotes, outbox,
-- alertas de caducidad / stock, recordatorios de vacunas, purga de tenants.
-- Todas son SECURITY INVOKER: respetan RLS del rol que llama.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────── Correlativo de comprobantes ─────────────
-- UPDATE ... RETURNING toma un row-lock sobre la serie hasta el COMMIT.
-- El POS lo llama como ÚLTIMO paso de la transacción para mantener el lock
-- el menor tiempo posible (las ventas concurrentes solo se serializan aquí).
CREATE OR REPLACE FUNCTION app.next_document_number(
  p_tenant uuid, p_doc_type "DocumentType", p_series text
) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v_next integer;
BEGIN
  UPDATE document_series
     SET last_number = last_number + 1
   WHERE tenant_id = p_tenant AND doc_type = p_doc_type AND series = p_series AND is_active
  RETURNING last_number INTO v_next;
  IF v_next IS NULL THEN
    RAISE EXCEPTION 'Serie % no existe o está inactiva para %', p_series, p_doc_type
      USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v_next;
END $$;

-- ───────────── Descuento FEFO ─────────────
-- Bloquea solo los lotes necesarios (FOR UPDATE en orden FEFO determinista),
-- rechaza lotes vencidos o en cuarentena y registra kardex por lote.
-- Para evitar deadlocks el llamador procesa los productos ordenados por product_id.
CREATE OR REPLACE FUNCTION app.consume_stock_fefo(
  p_tenant uuid,
  p_branch uuid,
  p_product uuid,
  p_qty numeric,
  p_movement "StockMovementType",
  p_ref_type text,
  p_ref_id uuid,
  p_user uuid,
  p_preferred_batch uuid DEFAULT NULL
) RETURNS TABLE (batch_id uuid, quantity numeric, unit_cost numeric)
LANGUAGE plpgsql AS $$
DECLARE
  v_remaining numeric := p_qty;
  v_take numeric;
  v_today date := app.lima_today();
  r record;
BEGIN
  IF p_qty <= 0 THEN
    RAISE EXCEPTION 'Cantidad inválida %', p_qty USING ERRCODE = 'check_violation';
  END IF;

  FOR r IN
    SELECT b.id, b.stock, b.unit_cost
      FROM product_batches b
     WHERE b.tenant_id = p_tenant
       AND b.branch_id = p_branch
       AND b.product_id = p_product
       AND b.stock > 0
       AND b.deleted_at IS NULL
       AND NOT b.is_quarantined
       AND (b.expiry_date IS NULL OR b.expiry_date >= v_today)  -- bloqueo de vencidos
     ORDER BY (b.id = p_preferred_batch) DESC NULLS LAST,
              b.expiry_date ASC NULLS LAST, b.received_at, b.id
     FOR UPDATE OF b
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := least(r.stock, v_remaining);

    UPDATE product_batches SET stock = stock - v_take WHERE id = r.id;

    INSERT INTO stock_movements
      (tenant_id, branch_id, product_id, batch_id, type, quantity, balance_after,
       unit_cost, ref_type, ref_id, created_by)
    VALUES
      (p_tenant, p_branch, p_product, r.id, p_movement, -v_take, r.stock - v_take,
       r.unit_cost, p_ref_type, p_ref_id, p_user);

    batch_id := r.id; quantity := v_take; unit_cost := r.unit_cost;
    RETURN NEXT;
    v_remaining := v_remaining - v_take;
  END LOOP;

  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'Stock insuficiente para producto % (faltan %)', p_product, v_remaining
      USING ERRCODE = 'P0001', HINT = 'INSUFFICIENT_STOCK';
  END IF;
END $$;

-- Reintegro de stock (NC por devolución) al mismo lote original
CREATE OR REPLACE FUNCTION app.restock_batch(
  p_tenant uuid, p_batch uuid, p_qty numeric, p_movement "StockMovementType",
  p_ref_type text, p_ref_id uuid, p_user uuid
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_b record;
BEGIN
  UPDATE product_batches SET stock = stock + p_qty
   WHERE id = p_batch AND tenant_id = p_tenant
  RETURNING id, branch_id, product_id, stock, unit_cost INTO v_b;
  IF v_b.id IS NULL THEN
    RAISE EXCEPTION 'Lote % no encontrado', p_batch;
  END IF;
  INSERT INTO stock_movements
    (tenant_id, branch_id, product_id, batch_id, type, quantity, balance_after, unit_cost, ref_type, ref_id, created_by)
  VALUES
    (p_tenant, v_b.branch_id, v_b.product_id, v_b.id, p_movement, p_qty, v_b.stock, v_b.unit_cost, p_ref_type, p_ref_id, p_user);
END $$;

-- ───────────── Recepción de lote (compras / IA) ─────────────
-- Upsert por (tenant, sucursal, producto, lote). Costo promedio ponderado del lote.
CREATE OR REPLACE FUNCTION app.receive_batch(
  p_tenant uuid, p_branch uuid, p_product uuid, p_lot text, p_expiry date,
  p_qty numeric, p_unit_cost numeric, p_purchase_item uuid, p_user uuid
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
  v_stock numeric;
  v_lot text := coalesce(nullif(trim(p_lot), ''), 'S/L-' || to_char(app.lima_today(), 'YYYYMMDD'));
BEGIN
  IF p_qty <= 0 THEN
    RAISE EXCEPTION 'Cantidad recibida inválida';
  END IF;

  INSERT INTO product_batches
    (tenant_id, branch_id, product_id, lot_code, expiry_date, unit_cost, stock, purchase_item_id)
  VALUES (p_tenant, p_branch, p_product, v_lot, p_expiry, p_unit_cost, p_qty, p_purchase_item)
  ON CONFLICT (tenant_id, branch_id, product_id, lot_code) DO UPDATE
     SET unit_cost = round(
           (product_batches.unit_cost * product_batches.stock + EXCLUDED.unit_cost * EXCLUDED.stock)
           / nullif(product_batches.stock + EXCLUDED.stock, 0), 6),
         stock = product_batches.stock + EXCLUDED.stock,
         expiry_date = coalesce(product_batches.expiry_date, EXCLUDED.expiry_date),
         deleted_at = NULL
  RETURNING id, stock INTO v_id, v_stock;

  INSERT INTO stock_movements
    (tenant_id, branch_id, product_id, batch_id, type, quantity, balance_after, unit_cost, ref_type, ref_id, created_by)
  VALUES
    (p_tenant, p_branch, p_product, v_id, 'PURCHASE', p_qty, v_stock, p_unit_cost, 'purchase_item', p_purchase_item, p_user);

  RETURN v_id;
END $$;

-- ───────────── Outbox: reclamar lote de eventos ─────────────
-- FOR UPDATE SKIP LOCKED: N workers en paralelo sin bloquearse ni duplicar.
-- El lease (locked_until) permite recuperar eventos de workers caídos.
CREATE OR REPLACE FUNCTION app.claim_outbox(
  p_worker text, p_event_types text[], p_limit integer DEFAULT 20, p_lease_seconds integer DEFAULT 120
) RETURNS SETOF outbox_events
LANGUAGE sql AS $$
  WITH picked AS (
    SELECT id FROM outbox_events
     WHERE (
             (status IN ('PENDING', 'FAILED') AND next_attempt_at <= now())
          OR (status = 'PROCESSING' AND locked_until < now())
           )
       AND (p_event_types IS NULL OR event_type = ANY (p_event_types))
     ORDER BY next_attempt_at, id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE outbox_events o
     SET status = 'PROCESSING',
         locked_by = p_worker,
         locked_until = now() + make_interval(secs => p_lease_seconds),
         attempts = o.attempts + 1
    FROM picked
   WHERE o.id = picked.id
  RETURNING o.*
$$;

-- ───────────── Vista de caducidad (núcleo, todos los rubros) ─────────────
CREATE OR REPLACE VIEW app.v_batch_expiry WITH (security_invoker = true) AS
SELECT
  b.tenant_id, b.branch_id, b.product_id, b.id AS batch_id, b.lot_code, b.expiry_date,
  b.stock, b.unit_cost, round(b.stock * b.unit_cost, 2) AS stock_value,
  p.name AS product_name, p.sku,
  (b.expiry_date - app.lima_today()) AS days_to_expiry,
  CASE
    WHEN b.expiry_date < app.lima_today() THEN 'EXPIRED'
    WHEN b.expiry_date - app.lima_today() <= 7 THEN 'D7'
    WHEN b.expiry_date - app.lima_today() <= 15 THEN 'D15'
    WHEN b.expiry_date - app.lima_today() <= 30 THEN 'D30'
    WHEN b.expiry_date - app.lima_today() <= 60 THEN 'D60'
    WHEN b.expiry_date - app.lima_today() <= 90 THEN 'D90'
    ELSE 'OK'
  END AS bucket
FROM product_batches b
JOIN products p ON p.id = b.product_id
WHERE b.stock > 0 AND b.deleted_at IS NULL AND b.expiry_date IS NOT NULL;

GRANT SELECT ON app.v_batch_expiry TO app_runtime;

-- ───────────── Generación de alertas de caducidad (pg_cron diario) ─────────────
-- Para cada lote con stock, el umbral activo es el MENOR umbral configurado
-- que sea >= días restantes. dedupe_key garantiza 1 alerta por lote/umbral/usuario.
CREATE OR REPLACE FUNCTION app.enqueue_expiry_alerts() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE v_count integer;
BEGIN
  WITH rules AS (
    SELECT t.id AS tenant_id,
           coalesce(ar.thresholds, ARRAY[90, 60, 30, 15, 7, 0]) AS thresholds,
           coalesce(ar.recipient_roles, ARRAY['admin', 'warehouse', 'pharmacist']) AS roles
      FROM tenants t
      LEFT JOIN alert_rules ar ON ar.tenant_id = t.id AND ar.kind = 'BATCH_EXPIRY'
     WHERE t.status IN ('TRIAL', 'ACTIVE') AND t.deleted_at IS NULL
       AND coalesce(ar.enabled, true)
  ),
  hits AS (
    SELECT b.tenant_id, b.batch_id, b.product_name, b.lot_code, b.expiry_date, b.stock,
           b.stock_value, b.days_to_expiry, r.roles,
           CASE WHEN b.days_to_expiry < 0 THEN -1
                ELSE (SELECT min(th) FROM unnest(r.thresholds) th WHERE th >= b.days_to_expiry)
           END AS threshold
      FROM app.v_batch_expiry b
      JOIN rules r ON r.tenant_id = b.tenant_id
  ),
  recipients AS (
    SELECT h.*, tu.user_id
      FROM hits h
      JOIN tenant_users tu ON tu.tenant_id = h.tenant_id AND tu.status = 'ACTIVE' AND tu.deleted_at IS NULL
      JOIN roles ro ON ro.id = tu.role_id AND ro.key = ANY (h.roles)
     WHERE h.threshold IS NOT NULL
  ),
  ins AS (
    INSERT INTO notifications (tenant_id, user_id, channel, template, payload, dedupe_key, related_type, related_id)
    SELECT tenant_id, user_id, 'IN_APP', 'batch_expiry',
           jsonb_build_object(
             'batchId', batch_id, 'product', product_name, 'lot', lot_code,
             'expiryDate', expiry_date, 'daysToExpiry', days_to_expiry,
             'stock', stock, 'stockValue', stock_value, 'threshold', threshold,
             'suggestPromotion', days_to_expiry BETWEEN 0 AND 60),
           'expiry:' || batch_id || ':' || threshold || ':' || user_id,
           'product_batch', batch_id::text
      FROM recipients
    ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;
  RETURN v_count;
END $$;

-- ───────────── Alertas de stock mínimo (pg_cron diario) ─────────────
CREATE OR REPLACE FUNCTION app.enqueue_low_stock_alerts() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE v_count integer;
BEGIN
  WITH stock AS (
    SELECT p.tenant_id, b.branch_id, p.id AS product_id, p.name, p.min_stock,
           coalesce(sum(b.stock) FILTER (WHERE b.expiry_date IS NULL OR b.expiry_date >= app.lima_today()), 0) AS available
      FROM products p
      JOIN product_batches b ON b.product_id = p.id AND b.deleted_at IS NULL
     WHERE p.deleted_at IS NULL AND p.is_active AND p.min_stock > 0
     GROUP BY p.tenant_id, b.branch_id, p.id, p.name, p.min_stock
  ),
  low AS (SELECT * FROM stock WHERE available <= min_stock),
  recipients AS (
    SELECT l.*, tu.user_id
      FROM low l
      JOIN tenants t ON t.id = l.tenant_id AND t.status IN ('TRIAL', 'ACTIVE')
      LEFT JOIN alert_rules ar ON ar.tenant_id = l.tenant_id AND ar.kind = 'LOW_STOCK'
      JOIN tenant_users tu ON tu.tenant_id = l.tenant_id AND tu.status = 'ACTIVE' AND tu.deleted_at IS NULL
      JOIN roles ro ON ro.id = tu.role_id
     WHERE coalesce(ar.enabled, true)
       AND ro.key = ANY (coalesce(ar.recipient_roles, ARRAY['admin', 'warehouse']))
  ),
  ins AS (
    INSERT INTO notifications (tenant_id, user_id, channel, template, payload, dedupe_key, related_type, related_id)
    SELECT tenant_id, user_id, 'IN_APP', 'low_stock',
           jsonb_build_object('productId', product_id, 'product', name, 'branchId', branch_id,
                              'available', available, 'minStock', min_stock),
           -- una alerta por producto/sucursal/usuario por semana ISO
           'lowstock:' || product_id || ':' || branch_id || ':' || to_char(app.lima_today(), 'IYYY-IW') || ':' || user_id,
           'product', product_id::text
      FROM recipients
    ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;
  RETURN v_count;
END $$;

-- ───────────── Recordatorios de vacunación (pg_cron diario) ─────────────
-- Considera solo la ÚLTIMA aplicación de cada vacuna por mascota (si ya se
-- aplicó una dosis posterior, no se recuerda la anterior). Tolera 1 día de
-- atraso del cron (ventana de catch-up). Duplicados: UNIQUE en reminders y
-- dedupe_key en notifications. Encola un evento outbox por notificación.
CREATE OR REPLACE FUNCTION app.enqueue_vaccine_reminders() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE
  v_today date := app.lima_today();
  v_count integer;
BEGIN
  WITH latest AS (
    SELECT DISTINCT ON (pv.pet_id, pv.vaccine_id)
           pv.id, pv.tenant_id, pv.pet_id, pv.vaccine_id, pv.next_due_at, pv.dose_number
      FROM pet_vaccinations pv
     WHERE pv.deleted_at IS NULL
     ORDER BY pv.pet_id, pv.vaccine_id, pv.applied_at DESC, pv.created_at DESC
  ),
  cfg AS (
    SELECT t.id AS tenant_id,
           coalesce(ar.thresholds, ARRAY[7, 3, 1, 0]) AS offsets,
           coalesce(ar.channels, ARRAY['WHATSAPP', 'EMAIL', 'IN_APP']::"NotificationChannel"[]) AS channels,
           EXISTS (SELECT 1 FROM tenant_modules m WHERE m.tenant_id = t.id AND m.module = 'WHATSAPP' AND m.enabled) AS wa_enabled
      FROM tenants t
      JOIN tenant_modules vm ON vm.tenant_id = t.id AND vm.module = 'VETERINARY' AND vm.enabled
      LEFT JOIN alert_rules ar ON ar.tenant_id = t.id AND ar.kind = 'VACCINE_DUE'
     WHERE t.status IN ('TRIAL', 'ACTIVE') AND coalesce(ar.enabled, true)
  ),
  due AS (
    SELECT gen_random_uuid() AS notif_id,
           l.id AS vaccination_id, l.tenant_id, l.pet_id, l.next_due_at, off AS offset_days, ch AS channel,
           p.name AS pet_name, o.full_name AS owner_name, o.whatsapp, o.email,
           o.notify_whatsapp, o.notify_email, vc.name AS vaccine_name, l.dose_number,
           t.trade_name, t.legal_name
      FROM latest l
      JOIN cfg c ON c.tenant_id = l.tenant_id
      JOIN pets p ON p.id = l.pet_id AND p.deleted_at IS NULL AND p.deceased_at IS NULL
      JOIN owners o ON o.id = p.owner_id AND o.deleted_at IS NULL
      JOIN vaccine_catalog vc ON vc.id = l.vaccine_id
      JOIN tenants t ON t.id = l.tenant_id
      CROSS JOIN LATERAL unnest(c.offsets) off
      CROSS JOIN LATERAL unnest(c.channels) ch
     WHERE l.next_due_at IS NOT NULL
       AND l.next_due_at >= v_today
       AND (l.next_due_at - off) BETWEEN v_today - 1 AND v_today
       AND (
            (ch = 'WHATSAPP' AND c.wa_enabled AND o.notify_whatsapp AND o.whatsapp IS NOT NULL)
         OR (ch = 'EMAIL' AND o.notify_email AND o.email IS NOT NULL)
         OR ch = 'IN_APP'
       )
  ),
  rem AS (
    -- notification_id se pre-genera en `due`: los CTE hermanos no ven filas
    -- insertadas por otros CTE del mismo statement, así que no se puede enlazar después.
    INSERT INTO reminders (tenant_id, pet_id, pet_vaccination_id, due_date, offset_days, channel, notification_id)
    SELECT tenant_id, pet_id, vaccination_id, next_due_at, offset_days, channel, notif_id FROM due
    ON CONFLICT (pet_vaccination_id, offset_days, channel) DO NOTHING
    RETURNING id, tenant_id, pet_vaccination_id, offset_days, channel, notification_id
  ),
  notif AS (
    INSERT INTO notifications (id, tenant_id, channel, template, recipient, payload, dedupe_key, related_type, related_id)
    SELECT r.notification_id, d.tenant_id, d.channel,
           CASE WHEN d.offset_days = 0 THEN 'vaccine_due_today' ELSE 'vaccine_due_soon' END,
           CASE d.channel WHEN 'WHATSAPP' THEN d.whatsapp WHEN 'EMAIL' THEN d.email ELSE NULL END,
           jsonb_build_object('reminderId', r.id, 'petName', d.pet_name, 'ownerName', d.owner_name,
                              'vaccine', d.vaccine_name, 'dose', d.dose_number, 'dueDate', d.next_due_at,
                              'daysLeft', d.offset_days, 'clinic', coalesce(d.trade_name, d.legal_name)),
           'vacc:' || d.vaccination_id || ':' || d.offset_days || ':' || d.channel,
           'reminder', r.id::text
      FROM rem r
      JOIN due d ON d.vaccination_id = r.pet_vaccination_id AND d.offset_days = r.offset_days AND d.channel = r.channel
    ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
    RETURNING id, tenant_id, related_id, channel
  ),
  ob AS (
    INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    SELECT n.tenant_id, 'notification', n.id::text, 'notification.send',
           jsonb_build_object('notificationId', n.id), 'notification.send:' || n.id
      FROM notif n WHERE n.channel <> 'IN_APP'
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM notif;
  RETURN v_count;
END $$;

-- ───────────── Certificados digitales por vencer ─────────────
CREATE OR REPLACE FUNCTION app.enqueue_certificate_alerts() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE v_count integer;
BEGIN
  WITH due AS (
    SELECT t.id AS tenant_id, t.certificate_expires_at,
           (t.certificate_expires_at::date - app.lima_today()) AS days_left
      FROM tenants t
     WHERE t.certificate_expires_at IS NOT NULL
       AND t.status IN ('TRIAL', 'ACTIVE')
       AND t.certificate_expires_at::date - app.lima_today() <= 30
  ),
  bucketed AS (
    SELECT d.*, (SELECT min(th) FROM unnest(ARRAY[30, 15, 7, 1, 0]) th WHERE th >= greatest(d.days_left, 0)) AS threshold
      FROM due d
  ),
  ins AS (
    INSERT INTO notifications (tenant_id, user_id, channel, template, payload, dedupe_key, related_type, related_id)
    SELECT b.tenant_id, tu.user_id, 'IN_APP', 'certificate_expiry',
           jsonb_build_object('expiresAt', b.certificate_expires_at, 'daysLeft', b.days_left),
           'cert:' || b.tenant_id || ':' || b.threshold || ':' || tu.user_id,
           'tenant', b.tenant_id::text
      FROM bucketed b
      JOIN tenant_users tu ON tu.tenant_id = b.tenant_id AND tu.status = 'ACTIVE'
      JOIN roles r ON r.id = tu.role_id AND r.key = 'admin'
    ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;
  RETURN v_count;
END $$;

-- ───────────── Purga de tenants (tras periodo de gracia) ─────────────
-- Elimina datos operativos y personales NO fiscales. Conserva comprobantes,
-- ítems, envíos SUNAT y auditoría (retención legal; ver docs/COMPLIANCE.md).
-- Requiere doble confirmación: RUC exacto + token emitido por el panel.
CREATE OR REPLACE FUNCTION app.purge_tenant(p_tenant uuid, p_confirm_ruc text, p_actor uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE v_t record;
BEGIN
  SELECT * INTO v_t FROM tenants WHERE id = p_tenant FOR UPDATE;
  IF v_t.id IS NULL THEN RAISE EXCEPTION 'Tenant inexistente'; END IF;
  IF v_t.ruc <> p_confirm_ruc THEN RAISE EXCEPTION 'Confirmación de RUC no coincide'; END IF;
  IF v_t.status <> 'PENDING_DELETION' OR v_t.purge_after IS NULL OR v_t.purge_after > now() THEN
    RAISE EXCEPTION 'El tenant no está en periodo de purga habilitado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant_exports e WHERE e.tenant_id = p_tenant AND e.status = 'READY') THEN
    RAISE EXCEPTION 'Se requiere una exportación completa previa (tenant_exports READY)';
  END IF;

  -- Las tablas append-only (kardex, libro de controlados) se conservan con el
  -- tenant marcado como DELETED: forman parte del sustento contable/sanitario.
  DELETE FROM reminders            WHERE tenant_id = p_tenant;
  DELETE FROM notifications        WHERE tenant_id = p_tenant;
  DELETE FROM ai_ingestion_items   WHERE tenant_id = p_tenant;
  DELETE FROM ai_ingestion_jobs    WHERE tenant_id = p_tenant;
  DELETE FROM outbox_events        WHERE tenant_id = p_tenant AND status IN ('DONE', 'DEAD');
  UPDATE owners SET full_name = 'ELIMINADO', phone = NULL, whatsapp = NULL, email = NULL,
                    address = NULL, doc_number = NULL, deleted_at = now()
   WHERE tenant_id = p_tenant;
  UPDATE pets SET photo_path = NULL, microchip = NULL, deleted_at = now() WHERE tenant_id = p_tenant;
  UPDATE medical_records SET anamnesis = NULL, physical_exam = NULL, attachments = '{}', deleted_at = now()
   WHERE tenant_id = p_tenant;
  UPDATE customers SET email = NULL, phone = NULL, deleted_at = now() WHERE tenant_id = p_tenant;
  UPDATE tenant_users SET status = 'DISABLED', deleted_at = now() WHERE tenant_id = p_tenant;
  DELETE FROM tenant_secrets WHERE tenant_id = p_tenant;
  UPDATE tenant_modules SET enabled = false WHERE tenant_id = p_tenant;

  UPDATE tenants SET status = 'DELETED', deleted_at = now(), logo_path = NULL, sol_user = NULL
   WHERE id = p_tenant;

  INSERT INTO audit_logs (tenant_id, actor_user_id, actor_kind, action, entity_type, entity_id, reason)
  VALUES (p_tenant, p_actor, 'platform_admin', 'tenant.purge', 'tenant', p_tenant::text,
          'Purga definitiva tras periodo de gracia');
END $$;

REVOKE ALL ON FUNCTION app.purge_tenant(uuid, text, uuid) FROM PUBLIC, app_runtime, authenticated;
REVOKE ALL ON FUNCTION app.enqueue_expiry_alerts() FROM PUBLIC, app_runtime, authenticated;
REVOKE ALL ON FUNCTION app.enqueue_low_stock_alerts() FROM PUBLIC, app_runtime, authenticated;
REVOKE ALL ON FUNCTION app.enqueue_vaccine_reminders() FROM PUBLIC, app_runtime, authenticated;
REVOKE ALL ON FUNCTION app.enqueue_certificate_alerts() FROM PUBLIC, app_runtime, authenticated;
REVOKE ALL ON FUNCTION app.claim_outbox(text, text[], integer, integer) FROM PUBLIC, app_runtime, authenticated;
