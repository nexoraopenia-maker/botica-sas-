-- ═══════════════════════════════════════════════════════════════════════════
-- Jobs programados (Supabase pg_cron + pg_net). Horas en UTC (Lima = UTC-5).
-- Si pg_cron no está disponible (entorno local), se omite sin fallar.
-- La URL y el secreto del worker se leen de Supabase Vault:
--   select vault.create_secret('https://<app>/api/internal/outbox', 'outbox_dispatch_url');
--   select vault.create_secret('<INTERNAL_CRON_SECRET>', 'internal_cron_secret');
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION app.kick_outbox_worker() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')
     OR NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'vault') THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM outbox_events WHERE status IN ('PENDING','FAILED') AND next_attempt_at <= now()
                 UNION ALL
                 SELECT 1 FROM outbox_events WHERE status = 'PROCESSING' AND locked_until < now()) THEN
    RETURN; -- nada que hacer: no despertar al worker
  END IF;
  EXECUTE $q$SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'outbox_dispatch_url'$q$ INTO v_url;
  EXECUTE $q$SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_cron_secret'$q$ INTO v_secret;
  IF v_url IS NULL OR v_secret IS NULL THEN RETURN; END IF;
  EXECUTE 'SELECT net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 5000)'
    USING v_url,
          jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
          '{}'::jsonb;
END $$;

REVOKE ALL ON FUNCTION app.kick_outbox_worker() FROM PUBLIC, app_runtime, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron no disponible: jobs no programados';
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS pg_cron;

  -- 07:00 Lima: alertas de caducidad por lote (90/60/30/15/7/vencidos)
  PERFORM cron.schedule('expiry-alerts',      '0 12 * * *',  'SELECT app.enqueue_expiry_alerts()');
  -- 07:10 Lima: stock mínimo
  PERFORM cron.schedule('low-stock-alerts',   '10 12 * * *', 'SELECT app.enqueue_low_stock_alerts()');
  -- 08:00 Lima: recordatorios de vacunas (7, 3, 1 días y el mismo día)
  PERFORM cron.schedule('vaccine-reminders',  '0 13 * * *',  'SELECT app.enqueue_vaccine_reminders()');
  -- 06:00 Lima: certificados digitales por vencer
  PERFORM cron.schedule('certificate-alerts', '0 11 * * *',  'SELECT app.enqueue_certificate_alerts()');
  -- Cada minuto: despertar al worker si hay eventos (envíos SUNAT, WhatsApp, IA)
  PERFORM cron.schedule('outbox-kick',        '* * * * *',   'SELECT app.kick_outbox_worker()');
  -- Diario: limpiar eventos procesados con más de 30 días
  PERFORM cron.schedule('outbox-cleanup',     '30 8 * * *',
    $q$DELETE FROM outbox_events WHERE status = 'DONE' AND processed_at < now() - interval '30 days'$q$);
END $$;
