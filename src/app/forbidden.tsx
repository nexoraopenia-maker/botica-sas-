import Link from "next/link";

export const metadata = { title: "Acceso denegado" };

/** Respuesta de forbidden(): el rol del usuario no incluye esta sección. */
export default function Forbidden() {
  return (
    <section className="app-panel" style={{ margin: 24 }}>
      <div className="app-empty">
        <span className="app-empty-icon" aria-hidden>403</span>
        <h3>No tiene acceso a esta sección</h3>
        <p>Su rol no incluye este permiso. Si lo necesita, pídalo al administrador del negocio.</p>
        <Link href="/app" className="app-btn primary">Ir al inicio</Link>
      </div>
    </section>
  );
}
