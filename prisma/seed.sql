-- Datos base de plataforma. Idempotente.  psql "$DIRECT_URL" -f prisma/seed.sql

INSERT INTO plans (id, code, name, monthly_price_pen, annual_price_pen, max_users, max_branches, max_documents_month, max_ai_pages_month, included_modules, trial_days, updated_at)
VALUES
  (gen_random_uuid(), 'basico',      'Básico',      89.00,  890.00,  3, 1,   800,  20, '{CORE}', 14, now()),
  (gen_random_uuid(), 'profesional', 'Profesional', 179.00, 1790.00, 8, 2,  3000, 100, '{CORE,AI_INVENTORY}', 14, now()),
  (gen_random_uuid(), 'premium',     'Premium',     349.00, 3490.00, 25, 5, 15000, 400, '{CORE,AI_INVENTORY,WHATSAPP,DISPATCH_GUIDES}', 14, now())
ON CONFLICT (code) DO NOTHING;

-- Catálogo global de vacunas/antiparasitarios (tenant_id NULL). Esquemas REFERENCIALES:
-- cada clínica debe validarlos con su médico veterinario y puede crear los propios.
INSERT INTO vaccine_catalog (species, name, kind, first_dose_min_age_days, primary_doses, primary_interval_days, booster_interval_days, max_age_days_for_primary, adult_primary_doses, updated_at)
SELECT * FROM (VALUES
  ('CANINE'::"Species", 'Séxtuple / Polivalente canina', 'VACCINE'::"VaccineKind", 56, 3, 21, 365::int, 120::int, 2::int, now()),
  ('CANINE', 'Antirrábica canina',                        'RABIES',              90, 1, 0,  365, NULL, NULL, now()),
  ('CANINE', 'KC (Tos de las perreras)',                  'VACCINE',             56, 1, 0,  365, NULL, NULL, now()),
  ('CANINE', 'Desparasitación interna cachorro',          'DEWORMING_INTERNAL',  15, 4, 15, 90,  NULL, NULL, now()),
  ('CANINE', 'Desparasitación externa',                   'DEWORMING_EXTERNAL',  56, 1, 0,  30,  NULL, NULL, now()),
  ('FELINE', 'Triple felina',                             'VACCINE',             56, 2, 21, 365, 120, 2, now()),
  ('FELINE', 'Leucemia felina',                           'VACCINE',             56, 2, 21, 365, NULL, NULL, now()),
  ('FELINE', 'Antirrábica felina',                        'RABIES',              90, 1, 0,  365, NULL, NULL, now()),
  ('FELINE', 'Desparasitación interna gatito',            'DEWORMING_INTERNAL',  21, 3, 15, 90,  NULL, NULL, now()),
  ('BOVINE', 'Carbunco sintomático / edema maligno',      'VACCINE',             90, 2, 30, 365, NULL, NULL, now()),
  ('BOVINE', 'Fiebre aftosa (según campaña SENASA)',      'VACCINE',             90, 1, 0,  180, NULL, NULL, now()),
  ('PORCINE','Peste porcina clásica (según campaña SENASA)','VACCINE',           45, 1, 0,  365, NULL, NULL, now())
) AS v(species, name, kind, a, b, c, d, e, f, u)
WHERE NOT EXISTS (SELECT 1 FROM vaccine_catalog vc WHERE vc.tenant_id IS NULL AND vc.name = v.name AND vc.species = v.species);
