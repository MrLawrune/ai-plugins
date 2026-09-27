// Turns ansible-runner JSON lines, ansible.posix.jsonl lines, or plain ansible-playbook text into RunEvents.
import type { HostStats, RunEvent, RunStatus } from "../../shared/types.ts";
import { LIMITS } from "../../shared/constants.ts";

type Ev = Omit<RunEvent, "seq">;
type Kind = RunEvent["kind"];
type Obj = Record<string, unknown>;
type Mode = "runner" | "jsonl" | "text";
/** A `=> {` result that never closes (truncated output, an unbalanced brace in a message) is flushed after this many lines. */
const ACC_MAX_LINES = 500;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const cut = (s: string | null, max: number): string | null => (s === null ? null : s.length > max ? s.slice(0, max) : s);

const HEAVY_RES_KEYS = ["ansible_facts", "diff", "stdout_lines", "stderr_lines"];
/** JSON for the res column: drop bulky keys first so the string stays parseable, then hard-cut as a last resort. */
function resJson(res: unknown): string | null {
  if (res === undefined || res === null) return null;
  let s = JSON.stringify(res);
  if (s.length > LIMITS.res && isObj(res)) {
    const slim: Obj = { ...res };
    for (const k of HEAVY_RES_KEYS) delete slim[k];
    s = JSON.stringify(slim);
  }
  return cut(s, LIMITS.res);
}

function diffText(d: unknown): string | null {
  if (typeof d === "string") return cut(d || null, LIMITS.diff);
  const items = Array.isArray(d) ? d : isObj(d) ? [d] : [];
  const parts: string[] = [];
  for (const it of items) {
    if (!isObj(it)) continue;
    const prepared = str(it.prepared);
    if (prepared) { parts.push(prepared); continue; }
    if (it.before === undefined && it.after === undefined) continue;
    parts.push(`--- ${str(it.before_header) ?? "before"}\n+++ ${str(it.after_header) ?? "after"}\n${String(it.before ?? "")}\n${String(it.after ?? "")}`);
  }
  return cut(parts.join("\n") || null, LIMITS.diff);
}

const blank = (source: Ev["source"], at: number, kind: Kind): Ev => ({
  kind, play: null, task: null, taskAction: null, nodeId: null, host: null, changed: false, failed: false,
  msg: null, res: null, diff: null, stdout: null, source, at,
});

const HOST_KINDS: Record<string, Kind> = { ok: "host_ok", failed: "host_failed", unreachable: "host_unreachable", skipped: "host_skipped" };
const ITEM_KINDS: Record<string, Kind> = { ok: "item_ok", failed: "item_failed", skipped: "item_skipped" };

/** Fill a host-result event from a result object (`res`). ignoreErrors keeps a failure from counting as failed. */
function withResult(e: Ev, res: unknown, ignoreErrors: boolean, fallbackStdout?: string | null): Ev {
  const r = isObj(res) ? res : {};
  e.changed = r.changed === true;
  e.res = resJson(res);
  e.diff = diffText(r.diff);
  const failing = e.kind === "host_failed" || e.kind === "item_failed" || e.kind === "host_unreachable";
  e.failed = failing && !ignoreErrors;
  e.msg = cut(str(r.msg) ?? (failing ? str(r.stderr) ?? str(r.stdout) ?? str(fallbackStdout) : str(r.skip_reason)), LIMITS.msg);
  return e;
}

export class EventNormalizer {
  private mode: Mode;
  private play: string | null = null;
  private task: string | null = null;
  // text mode state
  private pendingFail: Ev | null = null;
  private acc: { head: Ev; text: string; lines: number } | null = null;
  private loose: string[] = [];
  private inRecap = false;
  private recap: Record<string, HostStats> = {};
  private recapAt = 0;

  constructor(mode: Mode) { this.mode = mode; }

  push(line: string, at: number): Ev[] {
    if (this.mode === "text") return this.pushText(line, at);
    const t = line.trim();
    if (t === "") return [];
    const src: Ev["source"] = "events";
    let obj: unknown;
    if (t.startsWith("{")) { try { obj = JSON.parse(t); } catch { obj = undefined; } }
    if (!isObj(obj)) return [this.log(src, at, line)];
    return this.mode === "runner" ? this.runner(obj, at) : this.jsonl(obj, at);
  }

  finish(): Ev[] {
    if (this.mode !== "text") return [];
    const out: Ev[] = [];
    if (this.acc) { out.push(this.flushAcc(this.acc.text)); this.acc = null; }
    this.flushFail(out);
    if (Object.keys(this.recap).length > 0) {
      const e = blank("text", this.recapAt, "stats");
      e.res = cut(JSON.stringify(this.recap), LIMITS.res);
      out.push(e);
      this.recap = {};
    }
    return out;
  }

  private log(source: Ev["source"], at: number, text: string): Ev {
    const e = blank(source, at, "log");
    e.play = this.play; e.task = this.task;
    e.stdout = cut(text, LIMITS.stdout);
    return e;
  }

