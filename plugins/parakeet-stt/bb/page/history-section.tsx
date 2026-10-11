// What was dictated, newest first, and how long it is kept. Audio is never stored.
import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { rpcContract } from "../contract.ts";
import { HISTORY_MAX_AGE_DAYS, HISTORY_MAX_ENTRIES, type HistoryEntry, type Prefs } from "../schemas.ts";
import { SHARED, SLIDER_DEBOUNCE_MS } from "./dictation-sections.tsx";
import type { PrefsPatch } from "./panel-state.ts";
import { errorText } from "./error-text.ts";
import { Row, Section, SliderRow } from "./ui.tsx";

const SOURCE_LABEL: Record<HistoryEntry["source"], string> = {
  oneshot: "One-shot",
  stream: "Continuous",
  voice: "Voice button",
};

/** A whole-number field that saves on blur or Enter, and only when within range, so it can be cleared and retyped. */
function DaysRow({ id, label, value, min, max, onSave }: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onSave: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setText(String(value)); setInvalid(false); }, [value]);
  const commit = () => {
    const t = text.trim();
    if (!/^\d+$/.test(t) || Number(t) < min || Number(t) > max) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (Number(t) !== value) onSave(Number(t));
  };
  return (
    <Row label={label} hint={`${min}–${max} days. ${SHARED}`} htmlFor={id}>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={text}
        className="w-28"
        aria-invalid={invalid}
        onChange={(e) => { setText(e.target.value); setInvalid(false); }}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
      />
      {invalid ? <p role="alert" className="mt-1 text-xs text-destructive">{`Between ${min} and ${max} days.`}</p> : null}
    </Row>
  );
}

export function HistorySection({ prefs, patch }: { prefs: Prefs | null; patch: PrefsPatch }) {
  const rpc = useRpc<typeof rpcContract>();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(() => rpc.call("listHistory").then(
    (r) => setEntries([...r.entries].sort((a, b) => b.at - a.at)),
    (cause) => { setEntries([]); toast.error(errorText(cause)); },
  ), [rpc]);
  useEffect(() => { void load(); }, [load]);

  const clear = async () => {
    setClearing(true);
    try {
      await rpc.call("clearHistory");
      setEntries([]);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setClearing(false);
      setConfirming(false);
    }
  };

  const actions = confirming ? (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm">Delete every entry?</span>
      <Button variant="destructive" size="sm" disabled={clearing} onClick={() => void clear()}>Clear all</Button>
      <Button variant="ghost" size="sm" disabled={clearing} onClick={() => setConfirming(false)}>Cancel</Button>
    </div>
  ) : (
    <Button variant="ghost" size="sm" disabled={!entries?.length} onClick={() => setConfirming(true)}>Clear</Button>
  );

  return (
    <Section title="History" description="What you dictated, kept on the server. Audio is never kept." actions={actions}>
      {prefs ? (
        <>
          <SliderRow id="history-entries" label="Entries to keep" hint={`0 records nothing. ${SHARED}`} value={prefs.historyMaxEntries}
            min={0} max={HISTORY_MAX_ENTRIES} step={10} format={String} onChange={(historyMaxEntries) => patch({ historyMaxEntries }, SLIDER_DEBOUNCE_MS)} />
          <DaysRow id="history-days" label="Keep for" value={prefs.historyMaxAgeDays} min={1} max={HISTORY_MAX_AGE_DAYS}
            onSave={(historyMaxAgeDays) => patch({ historyMaxAgeDays })} />
        </>
      ) : null}
      {entries === null ? null : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No transcriptions yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {entries.map((h) => (
            <li key={h.id} data-testid="history-entry" className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="break-words text-sm">{h.text}</p>
                <p className="text-xs text-muted-foreground">
                  {SOURCE_LABEL[h.source]} · {new Date(h.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })} · {(h.durationMs / 1000).toFixed(1)} s
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(h.text).then(() => toast("Copied"), (e) => toast.error(errorText(e)))}>Copy</Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
