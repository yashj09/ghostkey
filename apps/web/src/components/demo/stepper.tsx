import { DEMO_STEP_META, DEMO_STEPS, type DemoStepId } from "@ghostkey/core/demo-api";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const ACTS: Record<1 | 2 | 3, string> = { 1: "Act 1: the migration", 2: "Act 2: Q-day", 3: "Act 3: GhostKey" };

export function Stepper({ completed, busy, next }: { completed: DemoStepId[]; busy: DemoStepId | null; next?: DemoStepId }) {
  return (
    <ol className="space-y-5">
      {([1, 2, 3] as const).map((act) => (
        <li key={act}>
          <div className="mb-2 text-sm font-medium text-muted-foreground">{ACTS[act]}</div>
          <ol className="space-y-1">
            {DEMO_STEPS.filter((s) => DEMO_STEP_META[s].act === act).map((s) => {
              const done = completed.includes(s);
              const running = busy === s;
              const current = !busy && next === s;
              return (
                <li
                  key={s}
                  aria-current={current ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
                    current && "bg-primary/10 font-medium text-foreground",
                    running && "bg-muted font-medium",
                    !done && !current && !running && "text-muted-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-5 shrink-0 place-items-center rounded-full border text-[11px] tabular-nums",
                      done && "border-sev-clear bg-sev-clear text-background",
                      current && "border-primary text-primary",
                    )}
                  >
                    {running ? <Loader2 className="size-3.5 animate-spin" /> : done ? <Check className="size-3.5" /> : DEMO_STEPS.indexOf(s) + 1}
                  </span>
                  {DEMO_STEP_META[s].title}
                </li>
              );
            })}
          </ol>
        </li>
      ))}
    </ol>
  );
}
