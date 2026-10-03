import { useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatHomePathForDisplay } from "@/lib/utils";
import type { rpcContract } from "../contract.ts";
import type { ConfigResponse, EngineRef, EngineStatus, RuntimePatch, Settings } from "../schemas.ts";
import { localEngineUp, useConfig, usePrefs, useStatus } from "./state.ts";
import { ownerText, statusLine } from "./status.ts";
import { ChoiceGroup, Disclosure, errorText, Row, SaveIndicator, SliderRow, StatusDot, SwitchRow } from "./ui.tsx";

type Provider = NonNullable<RuntimePatch["provider"]>;
/** What the local server reports, including "remote" (it forwards instead of synthesizing). */
type ShownProvider = NonNullable<ConfigResponse["runtime"]>["config"]["provider"];

const FORWARDS = "This server forwards to another one";
/** The supervisor's detail for a cold backup on standby; the backup slot already says it. */
const STANDBY_DETAIL = "Starts when the main server fails.";
type Engines = Settings["engines"];
type EngineChoice = "none" | "local" | "url";

const choiceOf = (ref: EngineRef | null): EngineChoice => (ref === null ? "none" : ref === "local" ? "local" : "url");
const isHttpUrl = (url: string) => /^https?:\/\/\S+$/.test(url);

function engineStatusText(e: EngineStatus): string {
  if (e.cold === "standby") return "Standby — starts when the main server fails";
  const why = e.cold === "active" ? " · running because the main server failed" : "";
  if (!e.health.up) return `Unreachable: ${e.health.error}${why}`;
  if (e.health.health.forwards) return `${FORWARDS}, so it can't synthesize for bb. Point this engine at the synthesizing server.`;
  const version = e.health.health.version;
  return `${version ? `Reachable · v${version}` : "Reachable"}${why}`;
}

/** A stopped cold backup is as it should be, not a problem. */
const engineOk = (e: EngineStatus) => e.cold === "standby" || (e.health.up && !e.health.health.forwards);

