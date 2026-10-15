-- ═══════════════════════════════════════════════════════════════════════════
-- Seguridad e integridad: roles, helpers de contexto, defaults, CHECKs,
-- índices especializados, triggers de inmutabilidad y RLS.
--
-- Modelo de contexto de tenant:
--   • Servidor (Prisma, rol app_runtime): en cada transacción
--       SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)
--     tras validar sesión + membresía en Node. GUC local a la transacción
--     (seguro con PgBouncer en modo transaction).
--   • Cliente Supabase (rol authenticated, PostgREST/Realtime): el tenant activo
--     viene de auth.jwt()->app_metadata.tenant_id (solo escribible por el
--     servidor) y se re-verifica la membresía.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS app;

-- ───────────── Roles ─────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    -- La contraseña/LOGIN se asigna fuera de las migraciones (ver README):
    --   ALTER ROLE app_runtime WITH LOGIN PASSWORD '...';
    CREATE ROLE app_runtime NOLOGIN NOBYPASSRLS NOINHERIT;
  END IF;
  -- Roles de Supabase: se crean vacíos si no existen (entornos de test locales)
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
END $$;

-- ───────────── Helpers ─────────────

CREATE OR REPLACE FUNCTION app.jwt_claims() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('app.user_id', true), ''),
    app.jwt_claims() ->> 'sub'
  )::uuid
$$;

-- SECURITY DEFINER para poder leer tenant_users sin recursión de RLS.
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app AS $$
DECLARE
  v_guc text := nullif(current_setting('app.tenant_id', true), '');
  v_jwt uuid;
BEGIN
  IF v_guc IS NOT NULL THEN
    -- Solo el runtime del servidor (o el owner/servicio) puede fijar el GUC
    RETURN v_guc::uuid;
  END IF;
  v_jwt := nullif(app.jwt_claims() -> 'app_metadata' ->> 'tenant_id', '')::uuid;
  IF v_jwt IS NULL THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM tenant_users tu
    JOIN tenants t ON t.id = tu.tenant_id
    WHERE tu.tenant_id = v_jwt
      AND tu.user_id = app.current_user_id()
      AND tu.status = 'ACTIVE' AND tu.deleted_at IS NULL
      AND t.status IN ('TRIAL', 'ACTIVE')
  ) THEN
    RETURN v_jwt;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app.is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_admins
    WHERE id = app.current_user_id() AND deleted_at IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION app.lima_today() RETURNS date
LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'America/Lima')::date $$;

