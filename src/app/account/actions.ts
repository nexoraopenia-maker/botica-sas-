"use server";

import { cookies } from "next/headers";
import type { z } from "zod";
import { IMPERSONATION_COOKIE } from "@/lib/auth/session";
import { changeOwnPassword, type changePasswordSchema } from "@/lib/auth/password";
import { DomainError, ok, toActionError, type ActionResult } from "@/lib/result";

export async function changePasswordAction(input: z.input<typeof changePasswordSchema>): Promise<ActionResult<null>> {
  try {
    // En modo soporte la sesión es la del superadmin: no se permite cambiar su contraseña desde el panel del cliente
    if ((await cookies()).get(IMPERSONATION_COOKIE)?.value) {
      throw new DomainError("SUPPORT_MODE", "No disponible durante una sesión de soporte.");
    }
    await changeOwnPassword(input);
    return ok(null);
  } catch (e) {
    return toActionError(e);
  }
}
