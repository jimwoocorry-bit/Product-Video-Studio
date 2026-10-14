import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SecretStore } from "../../application/ports/secret-store.js";
import { WindowsDpapiSecretStore } from "./windows-dpapi-secret-store.js";

/** Linux/NAS secrets stay local and encrypted; Windows keeps its existing DPAPI format. */
export class LocalAesSecretStore implements SecretStore {
  constructor(private readonly root: string) {}
  private file(key: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error("Invalid secret key");
    return path.join(this.root, key + ".json");
  }
  private async masterKey(create = false): Promise<Buffer> {
    const filename = path.join(this.root, ".master-key");
    if (create) {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      try { await fs.writeFile(filename, randomBytes(32), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const key = await fs.readFile(filename);
    if (key.length !== 32) throw new Error("Invalid local secret master key");
    return key;
  }
  async has(key: string): Promise<boolean> {
    try { await fs.access(this.file(key)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async get(key: string): Promise<string | null> {
    let raw: string;
    try { raw = await fs.readFile(this.file(key), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const record = JSON.parse(raw) as { version: number; scheme: string; iv: string; tag: string; ciphertext: string };
    if (record.version !== 1 || record.scheme !== "aes-256-gcm-local") throw new Error("Unsupported local secret format");
    const decipher = createDecipheriv("aes-256-gcm", await this.masterKey(), Buffer.from(record.iv, "base64"));
    decipher.setAAD(Buffer.from(key));
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }
  async set(key: string, value: string): Promise<void> {
    const filename = this.file(key);
    if (!value.trim()) throw new Error("Secret value cannot be empty");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", await this.masterKey(true), iv);
    cipher.setAAD(Buffer.from(key));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const record = { version: 1, scheme: "aes-256-gcm-local", iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
    const temp = filename + ".tmp-" + randomBytes(8).toString("hex");
    try {
      await fs.writeFile(temp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      await fs.rename(temp, filename);
    } finally { await fs.rm(temp, { force: true }); }
  }
  async delete(key: string): Promise<void> { await fs.rm(this.file(key), { force: true }); }
}

export function createPlatformSecretStore(): SecretStore {
  const root = path.resolve(process.env.PVS_SECRETS_ROOT ?? ".runtime-secrets/ai-providers");
  return process.platform === "win32" ? new WindowsDpapiSecretStore(root) : new LocalAesSecretStore(root);
}