CREATE OR REPLACE FUNCTION app.immutable_unaccent(text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT public.unaccent('public.unaccent'::regdictionary, $1)
$$;

CREATE OR REPLACE FUNCTION app.search_key(text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT lower(app.immutable_unaccent($1))
$$;

-- ───────────── Defaults en BD (para SQL crudo, funciones y Edge Functions) ─────────────

CREATE OR REPLACE FUNCTION app.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN updated_at SET DEFAULT now()', r.table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_set_updated_at ON public.%I', r.table_name);
    EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()', r.table_name);
  END LOOP;

  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.column_name = 'id' AND c.data_type = 'uuid'
      AND c.column_default IS NULL
      AND c.table_name NOT IN ('platform_admins', 'users') -- id = auth.users.id
  LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN id SET DEFAULT gen_random_uuid()', r.table_name);
  END LOOP;
END $$;

-- ───────────── CHECK constraints ─────────────

ALTER TABLE tenants
  ADD CONSTRAINT tenants_ruc_chk CHECK (ruc ~ '^(10|15|16|17|20)[0-9]{9}$'),
  ADD CONSTRAINT tenants_ubigeo_chk CHECK (ubigeo ~ '^[0-9]{6}$');

ALTER TABLE branches
  ADD CONSTRAINT branches_sunat_code_chk CHECK (sunat_code ~ '^[0-9]{4}$');

ALTER TABLE suppliers
  ADD CONSTRAINT suppliers_ruc_chk CHECK (ruc ~ '^(10|15|16|17|20)[0-9]{9}$');

ALTER TABLE customers
  ADD CONSTRAINT customers_doc_chk CHECK (
    (doc_type = 'DNI' AND doc_number ~ '^[0-9]{8}$') OR
    (doc_type = 'RUC' AND doc_number ~ '^(10|15|16|17|20)[0-9]{9}$') OR
    (doc_type = 'CE' AND doc_number ~ '^[A-Za-z0-9]{6,12}$') OR
    (doc_type = 'PASSPORT' AND doc_number ~ '^[A-Za-z0-9]{6,12}$') OR
    (doc_type = 'NO_DOC')
  );

-- Catálogo 07 (afectación del IGV)
ALTER TABLE products
  ADD CONSTRAINT products_igv_aff_chk CHECK (igv_affectation IN
    ('10','11','12','13','14','15','16','17','20','21','30','31','32','33','34','35','36','37','40')),
  ADD CONSTRAINT products_units_per_package_chk CHECK (units_per_package >= 1),
  ADD CONSTRAINT products_price_chk CHECK (sale_price >= 0 AND (package_price IS NULL OR package_price >= 0)),
  ADD CONSTRAINT products_controlled_requires_rx_chk CHECK (
    NOT is_controlled OR sale_condition IN ('RETAINED_PRESCRIPTION')
  );

ALTER TABLE product_batches
  ADD CONSTRAINT product_batches_stock_nonneg_chk CHECK (stock >= 0),
  ADD CONSTRAINT product_batches_cost_chk CHECK (unit_cost >= 0);

ALTER TABLE document_series
  ADD CONSTRAINT document_series_format_chk CHECK (
    (doc_type = 'FACTURA' AND series ~ '^F[A-Z0-9]{3}$') OR
    (doc_type = 'BOLETA' AND series ~ '^B[A-Z0-9]{3}$') OR
    (doc_type IN ('NOTA_CREDITO','NOTA_DEBITO') AND series ~ '^[FB][A-Z0-9]{3}$')
  ),
  ADD CONSTRAINT document_series_last_number_chk CHECK (last_number BETWEEN 0 AND 99999999);

ALTER TABLE documents
  ADD CONSTRAINT documents_number_chk CHECK (number BETWEEN 1 AND 99999999),
  ADD CONSTRAINT documents_total_chk CHECK (total >= 0 AND igv >= 0),
  -- Defensa en profundidad de reglas SUNAT (la validación principal está en src/lib/sunat/validation.ts)
  ADD CONSTRAINT documents_factura_ruc_chk CHECK (
    doc_type <> 'FACTURA' OR customer_doc_type = 'RUC'
  ),
  ADD CONSTRAINT documents_boleta_700_chk CHECK (
    doc_type <> 'BOLETA' OR total <= 700 OR customer_doc_type <> 'NO_DOC'
  ),
  ADD CONSTRAINT documents_note_ref_chk CHECK (
    doc_type NOT IN ('NOTA_CREDITO','NOTA_DEBITO')
    OR (ref_document_id IS NOT NULL AND note_reason_code IS NOT NULL)
  );

ALTER TABLE document_items
  ADD CONSTRAINT document_items_qty_chk CHECK (quantity > 0 AND base_quantity > 0),
  ADD CONSTRAINT document_items_igv_aff_chk CHECK (igv_affectation IN
    ('10','11','12','13','14','15','16','17','20','21','30','31','32','33','34','35','36','37','40'));

ALTER TABLE document_item_lots
  ADD CONSTRAINT document_item_lots_qty_chk CHECK (quantity > 0);

ALTER TABLE document_payments
  ADD CONSTRAINT document_payments_amount_chk CHECK (amount > 0);

ALTER TABLE controlled_substance_log
  ADD CONSTRAINT controlled_qty_chk CHECK (quantity > 0),
  ADD CONSTRAINT controlled_balance_chk CHECK (balance >= 0);

ALTER TABLE ai_ingestion_items
  ADD CONSTRAINT ai_items_conf_chk CHECK (confidence BETWEEN 0 AND 1);

ALTER TABLE impersonation_sessions
  ADD CONSTRAINT impersonation_reason_chk CHECK (length(trim(reason)) >= 15),
  ADD CONSTRAINT impersonation_ttl_chk CHECK (expires_at <= started_at + interval '60 minutes');

-- ───────────── Integridad cruzada por tenant (FK compuestas) ─────────────
-- Impiden, a nivel BD, que una fila de un tenant referencie datos de otro.

ALTER TABLE product_batches
  ADD CONSTRAINT product_batches_product_tenant_fk
    FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  ADD CONSTRAINT product_batches_branch_tenant_fk
    FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id);

