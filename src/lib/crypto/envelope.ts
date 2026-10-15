import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Envelope encryption para secretos de tenant (Clave SOL, .pfx y su contraseña).
 *   plaintext --AES-256-GCM(DEK)--> ciphertext
 *   DEK       --KEK (KMS)--------> wrapped_dek
 * La KEK nunca toca la BD. En producción `KeyEncryptionKeyProvider` se implementa
 * con AWS KMS / GCP KMS (Encrypt/Decrypt de 32 bytes); localmente, con una KEK en env.
 * AAD = tenant_id + kind: un ciphertext copiado a otro tenant no descifra.
 */
export interface KeyEncryptionKeyProvider {
  readonly kekId: string;
  wrap(dek: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer, kekId: string): Promise<Buffer>;
}

export class LocalKekProvider implements KeyEncryptionKeyProvider {
  readonly kekId: string;
  private readonly kek: Buffer;

  constructor(kekBase64: string, kekId: string) {
    this.kek = Buffer.from(kekBase64, "base64");
    if (this.kek.length !== 32) throw new Error("KEK inválida");
    this.kekId = kekId;
  }

  async wrap(dek: Buffer): Promise<Buffer> {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.kek, iv);
    const ct = Buffer.concat([c.update(dek), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }

  async unwrap(wrapped: Buffer, kekId: string): Promise<Buffer> {
    if (kekId !== this.kekId) throw new Error(`KEK ${kekId} no disponible (rotación pendiente)`);
    const iv = wrapped.subarray(0, 12);
    const tag = wrapped.subarray(12, 28);
    const ct = wrapped.subarray(28);
    const d = createDecipheriv("aes-256-gcm", this.kek, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  }
}

let provider: KeyEncryptionKeyProvider | undefined;
export function kekProvider(): KeyEncryptionKeyProvider {
  provider ??= new LocalKekProvider(env().SECRETS_KEK_BASE64, env().SECRETS_KEK_ID);
  return provider;
}

export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  wrappedDek: Buffer;
  kekId: string;
}

export async function seal(
  plaintext: Buffer,
  aad: string,
  kp: KeyEncryptionKeyProvider = kekProvider(),
): Promise<SealedSecret> {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", dek, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
  const sealed: SealedSecret = {
    ciphertext,
    iv,
    authTag: c.getAuthTag(),
    wrappedDek: await kp.wrap(dek),
    kekId: kp.kekId,
  };
  dek.fill(0);
  return sealed;
}

export async function open(
  s: SealedSecret,
  aad: string,
  kp: KeyEncryptionKeyProvider = kekProvider(),
): Promise<Buffer> {
  const dek = await kp.unwrap(s.wrappedDek, s.kekId);
  try {
    const d = createDecipheriv("aes-256-gcm", dek, s.iv);
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(s.authTag);
    return Buffer.concat([d.update(s.ciphertext), d.final()]);
  } finally {
    dek.fill(0);
  }
}

export const secretAad = (tenantId: string, kind: string): string => `tenant:${tenantId}|kind:${kind}`;
