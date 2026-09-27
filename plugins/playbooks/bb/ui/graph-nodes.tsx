// Custom React Flow nodes: every kind is a host-token-styled card (default nodes ignore host tokens in dark mode).
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { cn } from "@/lib/utils";
import { CellGlyph } from "./badges.tsx";
import { stateBorderClass, type FlowNode } from "./graph-model.ts";

const handle = "!size-1.5 !border-0 !bg-border";

function Card({ selected, className, children }: { selected: boolean; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("w-[190px] rounded-md border bg-card px-2 py-1 text-xs text-foreground shadow-sm", selected && "ring-2 ring-primary", className)}>
      {children}
    </div>
  );
}

function Label({ label, sub, mono }: { label: string; sub?: string; mono?: boolean }) {
  return (
    <>
      <div className={cn("truncate font-medium", mono && "font-mono")} title={label}>{label}</div>
      {sub ? <div className="truncate text-muted-foreground" title={sub}>{sub}</div> : null}
    </>
  );
}

function HostsNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <Card selected={selected} className="border-dashed">
      <Label label={data.label} sub={data.sub} mono />
      <Handle type="source" position={Position.Right} className={handle} />
    </Card>
  );
}

function PlayNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <Card selected={selected} className="border-l-4 border-l-primary">
      <Handle type="target" position={Position.Left} className={handle} />
      <Label label={data.label} sub={[data.sub, data.progress].filter(Boolean).join(" · ") || undefined} />
      <Handle type="source" position={Position.Bottom} className={handle} />
    </Card>
  );
}

function RoleNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <Card selected={selected} className="border-l-4 border-l-border">
      <Handle type="target" position={Position.Top} className={handle} />
      <Label label={data.label} sub={data.sub} />
      <Handle type="source" position={Position.Bottom} className={handle} />
    </Card>
  );
}

function StepNode({ data, selected }: NodeProps<FlowNode>) {
  const kind = data.kind;
  return (
    <Card selected={selected} className={cn("border-l-4", stateBorderClass(data.state), kind === "block" && "border-dashed")}>
      <Handle type="target" position={Position.Top} className={handle} />
      <Label label={kind === "include" ? `⤷ ${data.label}` : data.label} sub={data.sub} />
      {data.hostDots?.length ? (
        <div className="mt-0.5 flex flex-wrap gap-x-0.5" aria-label="host results">
          {data.hostDots.map((h) => <span key={h.host} title={`${h.host}: ${h.state}`}><CellGlyph state={h.state} /></span>)}
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} className={handle} />
      <Handle id="notify" type="source" position={Position.Right} className={handle} />
    </Card>
  );
}

function HandlerNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <Card selected={selected} className="border-l-4 border-l-muted-foreground/40">
      <Handle type="target" position={Position.Left} className={handle} />
      <Label label={`handler: ${data.label}`} sub={data.sub} />
    </Card>
  );
}

export const nodeTypes = { hosts: HostsNode, play: PlayNode, role: RoleNode, task: StepNode, block: StepNode, handler: HandlerNode, include: StepNode };
