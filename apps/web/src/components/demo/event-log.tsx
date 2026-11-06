import type { DemoEvent } from "@ghostkey/core/demo-api";
import { AlertTriangle, CheckCircle2, Circle, Skull } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";

const LEVEL = {
  info: { icon: Circle, cls: "text-muted-foreground" },
  success: { icon: CheckCircle2, cls: "text-sev-clear" },
  warn: { icon: AlertTriangle, cls: "text-sev-conditional" },
  danger: { icon: Skull, cls: "text-sev-exposed" },
} as const;

export function EventLog({ events }: { events: DemoEvent[] }) {
  return (
    <ScrollArea className="h-[min(70dvh,640px)] pr-3">
      <ol className="space-y-2.5 font-mono text-[13px] leading-snug" aria-live="polite">
        {events.length === 0 && <li className="text-muted-foreground">Waiting for the first step…</li>}
        {events.map((e) => {
          const L = LEVEL[e.level];
          const Icon = L.icon;
          return (
            <li key={e.id} className="flex gap-2">
              <Icon className={cn("mt-0.5 size-3.5 shrink-0", L.cls)} aria-hidden />
              <div className="min-w-0">
                <span className={cn(e.level === "danger" && "text-sev-exposed", e.level === "success" && "text-sev-clear")}>{e.msg}</span>
                {e.tx && <div className="truncate text-xs text-muted-foreground">tx {shortAddr(e.tx, 6)}</div>}
              </div>
            </li>
          );
        })}
      </ol>
    </ScrollArea>
  );
}
