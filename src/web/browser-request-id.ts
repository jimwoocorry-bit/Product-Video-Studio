type BrowserCrypto = {
  randomUUID?: () => string;
  getRandomValues: (bytes: Uint8Array) => Uint8Array;
};

/** LAN HTTP exposes getRandomValues but may omit the secure-context-only randomUUID. */
export function createBrowserRequestId(cryptoApi: BrowserCrypto): string {
  if (typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const browserRequestIdScript = createBrowserRequestId.toString();
