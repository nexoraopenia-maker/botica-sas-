# Nexo ERP

ERP + facturación electrónica SUNAT, SaaS multi-tenant para **agroveterinarias, veterinarias, boticas/farmacias** y comercios afines. Núcleo común (inventario por lotes con FEFO, POS, comprobantes UBL 2.1, compras, alertas) y módulos activables por cliente (Veterinaria, Agro, Farmacia, IA de inventario, WhatsApp).

- Arquitectura, multi-tenancy, seguridad y colas: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Normativa SUNAT / DIGEMID / SENASA y puntos a validar: [docs/COMPLIANCE.md](docs/COMPLIANCE.md)

**Stack:** Next.js 16 (App Router, Server Actions, `proxy.ts`), TypeScript estricto, PostgreSQL + Prisma 7 (driver adapter `pg`), Supabase (Auth + MFA, Storage, RLS, pg_cron, pg_net, Vault), Claude API (`claude-opus-5-5`).

## Estructura

```
prisma/
  schema.prisma                  modelo de datos (≈45 tablas)
  migrations/
    …_init                       tablas, enums, índices (generado por Prisma)
    …_security_integrity         roles, RLS, CHECKs, FKs por tenant, inmutabilidad, auditoría con hash
    …_domain_functions           FEFO, correlativos, recepción de lotes, outbox, alertas, recordatorios, purga
    …_cron_jobs                  pg_cron
  seed.sql                       planes y catálogo global de vacunas
src/
  proxy.ts                       sesión + chequeo optimista (MFA para /superadmin)
  lib/
    db.ts                        runtimeDb (RLS) / platformDb, withTenant()
    auth/                        sesión, guards, permisos por rol
    modules/registry.ts          módulos, menú, rutas por módulo
    crypto/envelope.ts           cifrado de Clave SOL y certificado (AES-GCM + KEK/KMS)
    sunat/                       totales, validaciones, UBL, firma, SOAP, CDR, NC, emisión
    inventory/pos.ts             venta atómica
    pharmacy/                    fraccionamiento, reglas de receta, búsqueda DCI/genéricos
    vet/                         esquemas de vacunación, aplicación, vacunas por vencer
    ai/ingestion/                prompt, esquema, extracción, matching, revisión y commit
    notifications/               WhatsApp (Meta/Twilio), email, plantillas
    platform/                    alta/suspensión/baja de tenants, secretos, onboarding, impersonación, dashboard
  workers/outbox.ts              procesador del outbox (handlers idempotentes)
  app/                           Server Actions, páginas y route handlers
tests/
  unit/                          lógica pura + firma/verificación con certificado generado
  integration/pos.test.ts        POS contra PostgreSQL real (concurrencia, idempotencia, RLS)
  sql/integration.sql            RLS, FEFO, inmutabilidad, controlados, alertas, recordatorios
```

## Puesta en marcha

1. **Variables de entorno:** `cp .env.example .env.local` y complete los valores (nunca los suba al repositorio).
2. **Dependencias:** `pnpm install`
3. **Migraciones** (con `DIRECT_URL` del rol propietario): `pnpm db:migrate`, luego `pnpm db:seed`.
4. **Rol de runtime** (una vez, fuera de las migraciones; use una contraseña generada):
   ```sql
   ALTER ROLE app_runtime WITH LOGIN PASSWORD '<generada>';
   ```
5. **Primer superadmin:** cree el usuario en Supabase Auth, enrólelo en MFA (TOTP) y registre su id:
   ```sql
   INSERT INTO platform_admins (id, email, full_name, role, updated_at)
   VALUES ('<auth.users.id>', 'admin@su-dominio.pe', 'Nombre', 'OWNER', now());
   ```
6. **Worker:** en Supabase Vault cree `outbox_dispatch_url` (`https://<app>/api/internal/outbox`) e `internal_cron_secret` (= `INTERNAL_CRON_SECRET`). pg_cron lo invocará cada minuto. Alternativa: `pnpm worker` como proceso dedicado.
7. **WhatsApp:** registre en Meta las plantillas `recordatorio_vacuna` y `vacuna_hoy` (variables en `src/lib/notifications/templates.ts`) y apunte el webhook a `/api/webhooks/whatsapp`.
8. `pnpm dev`

## Pruebas

```bash
pnpm typecheck
pnpm test                      # unitarias (las de integración se omiten sin BD)

# Integración contra una BD desechable con las migraciones aplicadas:
export TEST_DATABASE_URL=postgresql://app_runtime:...@localhost:5432/erp_test
export TEST_PLATFORM_DATABASE_URL=postgresql://postgres:...@localhost:5432/erp_test
pnpm test:db
```

## Onboarding de un cliente (Superadmin)

1. `validateRucAction` → dígito verificador (+ padrón si `RUC_LOOKUP_URL` está configurado).
2. `createTenantAction` → tenant en `TRIAL`/`BETA`, sucursal 0000, series F001/B001/FC01/BC01/FD01/BD01, roles, módulos por rubro, suscripción de prueba, alertas por defecto e invitación al administrador.
3. `uploadCertificateAction` + `setSolCredentialsAction` (requieren reautenticación).
4. `runBetaTestAction` → firma con el certificado real y envía una boleta de prueba a SUNAT beta.
5. `updateTenantAction({ sunatEnv: "PRODUCTION" })` → bloqueado hasta aprobar beta y tener certificado vigente.
