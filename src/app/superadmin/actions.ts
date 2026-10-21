"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { platformDb } from "@/lib/db";
import { requirePlatformAdmin, requireRecentAuth } from "@/lib/auth/session";
import { ok, toActionError, type ActionResult } from "@/lib/result";
import { audit } from "@/lib/audit";
import {
  type CreateTenantResult,
  createTenant, purgeTenant, reactivateTenant, requestTenantDeletion, setModules, suspendTenant, updateTenant,
} from "@/lib/platform/tenants";
import { storeCertificate, storeSolCredentials, type CertificateCheck } from "@/lib/platform/tenant-secrets";
import { startImpersonation, endImpersonation } from "@/lib/platform/impersonation";
import { runSunatBetaTest, validateRuc } from "@/lib/platform/onboarding";
import { certificateSchema, reasonSchema, solSchema, type CreateTenantInput } from "@/lib/platform/schemas";
import type { SunatOutcome } from "@/lib/sunat/errors";

/** Ventana de reautenticación para acciones críticas (segundos). */
const CRITICAL = 300;

/** Reautenticación: verificar de nuevo el TOTP renueva el timestamp del factor en el claim amr. */
export async function reauthAction(code: string): Promise<ActionResult<null>> {
  try {
    await requirePlatformAdmin();
    const parsed = z.string().regex(/^\d{6}$/, "Código de 6 dígitos").parse(code);
    const supabase = await supabaseServer();
    const { data: factors } = await supabase.auth.mfa.listFactors();
    const totp = factors?.totp.find((f) => f.status === "verified");
    if (!totp) return { ok: false, error: { code: "NO_FACTOR", message: "No tiene un factor TOTP verificado." } };
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: totp.id, code: parsed });
    if (error) return { ok: false, error: { code: "INVALID_CODE", message: "Código incorrecto o expirado." } };
    return ok(null);
  } catch (e) {
    return toActionError(e);
  }
}

export async function validateRucAction(ruc: string): Promise<ActionResult<Awaited<ReturnType<typeof validateRuc>>>> {
  try {
    await requirePlatformAdmin();
    return ok(await validateRuc(ruc));
  } catch (e) {
    return toActionError(e);
  }
}

export async function createTenantAction(input: CreateTenantInput): Promise<ActionResult<CreateTenantResult>> {
  try {
    const admin = await requirePlatformAdmin(["OWNER", "SUPPORT"]);
    const res = await createTenant(admin, input);
    revalidatePath("/superadmin", "layout");
    return ok(res);
  } catch (e) {
    return toActionError(e);
  }
}

export async function updateTenantAction(input: Parameters<typeof updateTenant>[1]): Promise<ActionResult<null>> {
  try {
    const admin = await requirePlatformAdmin(["OWNER", "SUPPORT"]);
    if (input.sunatEnv || input.ruc) await requireRecentAuth(CRITICAL);
    await updateTenant(admin, input);
    revalidatePath("/superadmin", "layout");
    return ok(null);
  } catch (e) {
    return toActionError(e);
  }
}

export async function setModulesAction(input: Parameters<typeof setModules>[1]): Promise<ActionResult<string[]>> {
  try {
    const admin = await requirePlatformAdmin(["OWNER", "SUPPORT"]);
    const modules = await setModules(admin, input);
    revalidatePath("/superadmin", "layout");
    return ok(modules);
  } catch (e) {
    return toActionError(e);
  }
}

export async function suspendTenantAction(input: Parameters<typeof suspendTenant>[1]): Promise<ActionResult<null>> {
  try {
    const admin = await requirePlatformAdmin(["OWNER", "BILLING"]);
    await requireRecentAuth(CRITICAL);
    await suspendTenant(admin, input);
    revalidatePath("/superadmin", "layout");
    return ok(null);
  } catch (e) {
    return toActionError(e);
  }
}

export async function reactivateTenantAction(tenantId: string, reason: string): Promise<ActionResult<null>> {
  try {
    const admin = await requirePlatformAdmin(["OWNER", "BILLING"]);
    await requireRecentAuth(CRITICAL);
    await reactivateTenant(admin, tenantId, reasonSchema.parse(reason));
    revalidatePath("/superadmin", "layout");
    return ok(null);
  } catch (e) {
    return toActionError(e);
  }
}

