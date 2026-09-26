// bb-plugin-kokoro-tts — "Where it plays" section: playback target, route, devices, output.
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { DEVICE_NAME_EVENT, readClientId, readDeviceName, writeDeviceName } from "../player/device.ts";
import type { DeviceInfo, KokoroConfig, Prefs, PublicClientInfo } from "../schemas.ts";
import { Row, Section, SliderRow, SwitchRow } from "./ui.tsx";

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

interface DeviceGroup {
  deviceName: string;
  windows: PublicClientInfo[];
  mostRecentFocus: number;
}

/** Group live clients by device name, newest-focused device (and window) first. */
function groupByDevice(clients: PublicClientInfo[]): DeviceGroup[] {
  const byName = new Map<string, PublicClientInfo[]>();
  for (const c of clients) {
    const list = byName.get(c.deviceName) ?? [];
    list.push(c);
    byName.set(c.deviceName, list);
  }
  const groups = [...byName.entries()].map(([deviceName, windows]) => {
    const sorted = [...windows].sort((a, b) => b.focusedAt - a.focusedAt);
    return { deviceName, windows: sorted, mostRecentFocus: sorted[0].focusedAt };
  });
  return groups.sort((a, b) => b.mostRecentFocus - a.mostRecentFocus);
}

export function WhereSection({ prefs, setPrefs, config, patch, clients, devices, reloadDevices, pauseSupported, headless }: {
  prefs: Prefs;
  setPrefs: (p: Partial<Prefs>) => Promise<boolean>;
  config: KokoroConfig;
  patch: (p: Partial<KokoroConfig>, debounceMs?: number) => void;
  /** From the shared status poll; no separate client polling. */
  clients: PublicClientInfo[];
  devices: DeviceInfo[];
  reloadDevices: () => Promise<void>;
  /** The server can pause other media (Linux with playerctl). */
  pauseSupported: boolean;
  /** The server host has no audio output: server playback is unavailable. */
  headless: boolean;
}) {
  const myId = useMemo(() => readClientId(sessionStorage), []);
  const [name, setName] = useState(() => readDeviceName(localStorage, navigator.userAgent));

  const deviceNames = useMemo(() => {
    const names = new Set(clients.map((c) => c.deviceName));
    if (prefs.pinnedDevice) names.add(prefs.pinnedDevice);
    return [...names].sort();
  }, [clients, prefs.pinnedDevice]);

  const deviceGroups = useMemo(() => groupByDevice(clients), [clients]);
  // Whether this window is on the computer running bb (only there can other media be paused).
  const thisWindowLocal = clients.find((c) => c.clientId === myId)?.local;

  const saveName = () => {
    writeDeviceName(localStorage, name);
    setName(readDeviceName(localStorage, navigator.userAgent));
    window.dispatchEvent(new Event(DEVICE_NAME_EVENT));
  };

  const outputValue = config.output_device === null ? "default" : String(config.output_device);

  return (
    <Section title="Where it plays">
      <Row
        label="Play audio"
        hint={headless ? "The server has no audio output, so replies play in a bb window." : undefined}
        htmlFor="playback"
      >
        <Select value={prefs.playback} onValueChange={(v) => void setPrefs({ playback: v as Prefs["playback"] })}>
          <SelectTrigger id="playback" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="client">In a bb window</SelectItem>
            <SelectItem value="server" disabled={headless}>On the server's speakers</SelectItem>
          </SelectContent>
        </Select>
      </Row>

      {thisWindowLocal && pauseSupported ? (
        <SwitchRow
          id="other_audio"
          label="Pause other media while speech plays here"
          hint="Music and videos on this computer pause while a reply plays here or on its speakers, then resume. Replies going to another device leave them alone."
          checked={config.other_audio === "pause"}
          onChange={(v) => patch({ other_audio: v ? "pause" : "keep" })}
        />
      ) : null}

      {prefs.playback === "client" ? (
        <>
          <Row label="Route" htmlFor="playOn">
            <Select value={prefs.playOn} onValueChange={(v) => void setPrefs({ playOn: v as Prefs["playOn"] })}>
              <SelectTrigger id="playOn" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="follow">The window I used last</SelectItem>
                <SelectItem value="pinned">A chosen device</SelectItem>
                <SelectItem value="all">Every open window</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          {prefs.playOn === "pinned" ? (
            <Row label="Pinned device" hint="If it just went offline, replies wait up to 15 minutes for it; otherwise they play in the window you used last." htmlFor="pinnedDevice">
              <Select value={prefs.pinnedDevice ?? ""} onValueChange={(v) => void setPrefs({ pinnedDevice: v })}>
                <SelectTrigger id="pinnedDevice" className="w-full"><SelectValue placeholder="Choose a device" /></SelectTrigger>
                <SelectContent>
                  {deviceNames.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                </SelectContent>
              </Select>
            </Row>
          ) : null}
          <Row label="This device's name" htmlFor="deviceName">
            <div className="flex gap-2">
              <Input id="deviceName" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
              <Button size="sm" variant="outline" onClick={saveName}>Save</Button>
            </div>
          </Row>
          <ul className="space-y-1.5 text-sm">
            {deviceGroups.length === 0 ? <li className="text-xs text-muted-foreground">No windows connected.</li> : null}
            {deviceGroups.map((g) => {
              const anyUnlocked = g.windows.some((w) => w.audioUnlocked);
              return (
                <li key={g.deviceName} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn("size-2 shrink-0 rounded-full", anyUnlocked ? "bg-emerald-500" : "bg-amber-500")}
                      title={anyUnlocked ? "Audio enabled" : "Click in that window to enable audio"}
                    />
                    <span className="truncate">{g.deviceName}</span>
                    {g.windows.length > 1 ? (
                      <span className="text-xs text-muted-foreground">{g.windows.length} windows</span>
                    ) : null}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {g.mostRecentFocus ? `used ${ago(g.mostRecentFocus)}` : "not used yet"}
                    </span>
                  </div>
                  <ul className="ml-4 space-y-1 border-l border-border pl-3">
                    {g.windows.map((w, i) => (
                      <li key={w.clientId} className="flex items-center gap-2">
                        <span
                          className={cn("size-2 shrink-0 rounded-full", w.audioUnlocked ? "bg-emerald-500" : "bg-amber-500")}
                          title={w.audioUnlocked ? "Audio enabled" : "Click in that window to enable audio"}
                        />
                        {w.clientId === myId ? (
                          <Badge variant="outline">this window</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">{`window ${i + 1}`}</span>
                        )}
                        <span className="ml-auto text-xs text-muted-foreground">
                          {w.focusedAt ? `used ${ago(w.focusedAt)}` : "not used yet"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <>
          <SliderRow
            id="lead_in_ms"
            label="Lead-in silence"
            hint="Played before speech so a sleeping Bluetooth sink wakes without clipping the first word."
            value={config.lead_in_ms}
            min={0}
            max={1500}
            step={50}
            format={(v) => `${Math.round(v)} ms`}
            onChange={(v) => patch({ lead_in_ms: Math.round(v) }, 350)}
          />
          <SliderRow
            id="gap_ms"
            label="Sentence gap"
            hint="Silence inserted between sentence groups."
            value={config.gap_ms}
            min={0}
            max={500}
            step={10}
            format={(v) => `${Math.round(v)} ms`}
            onChange={(v) => patch({ gap_ms: Math.round(v) }, 350)}
          />
          <Row label="Device" htmlFor="output_device">
            <Select
              value={outputValue}
              onValueChange={(v) => patch({ output_device: v === "default" ? null : Number.parseInt(v, 10) })}
            >
              <SelectTrigger id="output_device" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">System default</SelectItem>
                {devices.map((d) => (
                  <SelectItem key={d.index} value={String(d.index)}>
                    {d.name}
                    {d.default ? <span className="ml-2 text-xs text-muted-foreground">current default</span> : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Button variant="ghost" size="sm" onClick={() => void reloadDevices()}>
            Rescan devices
          </Button>
        </>
      )}
    </Section>
  );
}
