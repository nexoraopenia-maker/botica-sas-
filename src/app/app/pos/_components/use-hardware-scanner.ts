"use client";

import { useEffect, useRef } from "react";

/**
 * Lector físico (USB/Bluetooth en modo teclado): "teclea" el código muy rápido y termina con Enter.
 * Se detecta por la velocidad entre teclas, aunque el foco no esté en el buscador.
 * Si el foco está en un campo de texto, ese campo maneja el Enter (no se duplica).
 */
export function useHardwareScanner(onScan: (code: string) => void, enabled = true): void {
  const buffer = useRef("");
  const last = useRef(0);
  const cb = useRef(onScan);
  cb.current = onScan;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const now = performance.now();
      if (now - last.current > 60) buffer.current = ""; // pausa larga: es una persona tecleando
      last.current = now;
      if (e.key === "Enter") {
        if (buffer.current.length >= 4) {
          e.preventDefault();
          cb.current(buffer.current);
        }
        buffer.current = "";
        return;
      }
      if (e.key.length === 1) buffer.current += e.key;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