export async function requestDeletionAction(input: Parameters<typeof requestTenantDeletion>[1]): Promise<ActionResult<{ purgeAfter: Date }>> {
  try {
    const admin = await requirePlatformAdmin(["OWNER"]);
    await requireRecentAuth(CRITICAL);
    return ok(await requestTenantDeletion(admin, input));
  } catch (e) {
    return toActionError(e);
  }
}

export async function purgeTenantAction(input: Parameters<typeof purgeTenant>[1]): Promise<ActionResult<null>> {
  try {
    const admin = await requirePlatformAdmin(["OWNER"]);
    await requireRecentAuth(120);
    await purgeTenant(admin, input);
    return ok(null);
  } catch (e) {
    return toActionError(e);
  }
}

export async function setSolCredentialsAction(input: { tenantId: string; solUser: string; solPassword: string }): Promise<ActionResult<null>> {
  try {
    const admin = await requirePlatformAdmin(["OWNER", "SUPPORT"]);
    await requireRecentAuth(CRITICAL);
    const i = solSchema.parse(input);
    await platformDb().$transaction(async (tx) => {
      await storeSolCredentials(tx, i.tenantId, { user: i.solUser, password: i.solPassword }, admin.userId);
      await audit(tx, {
        tenantId: i.tenantId, actorUserId: admin.userId, actorKind: "platform_admin", action: "tenant.sol_credentials",
        entityType: "tenant", entityId: i.tenantId, after: { sol_user: i.solUser, sol_password: "[REDACTED]" },
      });
    });
    return ok(null);
  } catch (e) {
    return toActionError(e);
  }
}

export async function uploadCertificateAction(form: FormData): Promise<ActionResult<CertificateCheck>> {
  try {
    const admin = await requirePlatformAdmin(["OWNER", "SUPPORT"]);
    await requireRecentAuth(CRITICAL);
    const i = certificateSchema.parse({ tenantId: form.get("tenantId"), pfx: form.get("pfx"), password: form.get("password") });
    const pfx = Buffer.from(await i.pfx.arrayBuffer());
    const check = await platformDb().$transaction(async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: i.tenantId } });
      const res = await storeCertificate(tx, tenant.id, tenant.ruc, pfx, i.password, admin.userId);
      await audit(tx, {
        tenantId: tenant.id, actorUserId: admin.userId, actorKind: "platform_admin", action: "tenant.certificate",
        entityType: "tenant", entityId: tenant.id, after: { subject: res.subject, notAfter: res.notAfter.toISOString(), fingerprint: res.fingerprint },
      });
      return res;
    });
    pfx.fill(0);
    return ok(check);
  } catch (e) {
    return toActionError(e);
  }
}

export async function runBetaTestAction(tenantId: string): Promise<ActionResult<SunatOutcome>> {
  try {
    await requirePlatformAdmin(["OWNER", "SUPPORT"]);
    return ok(await runSunatBetaTest(tenantId));
  } catch (e) {
    return toActionError(e);
  }
}

export async function startImpersonationAction(input: Parameters<typeof startImpersonation>[1]): Promise<ActionResult<{ id: string; expiresAt: Date }>> {
  try {
    const admin = await requirePlatformAdmin(["OWNER", "SUPPORT"]);
    await requireRecentAuth(CRITICAL);
    return ok(await startImpersonation(admin, input));
  } catch (e) {
    return toActionError(e);
  }
}

export async function endImpersonationAction(): Promise<ActionResult<null>> {
  try {
    const admin = await requirePlatformAdmin();
    await endImpersonation(admin);
    return ok(null);
  } catch (e) {
    return toActionError(e);
  }
}

/** Salir del modo soporte desde el banner de /app: cierra la sesión de impersonación y vuelve al panel. */
export async function exitSupportAction(): Promise<void> {
  const admin = await requirePlatformAdmin();
  await endImpersonation(admin);
  redirect("/superadmin");
}
