// Devices and profiles: name this device, pick which profile the settings below edit, assign
// profiles to devices, and create, rename, or delete profiles.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DeviceRecord, ProfileInfo } from "../schemas.ts";
import { errorText, Row, Section } from "./ui.tsx";

const KIND_LABEL = { touch: "touch screen", desktop: "desktop" } as const;
const SELECT = "rounded-md border bg-transparent px-2 py-1 text-sm";

function ago(ms: number, now: number): string {
  const m = Math.round((now - ms) / 60_000);
  if (m < 2) return "now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export interface ProfilesApi {
  renameDevice(id: string, name: string): Promise<void>;
  assign(deviceId: string, profileId: string): Promise<void>;
  forget(deviceId: string): Promise<void>;
  create(name: string, copyFrom: string): Promise<ProfileInfo>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export function ProfilesSection({ me, devices, profiles, editing, onEdit, api }: {
  me: DeviceRecord;
  devices: DeviceRecord[];
  profiles: ProfileInfo[];
  editing: string;
  onEdit(profileId: string): void;
  api: ProfilesApi;
}) {
  const [deviceName, setDeviceName] = useState(me.name);
  const current = profiles.find((p) => p.id === editing);
  const [profileName, setProfileName] = useState(current?.name ?? "");
  useEffect(() => setDeviceName(me.name), [me.name]);
  useEffect(() => setProfileName(current?.name ?? ""), [current?.name]);
  const run = (p: Promise<unknown>) => void p.catch((e) => toast.error(errorText(e)));
  const now = Date.now();
  const nameOf = (id: string) => profiles.find((p) => p.id === id)?.name ?? id;

  return (
    <Section
      title="Devices and profiles"
      description="Each browser is a device and uses one profile. Settings marked shared apply to every profile."
    >
      <Row label="This device" hint={`${KIND_LABEL[me.kind]} · uses ${nameOf(me.profileId)}`} htmlFor="device-name">
        <Input id="device-name" value={deviceName} onChange={(e) => setDeviceName(e.target.value)}
          onBlur={() => { if (deviceName.trim() && deviceName !== me.name) run(api.renameDevice(me.id, deviceName)); }} />
      </Row>
      <Row label="Editing profile" hint="The settings below change this profile" htmlFor="editing">
        <div className="flex flex-wrap items-center gap-2">
          <select id="editing" className={SELECT} value={editing} onChange={(e) => onEdit(e.target.value)}>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === me.profileId ? " (this device)" : ""}</option>)}
          </select>
          {editing !== me.profileId && (
            <Button size="sm" variant="outline" onClick={() => run(api.assign(me.id, editing))}>Use on this device</Button>
          )}
          <Button size="sm" variant="outline" onClick={() => run(api.create(`${current?.name ?? "Profile"} copy`, editing).then((p) => onEdit(p.id)))}>Copy</Button>
          {profiles.length > 1 && (
            <Button size="sm" variant="ghost" onClick={() => run(api.remove(editing).then(() => onEdit(me.profileId === editing ? profiles.find((p) => p.id !== editing)!.id : me.profileId)))}>Delete</Button>
          )}
        </div>
      </Row>
      <Row label="Profile name" htmlFor="profile-name">
        <Input id="profile-name" value={profileName} onChange={(e) => setProfileName(e.target.value)}
          onBlur={() => { if (profileName.trim() && profileName !== current?.name) run(api.rename(editing, profileName)); }} />
      </Row>
      {devices.map((d) => (
        <Row key={d.id} label={d.id === me.id ? `${d.name} (this device)` : d.name} hint={`${KIND_LABEL[d.kind]} · seen ${ago(d.lastSeen, now)}`} htmlFor={`dev-${d.id}`}>
          <div className="flex items-center gap-2">
            <select id={`dev-${d.id}`} className={SELECT} value={d.profileId} onChange={(e) => run(api.assign(d.id, e.target.value))}>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {d.id !== me.id && <Button size="sm" variant="ghost" onClick={() => run(api.forget(d.id))}>Forget</Button>}
          </div>
        </Row>
      ))}
    </Section>
  );
}
