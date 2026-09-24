// bb-plugin-kokoro-tts — Engine card: where synthesis runs (merged Runtime + Provider).
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { useRpc } from "@get-bb/plugin-sdk/app";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import type { ConfigResponse, EngineInfo, KokoroConfig, Prefs, rpcContract, SetupState } from "../schemas.ts";
import { Advanced, Row, Section, SliderRow, SwitchRow, useDebouncedPatch } from "./ui.tsx";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Patch = Partial<KokoroConfig>;
type LocalProvider = "cpu" | "cuda" | "remote";

const RUNTIME_LABEL: Record<"cpu" | "gpu", string> = { cpu: "CPU", gpu: "GPU" };

export function EngineCard({ data, patch, rpc, prefs, setPrefs, setupState, up }: {
  data: ConfigResponse;
  patch: (p: Patch) => Promise<void>;
  rpc: Rpc;
  prefs: Prefs | null;
  setPrefs: (p: Partial<Prefs>) => Promise<void>;
  setupState: SetupState | null;
  up: boolean;
}) {
  const cfg = data.config;
  const avail = data.providers_available;
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [url, setUrl] = useState(cfg.remote_url ?? "");
  const [busy, setBusy] = useState<LocalProvider | null>(null);
  const debounced = useDebouncedPatch(patch, 600);

  useEffect(() => setUrl(cfg.remote_url ?? ""), [cfg.remote_url]);
  useEffect(() => {
    let live = true;
    const tick = () => rpc.call("engine").then((e) => live && setEngine(e), () => live && setEngine(null));
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [rpc, cfg.provider, cfg.remote_url]);

  // A managed install always records the runtime preference, whatever the setup
  // state is right now: that's what the supervisor reads on its next (re)start,
  // and its #alignProvider brings the engine provider in line with it afterwards.
  // Only the live PATCH — which needs a server to talk to — is gated on health.
  const managed = prefs?.manageServer === true;
  const gpuAvailable = setupState?.gpuAvailable === true || avail.cuda;

  const choose = async (p: LocalProvider) => {
    if (p === cfg.provider || busy !== null) return;
    if (p === "remote" && !cfg.remote_url && !url.trim()) {
      toast.message("Enter the remote node URL first");
      return;
    }
    setBusy(p);
    try {
      if (p === "cpu" || p === "cuda") {
        const runtime: Prefs["runtime"] = p === "cpu" ? "cpu" : "gpu";
        if (managed) {
          await setPrefs({ runtime });
          if (up) {
            await patch({ provider: p });
          } else {
            toast.message(`Switching to ${RUNTIME_LABEL[runtime]} — the server restarts into the ${RUNTIME_LABEL[runtime]} runtime.`);
          }
        } else {
          await patch({ provider: p });
        }
      } else {
        await patch(cfg.remote_url ? { provider: "remote" } : { provider: "remote", remote_url: url.trim() });
      }
    } finally {
      setBusy(null);
    }
  };

  const isGpu = cfg.provider === "cuda" || cfg.provider === "openvino";
  const local = engine?.kind === "local" ? engine : engine?.kind === "remote" ? engine.fallback : null;
  const remote = engine?.kind === "remote" ? engine : null;
  const r = data.restart_required;

  return (
    <Section
      title="Engine"
      description="Where synthesis runs. Switching applies immediately; a managed server may restart into a different runtime."
      actions={
        engine ? (
          <Badge variant="outline">
            {remote
              ? remote.remote_health
                ? `remote ok${remote.last_latency_ms ? ` · ${Math.round(remote.last_latency_ms)} ms` : ""}`
                : "remote down · using fallback"
              : local?.loaded
                ? `${local.loaded_provider} loaded${local.load_ms ? ` · ${Math.round(local.load_ms)} ms` : ""}`
                : "idle · unloaded"}
          </Badge>
        ) : null
      }
    >
      <Row label="Synthesis runs on">
        <div role="radiogroup" className="flex flex-wrap gap-1.5">
          <Button
            role="radio"
            aria-checked={cfg.provider === "cpu"}
            aria-label="This machine, CPU. Always available."
            variant={cfg.provider === "cpu" ? "default" : "outline"}
            size="sm"
            disabled={busy !== null}
            onClick={() => void choose("cpu")}
          >
            {busy === "cpu" ? <Icon name="Loading" className="size-3.5 animate-spin" /> : null}
            This machine · CPU
          </Button>
          {gpuAvailable ? (
            <Button
              role="radio"
              aria-checked={cfg.provider === "cuda"}
              aria-label="This machine, NVIDIA GPU. Faster; holds VRAM while loaded."
              variant={cfg.provider === "cuda" ? "default" : "outline"}
              size="sm"
              disabled={busy !== null}
              onClick={() => void choose("cuda")}
            >
              {busy === "cuda" ? <Icon name="Loading" className="size-3.5 animate-spin" /> : null}
              This machine · NVIDIA GPU
            </Button>
          ) : null}
          <Button
            role="radio"
            aria-checked={cfg.provider === "remote"}
            aria-label="Remote node. Another Kokoro node synthesizes; this machine only plays audio."
            variant={cfg.provider === "remote" ? "default" : "outline"}
            size="sm"
            disabled={busy !== null}
            onClick={() => void choose("remote")}
          >
            {busy === "remote" ? <Icon name="Loading" className="size-3.5 animate-spin" /> : null}
            Remote node
          </Button>
        </div>
        {gpuAvailable && cfg.provider !== "cuda" && !avail.cuda ? (
          <p className="mt-1 text-xs text-muted-foreground">
            NVIDIA GPU: about 2.5 GB to install the runtime, the first time you switch.
          </p>
        ) : null}
        {cfg.provider === "openvino" ? (
          <p className="mt-1 text-xs text-muted-foreground">Currently OpenVINO (set outside this page).</p>
        ) : null}
      </Row>

      {cfg.provider === "remote" || url ? (
        <Row label="Remote node" hint="URL of a Kokoro node exposing /synthesize." htmlFor="remote_url">
          <div className="flex gap-2">
            <Input
              id="remote_url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => {
                const v = url.trim();
                if (v !== (cfg.remote_url ?? "") && (v === "" || /^https?:\/\//.test(v))) void patch({ remote_url: v === "" ? null : v });
              }}
              placeholder="http://192.168.1.50:6789"
              className="font-mono text-xs"
            />
          </div>
          {remote?.last_error ? <p className="mt-1 text-xs text-destructive">{remote.last_error}</p> : null}
        </Row>
      ) : null}
      {cfg.provider === "remote" ? (
        <SwitchRow id="fallback_to_cpu" label="Fall back to local CPU" hint="Speak locally if the remote node is unreachable." checked={cfg.fallback_to_cpu} onChange={(v) => void patch({ fallback_to_cpu: v })} />
      ) : null}

      <Advanced>
        {isGpu ? (
          <>
            <SliderRow
              id="idle_unload_minutes"
              label="Idle unload"
              hint="Release the GPU after this many quiet minutes. 0 keeps it loaded."
              value={cfg.idle_unload_minutes}
              min={0}
              max={60}
              step={1}
              format={(v) => (v === 0 ? "never" : `${v} min`)}
              onChange={(v) => debounced({ idle_unload_minutes: Math.round(v) })}
            />
            {cfg.provider === "cuda" ? (
              <SliderRow
                id="gpu_mem_limit_mb"
                label="VRAM cap"
                hint="Arena limit for the CUDA session. 0 is unlimited; 512 MB is plenty for this model."
                value={cfg.gpu_mem_limit_mb}
                min={0}
                max={4096}
                step={128}
                format={(v) => (v === 0 ? "none" : `${v} MB`)}
                onChange={(v) => debounced({ gpu_mem_limit_mb: Math.round(v) })}
              />
            ) : null}
          </>
        ) : null}
        {cfg.provider === "cpu" || (cfg.provider === "remote" && cfg.fallback_to_cpu) ? (
          <SliderRow
            id="intra_op_threads"
            label="CPU threads"
            hint="ONNX intra-op threads. 0 is automatic; 6 measured fastest on a 12-core desktop."
            value={cfg.intra_op_threads}
            min={0}
            max={32}
            step={1}
            format={(v) => (v === 0 ? "auto" : String(v))}
            onChange={(v) => debounced({ intra_op_threads: Math.round(v) })}
          />
        ) : null}

        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(0,12rem)_1fr]">
          {([["Model", r.model_path], ["Voices", r.voices_path], ["Port", String(r.port)], ["Config file", r.config_path]] as [string, string][]).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0 break-all font-mono text-xs">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">{data.restart_command}</p>
        <p className="text-xs text-muted-foreground">
          Model and voices paths come from the server's KOKORO_MODEL and KOKORO_VOICES environment; bb sets them when it
          manages the server. Quantized models (int8, fp16) swap in via KOKORO_MODEL.
        </p>
      </Advanced>
    </Section>
  );
}
