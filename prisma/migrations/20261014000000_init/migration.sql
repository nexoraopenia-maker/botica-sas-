-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('TRIAL', 'ACTIVE', 'SUSPENDED', 'PENDING_DELETION', 'DELETED');

-- CreateEnum
CREATE TYPE "BusinessLine" AS ENUM ('AGROVET', 'VETERINARY', 'PHARMACY', 'RETAIL');

-- CreateEnum
CREATE TYPE "ModuleKey" AS ENUM ('CORE', 'VETERINARY', 'AGRO', 'PHARMACY', 'MAGISTRAL', 'AI_INVENTORY', 'WHATSAPP', 'DISPATCH_GUIDES');

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('OWNER', 'SUPPORT', 'BILLING');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'OVERDUE', 'WAIVED');

-- CreateEnum
CREATE TYPE "SunatEnvironment" AS ENUM ('BETA', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "OseProvider" AS ENUM ('SUNAT_SEE', 'OSE_GENERIC');

-- CreateEnum
CREATE TYPE "SecretKind" AS ENUM ('SOL_CREDENTIALS', 'CERTIFICATE_PFX');

-- CreateEnum
CREATE TYPE "IdentityDocType" AS ENUM ('NO_DOC', 'DNI', 'CE', 'RUC', 'PASSPORT');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('FACTURA', 'BOLETA', 'NOTA_CREDITO', 'NOTA_DEBITO');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDIENTE', 'ENVIANDO', 'ACEPTADO', 'ACEPTADO_CON_OBS', 'RECHAZADO', 'ERROR_REINTENTABLE', 'ANULACION_PENDIENTE', 'ANULADO');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('EFECTIVO', 'YAPE', 'PLIN', 'TARJETA', 'TRANSFERENCIA', 'CREDITO');

-- CreateEnum
CREATE TYPE "SaleUnit" AS ENUM ('UNIT', 'PACKAGE');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('PURCHASE', 'SALE', 'SALE_RETURN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'WASTE', 'TRANSFER_IN', 'TRANSFER_OUT', 'CLINICAL_USE');

-- CreateEnum
CREATE TYPE "SaleCondition" AS ENUM ('FREE', 'PRESCRIPTION', 'RETAINED_PRESCRIPTION');

-- CreateEnum
CREATE TYPE "PharmaceuticalKind" AS ENUM ('GENERIC', 'BRAND');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('DRAFT', 'RECEIVED', 'CANCELED');

-- CreateEnum
CREATE TYPE "PurchaseSource" AS ENUM ('MANUAL', 'AI_IMAGE', 'AI_PDF', 'XML_UBL');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "Species" AS ENUM ('CANINE', 'FELINE', 'BOVINE', 'OVINE', 'CAPRINE', 'PORCINE', 'EQUINE', 'AVIAN', 'CAVY', 'RABBIT', 'OTHER');

-- CreateEnum
CREATE TYPE "PetSex" AS ENUM ('MALE', 'FEMALE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "VisitType" AS ENUM ('CONSULTATION', 'VACCINATION', 'DEWORMING', 'HOSPITALIZATION', 'SURGERY', 'GROOMING', 'CONTROL');

-- CreateEnum
CREATE TYPE "VaccineKind" AS ENUM ('VACCINE', 'RABIES', 'DEWORMING_INTERNAL', 'DEWORMING_EXTERNAL');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('WHATSAPP', 'EMAIL', 'IN_APP');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AlertKind" AS ENUM ('BATCH_EXPIRY', 'LOW_STOCK', 'VACCINE_DUE', 'CERTIFICATE_EXPIRY', 'SUNAT_REJECTION');

-- CreateEnum
CREATE TYPE "PrescriptionKind" AS ENUM ('SIMPLE', 'RETAINED', 'SPECIAL');

-- CreateEnum
CREATE TYPE "ControlledMovement" AS ENUM ('IN', 'OUT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "AiSourceKind" AS ENUM ('IMAGE', 'PDF', 'XML');

-- CreateEnum
CREATE TYPE "AiJobStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'NEEDS_REVIEW', 'APPROVED', 'COMMITTED', 'FAILED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "AiItemStatus" AS ENUM ('MATCHED', 'NEEDS_REVIEW', 'NEW_PRODUCT', 'IGNORED');

-- CreateEnum
CREATE TYPE "MatchMethod" AS ENUM ('EXACT_CODE', 'TRIGRAM', 'VECTOR', 'MANUAL', 'NONE');

-- CreateTable
CREATE TABLE "platform_admins" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "role" "PlatformRole" NOT NULL DEFAULT 'SUPPORT',
    "mfa_required" BOOLEAN NOT NULL DEFAULT true,
    "last_reauth_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "monthly_price_pen" DECIMAL(10,2) NOT NULL,
    "annual_price_pen" DECIMAL(10,2),
    "max_users" INTEGER NOT NULL,
    "max_branches" INTEGER NOT NULL,
    "max_documents_month" INTEGER NOT NULL,
    "max_ai_pages_month" INTEGER NOT NULL,
    "included_modules" "ModuleKey"[],
    "trial_days" INTEGER NOT NULL DEFAULT 14,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "payment_status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "trial_ends_at" TIMESTAMPTZ(6),
    "current_period_start" TIMESTAMPTZ(6) NOT NULL,
    "current_period_end" TIMESTAMPTZ(6) NOT NULL,
    "auto_renew" BOOLEAN NOT NULL DEFAULT true,
    "last_payment_at" TIMESTAMPTZ(6),
    "canceled_at" TIMESTAMPTZ(6),
    "limit_overrides" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_counters" (
    "tenant_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("tenant_id","period","metric")
);

-- CreateTable
CREATE TABLE "tenant_modules" (
    "tenant_id" UUID NOT NULL,
    "module" "ModuleKey" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enabled_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_modules_pkey" PRIMARY KEY ("tenant_id","module")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" UUID,
    "actor_user_id" UUID,
    "actor_kind" TEXT NOT NULL,
    "impersonation_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "prev_hash" TEXT,
    "hash" TEXT NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "impersonation_sessions" (
    "id" UUID NOT NULL,
    "platform_admin_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "target_user_id" UUID,
    "reason" TEXT NOT NULL,
    "ticket_ref" TEXT,
    "read_only" BOOLEAN NOT NULL DEFAULT true,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "impersonation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_exports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "storage_path" TEXT,
    "sha256" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "tenant_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "ruc" CHAR(11) NOT NULL,
    "legal_name" TEXT NOT NULL,
    "trade_name" TEXT,
    "business_lines" "BusinessLine"[],
    "fiscal_address" TEXT NOT NULL,
    "ubigeo" CHAR(6) NOT NULL,
    "department" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "urbanization" TEXT,
    "contact_name" TEXT,
    "contact_email" TEXT NOT NULL,
    "contact_phone" TEXT,
    "logo_path" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/Lima',
    "status" "TenantStatus" NOT NULL DEFAULT 'TRIAL',
    "sunat_env" "SunatEnvironment" NOT NULL DEFAULT 'BETA',
    "ose_provider" "OseProvider" NOT NULL DEFAULT 'SUNAT_SEE',
    "ose_endpoint" TEXT,
    "sol_user" TEXT,
    "certificate_expires_at" TIMESTAMPTZ(6),
    "sunat_beta_passed_at" TIMESTAMPTZ(6),
    "onboarding_step" INTEGER NOT NULL DEFAULT 0,
    "suspended_at" TIMESTAMPTZ(6),
    "suspension_reason" TEXT,
    "deletion_requested_at" TIMESTAMPTZ(6),
    "purge_after" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_secrets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "SecretKind" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "auth_tag" BYTEA NOT NULL,
    "wrapped_dek" BYTEA NOT NULL,
    "kek_id" TEXT NOT NULL,
    "cert_subject" TEXT,
    "cert_serial" TEXT,
    "cert_not_before" TIMESTAMPTZ(6),
    "cert_not_after" TIMESTAMPTZ(6),
    "fingerprint" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_at" TIMESTAMPTZ(6),

    CONSTRAINT "tenant_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sunat_code" CHAR(4) NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "ubigeo" CHAR(6) NOT NULL,
    "phone" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" TEXT[],
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "branch_ids" UUID[],
    "status" TEXT NOT NULL DEFAULT 'INVITED',
    "invited_by" UUID,
    "invited_at" TIMESTAMPTZ(6),
    "accepted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tenant_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "doc_type" "IdentityDocType" NOT NULL,
    "doc_number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "ubigeo" CHAR(6),
    "email" TEXT,
    "phone" TEXT,
    "whatsapp_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ruc" CHAR(11) NOT NULL,
    "legal_name" TEXT NOT NULL,
    "trade_name" TEXT,
    "address" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category_id" UUID,
    "sku" TEXT NOT NULL,
    "barcode" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unit_code" TEXT NOT NULL DEFAULT 'NIU',
    "igv_affectation" CHAR(2) NOT NULL DEFAULT '10',
    "sale_price" DECIMAL(14,4) NOT NULL,
    "package_price" DECIMAL(14,4),
    "units_per_package" INTEGER NOT NULL DEFAULT 1,
    "package_unit_code" TEXT,
    "allow_fractional" BOOLEAN NOT NULL DEFAULT false,
    "min_stock" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "tracks_batches" BOOLEAN NOT NULL DEFAULT true,
    "is_service" BOOLEAN NOT NULL DEFAULT false,
    "icbper" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "senasa_registration" TEXT,
    "withdrawal_days_meat" INTEGER,
    "withdrawal_days_milk" INTEGER,
    "target_species" "Species"[],
    "digemid_registration" TEXT,
    "dci" TEXT,
    "concentration" TEXT,
    "pharmaceutical_form" TEXT,
    "laboratory" TEXT,
    "pharmaceutical_kind" "PharmaceuticalKind",
    "sale_condition" "SaleCondition",
    "is_controlled" BOOLEAN NOT NULL DEFAULT false,
    "controlled_list" TEXT,
    "digemid_product_code" TEXT,
    "embedding" vector(1024),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_batches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "lot_code" TEXT NOT NULL,
    "expiry_date" DATE,
    "unit_cost" DECIMAL(18,6) NOT NULL,
    "stock" DECIMAL(14,3) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purchase_item_id" UUID,
    "is_quarantined" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "product_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "batch_id" UUID,
    "type" "StockMovementType" NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "balance_after" DECIMAL(14,3) NOT NULL,
    "unit_cost" DECIMAL(18,6),
    "ref_type" TEXT,
    "ref_id" UUID,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "doc_type" CHAR(2) NOT NULL,
    "series" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "issue_date" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'PEN',
    "exchange_rate" DECIMAL(10,4),
    "subtotal" DECIMAL(14,2) NOT NULL,
    "igv" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'DRAFT',
    "source" "PurchaseSource" NOT NULL DEFAULT 'MANUAL',
    "ai_job_id" UUID,
    "attachment_path" TEXT,
    "received_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "purchase_unit" "SaleUnit" NOT NULL DEFAULT 'UNIT',
    "base_quantity" DECIMAL(14,3) NOT NULL,
    "unit_cost" DECIMAL(18,6) NOT NULL,
    "igv_affectation" CHAR(2) NOT NULL DEFAULT '10',
    "line_total" DECIMAL(14,2) NOT NULL,
    "lot_code" TEXT,
    "expiry_date" DATE,
    "batch_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_series" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "doc_type" "DocumentType" NOT NULL,
    "series" CHAR(4) NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "document_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "doc_type" "DocumentType" NOT NULL,
    "series" CHAR(4) NOT NULL,
    "number" INTEGER NOT NULL,
    "issue_date" DATE NOT NULL,
    "issue_time" TEXT NOT NULL,
    "due_date" DATE,
    "currency" CHAR(3) NOT NULL DEFAULT 'PEN',
    "operation_type" CHAR(4) NOT NULL DEFAULT '0101',
    "payment_terms" TEXT NOT NULL DEFAULT 'Contado',
    "customer_id" UUID,
    "customer_doc_type" "IdentityDocType" NOT NULL,
    "customer_doc_number" TEXT NOT NULL,
    "customer_name" TEXT NOT NULL,
    "customer_address" TEXT,
    "op_gravadas" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "op_exoneradas" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "op_inafectas" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "op_gratuitas" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igv" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "icbper" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "ref_document_id" UUID,
    "note_reason_code" CHAR(2),
    "note_reason_text" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDIENTE',
    "sunat_code" TEXT,
    "sunat_description" TEXT,
    "sunat_notes" TEXT[],
    "hash" TEXT,
    "xml_path" TEXT,
    "cdr_path" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "accepted_at" TIMESTAMPTZ(6),
    "void_reason" TEXT,
    "voided_at" TIMESTAMPTZ(6),
    "idempotency_key" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" UUID,
    "description" TEXT NOT NULL,
    "unit_code" TEXT NOT NULL,
    "sale_unit" "SaleUnit" NOT NULL DEFAULT 'UNIT',
    "quantity" DECIMAL(14,3) NOT NULL,
    "base_quantity" DECIMAL(14,3) NOT NULL,
    "unit_value" DECIMAL(18,10) NOT NULL,
    "unit_price" DECIMAL(18,10) NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igv_affectation" CHAR(2) NOT NULL,
    "igv_base" DECIMAL(14,2) NOT NULL,
    "igv_amount" DECIMAL(14,2) NOT NULL,
    "line_extension" DECIMAL(14,2) NOT NULL,
    "line_total" DECIMAL(14,2) NOT NULL,
    "icbper_units" INTEGER NOT NULL DEFAULT 0,
    "icbper_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "prescription_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_item_lots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_item_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_cost" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "document_item_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sunat_submissions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "operation" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "ticket" TEXT,
    "http_status" INTEGER,
    "response_code" TEXT,
    "response_text" TEXT,
    "fault_code" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sunat_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 10,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_by" TEXT,
    "locked_until" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "owners" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID,
    "full_name" TEXT NOT NULL,
    "doc_type" "IdentityDocType",
    "doc_number" TEXT,
    "phone" TEXT,
    "whatsapp" TEXT,
    "email" TEXT,
    "address" TEXT,
    "notify_whatsapp" BOOLEAN NOT NULL DEFAULT true,
    "notify_email" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "owners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "species" "Species" NOT NULL,
    "breed" TEXT,
    "sex" "PetSex" NOT NULL DEFAULT 'UNKNOWN',
    "birth_date" DATE,
    "color" TEXT,
    "microchip" TEXT,
    "sterilized" BOOLEAN NOT NULL DEFAULT false,
    "weight_kg" DECIMAL(7,2),
    "photo_path" TEXT,
    "allergies" TEXT,
    "deceased_at" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medical_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "vet_user_id" UUID NOT NULL,
    "visit_type" "VisitType" NOT NULL,
    "visit_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "anamnesis" TEXT,
    "weight_kg" DECIMAL(7,2),
    "temperature_c" DECIMAL(4,1),
    "heart_rate" INTEGER,
    "resp_rate" INTEGER,
    "physical_exam" TEXT,
    "diagnosis" TEXT,
    "treatment" TEXT,
    "prescription" TEXT,
    "admitted_at" TIMESTAMPTZ(6),
    "discharged_at" TIMESTAMPTZ(6),
    "next_control_at" DATE,
    "document_id" UUID,
    "attachments" TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "medical_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vaccine_catalog" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "species" "Species" NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "VaccineKind" NOT NULL,
    "product_id" UUID,
    "first_dose_min_age_days" INTEGER NOT NULL,
    "primary_doses" INTEGER NOT NULL,
    "primary_interval_days" INTEGER NOT NULL,
    "booster_interval_days" INTEGER,
    "max_age_days_for_primary" INTEGER,
    "adult_primary_doses" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vaccine_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pet_vaccinations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "vaccine_id" UUID NOT NULL,
    "dose_number" INTEGER NOT NULL,
    "is_booster" BOOLEAN NOT NULL DEFAULT false,
    "applied_at" DATE NOT NULL,
    "next_due_at" DATE,
    "batch_id" UUID,
    "lot_code" TEXT,
    "applied_by" UUID,
    "medical_record_id" UUID,
    "document_item_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pet_vaccinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "pet_vaccination_id" UUID NOT NULL,
    "due_date" DATE NOT NULL,
    "offset_days" INTEGER NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "notification_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacist_staff" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "user_id" UUID,
    "full_name" TEXT NOT NULL,
    "cqfp_number" TEXT NOT NULL,
    "is_technical_director" BOOLEAN NOT NULL DEFAULT false,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pharmacist_staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "kind" "PrescriptionKind" NOT NULL,
    "customer_id" UUID,
    "patient_name" TEXT NOT NULL,
    "patient_doc" TEXT,
    "prescriber_name" TEXT NOT NULL,
    "prescriber_cmp" TEXT NOT NULL,
    "prescriber_profession" TEXT NOT NULL DEFAULT 'MEDICO',
    "issued_at" DATE NOT NULL,
    "valid_until" DATE,
    "diagnosis" TEXT,
    "image_path" TEXT,
    "retained" BOOLEAN NOT NULL DEFAULT false,
    "validated_by" UUID NOT NULL,
    "dispensed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "prescriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "controlled_substance_log" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "batch_id" UUID,
    "movement" "ControlledMovement" NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "balance" DECIMAL(14,3) NOT NULL,
    "document_id" UUID,
    "purchase_id" UUID,
    "prescription_id" UUID,
    "counterparty" TEXT,
    "recorded_by" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "controlled_substance_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_ingestion_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "storage_path" TEXT NOT NULL,
    "file_sha256" CHAR(64) NOT NULL,
    "mime_type" TEXT NOT NULL,
    "source_kind" "AiSourceKind" NOT NULL,
    "status" "AiJobStatus" NOT NULL DEFAULT 'UPLOADED',
    "model" TEXT,
    "extracted" JSONB,
    "overall_confidence" DECIMAL(4,3),
    "warnings" TEXT[],
    "supplier_id" UUID,
    "purchase_id" UUID,
    "duplicate_of_purchase_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "created_by" UUID NOT NULL,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_ingestion_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_ingestion_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "supplier_code" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_code" TEXT,
    "unit_price" DECIMAL(18,6) NOT NULL,
    "igv_included" BOOLEAN NOT NULL DEFAULT false,
    "line_total" DECIMAL(14,2),
    "lot_code" TEXT,
    "expiry_date" DATE,
    "confidence" DECIMAL(4,3) NOT NULL,
    "matched_product_id" UUID,
    "match_method" "MatchMethod" NOT NULL DEFAULT 'NONE',
    "match_score" DECIMAL(5,4),
    "candidates" JSONB,
    "units_per_package" INTEGER,
    "status" "AiItemStatus" NOT NULL DEFAULT 'NEEDS_REVIEW',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_ingestion_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "AlertKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "thresholds" INTEGER[],
    "channels" "NotificationChannel"[],
    "recipient_roles" TEXT[],
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "channel" "NotificationChannel" NOT NULL,
    "template" TEXT NOT NULL,
    "recipient" TEXT,
    "payload" JSONB NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "dedupe_key" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "related_type" TEXT,
    "related_id" TEXT,
    "read_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_admins_email_key" ON "platform_admins"("email");

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE INDEX "subscriptions_tenant_id_status_idx" ON "subscriptions"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "subscriptions_current_period_end_idx" ON "subscriptions"("current_period_end");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_occurred_at_idx" ON "audit_logs"("tenant_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_occurred_at_idx" ON "audit_logs"("actor_user_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "impersonation_sessions_platform_admin_id_started_at_idx" ON "impersonation_sessions"("platform_admin_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "impersonation_sessions_tenant_id_started_at_idx" ON "impersonation_sessions"("tenant_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "tenant_exports_tenant_id_created_at_idx" ON "tenant_exports"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_ruc_key" ON "tenants"("ruc");

-- CreateIndex
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- CreateIndex
CREATE INDEX "tenant_secrets_tenant_id_kind_is_active_idx" ON "tenant_secrets"("tenant_id", "kind", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "branches_tenant_id_sunat_code_key" ON "branches"("tenant_id", "sunat_code");

-- CreateIndex
CREATE UNIQUE INDEX "branches_tenant_id_id_key" ON "branches"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_key_key" ON "roles"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "tenant_users_user_id_idx" ON "tenant_users"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_users_tenant_id_user_id_key" ON "tenant_users"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "customers_tenant_id_name_idx" ON "customers"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_tenant_id_name_key" ON "product_categories"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "products_tenant_id_dci_idx" ON "products"("tenant_id", "dci");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenant_id_id_key" ON "products"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "product_batches_tenant_id_branch_id_product_id_expiry_date_idx" ON "product_batches"("tenant_id", "branch_id", "product_id", "expiry_date");

-- CreateIndex
CREATE INDEX "product_batches_tenant_id_expiry_date_idx" ON "product_batches"("tenant_id", "expiry_date");

-- CreateIndex
CREATE UNIQUE INDEX "product_batches_tenant_id_branch_id_product_id_lot_code_key" ON "product_batches"("tenant_id", "branch_id", "product_id", "lot_code");

-- CreateIndex
CREATE INDEX "stock_movements_tenant_id_product_id_created_at_idx" ON "stock_movements"("tenant_id", "product_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_movements_tenant_id_branch_id_created_at_idx" ON "stock_movements"("tenant_id", "branch_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_movements_ref_type_ref_id_idx" ON "stock_movements"("ref_type", "ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_tenant_id_supplier_id_doc_type_series_number_key" ON "purchases"("tenant_id", "supplier_id", "doc_type", "series", "number");

-- CreateIndex
CREATE INDEX "purchase_items_purchase_id_idx" ON "purchase_items"("purchase_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_series_tenant_id_doc_type_series_key" ON "document_series"("tenant_id", "doc_type", "series");

-- CreateIndex
CREATE INDEX "documents_tenant_id_status_created_at_idx" ON "documents"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "documents_tenant_id_issue_date_idx" ON "documents"("tenant_id", "issue_date");

-- CreateIndex
CREATE UNIQUE INDEX "documents_tenant_id_doc_type_series_number_key" ON "documents"("tenant_id", "doc_type", "series", "number");

-- CreateIndex
CREATE UNIQUE INDEX "documents_tenant_id_idempotency_key_key" ON "documents"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "document_items_document_id_line_no_key" ON "document_items"("document_id", "line_no");

-- CreateIndex
CREATE INDEX "document_item_lots_batch_id_idx" ON "document_item_lots"("batch_id");

-- CreateIndex
CREATE INDEX "sunat_submissions_document_id_attempt_idx" ON "sunat_submissions"("document_id", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_dedupe_key_key" ON "outbox_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "outbox_events_status_next_attempt_at_idx" ON "outbox_events"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "owners_tenant_id_full_name_idx" ON "owners"("tenant_id", "full_name");

-- CreateIndex
CREATE INDEX "pets_tenant_id_owner_id_idx" ON "pets"("tenant_id", "owner_id");

-- CreateIndex
CREATE INDEX "medical_records_tenant_id_pet_id_visit_at_idx" ON "medical_records"("tenant_id", "pet_id", "visit_at" DESC);

-- CreateIndex
CREATE INDEX "vaccine_catalog_species_is_active_idx" ON "vaccine_catalog"("species", "is_active");

-- CreateIndex
CREATE INDEX "pet_vaccinations_tenant_id_next_due_at_idx" ON "pet_vaccinations"("tenant_id", "next_due_at");

-- CreateIndex
CREATE INDEX "pet_vaccinations_pet_id_vaccine_id_applied_at_idx" ON "pet_vaccinations"("pet_id", "vaccine_id", "applied_at" DESC);

-- CreateIndex
CREATE INDEX "reminders_tenant_id_due_date_idx" ON "reminders"("tenant_id", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "reminders_pet_vaccination_id_offset_days_channel_key" ON "reminders"("pet_vaccination_id", "offset_days", "channel");

-- CreateIndex
CREATE INDEX "pharmacist_staff_tenant_id_branch_id_idx" ON "pharmacist_staff"("tenant_id", "branch_id");

-- CreateIndex
CREATE INDEX "prescriptions_tenant_id_issued_at_idx" ON "prescriptions"("tenant_id", "issued_at");

-- CreateIndex
CREATE INDEX "controlled_substance_log_tenant_id_branch_id_product_id_id_idx" ON "controlled_substance_log"("tenant_id", "branch_id", "product_id", "id");

-- CreateIndex
CREATE INDEX "ai_ingestion_jobs_tenant_id_status_idx" ON "ai_ingestion_jobs"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ai_ingestion_jobs_tenant_id_file_sha256_key" ON "ai_ingestion_jobs"("tenant_id", "file_sha256");

-- CreateIndex
CREATE UNIQUE INDEX "ai_ingestion_items_job_id_line_no_key" ON "ai_ingestion_items"("job_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "alert_rules_tenant_id_kind_key" ON "alert_rules"("tenant_id", "kind");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_user_id_read_at_idx" ON "notifications"("tenant_id", "user_id", "read_at");

-- CreateIndex
CREATE INDEX "notifications_status_created_at_idx" ON "notifications"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_tenant_id_dedupe_key_key" ON "notifications"("tenant_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_modules" ADD CONSTRAINT "tenant_modules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_platform_admin_id_fkey" FOREIGN KEY ("platform_admin_id") REFERENCES "platform_admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_exports" ADD CONSTRAINT "tenant_exports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_secrets" ADD CONSTRAINT "tenant_secrets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_users" ADD CONSTRAINT "tenant_users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_users" ADD CONSTRAINT "tenant_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_users" ADD CONSTRAINT "tenant_users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "product_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_batches" ADD CONSTRAINT "product_batches_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_series" ADD CONSTRAINT "document_series_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_items" ADD CONSTRAINT "document_items_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_item_lots" ADD CONSTRAINT "document_item_lots_document_item_id_fkey" FOREIGN KEY ("document_item_id") REFERENCES "document_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_payments" ADD CONSTRAINT "document_payments_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sunat_submissions" ADD CONSTRAINT "sunat_submissions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pets" ADD CONSTRAINT "pets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet_vaccinations" ADD CONSTRAINT "pet_vaccinations_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet_vaccinations" ADD CONSTRAINT "pet_vaccinations_vaccine_id_fkey" FOREIGN KEY ("vaccine_id") REFERENCES "vaccine_catalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_ingestion_items" ADD CONSTRAINT "ai_ingestion_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "ai_ingestion_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