/** One engine slot: where it runs, its URL when it is another server, and how it is doing. */
function EngineSlot({ label, value, optional, status, note, disabled, onSave }: {
  label: string;
  value: EngineRef | null;
  optional: boolean;
  status: EngineStatus | undefined;
  note: string | null;
  /** A save is applying: no second save may start from this (stale) snapshot. */
  disabled: boolean;
  onSave: (ref: EngineRef | null) => Promise<boolean>;
}) {
  const saved = choiceOf(value);
  const savedUrl = value !== null && value !== "local" ? value.url : "";
  const [draft, setDraft] = useState<EngineChoice | null>(null);
  const [url, setUrl] = useState(savedUrl);
  const [urlError, setUrlError] = useState<string | null>(null);
  /** Enter then blur must not send the same URL twice. */
  const savingUrl = useRef(false);
  useEffect(() => setUrl(savedUrl), [savedUrl]);
  const selected = draft ?? saved;

  const choose = async (next: EngineChoice) => {
    setUrlError(null);
    if (next === "url") {
      setDraft(saved === "url" ? null : "url");
      return;
    }
    setDraft(null);
    if (next !== saved) await onSave(next === "local" ? "local" : null);
  };
  const saveUrl = async () => {
    const next = url.trim();
    if (!isHttpUrl(next)) {
      setUrlError("Use an http:// or https:// address.");
      return;
    }
    setUrlError(null);
    if (next === savedUrl || savingUrl.current) return;
    savingUrl.current = true;
    try {
      if (await onSave({ url: next })) setDraft(null);
    } finally {
      savingUrl.current = false;
    }
  };
  const id = `${label.toLowerCase().replace(/\W+/g, "-")}-url`;

  return (
    <div className="space-y-2">
      <Row label={label}>
        <ChoiceGroup
          label={label}
          value={selected}
          onChange={(v) => void choose(v)}
          disabled={disabled}
          options={[
            ...(optional ? [{ value: "none" as const, label: "None", hint: "With the main engine unreachable, replies play an error cue." }] : []),
            optional
              ? { value: "local" as const, label: "This computer (starts only when the main server fails)",
                hint: "The Kokoro server on the computer running bb, stopped again once the main server is back." }
              : { value: "local" as const, label: "This computer (managed)", hint: "The Kokoro server on the computer running bb." },
            { value: "url" as const, label: "Another server", hint: "A Kokoro server elsewhere on your network synthesizes." },
          ]}
        />
      </Row>
      {selected === "url" ? (
        <Row label={`${label} URL`} htmlFor={id}>
          <Input id={id} value={url} disabled={disabled} onChange={(e) => setUrl(e.target.value)} onBlur={() => void saveUrl()}
            onKeyDown={(e) => { if (e.key === "Enter") void saveUrl(); }}
            placeholder="http://192.0.2.10:6789" className="font-mono text-xs" aria-invalid={urlError !== null} />
          {urlError ? <p role="alert" className="mt-1 text-xs text-destructive">{urlError}</p> : null}
        </Row>
      ) : null}
      {status && selected === saved && saved !== "none" ? (
        <p className={engineOk(status) ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
          {engineStatusText(status)}
        </p>
      ) : null}
      {note ? <p className="text-xs text-amber-600 dark:text-amber-400">{note}</p> : null}
    </div>
  );
}

export function ServerSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const status = useStatus();
  const up = status?.health.up === true;
  const { prefs, setPrefs } = usePrefs();
  const { data, patch, commit, save } = useConfig(localEngineUp(status));
  const [engineError, setEngineError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  if (!status || !prefs) return <p className="text-sm text-muted-foreground">Checking…</p>;

  const line = statusLine(status);
  const owner = ownerText(status);
  const external = status.setup.state === "external";
  const managed = prefs.manageServer && !external;
  const engines = data?.config.engines ?? null;
  const runtime = data?.runtime ?? null;
  // Without the engine's /config, the runtime bb will start is the best answer.
  const provider: ShownProvider = runtime?.config.provider ?? (prefs.runtime === "gpu" ? "cuda" : "cpu");
  const usesLocal = engines !== null && (engines.main === "local" || engines.backup === "local");
  // A managed engine that cannot start can still be moved to the other runtime.
  const showRuntime = runtime !== null || (usesLocal && managed);
  const gpuOffered = status.setup.gpuAvailable || runtime?.providers_available.cuda === true;
  const openvinoOffered = runtime?.providers_available.openvino === true || provider === "openvino";
  const h = up && status.health.up ? status.health.health : null;
  const slotStatus = (slot: EngineStatus["slot"]) => status.engines.find((e) => e.slot === slot);
  const showSetup = !["running", "external", "standby"].includes(status.setup.state) || status.setup.fixCommand !== null;
  // Under the main engine's status, a standby note is only worth showing when the backup's last run failed.
  const setupDetail = status.setup.state !== "standby" ? status.setup.detail
    : status.setup.detail && status.setup.detail !== STANDBY_DETAIL ? `Local backup: ${status.setup.detail}` : null;

  const apply = async (p: Parameters<typeof commit>[0]): Promise<boolean> => {
    setApplying(true);
    setEngineError(null);
    try {
      await commit(p);
      return true;
    } catch (cause) {
      setEngineError(errorText(cause));
      return false;
    } finally {
      setApplying(false);
    }
  };
  const saveEngines = (next: Partial<Engines>) => (engines ? apply({ engines: { ...engines, ...next } }) : Promise.resolve(false));

  const chooseRuntime = async (next: ShownProvider) => {
    if (next === provider || next === "remote") return;
    const wanted = next === "cuda" ? "gpu" : "cpu";
    if (managed && next !== "openvino" && prefs.runtime !== wanted) {
      // The supervisor does not move a server off OpenVINO, so leave it first.
      if (provider === "openvino" && !(await apply({ provider: "cpu" }))) return;
      // The supervisor restarts into the new runtime and aligns the engine to it.
      if (await setPrefs({ runtime: wanted })) {
        toast.message(wanted === "gpu"
          ? "Switching to the GPU runtime. The first switch downloads about 2.5 GB."
          : "Switching to the CPU runtime.");
      }
      return;
    }
    if (runtime) await apply({ provider: next });
  };

  const installUv = () => rpc.call("installUv").then(
    (r) => toast(r.started ? "Installing uv…" : "The uv installer is already running"),
    (e) => toast.error(errorText(e)),
  );

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <p className="flex items-center gap-2 text-sm font-medium"><StatusDot tone={line.tone} />{line.text}</p>
        <p className="text-xs text-muted-foreground">
          {[owner, h?.version ? `v${h.version}` : null,
            status.latency.median_ms != null ? `typical first audio ${Math.round(status.latency.median_ms)} ms` : null]
            .filter(Boolean).join(" · ")}
        </p>
        {setupDetail ? <p className="text-xs text-muted-foreground">{setupDetail}</p> : null}
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
        hint="bb installs, starts and restarts the server on this computer. Off: connect only to a server that is already running."
        checked={prefs.manageServer} onChange={(v) => void setPrefs({ manageServer: v })} />

      {engines ? (
        <div className="space-y-4">
          <EngineSlot label="Main engine" value={engines.main} optional={false} status={slotStatus("main")}
            note={slotStatus("main")?.breaker !== "open" ? null
              : engines.backup !== null ? "Breaker open — using backup" : "Main engine unreachable — retrying shortly"}
            disabled={applying} onSave={(ref) => saveEngines({ main: ref ?? "local" })} />
          <EngineSlot label="Backup engine" value={engines.backup} optional status={slotStatus("backup")} note={null}
            disabled={applying} onSave={(ref) => saveEngines({ backup: ref })} />
        </div>
      ) : null}

      {showRuntime ? (
        <Row label="Runtime">
          <ChoiceGroup<ShownProvider>
            label="Runtime"
            value={provider}
            onChange={(v) => void chooseRuntime(v)}
            disabled={applying}
            options={[
              { value: "cpu" as const, label: "CPU", hint: "Runs on this computer's processor. Always available." },
              ...(gpuOffered ? [{ value: "cuda" as const, label: "NVIDIA GPU",
                hint: prefs.runtime === "gpu" ? "Faster; holds video memory while loaded." : "Faster. The first switch downloads about 2.5 GB." }] : []),
              ...(openvinoOffered ? [{ value: "openvino" as const, label: "OpenVINO", hint: "Intel CPU and GPU acceleration." }] : []),
            ]}
          />
          {provider === "remote" ? (
            <p className="mt-1.5 text-xs text-destructive">
              {FORWARDS} instead of synthesizing. bb switches it when it next starts or connects to it; pick CPU or NVIDIA GPU to switch it now.
            </p>
          ) : null}
          {external ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              This server was started outside bb, so bb can't switch its runtime. Restart it with Manage server on to change it.
            </p>
          ) : null}
        </Row>
      ) : null}
      {engineError ? <p role="alert" className="text-xs text-destructive">{engineError}</p> : null}

      {runtime ? (
        <Disclosure label="Tuning">
          {runtime.config.provider === "cpu" ? (
            <SliderRow id="intra_op_threads" label="CPU threads" hint="0 lets the runtime decide." value={runtime.config.intra_op_threads}
              min={0} max={32} step={1} format={(v) => (v === 0 ? "auto" : String(v))}
              onChange={(v) => patch({ intra_op_threads: Math.round(v) }, 600)} />
          ) : null}
          {runtime.config.provider === "cuda" ? (
            <>
              <SliderRow id="idle_unload_minutes" label="Release the GPU after" hint="Quiet minutes before unloading. 0 keeps it loaded."
                value={runtime.config.idle_unload_minutes} min={0} max={60} step={1} format={(v) => (v === 0 ? "never" : `${v} min`)}
                onChange={(v) => patch({ idle_unload_minutes: Math.round(v) }, 600)} />
              <SliderRow id="gpu_mem_limit_mb" label="Video memory cap" hint="0 is unlimited; 512 MB is plenty for this model."
                value={runtime.config.gpu_mem_limit_mb} min={0} max={4096} step={128} format={(v) => (v === 0 ? "none" : `${v} MB`)}
                onChange={(v) => patch({ gpu_mem_limit_mb: Math.round(v) }, 600)} />
            </>
          ) : null}
          <SaveIndicator state={save} />
        </Disclosure>
      ) : usesLocal ? (
        <p className="text-xs text-muted-foreground">Runtime options appear when this computer's engine is running.</p>
      ) : null}

      {runtime ? (
        <Disclosure label="Diagnostics">
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(0,10rem)_1fr]">
            {([
              ["Model", formatHomePathForDisplay(runtime.restart_required.model_path)],
              ["Voices", formatHomePathForDisplay(runtime.restart_required.voices_path)],
              ["Config file", formatHomePathForDisplay(runtime.restart_required.config_path)],
              ["Port", String(runtime.restart_required.port)],
            ] as const).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="min-w-0 break-all font-mono text-xs">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">{runtime.restart_command}</p>
        </Disclosure>
      ) : null}

      <Button variant="outline" size="sm" onClick={() => navigate.toPluginPanel("kokoro")}>Open voice settings</Button>
    </div>
  );
}
