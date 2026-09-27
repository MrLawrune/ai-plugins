// The React Flow canvas. Lazily imported by graph-loader.tsx; owns the React Flow stylesheet (CSS must be imported from TS/TSX; a bb/app.css file is not a build input).
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { applyNodeChanges, Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, type NodeMouseHandler, type OnNodesChange } from "@xyflow/react";
import { experimental_useCodeTheme as useCodeTheme } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { parseTarget } from "../server/targets.ts";
import { CHANNELS } from "../shared/constants.ts";
import { toFlowEdges, toFlowNodes, type FlowEdge, type FlowNode } from "./graph-model.ts";
import { nodeTypes } from "./graph-nodes.tsx";
import { useMediaQuery, usePlaybooksQuery } from "./hooks.ts";

export interface GraphProps { target: string; runId: string | null; selected: string | null; onSelect(nodeId: string | null): void }

// React Flow reads its palette from --xy-* variables and declares the defaults on .react-flow itself, so they must go on that
// element (the ReactFlow style prop), not an ancestor. Map them to host tokens so Background/MiniMap/Controls/edges follow the theme.
const XY_VARS = {
  "--xy-node-background-color-default": "var(--card)",
  "--xy-node-border-default": "1px solid var(--border)",
  "--xy-node-color-default": "var(--foreground)",
  "--xy-edge-stroke-default": "var(--muted-foreground)",
  "--xy-edge-stroke-selected-default": "var(--primary)",
  "--xy-handle-background-color-default": "var(--border)",
  "--xy-handle-border-color-default": "var(--border)",
  "--xy-minimap-background-color-default": "var(--card)",
  "--xy-minimap-node-background-color-default": "var(--muted-foreground)",
  "--xy-minimap-mask-background-color-default": "color-mix(in oklab, var(--card) 60%, transparent)",
  "--xy-controls-button-background-color-default": "var(--card)",
  "--xy-controls-button-background-color-hover-default": "var(--muted)",
  "--xy-controls-button-color-default": "var(--foreground)",
  "--xy-controls-button-color-hover-default": "var(--foreground)",
  "--xy-controls-button-border-color-default": "var(--border)",
  "--xy-background-pattern-dots-color-default": "var(--border)",
  "--xy-background-color-default": "var(--background)",
} as CSSProperties;

function Canvas({ nodes, edges, onSelect }: { nodes: FlowNode[]; edges: FlowEdge[]; onSelect(id: string | null): void }) {
  const { fitView } = useReactFlow();
  const mode = useCodeTheme().mode;
  const compact = useMediaQuery("(max-width: 639px)");
  const wrap = useRef<HTMLDivElement>(null);

  // Nodes are derived from props, but React Flow reports measured sizes through onNodesChange (the MiniMap only draws measured
  // nodes): keep a local copy that applies those changes and carries the sizes over when the derived nodes change.
  const [flowNodes, setFlowNodes] = useState<FlowNode[]>(nodes);
  useEffect(() => {
    setFlowNodes((prev) => {
      const measured = new Map(prev.map((n) => [n.id, n.measured]));
      return nodes.map((n) => (measured.get(n.id) ? { ...n, measured: measured.get(n.id) } : n));
    });
  }, [nodes]);
  const onNodesChange: OnNodesChange<FlowNode> = useCallback((changes) => setFlowNodes((ns) => applyNodeChanges(changes, ns)), []);

  // React Flow does not re-fit when its box changes (panel resize, drawer): debounce a fitView on resize.
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let t: ReturnType<typeof setTimeout> | null = null;
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) { first = false; return; }
      if (t) clearTimeout(t);
      t = setTimeout(() => { void fitView({ padding: 0.1, duration: 150 }); }, 120);
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (t) clearTimeout(t); };
  }, [fitView]);

  // Selection ownership: the panel owns it (selected arrives through props and is stamped onto the nodes by toFlowNodes).
  // React Flow's own selection is off (elementsSelectable={false}) so there is one source of truth; clicks are wired directly.
  const onNodeClick: NodeMouseHandler<FlowNode> = (_, n) => { if (n.selectable !== false) onSelect(n.id); };

  return (
    <div ref={wrap} className="h-full w-full">
      <ReactFlow
        nodes={flowNodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        style={XY_VARS}
        colorMode={mode}
        fitView
        fitViewOptions={{ padding: 0.1 }}
        minZoom={0.2}
        maxZoom={2}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeClick={onNodeClick}
        onPaneClick={() => onSelect(null)}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} />
        {compact ? null : <MiniMap pannable zoomable />}
      </ReactFlow>
    </div>
  );
}

export default function Graph({ target, runId, selected, onSelect }: GraphProps) {
  const t = parseTarget(target);
  const q = usePlaybooksQuery("playbook.graph", t?.path ? { env: t.env, file: t.path, runId: runId ?? undefined } : null, { refreshOn: [CHANNELS.changed, CHANNELS.run] });
  const nodes = useMemo(() => (q.data ? toFlowNodes(q.data.nodes, selected) : []), [q.data, selected]);
  const edges = useMemo(() => (q.data ? toFlowEdges(q.data.edges) : []), [q.data]);
  if (!t?.path) return <div className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">Nothing to draw</div>;
  if (!q.data) {
    return q.error
      ? <div className="text-xs text-destructive">Could not load the graph: {q.error} <Button variant="link" size="sm" onClick={q.refresh}>Retry</Button></div>
      : <div className="h-full w-full animate-pulse rounded-lg border bg-muted/40" />;
  }
  if (!nodes.length) return <div className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">No plays to draw</div>;
  return (
    <ReactFlowProvider>
      <Canvas nodes={nodes} edges={edges} onSelect={onSelect} />
    </ReactFlowProvider>
  );
}
