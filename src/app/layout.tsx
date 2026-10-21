import type { Metadata, Viewport } from "next";
import { PwaRegister } from "./pwa-register";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "AIMA ERP",
  description: "ERP y facturación electrónica para agroveterinarias, veterinarias y boticas",
  applicationName: "AIMA ERP",
  // iOS: "Agregar a inicio" abre en pantalla completa con barra de estado oscura
  appleWebApp: { capable: true, title: "AIMA ERP", statusBarStyle: "black-translucent" },
  icons: {
    icon: [{ url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" }, { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#0b1220",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es-PE">
      <body>
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
