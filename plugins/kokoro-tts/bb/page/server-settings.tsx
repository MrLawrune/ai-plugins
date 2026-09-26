import { useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatHomePathForDisplay } from "@/lib/utils";
import type { KokoroConfig, Prefs, rpcContract } from "../schemas.ts";
import { useConfig, usePrefs, useStatus } from "./state.ts";
import { ownerText, statusLine } from "./status.ts";
import { ChoiceGroup, Disclosure, errorText, Row, SaveIndicator, SliderRow, StatusDot, SwitchRow } from "./ui.tsx";

type Engine = "cpu" | "gpu" | "remote";

export function engineChoice(provider: KokoroConfig["provider"] | undefined, runtime: Prefs["runtime"]): Engine {
  if (provider === "remote") return "remote";
  if (provider === "cuda") return "gpu";
  if (provider === "cpu" || provider === "openvino") return "cpu";
  return runtime; // server down: the runtime bb will start is the best answer
}

function formatUptime(s: number): string {
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

export function ServerSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const status = useStatus();
  const up = status?.health.up === true;
  const { prefs, setPrefs } = usePrefs();
  const { data, patch, commit, save } = useConfig(up);
  const [draft, setDraft] = useState<Engine | null>(null);
  const [url, setUrl] = useState("");
  const [fallback, setFallback] = useState(true);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const cfg = data?.config;
  useEffect(() => {
    setUrl(cfg?.remote_url ?? "");
    setFallback(cfg?.fallback_to_cpu ?? true);
  }, [cfg?.remote_url, cfg?.fallback_to_cpu]);

  if (!status || !prefs) return <p className="text-sm text-muted-foreground">Checking…</p>;

  const line = statusLine(status);
  const owner = ownerText(status);
  const external = status.setup.state === "external";
  const managed = prefs.manageServer && !external;
  const gpuOffered = status.setup.gpuAvailable || data?.providers_available.cuda === true;
  const current = engineChoice(cfg?.provider, prefs.runtime);
  const selected = draft ?? current;
  const h = up && status.health.up ? status.health.health : null;
  const showSetup = !["running", "external"].includes(status.setup.state);

  const chooseEngine = async (next: Engine) => {
    setEngineError(null);
    if (next === "remote") {
      setDraft(current === "remote" ? null : "remote");
      return;
    }
    setDraft(null);
    const runtime: Prefs["runtime"] = next;
    if (managed && prefs.runtime !== runtime) {
      // The supervisor restarts into the new runtime and aligns the engine to it.
      if (await setPrefs({ runtime })) {
        toast.message(runtime === "gpu"
          ? "Switching to the GPU runtime. The first switch downloads about 2.5 GB."
          : "Switching to the CPU runtime.");
      }
      return;
    }
    if (!data) {
      setEngineError("Start the server to change where synthesis runs.");
      return;
    }
    try {
      await commit({ provider: runtime === "gpu" ? "cuda" : "cpu" });
    } catch (cause) {
      setEngineError(errorText(cause));
    }
  };

  const applyRemote = async () => {
    setApplying(true);
    setEngineError(null);
    try {
      await commit({ provider: "remote", remote_url: url.trim(), fallback_to_cpu: fallback });
      setDraft(null);
    } catch (cause) {
      setEngineError(errorText(cause));
    } finally {
      setApplying(false);
    }
  };

  const urlValid = /^https?:\/\/\S+$/.test(url.trim());
  const installUv = () => rpc.call("installUv").then(
    (r) => toast(r.started ? "Installing uv…" : "The uv installer is already running"),
    (e) => toast.error(errorText(e)),
  );

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <p className="flex items-center gap-2 text-sm font-medium"><StatusDot tone={line.tone} />{line.text}</p>
        <p className="text-xs text-muted-foreground">
          {[owner, h?.version ? `v${h.version}` : null, h?.uptime_s ? `up ${formatUptime(h.uptime_s)}` : null,
            h?.latency?.median_ms != null ? `typical first audio ${Math.round(h.latency.median_ms)} ms` : null]
            .filter(Boolean).join(" · ")}
        </p>
        {status.setup.detail ? <p className="text-xs text-muted-foreground">{status.setup.detail}</p> : null}
      </div>

      {showSetup ? (
        <div className="space-y-2">
          {status.setup.progress !== null ? (
            <div className="h-1.5 w-full rounded bg-muted" role="progressbar" aria-valuenow={Math.round(status.setup.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded bg-primary" style={{ width: `${Math.round(status.setup.progress * 100)}%` }} />
            </div>
          ) : null}
          {status.setup.state === "needs-uv" ? <Button size="sm" onClick={() => void installUv()}>Install uv</Button> : null}
          {status.setup.fixCommand ? <code className="block break-all font-mono text-xs text-muted-foreground">{status.setup.fixCommand}</code> : null}
        </div>
      ) : null}

      <SwitchRow id="manageServer" label="Manage server"
        hint="bb installs, starts and restarts the server. Off: connect only to a server that is already running."
        checked={prefs.manageServer} onChange={(v) => void setPrefs({ manageServer: v })} />

      <Row label="Synthesis">
        <ChoiceGroup
          label="Synthesis"
          value={selected}
          onChange={(v) => void chooseEngine(v)}
          disabled={applying}
          options={[
            { value: "cpu" as const, label: "CPU", hint: "Runs on this server's processor. Always available." },
            ...(gpuOffered ? [{ value: "gpu" as const, label: "NVIDIA GPU",
              hint: prefs.runtime === "gpu" ? "Faster; holds video memory while loaded." : "Faster. The first switch downloads about 2.5 GB." }] : []),
            { value: "remote" as const, label: "Remote node", hint: "Another Kokoro server synthesizes; this one plays the audio." },
          ]}
        />
        {external ? (
          <p className="mt-1.5 text-xs text-muted-foreground">
            This server was started outside bb, so bb can't switch its runtime. Restart it with Manage server on to change it.
          </p>
        ) : null}
      </Row>

      {selected === "remote" ? (
        <div className="space-y-3 rounded-md border border-border p-3">
          <Row label="Remote node URL" htmlFor="remote_url">
            <Input id="remote_url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.0.2.10:6789" className="font-mono text-xs" />
          </Row>
          <SwitchRow id="fallback_to_cpu" label="Fall back to this server's CPU" hint="Speak locally when the remote node is unreachable."
            checked={fallback} onChange={setFallback} />
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={!urlValid || applying || !data} onClick={() => void applyRemote()}>Apply</Button>
            {draft === "remote" ? <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button> : null}
          </div>
        </div>
      ) : null}
      {engineError ? <p role="alert" className="text-xs text-destructive">{engineError}</p> : null}

      {cfg ? (
        <Disclosure label="Tuning">
          {cfg.provider === "cpu" || (cfg.provider === "remote" && cfg.fallback_to_cpu) ? (
            <SliderRow id="intra_op_threads" label="CPU threads" hint="0 lets the runtime decide." value={cfg.intra_op_threads}
              min={0} max={32} step={1} format={(v) => (v === 0 ? "auto" : String(v))}
              onChange={(v) => patch({ intra_op_threads: Math.round(v) }, 600)} />
          ) : null}
          {cfg.provider === "cuda" ? (
            <>
              <SliderRow id="idle_unload_minutes" label="Release the GPU after" hint="Quiet minutes before unloading. 0 keeps it loaded."
                value={cfg.idle_unload_minutes} min={0} max={60} step={1} format={(v) => (v === 0 ? "never" : `${v} min`)}
                onChange={(v) => patch({ idle_unload_minutes: Math.round(v) }, 600)} />
              <SliderRow id="gpu_mem_limit_mb" label="Video memory cap" hint="0 is unlimited; 512 MB is plenty for this model."
                value={cfg.gpu_mem_limit_mb} min={0} max={4096} step={128} format={(v) => (v === 0 ? "none" : `${v} MB`)}
                onChange={(v) => patch({ gpu_mem_limit_mb: Math.round(v) }, 600)} />
            </>
          ) : null}
          <SaveIndicator state={save} />
        </Disclosure>
      ) : (
        <p className="text-xs text-muted-foreground">Tuning and diagnostics appear when the server is running.</p>
      )}

      {data ? (
        <Disclosure label="Diagnostics">
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(0,10rem)_1fr]">
            {([
              ["Model", formatHomePathForDisplay(data.restart_required.model_path)],
              ["Voices", formatHomePathForDisplay(data.restart_required.voices_path)],
              ["Config file", formatHomePathForDisplay(data.restart_required.config_path)],
              ["Port", String(data.restart_required.port)],
            ] as const).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="min-w-0 break-all font-mono text-xs">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">{data.restart_command}</p>
        </Disclosure>
      ) : null}

      <Button variant="outline" size="sm" onClick={() => navigate.toPluginPanel("kokoro")}>Open voice settings</Button>
    </div>
  );
}
