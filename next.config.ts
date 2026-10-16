import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["xml-crypto", "node-forge", "pg"],
  experimental: {
    serverActions: { bodySizeLimit: "15mb" },
    // Caché del router en el cliente: volver a una sección visitada hace <30 s es instantáneo
    // (las mutaciones llaman a router.refresh()/revalidatePath y la invalidan).
    staleTimes: { dynamic: 30 },
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        ],
      },
    ];
  },
};

export default nextConfig;
