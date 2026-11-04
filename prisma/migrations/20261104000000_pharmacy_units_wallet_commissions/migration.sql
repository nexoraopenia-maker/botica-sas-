-- Fraccionamiento por blíster, código DIGEMID, monedero virtual y comisiones. Solo agrega: no modifica datos existentes.
ALTER TYPE "SaleUnit" ADD VALUE IF NOT EXISTS 'BLISTER' BEFORE 'PACKAGE';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'MONEDERO';

CREATE TYPE "WalletTransactionType" AS ENUM ('EARN', 'REDEEM', 'EARN_REVERSAL', 'REDEEM_REFUND');

ALTER TABLE products
  ADD COLUMN units_per_blister INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN blister_price DECIMAL(14, 4),
  ADD COLUMN base_unit_name TEXT,
  -- La caja debe contener blísteres completos: evita stock imposible de empaquetar
  ADD CONSTRAINT products_blister_chk CHECK (units_per_blister >= 1 AND units_per_package % units_per_blister = 0);

ALTER TABLE branches ADD COLUMN digemid_establishment_code TEXT;

ALTER TABLE documents
  ADD COLUMN seller_id UUID,
  ADD COLUMN seller_commission_percent DECIMAL(5, 2);
CREATE INDEX documents_tenant_id_seller_id_issue_date_idx ON documents (tenant_id, seller_id, issue_date);

CREATE UNIQUE INDEX customers_tenant_id_id_key ON customers (tenant_id, id);

CREATE TABLE loyalty_settings (
  tenant_id    UUID PRIMARY KEY,
  enabled      BOOLEAN NOT NULL DEFAULT false,
  earn_percent DECIMAL(5, 2) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT loyalty_settings_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT loyalty_settings_percent_chk CHECK (earn_percent >= 0 AND earn_percent <= 50)
);

CREATE TABLE customer_wallets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  customer_id UUID NOT NULL,
  balance     DECIMAL(14, 2) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT customer_wallets_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT customer_wallets_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT customer_wallets_balance_chk CHECK (balance >= 0)
);
CREATE UNIQUE INDEX customer_wallets_tenant_id_id_key ON customer_wallets (tenant_id, id);
CREATE UNIQUE INDEX customer_wallets_tenant_id_customer_id_key ON customer_wallets (tenant_id, customer_id);

CREATE TABLE wallet_transactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  wallet_id     UUID NOT NULL,
  type          "WalletTransactionType" NOT NULL,
  amount        DECIMAL(14, 2) NOT NULL,
  balance_after DECIMAL(14, 2) NOT NULL,
  document_id   UUID NOT NULL,
  created_by    UUID,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT wallet_transactions_wallet_fk FOREIGN KEY (tenant_id, wallet_id) REFERENCES customer_wallets(tenant_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT wallet_transactions_balance_chk CHECK (balance_after >= 0 AND amount <> 0)
);
CREATE UNIQUE INDEX wallet_transactions_tenant_id_document_id_type_key ON wallet_transactions (tenant_id, document_id, type);
CREATE INDEX wallet_transactions_tenant_id_wallet_id_created_at_idx ON wallet_transactions (tenant_id, wallet_id, created_at DESC);

CREATE TABLE seller_commission_rates (
  tenant_id  UUID NOT NULL,
  user_id    UUID NOT NULL,
  percent    DECIMAL(5, 2) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT seller_commission_rates_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT seller_commission_rates_percent_chk CHECK (percent >= 0 AND percent <= 100)
);

ALTER TABLE documents ADD CONSTRAINT documents_seller_percent_chk CHECK (seller_commission_percent IS NULL OR (seller_commission_percent >= 0 AND seller_commission_percent <= 100));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['loyalty_settings', 'customer_wallets', 'wallet_transactions', 'seller_commission_rates'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON public.%I
        FOR ALL TO app_runtime, authenticated
        USING (tenant_id = (SELECT app.current_tenant_id()))
        WITH CHECK (tenant_id = (SELECT app.current_tenant_id()))
    $p$, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['loyalty_settings', 'customer_wallets', 'seller_commission_rates'] LOOP
    EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON loyalty_settings, customer_wallets, seller_commission_rates TO app_runtime;
-- Un movimiento del monedero no se edita ni se borra
GRANT SELECT, INSERT ON wallet_transactions TO app_runtime;
