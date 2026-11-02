-- Revierte 20261102120000_workshop_service_orders: el taller mecánico no forma parte de este ERP.
-- Esa migración se conserva en el historial porque ya se aplicó; esta deja la base como estaba antes de ella.

DROP TABLE service_order_payments;
DROP TABLE service_orders;
DROP TYPE "ServiceOrderStatus";
DROP TYPE "ServicePaymentType";
DROP INDEX customers_tenant_id_id_key;

DELETE FROM tenant_modules WHERE module = 'WORKSHOP';
UPDATE tenants SET business_lines = array_remove(business_lines, 'WORKSHOP') WHERE 'WORKSHOP' = ANY (business_lines);
UPDATE plans SET included_modules = array_remove(included_modules, 'WORKSHOP') WHERE 'WORKSHOP' = ANY (included_modules);

-- PostgreSQL no permite quitar un valor de un enum: se recrean los tipos sin WORKSHOP
ALTER TYPE "BusinessLine" RENAME TO "BusinessLine_old";
CREATE TYPE "BusinessLine" AS ENUM ('AGROVET', 'VETERINARY', 'PHARMACY', 'RETAIL');
ALTER TABLE tenants ALTER COLUMN business_lines TYPE "BusinessLine"[] USING business_lines::text[]::"BusinessLine"[];
DROP TYPE "BusinessLine_old";

ALTER TYPE "ModuleKey" RENAME TO "ModuleKey_old";
CREATE TYPE "ModuleKey" AS ENUM ('CORE', 'VETERINARY', 'AGRO', 'PHARMACY', 'MAGISTRAL', 'AI_INVENTORY', 'WHATSAPP', 'DISPATCH_GUIDES');
ALTER TABLE tenant_modules ALTER COLUMN module TYPE "ModuleKey" USING module::text::"ModuleKey";
ALTER TABLE plans ALTER COLUMN included_modules TYPE "ModuleKey"[] USING included_modules::text[]::"ModuleKey"[];
DROP TYPE "ModuleKey_old";

-- Purga de un negocio: vuelve a su definición sin órdenes de servicio
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
