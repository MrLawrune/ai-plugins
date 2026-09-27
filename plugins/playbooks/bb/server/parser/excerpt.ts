export function excerpt(content: string, startLine: number, endLine: number, maxBytes: number): string {
  const lines = content.split("\n").slice(Math.max(0, startLine - 1), endLine);
  const out: string[] = []; let bytes = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = `${startLine + i} | ${lines[i]}`; const b = Buffer.byteLength(l) + 1;
    if (bytes + b > maxBytes) { out.push(`… (${lines.length - i} more lines)`); break; }
    out.push(l); bytes += b;
  }
  return out.join("\n");
}
