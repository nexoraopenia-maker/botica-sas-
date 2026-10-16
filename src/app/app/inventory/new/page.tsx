import Link from "next/link";
import { requireTenant } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { withTenant } from "@/lib/db";
import { PageHeader } from "../../_components/ui";
import { ProductForm } from "./product-form";

export const metadata = { title: "Nuevo producto" };

export default async function NewProductPage() {
  const ctx = await requireTenant({ permission: "products.manage" });
  const { categories, branches } = await withTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => ({
    categories: await tx.productCategory.findMany({ where: { deleted_at: null }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    branches: await tx.branch.findMany({
      where: { is_active: true, deleted_at: null, ...(ctx.branchIds.length ? { id: { in: ctx.branchIds } } : {}) },
      orderBy: { sunat_code: "asc" }, select: { id: true, name: true },
    }),
  }));
  return (
    <>
      <PageHeader title="Nuevo producto" subtitle="Escanee el código de barras con la cámara o un lector, o escríbalo"
        actions={<Link href="/app/inventory" className="app-btn">← Productos</Link>} />
      <ProductForm
        categories={categories}
        branches={branches}
        canAdjustStock={hasPermission(ctx.permissions, "inventory.adjust")}
        pharmacy={ctx.modules.has("PHARMACY")}
        agro={ctx.modules.has("AGRO") || ctx.modules.has("VETERINARY")}
      />
    </>
  );
}
