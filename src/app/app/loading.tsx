/**
 * Esqueleto instantáneo al navegar entre secciones del panel: Next lo precarga junto con
 * los enlaces visibles, así el clic responde de inmediato mientras llegan los datos.
 */
export default function Loading() {
  return (
    <div className="app-skeleton" aria-busy="true" aria-live="polite">
      <span className="sr-only">Cargando…</span>
      <div className="sk sk-title" />
      <div className="sk sk-sub" />
      <div className="sk-grid">
        {Array.from({ length: 4 }, (_, i) => <div key={i} className="sk sk-card" />)}
      </div>
      <div className="sk sk-panel" />
    </div>
  );
}
