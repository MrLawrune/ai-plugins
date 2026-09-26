// What a new user still has to configure, reported through bb.status.needsConfiguration.
const WHERE = "Settings → Plugins → Infra → Environments";

export function configurationGap(
  envs: { id: string; name: string }[],
  connections: { id: string; envId: string; enabled: boolean }[],
  hasSecret: (connectionId: string) => boolean,
): string | null {
  if (!envs.length) return `Add an environment and a Proxmox connection in ${WHERE}.`;
  const usable = connections.filter((c) => c.enabled && hasSecret(c.id));
  if (usable.length) return null;
  const enabled = connections.filter((c) => c.enabled);
  if (!connections.length) return `Add a Proxmox connection to ${envs[0]!.name} in ${WHERE}.`;
  if (!enabled.length) return `Enable a Proxmox connection in ${WHERE}.`;
  return `Save a token or password for a Proxmox connection in ${WHERE}.`;
}