ALTER TABLE documents
  ADD CONSTRAINT documents_branch_tenant_fk
    FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  ADD CONSTRAINT documents_ref_fk
    FOREIGN KEY (ref_document_id) REFERENCES documents (id);

ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_product_tenant_fk
    FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  ADD CONSTRAINT stock_movements_batch_fk
    FOREIGN KEY (batch_id) REFERENCES product_batches (id);

ALTER TABLE document_item_lots
  ADD CONSTRAINT document_item_lots_batch_fk FOREIGN KEY (batch_id) REFERENCES product_batches (id);

ALTER TABLE pet_vaccinations
  ADD CONSTRAINT pet_vaccinations_batch_fk FOREIGN KEY (batch_id) REFERENCES product_batches (id);

ALTER TABLE reminders
  ADD CONSTRAINT reminders_vacc_fk FOREIGN KEY (pet_vaccination_id) REFERENCES pet_vaccinations (id);

ALTER TABLE controlled_substance_log
  ADD CONSTRAINT controlled_product_tenant_fk
    FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id);

-- ───────────── Índices especializados ─────────────

CREATE UNIQUE INDEX customers_doc_uq ON customers (tenant_id, doc_type, doc_number)
  WHERE deleted_at IS NULL AND doc_type <> 'NO_DOC';
CREATE INDEX customers_name_trgm ON customers USING gin (app.search_key(name) gin_trgm_ops);

CREATE UNIQUE INDEX suppliers_ruc_uq ON suppliers (tenant_id, ruc) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX products_sku_uq ON products (tenant_id, sku) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX products_barcode_uq ON products (tenant_id, barcode)
  WHERE deleted_at IS NULL AND barcode IS NOT NULL;
CREATE INDEX products_name_trgm ON products USING gin (app.search_key(name) gin_trgm_ops);
CREATE INDEX products_dci_trgm ON products USING gin (app.search_key(dci) gin_trgm_ops) WHERE dci IS NOT NULL;
CREATE INDEX products_embedding_hnsw ON products USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL AND deleted_at IS NULL;

-- FEFO: solo lotes vendibles; el orden coincide con el ORDER BY de app.consume_stock_fefo
CREATE INDEX product_batches_fefo_idx ON product_batches
  (tenant_id, branch_id, product_id, expiry_date ASC NULLS LAST, received_at, id)
  WHERE stock > 0 AND deleted_at IS NULL AND NOT is_quarantined;

CREATE INDEX outbox_ready_idx ON outbox_events (next_attempt_at, id) WHERE status IN ('PENDING', 'FAILED');
CREATE INDEX notifications_queue_idx ON notifications (created_at) WHERE status = 'QUEUED';

-- ───────────── Tablas append-only ─────────────

CREATE OR REPLACE FUNCTION app.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'La tabla % es inmutable (operación % no permitida)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER trg_audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER trg_stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER trg_controlled_log_immutable BEFORE UPDATE OR DELETE ON controlled_substance_log
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER trg_sunat_submissions_immutable BEFORE UPDATE OR DELETE ON sunat_submissions
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER trg_document_items_immutable BEFORE UPDATE OR DELETE ON document_items
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER trg_document_item_lots_immutable BEFORE UPDATE OR DELETE ON document_item_lots
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- Comprobantes: nunca se borran (retención legal). Los campos fiscales no cambian
-- tras la emisión; solo evolucionan estado/respuesta SUNAT/rutas de archivos.
CREATE OR REPLACE FUNCTION app.guard_document_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Los comprobantes electrónicos no se eliminan (anule con NC o comunicación de baja)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.tenant_id, NEW.doc_type, NEW.series, NEW.number, NEW.issue_date, NEW.total, NEW.igv,
      NEW.customer_doc_type, NEW.customer_doc_number, NEW.op_gravadas, NEW.op_exoneradas,
      NEW.op_inafectas, NEW.op_gratuitas)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.doc_type, OLD.series, OLD.number, OLD.issue_date, OLD.total, OLD.igv,
      OLD.customer_doc_type, OLD.customer_doc_number, OLD.op_gravadas, OLD.op_exoneradas,
      OLD.op_inafectas, OLD.op_gratuitas) THEN
    RAISE EXCEPTION 'Campos fiscales del comprobante %-% son inmutables', OLD.series, OLD.number
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.hash IS NOT NULL AND NEW.hash IS DISTINCT FROM OLD.hash THEN
    RAISE EXCEPTION 'El hash de un comprobante firmado no puede cambiar'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'ANULADO' AND NEW.status <> 'ANULADO' THEN
    RAISE EXCEPTION 'Un comprobante anulado no puede reactivarse';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_documents_guard BEFORE UPDATE OR DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION app.guard_document_update();

