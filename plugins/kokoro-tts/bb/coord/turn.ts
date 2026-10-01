// Port of server/kokoro_turn.py; bb/coord/fixtures/turn.json pins parity.
// Turn routing: directive parsing, mode ceiling, fallback. Pure functions; no I/O.
import { decodeHTML } from "entities";
import type { Mode } from "../schemas.ts";
import { BOL, EOL, pyCollapse, pyStrip, WS } from "./pytext.ts";

export type Sound = "working" | "done" | "attention" | "error";
export type Routed = { action: "speech"; text: string } | { action: "sound"; sound: Sound } | { action: "silent" };
export interface CueSwitches { working_sound: boolean; attention_sound: boolean }

export const MAX_FALLBACK_CHARS = 240;
// "full" mode reads the whole reply; about six minutes of speech at most.
export const FULL_MAX_CHARS = 6000;

const WEIGHT_RANK: Record<string, number> = { silent: 0, "sound:working": 1, "sound:done": 2, "sound:attention": 3, speech: 4 };
const RANK_WEIGHT = Object.fromEntries(Object.entries(WEIGHT_RANK).map(([w, r]) => [r, w])) as Record<number, string>;
const MODE_CEILING: Record<string, number> = { quiet: 0, ambient: 3, brief: 4, conversational: 4, verbose: 4, full: 4 };

const S = `[${WS}]`;

