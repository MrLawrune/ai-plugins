// Mount boundary for the graph: lazy() + Suspense keep React Flow out of the panel's first render (the build inlines the chunk).
import { lazy, Suspense } from "react";
import type { GraphProps } from "./graph.tsx";

const Graph = lazy(() => import("./graph.tsx"));

export function GraphLoader(props: GraphProps) {
  return (
    <div className="h-[55vh] min-h-[320px] w-full overflow-hidden rounded-lg border">
      <Suspense fallback={<div className="h-full w-full animate-pulse bg-muted/40" />}>
        <Graph {...props} />
      </Suspense>
    </div>
  );
}
