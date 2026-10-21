"use client";

import { useEffect } from "react";

/** Registra el service worker (solo en producción: en desarrollo interferiría con la recarga en caliente). */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => console.warn("[pwa] registro del SW falló", err));
  }, []);
  return null;
}
