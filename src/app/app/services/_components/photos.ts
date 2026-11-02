const MAX_SIDE = 1600;

/** Comprime en el teléfono: una foto de cámara pesa varios MB y Vercel limita cada petición a 4,5 MB. */
export async function compressPhoto(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.8));
  if (!blob) throw new Error("No se pudo procesar la foto.");
  return new File([blob], `${file.name.replace(/\.\w+$/, "") || "foto"}.jpg`, { type: "image/jpeg" });
}
