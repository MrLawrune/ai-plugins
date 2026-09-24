// Maps a DOM caret/selection inside bb's ProseMirror editor to offsets in the composer's plain-text
// draft. bb's plugin API exposes only whole-draft edits, so the plugin rebuilds the draft text from
// the editor DOM and trusts the caret only when that rebuild matches the draft exactly.

export interface DomNode {
  nodeType: number;
  nodeName: string;
  data?: string;
  className?: unknown; // string for HTML elements, SVGAnimatedString for SVG
  childNodes: ArrayLike<DomNode>;
}
export interface DomPoint { node: DomNode; offset: number }

const TEXT = 3;
const SEPARATORS = ["\n", "\n\n"];

class Stop extends Error {}

function serialize(root: DomNode, sep: string, stop: DomPoint | null): string {
  let out = "";
  const inline = (node: DomNode): void => {
    if (stop && node === stop.node) {
      if (node.nodeType === TEXT) { out += (node.data ?? "").slice(0, stop.offset); throw new Stop(); }
      for (let i = 0; i < stop.offset && i < node.childNodes.length; i++) inline(node.childNodes[i]);
      throw new Stop();
    }
    if (node.nodeType === TEXT) { out += node.data ?? ""; return; }
    if (node.nodeName === "BR") { if (!(typeof node.className === "string" ? node.className : "").includes("ProseMirror-trailingBreak")) out += "\n"; return; }
    if (node.nodeName === "IMG") return;
    for (let i = 0; i < node.childNodes.length; i++) inline(node.childNodes[i]);
  };
  try {
    const blocks = Array.from(root.childNodes).filter((n) => n.nodeType !== TEXT || (n.data ?? "").trim() !== "");
    if (stop && stop.node === root) {
      for (let i = 0; i < stop.offset && i < blocks.length; i++) { if (i) out += sep; inline(blocks[i]); }
      if (stop.offset > 0 && stop.offset < blocks.length) out += sep;
      return out;
    }
    blocks.forEach((b, i) => { if (i) out += sep; inline(b); });
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
  }
  return out;
}

export function locateCaret(root: DomNode, start: DomPoint, end: DomPoint, draft: string): { start: number; end: number } | null {
  for (const sep of SEPARATORS) {
    if (serialize(root, sep, null) !== draft) continue;
    const a = serialize(root, sep, start).length;
    const b = serialize(root, sep, end).length;
    return { start: Math.min(a, b), end: Math.max(a, b) };
  }
  return null;
}
