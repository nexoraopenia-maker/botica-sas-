/**
 * Íconos de la PWA a partir de public/brand/aima-logo.png sobre el fondo corporativo oscuro.
 *   node scripts/generate-icons.mjs
 * "maskable" deja el logo dentro de la zona segura (80 % central) para íconos adaptativos de Android.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sharp = require(require.resolve("sharp", { paths: [require.resolve("next/package.json")] }));

const BG = { r: 11, g: 18, b: 32, alpha: 1 }; // #0b1220
const LOGO = "public/brand/aima-logo.png";

async function icon(size, logoRatio, out) {
  const logoWidth = Math.round(size * logoRatio);
  const logo = await sharp(LOGO).resize({ width: logoWidth }).toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: logo, gravity: "center" }])
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log("✓", out);
}

await icon(192, 0.8, "public/icons/icon-192.png");
await icon(512, 0.8, "public/icons/icon-512.png");
await icon(512, 0.6, "public/icons/icon-maskable-512.png");
await icon(180, 0.8, "public/icons/apple-touch-icon.png");
await icon(32, 0.9, "public/icons/favicon-32.png");
