// State behind the Dictation panel: this device and the profile roster, and the profile being edited.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../contract.ts";
import { thisDevice } from "../device.ts";
import { setDictationPrefs } from "../dictation-prefs.ts";
import { PROFILE_KEYS, type DeviceRecord, type Prefs, type ProfileInfo } from "../schemas.ts";
import { createPatchQueue, type SaveState } from "./patch-queue.ts";
import type { ProfilesApi } from "./profiles-section.tsx";
import { errorText } from "./error-text.ts";

export type PrefsPatch = (p: Partial<Prefs>, debounceMs?: number) => void;

const PROFILE_KEY_SET = new Set<string>(PROFILE_KEYS);

function omit<T extends object>(o: T, keys: (keyof T)[]): T {
  const out = { ...o };
  for (const k of keys) delete out[k];
  return out;
}

/** This browser's device record, every profile and device; registers the browser on first load. */
export function useRoster() {
  const rpc = useRpc<typeof rpcContract>();
  const [me, setMe] = useState<DeviceRecord | null>(null);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<DeviceRecord> => {
    const d = thisDevice();
    const hello = await rpc.call("hello", { deviceId: d.id, name: d.name, kind: d.kind });
    const list = await rpc.call("listProfiles");
    setMe(hello.device);
    setDictationPrefs(hello.prefs);
    setDevices(list.devices);
    setProfiles(list.profiles);
    setError(null);
    return hello.device;
  }, [rpc]);

  const api = useMemo<ProfilesApi>(() => ({
    renameDevice: async (id, name) => { await rpc.call("updateDevice", { id, name }); await load(); },
    assign: async (id, profileId) => { await rpc.call("updateDevice", { id, profileId }); await load(); },
    forget: async (id) => { await rpc.call("forgetDevice", { id }); await load(); },
    create: async (name, copyFrom) => { const p = await rpc.call("createProfile", { name, copyFrom }); await load(); return p; },
    rename: async (id, name) => { await rpc.call("renameProfile", { id, name }); await load(); },
    remove: async (id) => { await rpc.call("deleteProfile", { id }); await load(); },
  }), [rpc, load]);

  // Stable: effects depend on it, and a new function every render would reload the roster forever.
  const reload = useCallback(() => load().catch((e) => { setError(errorText(e)); return null; }), [load]);

  return { me, devices, profiles, error, api, load: reload };
}

/**
 * The prefs of one profile with edits applied at once and saved in the background. Edits to a
 * profile that is switched away from are still saved to that profile.
 */
export function useProfilePrefs(profileId: string | null, me: DeviceRecord | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [confirmed, setConfirmed] = useState<Prefs | null>(null);
  const [drafts, setDrafts] = useState<Partial<Prefs>>({});
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const active = useRef(profileId);
  active.current = profileId;
  const myProfile = useRef(me?.profileId);
  myProfile.current = me?.profileId;
  /** The previous profile's save, which the next load waits for: shared keys must be read after it lands. */
  const settling = useRef<Promise<void>>(Promise.resolve());

  const queue = useMemo(() => {
    if (profileId === null) return null;
    const current = () => active.current === profileId;
    return createPatchQueue<Prefs, Prefs>({
      send: (patch) => rpc.call("setPrefs", { profileId, patch }),
      onCommitted: (result, keys) => {
        if (current()) {
          setConfirmed(result);
          setDrafts((d) => omit(d, keys));
        }
        // This browser's dictation reads its own profile; a shared key edited elsewhere changes it too.
        if (profileId === myProfile.current) setDictationPrefs(result);
        else if (keys.some((k) => !PROFILE_KEY_SET.has(k)) && myProfile.current) {
          void rpc.call("getPrefs", { profileId: myProfile.current }).then(setDictationPrefs, () => {});
        }
      },
      onFailed: (keys, message) => {
        if (current()) setDrafts((d) => omit(d, keys));
        else toast.error(`Not saved: ${message}`);
      },
      onState: (s) => { if (current()) setSave(s); },
    });
  }, [rpc, profileId]);

  useEffect(() => {
    if (!queue || profileId === null) return;
    let live = true;
    setConfirmed(null);
    setDrafts({});
    setSave({ kind: "idle" });
    setError(null);
    const previous = settling.current;
    void previous
      .then(() => rpc.call("getPrefs", { profileId }))
      .then((p) => { if (live) setConfirmed(p); }, (e) => { if (live) setError(errorText(e)); });
    return () => {
      live = false;
      settling.current = queue.flush();
    };
  }, [queue, rpc, profileId, attempt]);

  const patch = useCallback<PrefsPatch>((p, debounceMs = 0) => {
    if (!queue) return;
    setDrafts((d) => ({ ...d, ...p }));
    queue.set(p, debounceMs);
  }, [queue]);

  const prefs = useMemo(() => (confirmed ? { ...confirmed, ...drafts } : null), [confirmed, drafts]);
  return { prefs, patch, save, error, retry: () => setAttempt((n) => n + 1) };
}
