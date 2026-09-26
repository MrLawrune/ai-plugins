// TLS policy per connection: pinned fingerprint (TOFU), custom CA, or insecure opt-in.
import { isIP } from "node:net";
import * as tls from "node:tls";
import { Agent, buildConnector, type Dispatcher } from "undici";

export type TlsMode = { mode: "pinned"; fingerprint: string } | { mode: "ca"; caPem: string } | { mode: "insecure" };

export class TlsPinError extends Error {
  override name = "TlsPinError";
}

export const normalizeFingerprint = (fp: string): string =>
  fp.replace(/[^0-9a-f]/gi, "").toUpperCase().match(/.{2}/g)?.join(":") ?? "";

export function createDispatcher(mode: TlsMode): Dispatcher {
  if (mode.mode === "ca") return new Agent({ connect: { ca: mode.caPem } });
  if (mode.mode === "insecure") return new Agent({ connect: { rejectUnauthorized: false } });
  const want = normalizeFingerprint(mode.fingerprint);
  // No session cache: a resumed TLS session reports no peer certificate, which would defeat the pin.
  const base = buildConnector({ rejectUnauthorized: false, maxCachedSessions: 0 });
  return new Agent({
    // The handshake completes before the callback, so the pin is checked before any request bytes are written.
    connect(opts, cb) {
      base(opts, (err, socket) => {
        if (err || !socket) return cb(err ?? new Error("no socket"), null);
        const got = normalizeFingerprint((socket as tls.TLSSocket).getPeerCertificate().fingerprint256 ?? "");
        if (got !== want) {
          socket.destroy();
          return cb(new TlsPinError(`certificate fingerprint ${got} does not match the pinned ${want}`), null);
        }
        cb(null, socket);
      });
    },
  });
}

/** The port a request to this URL uses: explicit, else the scheme default (as fetch does). */
export function portOf(baseUrl: string): number {
  const u = new URL(baseUrl);
  return u.port ? Number(u.port) : u.protocol === "http:" ? 80 : 443;
}

export interface CertInfo { fingerprint256: string; subject: string; issuer: string; validTo: string }

export function probeCertificate(baseUrl: string, timeoutMs = 5000): Promise<CertInfo> {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const s = tls.connect(
      { host: u.hostname, port: portOf(baseUrl), servername: isIP(u.hostname) ? undefined : u.hostname, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        const c = s.getPeerCertificate();
        s.end();
        resolve({ fingerprint256: normalizeFingerprint(c.fingerprint256 ?? ""), subject: String(c.subject?.CN ?? ""), issuer: String(c.issuer?.CN ?? ""), validTo: c.valid_to ?? "" });
      },
    );
    s.on("timeout", () => { s.destroy(); reject(new Error(`timed out connecting to ${u.host}`)); });
    s.on("error", reject);
  });
}
