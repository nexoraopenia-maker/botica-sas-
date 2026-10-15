-- Prueba de integración de BD. Ejecutar sobre una BD recién migrada:
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/sql/integration.sql
-- Termina con ROLLBACK: no deja datos.
BEGIN;

-- ── Fixtures (como owner) ──
INSERT INTO tenants (id, slug, ruc, legal_name, business_lines, fiscal_address, ubigeo, department, province, district, contact_email, status)
VALUES ('00000000-0000-0000-0000-0000000000a1', 'agro-a', '20123456789', 'AGRO A SAC', '{AGROVET,VETERINARY}', 'Av. 1', '150101', 'LIMA', 'LIMA', 'LIMA', 'a@a.pe', 'ACTIVE'),
       ('00000000-0000-0000-0000-0000000000b1', 'boti-b', '20987654321', 'BOTICA B SAC', '{PHARMACY}', 'Av. 2', '150101', 'LIMA', 'LIMA', 'LIMA', 'b@b.pe', 'ACTIVE');
INSERT INTO tenant_modules (tenant_id, module) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'CORE'), ('00000000-0000-0000-0000-0000000000a1', 'VETERINARY'),
  ('00000000-0000-0000-0000-0000000000b1', 'CORE'), ('00000000-0000-0000-0000-0000000000b1', 'PHARMACY');
INSERT INTO branches (id, tenant_id, sunat_code, name, address, ubigeo) VALUES
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a1', '0000', 'Principal', 'Av. 1', '150101'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b1', '0000', 'Principal', 'Av. 2', '150101');
INSERT INTO products (id, tenant_id, sku, name, sale_price) VALUES
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a1', 'IVER-1', 'Ivermectina 1% 50ml', 25),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000b1', 'PARA-500', 'Paracetamol 500mg', 0.5);
INSERT INTO document_series (tenant_id, branch_id, doc_type, series) VALUES
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'BOLETA', 'B001');

-- Lotes: uno vencido, uno que vence pronto, uno lejano
SELECT app.receive_batch('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
  '00000000-0000-0000-0000-0000000000a3', 'L-VENCIDO', app.lima_today() - 1, 10, 10, NULL, NULL);
SELECT app.receive_batch('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
  '00000000-0000-0000-0000-0000000000a3', 'L-PRONTO', app.lima_today() + 20, 5, 11, NULL, NULL);
SELECT app.receive_batch('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
  '00000000-0000-0000-0000-0000000000a3', 'L-LEJANO', app.lima_today() + 400, 8, 12, NULL, NULL);
-- Re-recepción del mismo lote: suma stock y promedia costo
SELECT app.receive_batch('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
  '00000000-0000-0000-0000-0000000000a3', 'L-LEJANO', app.lima_today() + 400, 2, 17, NULL, NULL);
DO $$ BEGIN
  ASSERT (SELECT stock FROM product_batches WHERE lot_code = 'L-LEJANO') = 10, 'stock acumulado';
  ASSERT (SELECT unit_cost FROM product_batches WHERE lot_code = 'L-LEJANO') = 13, 'costo promedio';
END $$;

-- ── Runtime con contexto del tenant A ──
SET LOCAL ROLE app_runtime;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-0000000000a1', true);

DO $$ BEGIN
  ASSERT (SELECT count(*) FROM products) = 1, 'RLS: solo productos del tenant A';
  ASSERT (SELECT count(*) FROM tenants) = 1, 'RLS: solo su tenant';
END $$;

-- Insertar en otro tenant debe fallar (WITH CHECK)
DO $$ BEGIN
  BEGIN
    INSERT INTO customers (tenant_id, doc_type, doc_number, name)
    VALUES ('00000000-0000-0000-0000-0000000000b1', 'DNI', '12345678', 'X');
    RAISE EXCEPTION 'FALLO: RLS permitió insertar en otro tenant';
  EXCEPTION WHEN insufficient_privilege THEN NULL; -- new row violates row-level security policy
  END;
END $$;

-- Secretos inaccesibles para el runtime
DO $$ BEGIN
  BEGIN
    PERFORM 1 FROM tenant_secrets;
    RAISE EXCEPTION 'FALLO: runtime pudo leer tenant_secrets';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- FEFO: pedir 7 → 5 de L-PRONTO + 2 de L-LEJANO; jamás L-VENCIDO
CREATE TEMP TABLE fefo AS
SELECT * FROM app.consume_stock_fefo('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
  '00000000-0000-0000-0000-0000000000a3', 7, 'SALE', 'test', NULL, NULL);
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM fefo) = 2, 'FEFO usa 2 lotes';
  ASSERT (SELECT stock FROM product_batches WHERE lot_code = 'L-PRONTO') = 0, 'consume primero el que vence antes';
  ASSERT (SELECT stock FROM product_batches WHERE lot_code = 'L-LEJANO') = 8, 'luego el lejano';
  ASSERT (SELECT stock FROM product_batches WHERE lot_code = 'L-VENCIDO') = 10, 'vencido intacto';
  ASSERT (SELECT count(*) FROM stock_movements WHERE type = 'SALE') = 2, 'kardex por lote';
END $$;

-- Stock insuficiente (solo 8 vendibles; los 10 vencidos no cuentan)
DO $$ BEGIN
  BEGIN
    PERFORM app.consume_stock_fefo('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
      '00000000-0000-0000-0000-0000000000a3', 9, 'SALE', 'test', NULL, NULL);
    RAISE EXCEPTION 'FALLO: vendió stock vencido';
  EXCEPTION WHEN raise_exception THEN
    NULL;
  END;
