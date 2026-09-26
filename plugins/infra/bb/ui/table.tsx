// Bordered, horizontally scrollable table used for guests, storage, network and backups.
import { cn } from "@/lib/utils";

export function DataTable({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-x-auto rounded-lg border", className)}>
      <table className="w-full whitespace-nowrap text-sm">{children}</table>
    </div>
  );
}

export function Head({ children }: { children: React.ReactNode }) {
  return <thead className="bg-muted/50 text-xs text-muted-foreground"><tr>{children}</tr></thead>;
}

export function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th className={cn("px-2 py-1.5 text-left font-medium", className)}>{children}</th>;
}

export function Td({ children, className, title }: { children?: React.ReactNode; className?: string; title?: string }) {
  return <td className={cn("px-2 py-1.5 align-baseline", className)} title={title}>{children}</td>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-4 text-center text-sm text-muted-foreground">{children}</p>;
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</h4>;
}
