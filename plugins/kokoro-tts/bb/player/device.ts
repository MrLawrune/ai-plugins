/**
 * Per-tab window id, kept in sessionStorage: localStorage is shared by every tab
 * of a browser profile, so an id stored there would make all tabs one client.
 */
export const CLIENT_ID_KEY = "kokoro-tts:tabClientId";
/** Device name, kept in localStorage: every tab of a browser is the same device. */
export const DEVICE_NAME_KEY = "kokoro-tts:deviceName";
/** Fired on window when this tab renames its device. */
export const DEVICE_NAME_EVENT = "kokoro-tts:device-name";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function guessDeviceName(ua: string): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Linux/.test(ua)) return "Linux PC";
  return "Browser";
}

/** Reads this tab's client id from `s` (pass sessionStorage), generating one when absent. */
export function readClientId(s: StorageLike, gen: () => string = () => crypto.randomUUID()): string {
  let id = s.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = gen();
    s.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

/**
 * Forces a fresh client id for this tab, overwriting whatever was stored. Used when
 * a duplicated tab (cloned sessionStorage, same id as an existing tab) gets its
 * socket superseded by the hub: it must shed the shared id rather than keep fighting
 * the original tab for it.
 */
export function regenerateClientId(s: StorageLike, gen: () => string = () => crypto.randomUUID()): string {
  const id = gen();
  s.setItem(CLIENT_ID_KEY, id);
  return id;
}

export function readDeviceName(s: StorageLike, ua: string): string {
  const stored = s.getItem(DEVICE_NAME_KEY)?.trim();
  return stored ? stored.slice(0, 64) : guessDeviceName(ua);
}

export function writeDeviceName(s: StorageLike, name: string): void {
  s.setItem(DEVICE_NAME_KEY, name.trim().slice(0, 64));
}
