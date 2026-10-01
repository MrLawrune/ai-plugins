// Python's notion of whitespace, so the TS ports agree with the Python originals.

// Python's \s (str.isspace); JS \s differs (adds U+FEFF, lacks U+001C-U+001F and U+0085).
export const WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
// Python re.MULTILINE ^ and $ break lines at \n only; JS's m flag also breaks at \r, U+2028 and U+2029.
export const BOL = "(?<![^\\n])";
export const EOL = "(?![^\\n])";
const WS_CLASS = new RegExp(`[${WS}]`, "u");
const WS_RUN = new RegExp(`[${WS}]+`, "gu");

// Every Python whitespace character is in the BMP, so testing UTF-16 units is exact.
const isSpace = (s: string, i: number): boolean => WS_CLASS.test(s[i]);

/** Python's str.strip(): a linear scan from both ends. */
export function pyStrip(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isSpace(s, start)) start++;
  while (end > start && isSpace(s, end - 1)) end--;
  return s.slice(start, end);
}

/** Python's re.sub(r"\s+", " ", s). */
export function pyCollapse(s: string): string {
  return s.replace(WS_RUN, " ");
}
