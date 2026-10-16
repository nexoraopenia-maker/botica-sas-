"use client";

import Link from "next/link";

/** Errores dentro del panel (p. ej. sin permiso para una sección): mensaje claro en lugar de la página genérica. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // En producción Next oculta el mensaje real del servidor; se muestra un texto general y el código para soporte.
  const forbidden = /permiso|módulo/i.test(error.message);
  return (
    <section className="app-panel">
      <div className="app-empty">
        <span className="app-empty-icon" aria-hidden>!</span>
        <h3>{forbidden ? "No tiene acceso a esta sección" : "No pudimos cargar esta sección"}</h3>
        <p>
          {forbidden
            ? "Su rol no incluye este permiso o el módulo no está activo. Pida al administrador del negocio que lo habilite."
            : "Puede ser algo momentáneo. Intente nuevamente; si persiste, contacte a soporte."}
          {error.digest && <><br /><small>Código: {error.digest}</small></>}
        </p>
        <div className="ai-drop-actions">
          <button type="button" className="app-btn" onClick={reset}>Reintentar</button>
          <Link href="/app" className="app-btn primary">Ir al inicio</Link>
        </div>
      </div>
    </section>
  );
}
