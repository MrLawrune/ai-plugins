// bb-plugin-kokoro-tts — Server card: health/status header (merged Status) plus
// setup progress and the "Manage server" toggle (merged Server/Setup).
import { toast } from "sonner";
import type { useRpc } from "@get-bb/plugin-sdk/app";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { ConfigResponse, Health, Prefs, rpcContract, SetupState } from "../schemas.ts";
import { Advanced, errorText, Section, SwitchRow } from "./ui.tsx";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

const SETUP_LABEL: Record<string, string> = {
  checking: "Checking…",
  "needs-uv": "Needs uv",
  "downloading-models": "Downloading voice model",
  "installing-runtime": "Installing runtime",
  starting: "Starting server",
};

function stateText(up: boolean, s: SetupState | null): string {
  if (!up) return "Server unreachable";
  if (!s) return "Server running";
  switch (s.state) {
    case "running":
      return "Running · managed by bb";
    case "external":
      return "Connected · external server";
    case "error":
      return "Error";
    default:
      return SETUP_LABEL[s.state] ?? s.state;
  }
}

function formatUptime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function ServerCard({ health, data, setMuted, rpc, setupState, prefs, setPrefs }: {
  health: { up: boolean; health?: Health; error?: string } | null;
  data: ConfigResponse | null;
  setMuted: (m: boolean) => Promise<void>;
  rpc: Rpc;
  setupState: SetupState | null;
  prefs: Prefs | null;
  setPrefs: (p: Partial<Prefs>) => Promise<void>;
}) {
  const up = health?.up === true;
  const h = health?.health;
  const muted = data?.muted ?? h?.muted ?? false;
  const s = setupState;
  const showSetup = s !== null && s.state !== "running" && s.state !== "external";

  const installUv = async () => {
    try {
      const r = await rpc.call("installUv");
      toast(r.started ? "Installing uv…" : "The uv installer is already running");
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  return (
    <Section
      title="Server"
      description="The local Kokoro server that turns text into speech."
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!up}
            onClick={() => rpc.call("interruptAll").then(
              (r) => toast.success(`Stopped ${r.sessions_cancelled} playback${r.sessions_cancelled === 1 ? "" : "s"}`),
              (e) => toast.error(errorText(e)),
            )}
          >
            <Icon name="Square" className="size-3.5" />
            Stop all
          </Button>
          <Button
            variant={muted ? "default" : "outline"}
            size="sm"
            disabled={!up}
            onClick={() => void setMuted(!muted)}
          >
            <Icon name={muted ? "Mic" : "Pause"} className="size-3.5" />
            {muted ? "Unmute" : "Mute"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span
          className={cn("inline-block size-2 rounded-full", up ? "bg-emerald-500" : "bg-destructive")}
          aria-hidden
        />
        <span className="font-medium">{stateText(up, s)}</span>
        {h ? (
          <>
            <Badge variant="secondary">{h.model}</Badge>
            {h.provider ? <Badge variant="outline">{h.provider}</Badge> : null}
            <span className="text-xs text-muted-foreground">
              v{h.version ?? "?"} · up {formatUptime(h.uptime_s ?? 0)} · {h.active_sessions} active
            </span>
            {h.latency?.last_ms != null ? (
              <>
                <span aria-hidden className="text-muted-foreground">·</span>
                <span
                  className="inline-flex shrink-0 items-baseline gap-1 whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground"
                  aria-label={`Time to first audio: last ${Math.round(h.latency.last_ms)} ms, median ${Math.round(h.latency.median_ms ?? h.latency.last_ms)} ms over ${h.latency.samples} responses`}
                >
                  <span>{Math.round(h.latency.last_ms)} ms</span>
                  <span className="opacity-70">(med {Math.round(h.latency.median_ms ?? h.latency.last_ms)} ms, n={h.latency.samples})</span>
                </span>
              </>
            ) : null}
            {muted ? <Badge>Muted</Badge> : null}
          </>
        ) : health?.error ? (
          <span className="text-xs text-muted-foreground">{health.error}</span>
        ) : null}
      </div>

      {showSetup ? (
        <div className="space-y-1.5">
          {s?.detail ? <p className="text-xs text-muted-foreground">{s.detail}</p> : null}
          {s?.progress !== null && s?.progress !== undefined ? (
            <div className="h-1.5 w-full rounded bg-muted">
              <div className="h-full rounded bg-primary" style={{ width: `${Math.round(s.progress * 100)}%` }} />
            </div>
          ) : null}
          {s?.state === "needs-uv" || s?.fixCommand ? (
            <div className="flex flex-wrap items-center gap-2">
              {s?.state === "needs-uv" ? <Button size="sm" onClick={() => void installUv()}>Install uv</Button> : null}
              {s?.fixCommand ? <code className="break-all font-mono text-xs text-muted-foreground">{s.fixCommand}</code> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {prefs ? (
        <Advanced>
          <SwitchRow
            id="manageServer"
            label="Manage server"
            hint="Install and run the server for you. Off: only connect to one that is already running."
            checked={prefs.manageServer}
            onChange={(v) => void setPrefs({ manageServer: v })}
          />
        </Advanced>
      ) : null}
    </Section>
  );
}
