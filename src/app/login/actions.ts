"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { platformDb } from "@/lib/db";
import { supabaseServer } from "@/lib/supabase/server";

const loginSchema = z.object({ email: z.email(), password: z.string().min(8), next: z.string().default("/app") });
const mfaSchema = z.object({ code: z.string().regex(/^\d{6}$/), next: z.string().default("/app") });
const enrollSchema = mfaSchema.extend({ factorId: z.uuid() });

/** Solo rutas internas (evita open redirect). */
const safeNext = (n: string): string => (n.startsWith("/") && !n.startsWith("//") ? n : "/app");

export async function loginAction(form: FormData): Promise<void> {
  const parsed = loginSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) redirect("/login?error=invalid");
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.signInWithPassword({ email: parsed.data.email, password: parsed.data.password });
  if (error || !data.user) redirect("/login?error=credentials");

  // Administradores de plataforma: su destino por defecto es /superadmin (no pertenecen a ningún negocio)
  // y, si su MFA es obligatorio, deben verificar o enrolar un factor antes de continuar.
  const admin = await platformDb().platformAdmin.findFirst({ where: { id: data.user.id, deleted_at: null } });
  const requested = safeNext(parsed.data.next);
  const target = admin && !requested.startsWith("/superadmin") ? "/superadmin" : requested;
  const encoded = encodeURIComponent(target);

  const { data: factors } = await supabase.auth.mfa.listFactors();
  const hasVerifiedTotp = factors?.totp.some((f) => f.status === "verified") ?? false;
  if (admin?.mfa_required && !hasVerifiedTotp) redirect(`/login/mfa/enroll?next=${encoded}`);

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.nextLevel === "aal2" && aal.currentLevel !== "aal2") redirect(`/login/mfa?next=${encoded}`);
  redirect(target);
}

/** Verificación TOTP: también sirve como reautenticación (renueva el timestamp en amr). */
export async function verifyMfaAction(form: FormData): Promise<void> {
  const parsed = mfaSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) redirect("/login/mfa?error=invalid");
  const supabase = await supabaseServer();
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const totp = factors?.totp.find((f) => f.status === "verified");
  if (!totp) redirect(`/login/mfa/enroll?next=${encodeURIComponent(safeNext(parsed.data.next))}`);
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: totp.id, code: parsed.data.code });
  if (error) redirect(`/login/mfa?error=code&next=${encodeURIComponent(safeNext(parsed.data.next))}`);
  redirect(safeNext(parsed.data.next));
}

/** Confirma el enrolamiento TOTP: el primer código válido verifica el factor y eleva la sesión a aal2. */
export async function confirmEnrollmentAction(form: FormData): Promise<void> {
  const parsed = enrollSchema.safeParse(Object.fromEntries(form));
  const next = safeNext(String(form.get("next") ?? "/app"));
  if (!parsed.success) redirect(`/login/mfa/enroll?error=invalid&next=${encodeURIComponent(next)}`);
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: parsed.data.factorId, code: parsed.data.code });
  if (error) redirect(`/login/mfa/enroll?error=code&next=${encodeURIComponent(next)}`);
  redirect(next);
}
