// Port of server/kokoro_server.py strip_markdown / sentence_chunks / _norm_text;
// bb/coord/fixtures/{strip,chunks}.json pin parity.
import { Marked } from "marked";
import { decodeHTML } from "entities";
import { BOL, EOL, pyCollapse, pyStrip, WS } from "./pytext.ts";

const S = `[${WS}]`;

const LINK_URL = new RegExp(`https?://[^${WS})]+`, "gu");
const PATH_CODE = /`[~/][^`]+`/gu;
const HOME_PATH = new RegExp(`(?:^|${S})~/[a-zA-Z0-9_./-]+`, "gu");
const ABS_PATH = new RegExp(`(?:^|${S})/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_./-]*`, "gu");
const TABLE_ROW = new RegExp(`${BOL}\\|[^\\n]*\\|${EOL}`, "gu");
const TABLE_RULE = new RegExp(`${BOL}${S}*\\|[-:${WS}|]+\\|${S}*${EOL}`, "gu");
// mistune's strikethrough plugin: ~~ only (a single ~ stays literal), no space just inside.
const STRIKE_START = new RegExp(`^~~(?=[^${WS}~])`, "u");
const STRIKE_END = new RegExp(`(?:(?<!\\\\)(?:\\\\\\\\)*\\\\~|[^${WS}~])~~(?!~)`, "u");
const SENTENCE_END = new RegExp(`(?<=[.!?;:])${S}+`, "u");

// Mirrors mistune's PlainTextRenderer in server/kokoro_server.py.
// gfm is off because mistune has no tables, task lists, or single-tilde strikethrough.
const md = new Marked({
  gfm: false,
  extensions: [
    {
      name: "strike",
      level: "inline",
      start: (src) => src.indexOf("~~"),
      tokenizer(src) {
        if (!STRIKE_START.test(src)) return undefined;
        const end = STRIKE_END.exec(src.slice(2));
        if (!end) return undefined;
        const stop = 2 + end.index + end[0].length;
        return { type: "strike", raw: src.slice(0, stop), tokens: this.lexer.inlineTokens(src.slice(2, stop - 2)) };
      },
      renderer(t) {
        return this.parser.parseInline(t.tokens ?? []);
      },
    },
  ],
  renderer: {
    text(t) {
      return "tokens" in t && t.tokens ? this.parser.parseInline(t.tokens) : t.text;
    },
    em({ tokens }) {
      return this.parser.parseInline(tokens);
    },
    strong({ tokens }) {
      return this.parser.parseInline(tokens);
    },
    codespan: () => "",
    code: () => "",
    link({ tokens }) {
      return this.parser.parseInline(tokens);
    },
    image: ({ text }) => text,
    heading({ tokens }) {
      return this.parser.parseInline(tokens) + ". ";
    },
    paragraph({ tokens }) {
      return this.parser.parseInline(tokens) + " ";
    },
    list(l) {
      return l.items.map((it) => this.listitem(it)).join("");
    },
    listitem(it) {
      return pyStrip(this.parser.parse(it.tokens, it.loose)) + ". ";
    },
    hr: () => "",
    blockquote({ tokens }) {
      return this.parser.parse(tokens);
    },
    br: () => " ",
    html: () => "",
    space: () => "",
  },
});

const isVariationSelector = (c: string): boolean => {
  const cp = c.codePointAt(0)!;
  return cp >= 0xfe00 && cp <= 0xfe0f;
};

/** Markdown to speakable plain text: links, paths, code, tables and symbols removed. */
export function stripMarkdown(text: string): string {
  text = text
    .replace(LINK_URL, "")
    .replace(PATH_CODE, "")
    .replace(HOME_PATH, " ")
    .replace(ABS_PATH, " ")
    .replace(TABLE_ROW, "")
    .replace(TABLE_RULE, "");
  let out = md.parse(text, { async: false }) as string;
  out = pyCollapse(out.replace(/`/gu, "").replace(/\[\]|\(\)/gu, ""));
  out = Array.from(out).filter((c) => !/\p{So}/u.test(c) && !isVariationSelector(c)).join("");
  return pyStrip(pyCollapse(decodeHTML(out)));
}

/** Split text at sentence boundaries into groups of at most maxChars code points. */
export function sentenceChunks(text: string, maxChars = 220): string[] {
  const len = (s: string): number => Array.from(s).length;
  const parts = pyStrip(text).split(SENTENCE_END).map(pyStrip).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const part of parts) {
    if (cur && len(cur) + 1 + len(part) > maxChars) {
      out.push(cur);
      cur = part;
    } else {
      cur = pyStrip(`${cur} ${part}`);
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : pyStrip(text) ? [pyStrip(text)] : [];
}

/** Speech-log text: whitespace collapsed to single spaces, trimmed, first 2000 code points. */
export function normalizeLogText(text: string): string {
  return Array.from(pyStrip(pyCollapse(text))).slice(0, 2000).join("");
}
