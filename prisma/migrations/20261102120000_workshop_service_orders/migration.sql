-- Taller mecánico: órdenes de servicio y cuentas por cobrar. Solo agrega: no modifica datos existentes.
ALTER TYPE "BusinessLine" ADD VALUE IF NOT EXISTS 'WORKSHOP';
ALTER TYPE "ModuleKey" ADD VALUE IF NOT EXISTS 'WORKSHOP';

CREATE TYPE "ServiceOrderStatus" AS ENUM ('RECEIVED', 'IN_PROGRESS', 'READY', 'DELIVERED');
CREATE TYPE "ServicePaymentType" AS ENUM ('CASH', 'CREDIT');

CREATE UNIQUE INDEX customers_tenant_id_id_key ON customers (tenant_id, id);

CREATE TABLE service_orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  branch_id        UUID NOT NULL,
  customer_id      UUID NOT NULL,
  number           INTEGER NOT NULL,
  idempotency_key  UUID NOT NULL,
  item_description TEXT NOT NULL,
  plate            TEXT,
  mileage          INTEGER,
  problem          TEXT NOT NULL,
  notes            TEXT,
  evidence_urls    TEXT[] NOT NULL DEFAULT '{}',
  status           "ServiceOrderStatus" NOT NULL DEFAULT 'RECEIVED',
  payment_type     "ServicePaymentType" NOT NULL DEFAULT 'CASH',
  total            DECIMAL(14, 2) NOT NULL DEFAULT 0,
  balance_due      DECIMAL(14, 2) NOT NULL DEFAULT 0,
  due_date         DATE,
  invoice_number   TEXT,
  delivered_at     TIMESTAMPTZ(6),
  created_by       UUID,
  created_at       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ(6),
  CONSTRAINT service_orders_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT service_orders_branch_tenant_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT service_orders_customer_tenant_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  -- Reglas de dinero también en la base: ningún error de aplicación deja un saldo imposible
  CONSTRAINT service_orders_amounts_chk CHECK (total >= 0 AND balance_due >= 0 AND balance_due <= total),
  CONSTRAINT service_orders_credit_due_chk CHECK (payment_type <> 'CREDIT' OR due_date IS NOT NULL OR deleted_at IS NOT NULL),
  CONSTRAINT service_orders_evidence_max_chk CHECK (cardinality(evidence_urls) <= 8)
);
CREATE UNIQUE INDEX service_orders_tenant_id_id_key ON service_orders (tenant_id, id);
CREATE UNIQUE INDEX service_orders_tenant_id_number_key ON service_orders (tenant_id, number);
CREATE UNIQUE INDEX service_orders_tenant_id_idempotency_key_key ON service_orders (tenant_id, idempotency_key);
CREATE INDEX service_orders_tenant_id_status_created_at_idx ON service_orders (tenant_id, status, created_at DESC);
CREATE INDEX service_orders_tenant_id_payment_type_due_date_idx ON service_orders (tenant_id, payment_type, due_date);

CREATE TABLE service_order_payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  order_id        UUID NOT NULL,
  idempotency_key UUID NOT NULL,
  method          "PaymentMethod" NOT NULL,
  amount          DECIMAL(14, 2) NOT NULL,
  reference       TEXT,
  created_by      UUID,
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT service_order_payments_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES service_orders(tenant_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT service_order_payments_amount_chk CHECK (amount > 0 AND method <> 'CREDITO')
);
CREATE UNIQUE INDEX service_order_payments_tenant_id_idempotency_key_key ON service_order_payments (tenant_id, idempotency_key);
CREATE INDEX service_order_payments_tenant_id_order_id_idx ON service_order_payments (tenant_id, order_id);

CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON service_orders
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['service_orders', 'service_order_payments'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON public.%I
        FOR ALL TO app_runtime, authenticated
        USING (tenant_id = (SELECT app.current_tenant_id()))
        WITH CHECK (tenant_id = (SELECT app.current_tenant_id()))
    $p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON service_orders TO app_runtime;
-- Un cobro registrado no se edita ni se borra
GRANT SELECT, INSERT ON service_order_payments TO app_runtime;

-- Purga de un negocio: también borra los datos personales de sus órdenes
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
  UPDATE service_orders SET plate = NULL, mileage = NULL, problem = '', notes = NULL, evidence_urls = '{}', deleted_at = now()
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