  // ---- ansible-runner ----
  private runner(o: Obj, at: number): Ev[] {
    const name = str(o.event) ?? "";
    const d = isObj(o.event_data) ? o.event_data : {};
    const stdout = str(o.stdout);
    const base = (kind: Kind): Ev => {
      const e = blank("events", at, kind);
      e.play = str(d.play); e.task = str(d.task); e.taskAction = str(d.task_action); e.host = str(d.host);
      return e;
    };
    switch (name) {
      case "playbook_on_start": return [base("playbook_start")];
      case "playbook_on_play_start": {
        const e = base("play_start"); e.play = str(d.play) ?? str(d.name); return [e];
      }
      case "playbook_on_task_start": case "playbook_on_handler_task_start": {
        const e = base("task_start"); e.task = str(d.task) ?? str(d.name); return [e];
      }
      case "runner_on_start": return [base("host_start")];
      case "playbook_on_stats": {
        const e = base("stats"); e.play = null; e.task = null; e.taskAction = null;
        e.res = cut(JSON.stringify(transposeRunnerStats(d)), LIMITS.res); return [e];
      }
      case "runner_on_file_diff": {
        const e = base("log"); e.diff = diffText(d.diff); e.stdout = cut(stdout, LIMITS.stdout);
        return e.diff || e.stdout ? [e] : [];
      }
    }
    const m = /^runner_on_(ok|failed|unreachable|skipped)$/.exec(name);
    const im = /^runner_item_on_(ok|failed|skipped)$/.exec(name);
    if (m || im) {
      const kind = m ? HOST_KINDS[m[1]!]! : ITEM_KINDS[im![1]!]!;
      return [withResult(base(kind), d.res, d.ignore_errors === true, stdout)];
    }
    return stdout ? [this.log("events", at, stdout)] : [];
  }

  // ---- ansible.posix.jsonl ----
  private jsonl(o: Obj, at: number): Ev[] {
    const name = str(o._event) ?? "";
    switch (name) {
      case "v2_playbook_on_play_start": {
        this.play = isObj(o.play) ? str(o.play.name) : null; this.task = null;
        const e = blank("events", at, "play_start"); e.play = this.play; return [e];
      }
      case "v2_playbook_on_task_start": case "v2_playbook_on_handler_task_start": {
        this.task = isObj(o.task) ? str(o.task.name) : null;
        const e = blank("events", at, "task_start"); e.play = this.play; e.task = this.task; return [e];
      }
      case "v2_playbook_on_stats": {
        const e = blank("events", at, "stats");
        e.res = cut(JSON.stringify(isObj(o.stats) ? o.stats : {}), LIMITS.res); return [e];
      }
    }
    const m = /^v2_runner_on_(ok|failed|unreachable|skipped)$/.exec(name);
    const im = /^v2_runner_item_on_(ok|failed|skipped)$/.exec(name);
    if (!m && !im) return [];
    const kind = m ? HOST_KINDS[m[1]!]! : ITEM_KINDS[im![1]!]!;
    const hosts = isObj(o.hosts) ? o.hosts : {};
    return Object.entries(hosts).map(([host, res]) => {
      const e = blank("events", at, kind);
      e.play = this.play; e.task = isObj(o.task) ? str(o.task.name) ?? this.task : this.task; e.host = host;
      e.taskAction = isObj(res) ? str(res.action) : null;
      return withResult(e, res, false);
    });
  }

  // ---- plain ansible-playbook text ----
  private text(kind: Kind, at: number): Ev {
    const e = blank("text", at, kind); e.play = this.play; e.task = this.task; return e;
  }

  private flushFail(out: Ev[]): void {
    if (this.pendingFail) { out.push(this.pendingFail); this.pendingFail = null; }
  }

  private takeLoose(e: Ev): void {
    if (this.loose.length === 0) return;
    const t = this.loose.join("\n"); this.loose = [];
    if (t.startsWith("--- ")) e.diff = cut(t, LIMITS.diff); else e.stdout = cut(t, LIMITS.stdout);
  }

  private flushAcc(json: string): Ev {
    const { head } = this.acc!;
    let res: unknown; try { res = JSON.parse(json); } catch { res = undefined; }
    withResult(head, res, false, res === undefined ? json : null);
    if (res === undefined) head.msg = cut(json, LIMITS.msg);
    return head;
  }

