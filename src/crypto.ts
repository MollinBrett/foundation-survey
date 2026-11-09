const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(message));
  return toHex(sig);
}

export async function sha256Hex(message: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(message)));
}

export function randomToken(bytes = 24): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Uniform 6-digit code. */
export function randomCode(): string {
  const max = 4_294_967_296 - (4_294_967_296 % 1_000_000);
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0]! >= max);
  return (buf[0]! % 1_000_000).toString().padStart(6, "0");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Signed, expiring value for cookies: base64url(json).hmac */
export async function signValue(secret: string, payload: object, ttlSeconds: number): Promise<string> {
  const body = base64url(enc.encode(JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })));
  return `${body}.${await hmacHex(secret, body)}`;
}

export async function verifyValue<T>(secret: string, value: string | undefined): Promise<T | null> {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!timingSafeEqual(sig, await hmacHex(secret, body))) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64urlDecode(body))) as T & { exp: number };
    if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The one place an account becomes a hash. Same input from OAuth or the code fallback. */
export function identityHash(pepper: string, provider: string, providerUserId: string): Promise<string> {
  return hmacHex(pepper, `id:${provider}:${providerUserId}`);
}

/** IPs are hashed with the current UTC day so the hash rotates daily. */
export function ipHash(pepper: string, ip: string): Promise<string> {
  return hmacHex(pepper, `ip:${new Date().toISOString().slice(0, 10)}:${ip}`);
}
