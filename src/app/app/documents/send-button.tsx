"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendToSunatAction } from "./actions";

const LABEL: Record<string, string> = { ACEPTADO: "Aceptado", ACEPTADO_CON_OBS: "Aceptado con observaciones", RECHAZADO: "Rechazado", ERROR_REINTENTABLE: "Pendiente de reintento" };

/** Envío manual a SUNAT de un comprobante pendiente (respaldo del envío automático al cobrar). */
export function SendToSunatButton({ documentId }: { documentId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "green" | "amber" | "red"; text: string } | null>(null);
  return (
    <span className="doc-send">
      <button type="button" className="app-btn small" disabled={pending}
        onClick={() => start(async () => {
          setMsg(null);
          const res = await sendToSunatAction(documentId);
          if (!res.ok) setMsg({ tone: "red", text: res.error.message });
          else {
            const tone = res.data.status.startsWith("ACEPTADO") ? "green" : res.data.status === "RECHAZADO" ? "red" : "amber";
            setMsg({ tone, text: `${LABEL[res.data.status] ?? res.data.status}${res.data.description ? `: ${res.data.description}` : ""}` });
          }
          router.refresh();
        })}>
        {pending ? "Enviando…" : "Enviar a SUNAT"}
      </button>
      {msg && <span className={`app-pill ${msg.tone} doc-send-msg`} title={msg.text}>{msg.text}</span>}
    </span>
  );
}
