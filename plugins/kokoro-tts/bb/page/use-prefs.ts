import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Prefs, rpcContract, SetupState } from "../schemas.ts";
import { errorText } from "./ui.tsx";

export function usePrefs() {
  const rpc = useRpc<typeof rpcContract>();
  const [prefs, set] = useState<Prefs | null>(null);
  useEffect(() => {
    void rpc.call("getPrefs").then(set, (e) => toast.error(errorText(e)));
  }, [rpc]);
  const setPrefs = useCallback(async (patch: Partial<Prefs>) => {
    try {
      set(await rpc.call("setPrefs", patch));
    } catch (e) {
      toast.error(errorText(e));
    }
  }, [rpc]);
  return { prefs, setPrefs };
}

/** Polls the supervisor's setup status: fast while it's transitioning, slow once settled. */
export function useSetupStatus(): SetupState | null {
  const rpc = useRpc<typeof rpcContract>();
  const [s, setS] = useState<SetupState | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await rpc.call("setupStatus");
        if (!live) return;
        setS(next);
        timer = setTimeout(tick, next.state === "running" || next.state === "external" ? 5_000 : 1_000);
      } catch {
        if (live) timer = setTimeout(tick, 5_000);
      }
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [rpc]);
  return s;
}
