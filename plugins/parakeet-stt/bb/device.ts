// This browser's identity for per-device profiles. Browsers expose neither MAC nor a stable IP, so
// each browser keeps a random id in localStorage; clearing site data makes it a new device.
import type { DeviceKind } from "./schemas.ts";

export const DEVICE_ID_KEY = "parakeet-stt:deviceId";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readDeviceId(s: StorageLike, gen: () => string = () => crypto.randomUUID()): string {
  let id = s.getItem(DEVICE_ID_KEY);
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    id = gen();
    s.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/** iPadOS reports itself as a Mac; touch points tell them apart. */
export function deviceKind(ua: string, maxTouchPoints: number): DeviceKind {
  if (/iPhone|iPod/.test(ua) || (/Android/.test(ua) && /Mobile/.test(ua))) return "phone";
  if (/iPad|Tablet|Android/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return "tablet";
  return "desktop";
}

export function guessDeviceName(ua: string, kind: DeviceKind): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (kind === "tablet" && /Macintosh/.test(ua))) return "iPad";
  if (/Android/.test(ua)) return kind === "phone" ? "Android phone" : "Android tablet";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Linux/.test(ua)) return "Linux PC";
  return "Browser";
}

export interface ThisDevice { id: string; kind: DeviceKind; name: string }

let cached: ThisDevice | null = null;

export function thisDevice(): ThisDevice {
  if (!cached) {
    const kind = deviceKind(navigator.userAgent, navigator.maxTouchPoints ?? 0);
    cached = { id: readDeviceId(localStorage), kind, name: guessDeviceName(navigator.userAgent, kind) };
  }
  return cached;
}
