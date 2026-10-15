import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";

export type Bucket = "tenant-files" | "sunat" | "ai-ingestion";

/** Todas las rutas comienzan con el tenant_id (las políticas de Storage dependen de eso). */
export const tenantPath = (tenantId: string, ...parts: string[]): string =>
  [tenantId, ...parts.map((p) => p.replace(/[^\w.\-/]/g, "_"))].join("/");

export async function putObject(bucket: Bucket, path: string, body: Buffer | string, contentType: string): Promise<void> {
  const { error } = await supabaseAdmin().storage.from(bucket).upload(path, body, { contentType, upsert: true });
  if (error) throw new Error(`Storage upload ${bucket}/${path}: ${error.message}`);
}

export async function getObject(bucket: Bucket, path: string): Promise<Buffer> {
  const { data, error } = await supabaseAdmin().storage.from(bucket).download(path);
  if (error || !data) throw new Error(`Storage download ${bucket}/${path}: ${error?.message ?? "vacío"}`);
  return Buffer.from(await data.arrayBuffer());
}

export async function signedUrl(bucket: Bucket, path: string, expiresInSeconds = 300): Promise<string> {
  const { data, error } = await supabaseAdmin().storage.from(bucket).createSignedUrl(path, expiresInSeconds);
  if (error || !data) throw new Error(`Storage signed URL: ${error?.message}`);
  return data.signedUrl;
}
