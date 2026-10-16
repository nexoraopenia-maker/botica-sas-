"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireTenant } from "@/lib/auth/session";
import type { Permission } from "@/lib/auth/permissions";
import { addMember, updateMember, type AddMemberResult, type addMemberSchema, type updateMemberSchema } from "@/lib/settings/users";
import { ok, toActionError, type ActionResult } from "@/lib/result";
import {
  createBranch, createSeries, saveAlertRule, toggleSeries, updateBranch,
  type createBranchSchema, type createSeriesSchema, type saveAlertRuleSchema, type toggleSeriesSchema, type updateBranchSchema,
} from "@/lib/settings/service";

async function run<T>(
  fn: (ctx: Awaited<ReturnType<typeof requireTenant>>) => Promise<T>,
  permission: Permission = "settings.manage",
): Promise<ActionResult<T>> {
  try {
    const ctx = await requireTenant({ permission, mutation: true });
    const data = await fn(ctx);
    revalidatePath("/app", "layout");
    return ok(data);
  } catch (e) {
    return toActionError(e);
  }
}

const db = (ctx: { tenantId: string; userId: string }) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

export async function createBranchAction(i: z.input<typeof createBranchSchema>) {
  return run((ctx) => createBranch(db(ctx), i));
}
export async function updateBranchAction(i: z.input<typeof updateBranchSchema>) {
  return run((ctx) => updateBranch(db(ctx), i));
}
export async function createSeriesAction(i: z.input<typeof createSeriesSchema>) {
  return run((ctx) => createSeries(db(ctx), i));
}
export async function toggleSeriesAction(i: z.input<typeof toggleSeriesSchema>) {
  return run((ctx) => toggleSeries(db(ctx), i));
}
export async function saveAlertRuleAction(i: z.input<typeof saveAlertRuleSchema>) {
  return run((ctx) => saveAlertRule({ ...db(ctx), modules: ctx.modules }, i));
}
export async function addMemberAction(i: z.input<typeof addMemberSchema>): Promise<ActionResult<AddMemberResult>> {
  return run((ctx) => addMember(db(ctx), i), "users.manage");
}
export async function updateMemberAction(i: z.input<typeof updateMemberSchema>) {
  return run((ctx) => updateMember(db(ctx), i), "users.manage");
}
