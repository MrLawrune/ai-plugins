// bb-plugin-kokoro-tts — "History" section: speech-log retention and clearing.
import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { rpcContract } from "../contract.ts";
import type { Settings, SettingsPatch } from "../schemas.ts";
import { errorText, Row, Section } from "./ui.tsx";

type Retention = Settings["retention"];

/** A whole-number input that saves on blur or Enter, and only when within range. */
function LimitRow({ id, label, unit, value, min, max, onSave }: {
  id: string;
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  onSave: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setText(String(value)); setInvalid(false); }, [value]);
  const commit = () => {
    const n = Number(text.trim());
    if (!/^\d+$/.test(text.trim()) || n < min || n > max) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (n !== value) onSave(n);
  };
  return (
    <Row label={label} htmlFor={id}>
      <div className="flex items-center gap-2">
        <Input id={id} type="number" inputMode="numeric" min={min} max={max} step={1} value={text} className="w-28"
          aria-invalid={invalid} onChange={(e) => setText(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />
        <span className="text-sm text-muted-foreground">{unit}</span>
      </div>
      {invalid ? <p role="alert" className="mt-1 text-xs text-destructive">{`Between ${min} and ${max} ${unit}.`}</p> : null}
    </Row>
  );
}

export function HistorySection({ config, patch }: { config: Settings; patch: (p: SettingsPatch) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const { retention } = config;
  const save = (p: Partial<Retention>) => patch({ retention: { ...retention, ...p } });

  const clear = async () => {
    setClearing(true);
    try {
      const { deleted } = await rpc.call("clearHistory");
      toast.success(`Cleared ${deleted} ${deleted === 1 ? "entry" : "entries"}`);
    } catch (cause) {
      toast.error(`Kokoro: ${errorText(cause)}`);
    } finally {
      setClearing(false);
      setConfirming(false);
    }
  };

  return (
    <Section title="History" description="What was spoken, shown on each reply's card. Audio is never kept.">
      <LimitRow id="maxAgeDays" label="Keep history for" unit="days" value={retention.maxAgeDays} min={1} max={90}
        onSave={(maxAgeDays) => save({ maxAgeDays })} />
      <LimitRow id="maxEntries" label="Keep at most" unit="entries" value={retention.maxEntries} min={100} max={10000}
        onSave={(maxEntries) => save({ maxEntries })} />
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">Delete every entry? Cards will show No record.</span>
          <Button variant="destructive" size="sm" disabled={clearing} onClick={() => void clear()}>Clear all</Button>
          <Button variant="ghost" size="sm" disabled={clearing} onClick={() => setConfirming(false)}>Cancel</Button>
        </div>
      ) : (
        <div>
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>Clear history</Button>
        </div>
      )}
    </Section>
  );
}
