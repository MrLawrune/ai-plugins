// Data hooks: RPC calls that refetch on realtime signals and after reconnects.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../schemas.ts";
import { CHANNELS } from "../shared/constants.ts";
import { dropUndefined } from "./json.ts";

type Methods = RpcContract;
type Method = keyof Methods & string;
export type RpcInput<M extends Method> = Methods[M]["input"] extends { _zod: { input: infer I } } ? I : never;
export type RpcResult<M extends Method> = Methods[M]["output"] extends { _zod: { output: infer O } } ? O : never;
type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];

export interface QueryState<T> { data: T | null; error: string | null; loading: boolean; refresh(): void }

export function useInfraRpc() {
  const rpc = useRpc<Methods>();
  return useCallback(<M extends Method>(method: M, input: RpcInput<M>) => rpc.call(method, dropUndefined(input as object) as never) as Promise<RpcResult<M>>, [rpc]);
}

export function useInfraQuery<M extends Method>(method: M, input: RpcInput<M> | null, opts: { refreshOn?: Channel[]; intervalMs?: number } = {}): QueryState<RpcResult<M>> {
  const call = useInfraRpc();
  const [state, setState] = useState<{ data: RpcResult<M> | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: input !== null });
  const key = JSON.stringify(input);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    if (input === null) return;
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    call(method, input).then(
      (data) => { if (mine === seq.current) setState({ data, error: null, loading: false }); },
      (e: unknown) => { if (mine === seq.current) setState((s) => ({ data: s.data, error: e instanceof Error ? e.message : String(e), loading: false })); },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, method, key]);

  useEffect(() => {
    setState({ data: null, error: null, loading: input !== null });
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const debounced = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, 300);
  }, [load]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const channels = opts.refreshOn ?? [CHANNELS.changed];
  useRealtime(CHANNELS.changed, () => { if (channels.includes(CHANNELS.changed)) debounced(); });
  useRealtime(CHANNELS.activity, () => { if (channels.includes(CHANNELS.activity)) debounced(); });
  useRealtime(CHANNELS.events, () => { if (channels.includes(CHANNELS.events)) debounced(); });

  const conn = useRealtimeConnectionState();
  const prevConn = useRef(conn);
  useEffect(() => {
    if (prevConn.current !== "connected" && conn === "connected") load();
    prevConn.current = conn;
  }, [conn, load]);

  useEffect(() => {
    if (!opts.intervalMs) return;
    const t = setInterval(load, opts.intervalMs);
    return () => clearInterval(t);
  }, [opts.intervalMs, load]);

  return { ...state, refresh: load };
}

/** Re-render periodically so relative ages ("42s ago") stay current. */
export function useNow(everyMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
