import { requireTenant } from "@/lib/auth/session";

export default async function AppHome() {
  const ctx = await requireTenant();
  return (
    <>
      <h1>Inicio</h1>
      <p>Módulos activos: {[...ctx.modules].join(", ")}</p>
    </>
  );
}