// bb never shows HTML comments, so they are never spoken either.
const HTML_COMMENT = /<!--[\s\S]*?-->/gu;
// bb's message card: a leaf directive alone on its line, e.g.
// ::kokoro-tts{weight="speech" say="Tests pass."}. Values are HTML-entity
// decoded, as bb's directive parser does.
const DIRECTIVE = new RegExp(`${BOL}::kokoro-tts\\{([^\\n]*)\\}[ \\t\\r]*${EOL}`, "gu");
const ATTR = `([A-Za-z][\\p{L}\\p{N}_-]*)(?:=(?:"([^"]*)"|'([^']*)'|([^${WS}"'=<>\`}]+)))?`;
const DIRECTIVE_ATTR = new RegExp(ATTR, "gu");
// The whole body must be whitespace-separated attributes; anything else
// (e.g. an unescaped quote inside say) is not a directive.
const DIRECTIVE_BODY = new RegExp(`^${S}*(?:${ATTR}(?:${S}+${ATTR})*)?${S}*$`, "u");
const CODE_FENCE = /```[\s\S]*?```/gu;
const SENTENCE = new RegExp(`^(.+?[.!?])(?:${S}|$)`, "u");
const TABLE = new RegExp(`(?:${BOL}[ \\t]*\\|[^\\n]*\\|[ \\t]*(?:\\n|${EOL}))+`, "gu");
const HEADING = new RegExp(`${BOL}#+${S}*`, "gu");
const INLINE_CODE = /`([^`\n]+)`/gu;
const MAX_INLINE_CODE = 60;

// Python lengths and slices count code points; JS strings count UTF-16 units.
const codePoints = (s: string): string[] => Array.from(s);
// Python's str.rfind over code points.
const rfind = (chars: string[], needle: string): number => {
  const n = codePoints(needle);
  for (let i = chars.length - n.length; i >= 0; i--) if (n.every((c, j) => chars[i + j] === c)) return i;
  return -1;
};
const own = (table: Record<string, number>, key: string): number | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

/**
 * Attributes of a directive's {...} body: key="v", key='v', key=v, or a bare key.
 * null when the body is malformed, so the reply falls back to its first
 * sentence just as bb shows the line as literal text.
 */
function parseDirectiveAttrs(raw: string): Map<string, string> | null {
  if (!DIRECTIVE_BODY.test(raw)) return null;
  const attrs = new Map<string, string>();
  for (const m of raw.matchAll(DIRECTIVE_ATTR)) attrs.set(m[1], decodeHTML(m[2] ?? m[3] ?? m[4] ?? ""));
  return attrs;
}

function fenceSpans(text: string): [number, number][] {
  return Array.from(text.matchAll(CODE_FENCE), (m) => [m.index, m.index + m[0].length]);
}

/** Remove HTML comments and directive lines (for fallback and full mode). */
function stripDirectives(text: string): string {
  return text.replace(HTML_COMMENT, "").replace(DIRECTIVE, "");
}

/**
 * [weight, say] from the reply's last kokoro-tts directive, or [null, null].
 * Directives inside code fences are examples, not the reply's directive,
 * and malformed ones are skipped (bb shows both as text).
 */
export function extractDirective(text: string): [weight: string | null, say: string | null] {
  const fences = fenceSpans(text);
  for (const m of Array.from(text.matchAll(DIRECTIVE)).reverse()) {
    if (fences.some(([s, e]) => s <= m.index && m.index < e)) continue;
    const attrs = parseDirectiveAttrs(m[1]);
    if (attrs === null) continue;
    return [attrs.get("weight") ?? "", pyStrip(attrs.get("say") ?? "") || null];
  }
  return [null, null];
}

/** First speakable sentence of the turn, directives, comments, and fences stripped. */
export function firstSentence(text: string): string | null {
  text = stripDirectives(text).replace(CODE_FENCE, "");
  text = pyStrip(pyCollapse(pyStrip(text).replace(HEADING, "")));
  if (!text) return null;
  const m = SENTENCE.exec(text);
  return codePoints(m ? m[1] : text).slice(0, MAX_FALLBACK_CHARS).join("");
}

function speakInlineCode(code: string): string {
  code = pyStrip(code);
  if (code.includes("://") || codePoints(code).length > MAX_INLINE_CODE) return "";
  if (code.includes("/") && !code.includes(" ")) return code.replace(/\/+$/u, "").split("/").at(-1)!;
  return code;
}

/**
 * The whole reply for "full" mode, ready for the markdown strip.
 * Directives and comments go; code blocks and tables become a short spoken marker;
 * short inline code is read as written, a path as its file name.
 * Replies over FULL_MAX_CHARS are cut at a sentence or line end.
 */
export function fullText(text: string): string | null {
  text = stripDirectives(text)
    .replace(CODE_FENCE, "\n\nCode block skipped.\n\n")
    .replace(TABLE, "\nTable skipped.\n\n")
    .replace(INLINE_CODE, (_, code: string) => speakInlineCode(code));
  text = pyStrip(text);
  if (!text) return null;
  const capped = capSpeech(text);
  return capped === text ? text : capped + "\n\nThe rest is on screen.";
}

/**
 * Speech text cut to at most FULL_MAX_CHARS code points, at the last sentence
 * or line end past the halfway point when there is one. Every spoken text
 * goes through it, so no reply asks an engine for more than about six minutes.
 */
export function capSpeech(text: string): string {
  const chars = codePoints(text);
  if (chars.length <= FULL_MAX_CHARS) return text;
  let cut = chars.slice(0, FULL_MAX_CHARS);
  const end = Math.max(rfind(cut, ". "), rfind(cut, "\n"));
  if (end > Math.floor(FULL_MAX_CHARS / 2)) cut = cut.slice(0, end + 1);
  return cut.join("").replace(new RegExp(`${S}+$`, "u"), "");
}

/** Decide what a finished turn sounds like, before the cue switches. */
export function routeTurn(text: string, mode: Mode): Routed {
  if (mode === "full") {
    // The reply itself is the speech; directives and weights are ignored.
    const content = fullText(text);
    return content ? { action: "speech", text: content } : { action: "silent" };
  }
  let [weight, content] = extractDirective(text);
  if (weight === null) {
    const fallback = firstSentence(text);
    if (fallback === null) return { action: "silent" };
    [weight, content] = ["speech", fallback];
  }
  const rank = Math.min(own(WEIGHT_RANK, weight) ?? 0, own(MODE_CEILING, mode) ?? 4);
  weight = RANK_WEIGHT[rank];
  if (weight === "silent") return { action: "silent" };
  if (weight.startsWith("sound:")) return { action: "sound", sound: weight.slice("sound:".length) as Sound };
  if (!content) return { action: "sound", sound: "done" };
  return { action: "speech", text: capSpeech(content) };
}

/** Gate the standalone attention ping an agent's pending prompt plays. */
export function routeCue(sound: string, mode: Mode, cfg: CueSwitches): Routed {
  if (sound !== "attention" || own(MODE_CEILING, mode) === 0) return { action: "silent" };
  if (!cfg.attention_sound) return { action: "silent" };
  return { action: "sound", sound };
}

/**
 * Honor the Working tick and Attention ping switches for a turn's sound.
 * A reply capped to the attention ping (ambient mode) still ends with the
 * done cue when pings are off, so a finished reply is never silent just
 * because the ping is disabled.
 */
export function applyCuePrefs(r: Routed, cfg: CueSwitches): Routed {
  if (r.action !== "sound") return r;
  if (r.sound === "working" && !cfg.working_sound) return { action: "silent" };
  if (r.sound === "attention" && !cfg.attention_sound) return { action: "sound", sound: "done" };
  return r;
}

/** routeTurn then applyCuePrefs — what a finished turn sounds like. */
export function route(text: string, mode: Mode, cfg: CueSwitches): Routed {
  return applyCuePrefs(routeTurn(text, mode), cfg);
}
