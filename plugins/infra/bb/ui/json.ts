/** RPC inputs must be strict JSON: omit keys whose value is undefined. */
export function dropUndefined<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as T;
}
