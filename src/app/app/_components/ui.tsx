import type { ReactNode } from "react";
import Link from "next/link";
import { Icon, type IconName } from "./icons";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="app-page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="app-page-actions">{actions}</div>}
    </div>
  );
}

export function StatCard({ label, value, hint, icon, tone = "blue", href }: {
  label: string; value: string; hint?: string; icon: IconName; tone?: "blue" | "green" | "amber" | "red" | "violet"; href?: string;
}) {
  const body = (
    <>
      <span className={`app-stat-icon ${tone}`}><Icon name={icon} size={20} /></span>
      <div>
        <p className="app-stat-label">{label}</p>
        <p className="app-stat-value">{value}</p>
        {hint && <p className="app-stat-hint">{hint}</p>}
      </div>
    </>
  );
  return href ? <Link href={href} className="app-stat">{body}</Link> : <div className="app-stat">{body}</div>;
}

export function Panel({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="app-panel">
      {(title || action) && (
        <header className="app-panel-head">
          {title && <h2>{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ icon, title, text, action }: { icon: IconName; title: string; text: string; action?: ReactNode }) {
  return (
    <div className="app-empty">
      <span className="app-empty-icon"><Icon name={icon} size={26} /></span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}

/** Secciones cuya interfaz aún no está construida (la lógica de servidor sí existe). */
export function ComingSoon({ title, icon, description }: { title: string; icon: IconName; description: string }) {
  return (
    <>
      <PageHeader title={title} />
      <Panel>
        <EmptyState icon={icon} title="Módulo en preparación" text={description}
          action={<Link href="/app" className="app-btn">Volver al inicio</Link>} />
      </Panel>
    </>
  );
}

export const soles = (v: { toString(): string } | number | string): string =>
  `S/ ${Number(v.toString()).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
