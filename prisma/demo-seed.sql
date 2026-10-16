-- ═══════════════════════════════════════════════════════════════════════════
-- Datos de demostración para el tenant 'demo' (no usar con clientes reales).
-- Idempotente: si los productos demo ya existen, no se duplican.
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/demo-seed.sql
-- Códigos de barras: prefijo EAN 200 (uso interno, no colisiona con productos reales).
-- Vencimientos relativos a hoy: hay lotes vencidos y por vencer para que las alertas se vean.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
BEGIN;
SELECT id AS tid FROM tenants WHERE slug = 'demo' \gset
SELECT id AS bid FROM branches WHERE tenant_id = :'tid' AND sunat_code = '0000' \gset
SELECT EXISTS (SELECT 1 FROM products WHERE tenant_id = :'tid' AND sku = 'IVER-500') AS seeded \gset

\if :seeded
  \echo 'Productos demo ya cargados: no se modifican'
\else
  INSERT INTO products (tenant_id, sku, barcode, name, unit_code, igv_affectation, sale_price, package_price, units_per_package,
                        package_unit_code, min_stock, withdrawal_days_meat, withdrawal_days_milk, target_species,
                        dci, concentration, pharmaceutical_form, pharmaceutical_kind, sale_condition, laboratory) VALUES
    (:'tid', 'IVER-500', '2000000000015', 'Ivermectina 1% inyectable 500 ml', 'NIU', '10', 85.00, NULL, 1, NULL, 5, 28, 0, '{BOVINE,OVINE,PORCINE}', NULL, NULL, NULL, NULL, NULL, NULL),
    (:'tid', 'VAC-RAB', '2000000000022', 'Vacuna antirrábica canina (1 dosis)', 'NIU', '10', 25.00, NULL, 1, NULL, 10, NULL, NULL, '{CANINE,FELINE}', NULL, NULL, NULL, NULL, NULL, NULL),
    (:'tid', 'PARA-500', '2000000000039', 'Paracetamol 500 mg tableta (genérico)', 'NIU', '10', 0.30, 25.00, 100, 'BX', 200, NULL, NULL, '{}', 'Paracetamol', '500 mg', 'Tableta', 'GENERIC', 'FREE', 'Laboratorio Genérico'),
    (:'tid', 'PANA-500', '2000000000046', 'Panadol 500 mg tableta', 'NIU', '10', 0.90, 80.00, 100, 'BX', 100, NULL, NULL, '{}', 'Paracetamol', '500 mg', 'Tableta', 'BRAND', 'FREE', 'GSK'),
    (:'tid', 'AMOX-500', '2000000000053', 'Amoxicilina 500 mg cápsula', 'NIU', '10', 0.80, 65.00, 100, 'BX', 100, NULL, NULL, '{}', 'Amoxicilina', '500 mg', 'Cápsula', 'GENERIC', 'PRESCRIPTION', 'Laboratorio Genérico'),
    (:'tid', 'ALIM-40', '2000000000060', 'Alimento balanceado engorde 40 kg', 'NIU', '10', 120.00, NULL, 1, NULL, 3, NULL, NULL, '{AVIAN}', NULL, NULL, NULL, NULL, NULL, NULL),
    (:'tid', 'SHAM-250', '2000000000077', 'Shampoo antipulgas para perros 250 ml', 'NIU', '10', 32.00, NULL, 1, NULL, 4, NULL, NULL, '{CANINE}', NULL, NULL, NULL, NULL, NULL, NULL),
    (:'tid', 'DESP-TAB', '2000000000084', 'Desparasitante canino tableta', 'NIU', '10', 12.00, NULL, 1, NULL, 10, NULL, NULL, '{CANINE}', NULL, NULL, NULL, NULL, NULL, NULL),
    (:'tid', 'MAIZ-1', '2000000000091', 'Semilla de maíz amarillo duro 1 kg', 'KGM', '20', 18.50, NULL, 1, NULL, 10, NULL, NULL, '{}', NULL, NULL, NULL, NULL, NULL, NULL),
    (:'tid', 'JER-5', '2000000000107', 'Jeringa descartable 5 ml', 'NIU', '10', 0.50, NULL, 1, NULL, 50, NULL, NULL, '{}', NULL, NULL, NULL, NULL, NULL, NULL);

  -- Lotes (stock en unidad base, costo sin IGV por unidad base)
  SELECT app.receive_batch(:'tid', :'bid', p.id, b.lot, CASE WHEN b.days IS NULL THEN NULL ELSE app.lima_today() + b.days END, b.qty, b.cost, NULL, NULL)
    FROM (VALUES
      ('IVER-500', 'IV-2407', 420, 18, 52.00),
      ('VAC-RAB',  'RB-0921',  12, 14, 11.00),   -- vence en 12 días → alerta
      ('VAC-RAB',  'RB-1102', 200, 30, 11.50),
      ('PARA-500', 'PA-2501', 540, 1000, 0.12),
      ('PANA-500', 'PN-2412', 300, 400, 0.45),
      ('AMOX-500', 'AX-2410',  45, 300, 0.35),   -- vence en 45 días → alerta 60
      ('ALIM-40',  'AL-2409', 150, 2, 92.00),    -- stock 2 ≤ mínimo 3 → stock bajo
      ('SHAM-250', 'SH-2408',  25, 9, 18.00),    -- vence en 25 días → alerta 30
      ('DESP-TAB', 'DS-0123', -10, 6, 5.00),     -- VENCIDO con stock → bloqueado para la venta
      ('DESP-TAB', 'DS-2501', 380, 60, 5.50),
      ('MAIZ-1',   'MZ-2409', 240, 40, 11.00),
      ('JER-5',    'JR-2506', 900, 500, 0.18)
    ) AS b(sku, lot, days, qty, cost)
    JOIN products p ON p.tenant_id = :'tid' AND p.sku = b.sku;

  INSERT INTO customers (tenant_id, doc_type, doc_number, name, address, phone) VALUES
    (:'tid', 'DNI', '45678912', 'Rosa Mamani Flores', NULL, '987654321'),
    (:'tid', 'DNI', '41237896', 'Jorge Huamán Ríos', NULL, NULL),
    (:'tid', 'RUC', '20000000010', 'COMERCIAL GANADERA DEMO S.A.C.', 'Jr. Las Praderas 456, Lima', NULL);

  -- Clínica: propietarios sin WhatsApp/email reales (los recordatorios demo quedan solo en la app)
  INSERT INTO owners (tenant_id, full_name, doc_type, doc_number, notify_whatsapp, notify_email)
  VALUES (:'tid', 'María Quispe (demo)', 'DNI', '45678912', false, false) RETURNING id AS oid \gset
  INSERT INTO pets (tenant_id, owner_id, name, species, breed, sex, birth_date, weight_kg) VALUES
    (:'tid', :'oid', 'Rocky', 'CANINE', 'Mestizo', 'MALE', app.lima_today() - 900, 18.5),
    (:'tid', :'oid', 'Mishi', 'FELINE', 'Común europeo', 'FEMALE', app.lima_today() - 400, 4.1);
  INSERT INTO pet_vaccinations (tenant_id, pet_id, vaccine_id, dose_number, is_booster, applied_at, next_due_at, lot_code)
  SELECT :'tid', pt.id, vc.id, v.dose, v.booster, app.lima_today() - v.ago, app.lima_today() + v.due, 'RB-0921'
    FROM (VALUES ('Rocky', 'Antirrábica canina', 2, true, 361, 4),
                 ('Rocky', 'Séxtuple / Polivalente canina', 4, true, 345, 20),
                 ('Mishi', 'Triple felina', 2, false, 18, 3)) AS v(pet, vaccine, dose, booster, ago, due)
    JOIN pets pt ON pt.tenant_id = :'tid' AND pt.name = v.pet
    JOIN vaccine_catalog vc ON vc.tenant_id IS NULL AND vc.name = v.vaccine;

  INSERT INTO audit_logs (tenant_id, actor_kind, action, entity_type, entity_id, reason)
  VALUES (:'tid', 'system', 'tenant.demo_seed', 'tenant', :'tid', 'Carga de datos de demostración');
\endif
COMMIT;