END $$;

-- Correlativo
DO $$ BEGIN
  ASSERT app.next_document_number('00000000-0000-0000-0000-0000000000a1', 'BOLETA', 'B001') = 1, 'correlativo 1';
  ASSERT app.next_document_number('00000000-0000-0000-0000-0000000000a1', 'BOLETA', 'B001') = 2, 'correlativo 2';
END $$;

-- Boleta > 700 sin documento → CHECK
DO $$ BEGIN
  BEGIN
    INSERT INTO documents (tenant_id, branch_id, doc_type, series, number, issue_date, issue_time,
      customer_doc_type, customer_doc_number, customer_name, total)
    VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'BOLETA', 'B001', 3,
      app.lima_today(), '10:00:00', 'NO_DOC', '-', 'CLIENTES VARIOS', 750);
    RAISE EXCEPTION 'FALLO: boleta > 700 sin DNI';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- Comprobante emitido: fiscal inmutable, no borrable
INSERT INTO documents (id, tenant_id, branch_id, doc_type, series, number, issue_date, issue_time,
  customer_doc_type, customer_doc_number, customer_name, total, igv, op_gravadas)
VALUES ('00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
  'BOLETA', 'B001', 4, app.lima_today(), '10:00:00', 'NO_DOC', '-', 'CLIENTES VARIOS', 118, 18, 100);
UPDATE documents SET status = 'ACEPTADO', sunat_code = '0' WHERE id = '00000000-0000-0000-0000-0000000000a9';
DO $$ BEGIN
  BEGIN
    UPDATE documents SET total = 1 WHERE id = '00000000-0000-0000-0000-0000000000a9';
    RAISE EXCEPTION 'FALLO: modificó total';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- Kardex inmutable
DO $$ BEGIN
  BEGIN
    UPDATE stock_movements SET quantity = 0;
    RAISE EXCEPTION 'FALLO: kardex mutable';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- Auditoría: cadena de hash
INSERT INTO audit_logs (tenant_id, actor_kind, action, entity_type) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'system', 'test.one', 'test'),
  ('00000000-0000-0000-0000-0000000000a1', 'system', 'test.two', 'test');
DO $$ BEGIN
  ASSERT (SELECT prev_hash FROM audit_logs WHERE action = 'test.two') =
         (SELECT hash FROM audit_logs WHERE action = 'test.one'), 'cadena de hash';
END $$;

RESET ROLE;

-- ── Libro de controlados (tenant B) ──
INSERT INTO controlled_substance_log (tenant_id, branch_id, product_id, movement, quantity, recorded_by)
VALUES ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b3', 'IN', 100, gen_random_uuid()),
       ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b3', 'OUT', 30, gen_random_uuid());
DO $$ BEGIN
  ASSERT (SELECT balance FROM controlled_substance_log ORDER BY id DESC LIMIT 1) = 70, 'saldo controlados';
  BEGIN
    INSERT INTO controlled_substance_log (tenant_id, branch_id, product_id, movement, quantity, recorded_by)
    VALUES ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b3', 'OUT', 71, gen_random_uuid());
    RAISE EXCEPTION 'FALLO: saldo negativo permitido';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- ── Recordatorios de vacunas ──
INSERT INTO owners (id, tenant_id, full_name, whatsapp, email) VALUES
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Ana', '+51999999999', 'ana@x.pe');
INSERT INTO pets (id, tenant_id, owner_id, name, species) VALUES
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'Firulais', 'CANINE');
INSERT INTO vaccine_catalog (id, species, name, kind, first_dose_min_age_days, primary_doses, primary_interval_days, booster_interval_days)
VALUES ('00000000-0000-0000-0000-0000000000c3', 'CANINE', 'Antirrábica', 'RABIES', 90, 1, 0, 365);
INSERT INTO pet_vaccinations (tenant_id, pet_id, vaccine_id, dose_number, applied_at, next_due_at) VALUES
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c3', 1, app.lima_today() - 358, app.lima_today() + 7);
DO $$ DECLARE n int; BEGIN
  n := app.enqueue_vaccine_reminders();
  -- WHATSAPP sin módulo WHATSAPP activo => solo EMAIL + IN_APP
  ASSERT n = 2, format('2 notificaciones, obtuvo %s', n);
  ASSERT app.enqueue_vaccine_reminders() = 0, 'idempotente';
  ASSERT (SELECT count(*) FROM reminders WHERE notification_id IS NOT NULL) = 2, 'reminders enlazados';
  ASSERT (SELECT count(*) FROM outbox_events WHERE event_type = 'notification.send') = 1, 'outbox solo canales externos';
END $$;

-- ── Alertas de caducidad ──
INSERT INTO users (id, email, full_name) VALUES ('00000000-0000-0000-0000-0000000000d1', 'adm@a.pe', 'Admin A');
INSERT INTO roles (id, tenant_id, key, name, permissions, is_system) VALUES
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', 'admin', 'Administrador', '{*}', true);
INSERT INTO tenant_users (tenant_id, user_id, role_id, status) VALUES
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2', 'ACTIVE');
DO $$ DECLARE n int; BEGIN
  n := app.enqueue_expiry_alerts();
  -- L-VENCIDO (stock 10) => EXPIRED. L-PRONTO stock 0 => no. L-LEJANO 400 días => no.
  ASSERT n = 1, format('1 alerta de caducidad, obtuvo %s', n);
  ASSERT app.enqueue_expiry_alerts() = 0, 'idempotente';
END $$;

\echo 'OK: todas las aserciones pasaron'
ROLLBACK;
