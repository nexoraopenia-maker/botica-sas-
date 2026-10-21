"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/app/app/_components/icons";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * "Instalar app" en el menú de perfil. Android/Chrome/Edge: usa el diálogo nativo (beforeinstallprompt).
 * iPhone/iPad (Safari no tiene ese evento): muestra cómo agregarla desde Compartir.
 */
export function InstallAppButton() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [ios, setIos] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    setInstalled(standalone);
    setIos(/iphone|ipad|ipod/i.test(navigator.userAgent));
    const onPrompt = (e: Event) => { e.preventDefault(); setPrompt(e as BeforeInstallPromptEvent); };
    const onInstalled = () => { setInstalled(true); setPrompt(null); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => { window.removeEventListener("beforeinstallprompt", onPrompt); window.removeEventListener("appinstalled", onInstalled); };
  }, []);

  if (installed || (!prompt && !ios)) return null;

  return (
    <>
      <button type="button" className="app-user-item neutral" onClick={async () => {
        if (prompt) { await prompt.prompt(); await prompt.userChoice; setPrompt(null); } else setHelp((v) => !v);
      }}>
        <Icon name="plus" size={16} /> Instalar app en este equipo
      </button>
      {help && (
        <p className="app-install-help">
          En iPhone/iPad: toque <strong>Compartir</strong> (cuadro con flecha) y luego <strong>Agregar a inicio</strong>.
        </p>
      )}
    </>
  );
}
