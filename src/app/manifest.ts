import type { MetadataRoute } from "next";

/** Manifiesto PWA (Next lo publica en /manifest.webmanifest). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/app",
    name: "AIMA ERP",
    short_name: "AIMA ERP",
    description: "Ventas, inventario y facturación electrónica para boticas, veterinarias y agroveterinarias.",
    lang: "es-PE",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0b1220",
    theme_color: "#0b1220",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Punto de venta", short_name: "Vender", url: "/app/pos", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Productos y stock", short_name: "Stock", url: "/app/inventory", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