-- ───────────── Auditoría: cadena de hash (tamper-evident) ─────────────

CREATE OR REPLACE FUNCTION app.audit_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_prev text;
BEGIN
  -- Serializa solo inserciones de auditoría del mismo tenant (acciones administrativas, bajo volumen)
  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || coalesce(NEW.tenant_id::text, 'platform'), 0));
  SELECT hash INTO v_prev FROM audit_logs
   WHERE tenant_id IS NOT DISTINCT FROM NEW.tenant_id
   ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := v_prev;
  NEW.hash := encode(digest(
      coalesce(v_prev, '') || '|' || NEW.occurred_at::text || '|' || coalesce(NEW.actor_user_id::text, '') || '|' ||
      NEW.action || '|' || NEW.entity_type || '|' || coalesce(NEW.entity_id, '') || '|' ||
      coalesce(NEW.before::text, '') || '|' || coalesce(NEW.after::text, '') || '|' || coalesce(NEW.reason, ''),
    'sha256'), 'hex');
  RETURN NEW;
END $$;

ALTER TABLE audit_logs ALTER COLUMN hash SET DEFAULT '';
CREATE TRIGGER trg_audit_chain BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION app.audit_chain();

-- ───────────── Libro de controlados: saldo automático ─────────────

CREATE OR REPLACE FUNCTION app.controlled_log_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last numeric;
  v_delta numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ctrl:' || NEW.tenant_id || ':' || NEW.branch_id || ':' || NEW.product_id, 0));
  SELECT balance INTO v_last FROM controlled_substance_log
   WHERE tenant_id = NEW.tenant_id AND branch_id = NEW.branch_id AND product_id = NEW.product_id
   ORDER BY id DESC LIMIT 1;
  v_delta := CASE NEW.movement WHEN 'IN' THEN NEW.quantity WHEN 'OUT' THEN -NEW.quantity ELSE NEW.quantity END;
  IF NEW.movement = 'ADJUSTMENT' THEN
    -- en ajustes, quantity es el saldo físico contado
    NEW.balance := NEW.quantity;
  ELSE
    NEW.balance := coalesce(v_last, 0) + v_delta;
  END IF;
  IF NEW.balance < 0 THEN
    RAISE EXCEPTION 'Saldo negativo en libro de controlados (producto %)', NEW.product_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_controlled_balance BEFORE INSERT ON controlled_substance_log
  FOR EACH ROW EXECUTE FUNCTION app.controlled_log_balance();

-- ───────────── Grants ─────────────

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
GRANT USAGE ON SCHEMA public, app TO app_runtime, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_runtime, authenticated;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT DELETE ON
  tenant_users, roles, product_categories, document_payments, alert_rules, ai_ingestion_items
  TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
-- Secretos y plano de plataforma: sin acceso desde el runtime de tenant
REVOKE ALL ON tenant_secrets, platform_admins, impersonation_sessions, plans, tenant_exports
  FROM app_runtime, authenticated;
GRANT SELECT ON plans TO app_runtime, authenticated;
-- Cliente directo (Supabase JS): solo lectura de lo necesario para realtime/UI
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
GRANT SELECT ON notifications, tenant_modules, tenants, branches, plans TO authenticated;
GRANT UPDATE (read_at) ON notifications TO authenticated;

-- ───────────── RLS ─────────────

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'subscriptions','usage_counters','tenant_modules','branches','roles','tenant_users',
    'customers','suppliers','product_categories','products','product_batches','stock_movements',
    'purchases','purchase_items','document_series','documents','document_items','document_item_lots',
    'document_payments','sunat_submissions','outbox_events','owners','pets','medical_records',
    'pet_vaccinations','reminders','pharmacist_staff','prescriptions','controlled_substance_log',
    'ai_ingestion_jobs','ai_ingestion_items','alert_rules','notifications'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON public.%I
        FOR ALL TO app_runtime, authenticated
        USING (tenant_id = (SELECT app.current_tenant_id()))
        WITH CHECK (tenant_id = (SELECT app.current_tenant_id()))
    $p$, t);
  END LOOP;