  private pushText(raw: string, at: number): Ev[] {
    const line = raw.replace(/\r$/, "");
    const out: Ev[] = [];
    if (this.acc) {
      this.acc.text += `\n${line}`;
      this.acc.lines += 1;
      // Still open and under the cap: keep collecting. Past the cap the text is flushed as an unparsed result
      // (msg/stdout carry the raw text) so the rest of the log is parsed normally instead of being swallowed.
      if (braceDepth(this.acc.text) > 0 && this.acc.lines < ACC_MAX_LINES) return out;
      const e = this.flushAcc(this.acc.text); this.acc = null;
      this.settle(e, out); return out;
    }
    if (line === "...ignoring") {
      if (this.pendingFail) { this.pendingFail.failed = false; }
      this.flushFail(out); return out;
    }
    this.flushFail(out);
    let m: RegExpExecArray | null;
    if ((m = /^PLAY RECAP\b/.exec(line))) { this.inRecap = true; this.recapAt = at; return out; }
    if (this.inRecap) {
      if ((m = /^(\S+)\s*:\s*ok=(\d+)\s+changed=(\d+)\s+unreachable=(\d+)\s+failed=(\d+)\s+skipped=(\d+)\s+rescued=(\d+)\s+ignored=(\d+)/.exec(line))) {
        this.recap[m[1]!] = { ok: +m[2]!, changed: +m[3]!, unreachable: +m[4]!, failures: +m[5]!, skipped: +m[6]!, rescued: +m[7]!, ignored: +m[8]! };
        this.recapAt = at;
      }
      return out;
    }
    if ((m = /^PLAY \[(.+)\] \*+$/.exec(line))) {
      this.play = m[1]!; this.task = null; this.loose = [];
      out.push(this.text("play_start", at)); return out;
    }
    if ((m = /^(?:TASK|RUNNING HANDLER) \[(?:(.+?) : )?(.+)\] \*+$/.exec(line))) {
      this.task = m[2]!; this.loose = [];
      out.push(this.text("task_start", at)); return out;
    }
    if ((m = /^(ok|changed|failed|fatal|skipping|unreachable): \[([^\]]+)\](?::? (?:FAILED|UNREACHABLE)!)?(?: => (.*))?$/.exec(line))) {
      const word = m[1]!;
      const unreach = word === "unreachable" || /UNREACHABLE!/.test(line);
      const isItem = m[3]?.startsWith("(item=") === true;
      const kind: Kind = word === "skipping" ? (isItem ? "item_skipped" : "host_skipped")
        : unreach ? "host_unreachable"
        : word === "ok" || word === "changed" ? (isItem ? "item_ok" : "host_ok")
        : (isItem ? "item_failed" : "host_failed");
      const head = this.text(kind, at); head.host = m[2]!; head.changed = word === "changed";
      head.failed = kind === "host_failed" || kind === "item_failed" || kind === "host_unreachable";
      this.takeLoose(head);
      const rest = m[3];
      if (rest && rest.startsWith("{")) {
        this.acc = { head, text: rest, lines: 1 };
        if (braceDepth(rest) > 0) return out;
        const e = this.flushAcc(rest); this.acc = null;
        this.settle(e, out); return out;
      }
      this.settle(head, out); return out;
    }
    if (line.trim() === "") return out;
    if (/^\[(WARNING|DEPRECATION WARNING|ERROR)\]/.test(line) || /^\[(WARNING|ERROR)\]:/.test(line)) {
      if (line.startsWith("[ERROR]")) this.loose = [line]; else out.push(this.log("text", at, line));
      return out;
    }
    this.loose.push(line);
    if (this.loose.length > 200) this.loose.shift();
    return out;
  }

  /** Failures wait one line so a trailing `...ignoring` can clear `failed`. */
  private settle(e: Ev, out: Ev[]): void {
    if (e.kind === "host_failed" || e.kind === "item_failed") this.pendingFail = e; else out.push(e);
  }
}

/** Brace depth of a JSON fragment, ignoring braces inside string literals. */
function braceDepth(s: string): number {
  let depth = 0, inStr = false, esc = false;
  for (const c of s) {
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === "{") depth++; else if (c === "}") depth--;
  }
  return depth;
}

const zeroStats = (): HostStats => ({ ok: 0, changed: 0, failures: 0, unreachable: 0, skipped: 0, rescued: 0, ignored: 0 });

/** runner's stats event_data is metric → {host: n}; store it host-keyed like the other sources. */
function transposeRunnerStats(d: Obj): Record<string, HostStats> {
  const out: Record<string, HostStats> = {};
  const metrics: [string, keyof HostStats][] = [["ok", "ok"], ["changed", "changed"], ["failures", "failures"], ["dark", "unreachable"], ["skipped", "skipped"], ["rescued", "rescued"], ["ignored", "ignored"]];
  for (const [src, dst] of metrics) {
    const m = d[src];
    if (!isObj(m)) continue;
    for (const [host, n] of Object.entries(m)) (out[host] ??= zeroStats())[dst] = typeof n === "number" ? n : 0;
  }
  return out;
}

export function recapFromStats(ev: RunEvent): Record<string, HostStats> | null {
  if (ev.kind !== "stats" || !ev.res) return null;
  let p: unknown; try { p = JSON.parse(ev.res); } catch { return null; }
  if (!isObj(p)) return null;
  const out: Record<string, HostStats> = {};
  for (const [host, v] of Object.entries(p)) {
    if (!isObj(v)) return null;
    const n = (k: string): number => (typeof v[k] === "number" ? v[k] : 0);
    out[host] = { ok: n("ok"), changed: n("changed"), failures: n("failures"), unreachable: n("unreachable") || n("dark"), skipped: n("skipped"), rescued: n("rescued"), ignored: n("ignored") };
  }
  return out;
}

export function statusFromExit(code: number | null, _hadStats: boolean, canceled: boolean): RunStatus {
  if (canceled) return "canceled";
  return code === 0 ? "success" : "failed";
}
