"use client";

import { useEffect, useRef, useState } from "react";

interface DetectedBarcode { rawValue: string }
interface NativeBarcodeDetector { detect(source: CanvasImageSource): Promise<DetectedBarcode[]> }
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): NativeBarcodeDetector;
  getSupportedFormats?: () => Promise<string[]>;
}

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "qr_code"];
const REPEAT_MS = 1500;

/**
 * Escáner por cámara. Usa BarcodeDetector nativo (Chrome/Android, Edge) y, si no existe
 * (Safari iOS, Firefox), carga @zxing/browser bajo demanda. Escaneo continuo: cada código
 * se reporta una vez (se ignora el mismo código por 1,5 s) para poder escanear varios productos.
 */
export function CameraScanner({ onDetected, onClose }: { onDetected: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<"starting" | "scanning" | "error">("starting");
  const [error, setError] = useState<string | null>(null);
  const [lastCode, setLastCode] = useState<string | null>(null);
  const cb = useRef(onDetected);
  cb.current = onDetected;

  useEffect(() => {
    let cancelled = false;
    let stopFn: (() => void) | null = null;
    const seen = new Map<string, number>();

    const report = (raw: string) => {
      const code = raw.trim();
      const now = Date.now();
      if (!code || (seen.get(code) ?? 0) > now - REPEAT_MS) return;
      seen.set(code, now);
      setLastCode(code);
      navigator.vibrate?.(60);
      beep();
      cb.current(code);
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Este navegador no permite usar la cámara. Use HTTPS y un navegador actualizado.");
      }
      const Native = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
      const supported = Native?.getSupportedFormats ? await Native.getSupportedFormats().catch(() => []) : [];

      if (Native && supported.length) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        const el = video.current!;
        el.srcObject = stream;
        await el.play();
        const detector = new Native({ formats: FORMATS.filter((f) => supported.includes(f)) });
        let raf = 0;
        let busy = false;
        const loop = async () => {
          if (cancelled) return;
          if (!busy && el.readyState >= 2) {
            busy = true;
            try {
              for (const b of await detector.detect(el)) report(b.rawValue);
            } catch { /* cuadro no decodificable */ }
            busy = false;
          }
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        stopFn = () => { cancelAnimationFrame(raf); stream.getTracks().forEach((t) => t.stop()); };
      } else {
        // Respaldo: ZXing en JavaScript (se descarga solo cuando hace falta)
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const reader = new BrowserMultiFormatReader();
        const controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: "environment" } }, audio: false },
          video.current!,
          (result) => { if (result) report(result.getText()); },
        );
        if (cancelled) return controls.stop();
        stopFn = () => controls.stop();
      }
      if (!cancelled) setStatus("scanning");
    })().catch((err: unknown) => {
      if (cancelled) return;
      const name = err instanceof DOMException ? err.name : "";
      setError(
        name === "NotAllowedError" ? "Permiso de cámara denegado. Habilítelo en la configuración del navegador."
        : name === "NotFoundError" ? "No se encontró una cámara en este dispositivo."
        : err instanceof Error ? err.message : "No se pudo iniciar la cámara.",
      );
      setStatus("error");
    });

    return () => { cancelled = true; stopFn?.(); };
  }, []);

  return (
    <div className="pos-overlay" role="dialog" aria-modal="true" aria-label="Escanear código con la cámara">
      <div className="pos-scanner">
        <div className="pos-scanner-head">
          <strong>Escanear código</strong>
          <button type="button" className="app-btn" onClick={onClose}>Listo</button>
        </div>
        <div className="pos-scanner-view">
          <video ref={video} playsInline muted />
          {status === "scanning" && <div className="pos-scanner-frame" aria-hidden />}
          {status === "starting" && <p className="pos-scanner-msg">Iniciando cámara…</p>}
          {status === "error" && <p className="pos-scanner-msg error">{error}</p>}
        </div>
        <p className="pos-scanner-foot">
          {lastCode ? <>Último código: <strong>{lastCode}</strong></> : "Apunte al código de barras o QR del producto. Puede escanear varios seguidos."}
        </p>
      </div>
    </div>
  );
}

let audioCtx: AudioContext | null = null;
function beep(): void {
  try {
    audioCtx ??= new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 1400;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.08);
  } catch { /* sin audio */ }
}