END $$;

-- Notificaciones internas: además, cada usuario ve solo las suyas desde el cliente
DROP POLICY IF EXISTS tenant_isolation ON notifications;
CREATE POLICY notifications_runtime ON notifications FOR ALL TO app_runtime
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY notifications_own ON notifications FOR SELECT TO authenticated
  USING (tenant_id = (SELECT app.current_tenant_id()) AND user_id = (SELECT app.current_user_id()));
CREATE POLICY notifications_mark_read ON notifications FOR UPDATE TO authenticated
  USING (tenant_id = (SELECT app.current_tenant_id()) AND user_id = (SELECT app.current_user_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND user_id = (SELECT app.current_user_id()));

-- Catálogo de vacunas: global (tenant_id NULL) visible para todos; propio editable
ALTER TABLE vaccine_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE vaccine_catalog FORCE ROW LEVEL SECURITY;
CREATE POLICY vaccine_catalog_read ON vaccine_catalog FOR SELECT TO app_runtime, authenticated
  USING (tenant_id IS NULL OR tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY vaccine_catalog_write ON vaccine_catalog FOR INSERT TO app_runtime
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY vaccine_catalog_update ON vaccine_catalog FOR UPDATE TO app_runtime
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

-- Tenants: cada tenant ve su propia fila. Cambios de estado/plan solo por plataforma.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_self_read ON tenants FOR SELECT TO app_runtime, authenticated
  USING (id = (SELECT app.current_tenant_id()));
CREATE POLICY tenants_self_update ON tenants FOR UPDATE TO app_runtime
  USING (id = (SELECT app.current_tenant_id()))
  WITH CHECK (id = (SELECT app.current_tenant_id()));
REVOKE UPDATE ON tenants FROM app_runtime;
GRANT UPDATE (trade_name, contact_name, contact_email, contact_phone, logo_path, fiscal_address, urbanization)
  ON tenants TO app_runtime;

-- Usuarios: cada uno ve su perfil y los miembros de su tenant
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_visible ON users FOR SELECT TO app_runtime, authenticated
  USING (
    id = (SELECT app.current_user_id())
    OR EXISTS (SELECT 1 FROM tenant_users tu
               WHERE tu.user_id = users.id AND tu.tenant_id = (SELECT app.current_tenant_id()))
  );
CREATE POLICY users_self_update ON users FOR UPDATE TO app_runtime
  USING (id = (SELECT app.current_user_id())) WITH CHECK (id = (SELECT app.current_user_id()));

-- Auditoría: lectura por tenant; inserción desde runtime solo para su tenant
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_tenant_read ON audit_logs FOR SELECT TO app_runtime
  USING (tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY audit_tenant_insert ON audit_logs FOR INSERT TO app_runtime
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

-- Tablas de plataforma y secretos: RLS activado sin políticas => denegado
-- para cualquier rol sin BYPASSRLS. Solo el rol de plataforma/servicio accede.
ALTER TABLE tenant_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_secrets FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE impersonation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY plans_public_read ON plans FOR SELECT TO app_runtime, authenticated
  USING (deleted_at IS NULL);

-- ───────────── Supabase Storage (si existe) ─────────────
-- Rutas: {tenant_id}/<carpeta>/<archivo>. Buckets privados; acceso por URLs firmadas.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage') THEN
    INSERT INTO storage.buckets (id, name, public)
    VALUES ('tenant-files', 'tenant-files', false),
           ('sunat', 'sunat', false),
           ('ai-ingestion', 'ai-ingestion', false)
    ON CONFLICT (id) DO NOTHING;

    EXECUTE $p$
      CREATE POLICY tenant_files_rw ON storage.objects FOR ALL TO authenticated
      USING (bucket_id IN ('tenant-files', 'ai-ingestion')
             AND (storage.foldername(name))[1] = (SELECT app.current_tenant_id())::text)
      WITH CHECK (bucket_id IN ('tenant-files', 'ai-ingestion')
             AND (storage.foldername(name))[1] = (SELECT app.current_tenant_id())::text)
    $p$;
    -- El bucket 'sunat' (XML firmados y CDR) solo es accesible por el servidor (service_role).
  END IF;
END $$;
