import "server-only";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import { platformDb } from "@/lib/db";
import { env } from "@/lib/env";

const SPECIES: Record<string, string> = {
  CANINE: "Canino", FELINE: "Felino", BOVINE: "Bovino", OVINE: "Ovino", CAPRINE: "Caprino", PORCINE: "Porcino",
  EQUINE: "Equino", AVIAN: "Ave", CAVY: "Cuy", RABBIT: "Conejo", OTHER: "Otro",
};

/** Clave propia derivada de la KEK: firmar enlaces no reutiliza la clave que protege los secretos. */
function signingKey(): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(env().SECRETS_KEK_BASE64, "base64"), "", "cartilla-qr-v1", 32));
}
const sign = (petId: string) => createHmac("sha256", signingKey()).update(petId).digest("base64url").slice(0, 32);

/** Token del QR: id del paciente + firma. No se puede adivinar ni alterar para ver otra cartilla. */
export const cartillaToken = (petId: string): string => `${petId}.${sign(petId)}`;

export function verifyCartillaToken(token: string): string | null {
  const [petId, sig] = token.split(".");
  if (!petId || !sig || !/^[0-9a-f-]{36}$/i.test(petId)) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign(petId));
  return a.length === b.length && timingSafeEqual(a, b) ? petId : null;
}

export interface CartillaData {
  clinic: string;
  pet: { id: string; name: string; species: string; breed: string | null; sex: string; birthDate: string | null; microchip: string | null };
  vaccines: { name: string; dose: number; appliedAt: string; nextDueAt: string | null; lot: string | null }[];
}

/**
 * Datos de la cartilla, siempre filtrados por negocio. Solo datos sanitarios del paciente:
 * sin datos del propietario, porque el QR se muestra sin iniciar sesión.
 */
export async function loadCartilla(petId: string, tenantId?: string): Promise<CartillaData | null> {
  const db = platformDb();
  const pet = await db.pet.findFirst({
    where: { id: petId, deleted_at: null, ...(tenantId ? { tenant_id: tenantId } : {}) },
    include: { vaccinations: { where: { deleted_at: null }, include: { vaccine: { select: { name: true } } }, orderBy: { applied_at: "desc" } } },
  });
  if (!pet) return null;
  const tenant = await db.tenant.findFirst({ where: { id: pet.tenant_id, deleted_at: null }, select: { trade_name: true, legal_name: true } });
  if (!tenant) return null;
  const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
  return {
    clinic: tenant.trade_name ?? tenant.legal_name,
    pet: {
      id: pet.id, name: pet.name, species: SPECIES[pet.species] ?? pet.species, breed: pet.breed,
      sex: pet.sex === "MALE" ? "Macho" : pet.sex === "FEMALE" ? "Hembra" : "No indicado", birthDate: iso(pet.birth_date), microchip: pet.microchip,
    },
    vaccines: pet.vaccinations.map((v) => ({ name: v.vaccine.name, dose: v.dose_number, appliedAt: iso(v.applied_at)!, nextDueAt: iso(v.next_due_at), lot: v.lot_code })),
  };
}

const dmy = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "-");
/** Las fuentes estándar del PDF solo cubren WinAnsi: otros caracteres harían fallar la generación. */
const safe = (s: string) => s.replace(/[^\x20-\x7E -ÿ]/g, "?");

/** PDF A4 de la cartilla con el QR de verificación. */
export async function renderCartillaPdf(data: CartillaData, verifyUrl: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(safe(`Cartilla de vacunación - ${data.pet.name}`));
  pdf.setCreator(safe(data.clinic));
  const [regular, bold] = await Promise.all([pdf.embedFont(StandardFonts.Helvetica), pdf.embedFont(StandardFonts.HelveticaBold)]);
  const ink = rgb(0.06, 0.09, 0.16), muted = rgb(0.4, 0.45, 0.53), line = rgb(0.86, 0.88, 0.92), blue = rgb(0.12, 0.42, 1);
  let page = pdf.addPage([595.28, 841.89]);
  const M = 48;
  let y = 790;
  const text = (t: string, x: number, yy: number, size = 10, font = regular, color = ink) => page.drawText(safe(t), { x, y: yy, size, font, color });

  text(data.clinic, M, y, 11, bold, blue);
  y -= 26;
  text("Cartilla de vacunación", M, y, 22, bold);
  y -= 30;

  const qr = await pdf.embedPng(await QRCode.toBuffer(verifyUrl, { type: "png", margin: 1, width: 300, errorCorrectionLevel: "M" }));
  page.drawImage(qr, { x: 595.28 - M - 110, y: y - 88, width: 110, height: 110 });
  text("Escanee para verificar", 595.28 - M - 110, y - 100, 8, regular, muted);

  const facts: [string, string][] = [
    ["Paciente", data.pet.name], ["Especie", `${data.pet.species}${data.pet.breed ? ` · ${data.pet.breed}` : ""}`], ["Sexo", data.pet.sex],
    ["Nacimiento", dmy(data.pet.birthDate)], ["Microchip", data.pet.microchip ?? "-"],
  ];
  for (const [k, v] of facts) {
    text(k, M, y, 9, regular, muted);
    text(v.slice(0, 50), M + 80, y, 11, k === "Paciente" ? bold : regular);
    y -= 19;
  }
  y = Math.min(y, 610) - 14;

  const cols = [M, M + 200, M + 245, M + 325, M + 405];
  const header = () => {
    page.drawRectangle({ x: M - 6, y: y - 6, width: 595.28 - 2 * M + 12, height: 22, color: rgb(0.95, 0.96, 0.98) });
    ["Vacuna", "Dosis", "Aplicada", "Próxima", "Lote"].forEach((h, i) => text(h, cols[i]!, y, 9, bold));
    y -= 24;
  };
  header();
  if (data.vaccines.length === 0) { text("Sin vacunas registradas.", M, y, 10, regular, muted); y -= 20; }
  for (const v of data.vaccines) {
    if (y < 70) { page = pdf.addPage([595.28, 841.89]); y = 790; header(); }
    text(v.name.slice(0, 38), cols[0]!, y);
    text(String(v.dose), cols[1]!, y);
    text(dmy(v.appliedAt), cols[2]!, y);
    text(dmy(v.nextDueAt), cols[3]!, y);
    text((v.lot ?? "-").slice(0, 14), cols[4]!, y);
    page.drawLine({ start: { x: M - 6, y: y - 6 }, end: { x: 595.28 - M + 6, y: y - 6 }, thickness: 0.5, color: line });
    y -= 20;
  }
  text(`Emitida el ${dmy(new Date().toISOString().slice(0, 10))}. El código QR muestra la información vigente.`, M, 40, 8, regular, muted);
  return pdf.save();
}
