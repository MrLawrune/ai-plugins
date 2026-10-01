import { join } from "node:path";
import { isLoopback } from "../kokoro-client.ts";
import { DEFAULT_SETTINGS, engineRefSchema, type Settings } from "../schemas.ts";
import { coerceSettings } from "./settings.ts";

export interface MigrateDeps {
  /** Plugin setting, default http://127.0.0.1:6789. */
  serverUrl: string;
  /** `await kv.get("prefs")`; may contain `playback: "server"`. */
  rawPrefs: unknown;
  /** prefs.runtime */
  runtime: "cpu" | "gpu";
  /** GET {baseUrl}/config → body.config, null on failure. */
  fetchConfig: (baseUrl: string) => Promise<Record<string, unknown> | null>;
  readFile: (path: string) => string | null;
  env: NodeJS.ProcessEnv;
  home: string;
  /** PATCH {localUrl}/config {provider}; rejects on failure. */
  setLocalProvider: (provider: "cpu" | "cuda") => Promise<void>;
}
export interface MigrationResult {
  settings: Settings;
  note: string | null;
}

export const NOTE_SERVER_PLAYBACK = "Speech now always plays in a bb window; playing on the server's speakers was removed.";
export const NOTE_UNREADABLE = "Your previous Kokoro settings could not be read, so defaults are in use.";
export const NOTE_LOCAL_SWITCH_FAILED =
  "The local Kokoro server could not be switched to synthesize by itself; as a backup it may forward to the main server first.";
export const NOTE_BAD_ENGINE_URL =
  "Your previous remote Kokoro server address could not be used, so this computer's server is the main engine.";

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Python's resolution: KOKORO_CONFIG, else $XDG_CONFIG_HOME/kokoro-tts/config.json, else ~/.config/kokoro-tts/config.json */
export function oldConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  return env.KOKORO_CONFIG ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "kokoro-tts", "config.json");
}

function readOldFile(d: MigrateDeps): Record<string, unknown> | null {
  const text = d.readFile(oldConfigPath(d.env, d.home));
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A `{ url }` engine ref with trailing slashes trimmed, or null when the url would not pass the settings schema. */
function urlRef(url: string): Settings["engines"]["main"] | null {
  const parsed = engineRefSchema.safeParse({ url: url.replace(/\/+$/, "") });
  return parsed.success ? parsed.data : null;
}

/** Builds the first `settings` row from the Python server's config (live, else its file). Never throws. */
export async function migrate(d: MigrateDeps): Promise<MigrationResult> {
  try {
    let old = await d.fetchConfig(d.serverUrl);
    if (old === null && isLoopback(d.serverUrl)) old = readOldFile(d);

    const settings = coerceSettings(old ?? {});
    const notes: string[] = [];
    if (old === null) notes.push(NOTE_UNREADABLE);

    settings.engines = { main: "local", backup: null };
    if (!isLoopback(d.serverUrl)) {
      const main = urlRef(d.serverUrl);
      if (main) settings.engines = { main, backup: null };
      else notes.push(NOTE_BAD_ENGINE_URL);
    } else if (old?.provider === "remote" && typeof old.remote_url === "string") {
      const main = urlRef(old.remote_url);
      const backup = old.fallback_to_cpu === false ? null : "local";
      if (main) settings.engines = { main, backup };
      else notes.push(NOTE_BAD_ENGINE_URL);
      if (main && backup === "local") {
        try {
          await d.setLocalProvider(d.runtime === "gpu" ? "cuda" : "cpu");
        } catch {
          notes.push(NOTE_LOCAL_SWITCH_FAILED);
        }
      }
    }

    if (isRecord(d.rawPrefs) && d.rawPrefs.playback === "server") notes.push(NOTE_SERVER_PLAYBACK);
    return { settings, note: notes.length > 0 ? notes.join(" ") : null };
  } catch {
    return { settings: structuredClone(DEFAULT_SETTINGS), note: NOTE_UNREADABLE };
  }
}
