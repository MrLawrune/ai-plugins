// "Ask agent" menu model (pure, testable).
import type { AskIntent } from "../schemas.ts";

export type TargetKind = "env" | "host" | "guest";
const NOUN: Record<TargetKind, string> = { env: "environment", host: "host", guest: "guest" };

export const ASK_MENU: { intent: AskIntent; verb: string }[] = [
  { intent: "ask", verb: "Ask an agent about" },
  { intent: "investigate", verb: "Investigate" },
  { intent: "troubleshoot", verb: "Troubleshoot" },
];

export function labelFor(intent: AskIntent, kind: TargetKind): string {
  const verb = ASK_MENU.find((m) => m.intent === intent)!.verb;
  return `${verb} this ${NOUN[kind]}`;
}
