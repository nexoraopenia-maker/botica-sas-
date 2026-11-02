-- WhatsApp por negocio, cierre de caja y DNI del prescriptor. Solo agrega: no modifica datos existentes.
ALTER TYPE "SecretKind" ADD VALUE IF NOT EXISTS 'WHATSAPP_TOKEN';

CREATE TYPE "WhatsappProvider" AS ENUM ('META_CLOUD', 'WEB_QR');

ALTER TABLE prescriptions ADD COLUMN prescriber_doc TEXT;

CREATE TABLE whatsapp_settings (
  tenant_id       UUID PRIMARY KEY,
  provider        "WhatsappProvider" NOT NULL DEFAULT 'META_CLOUD',
  waba_id         TEXT,
  phone_number_id TEXT,
  enabled         BOOLEAN NOT NULL DEFAULT false,
  reminder_days   INTEGER NOT NULL DEFAULT 3,
  alert_phone     TEXT,
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_settings_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE cash_closures (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  branch_id       UUID NOT NULL,
  user_id         UUID NOT NULL,
  idempotency_key UUID NOT NULL,
  period_from     TIMESTAMPTZ(6) NOT NULL,
  period_to       TIMESTAMPTZ(6) NOT NULL,
  opening_amount  DECIMAL(14, 2) NOT NULL,
  breakdown       JSONB NOT NULL,
  other_methods   JSONB NOT NULL DEFAULT '[]',
  expected_total  DECIMAL(14, 2) NOT NULL,
  counted_total   DECIMAL(14, 2) NOT NULL,
  difference      DECIMAL(14, 2) NOT NULL,
  document_count  INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT cash_closures_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX cash_closures_tenant_id_idempotency_key_key ON cash_closures (tenant_id, idempotency_key);
CREATE INDEX cash_closures_tenant_id_branch_id_user_id_period_to_idx ON cash_closures (tenant_id, branch_id, user_id, period_to DESC);

CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON whatsapp_settings
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- RLS por negocio, igual que el resto de tablas de tenant
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['whatsapp_settings', 'cash_closures'] LOOP
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

GRANT SELECT, INSERT, UPDATE ON whatsapp_settings TO app_runtime;
-- Un cierre de caja no se edita ni se borra
GRANT SELECT, INSERT ON cash_closures TO app_runtime;
