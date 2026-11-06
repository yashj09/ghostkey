import { DEMO_STEP_META } from "@ghostkey/core/demo-api";
import { ArrowRight, Loader2, RotateCcw, Unplug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { EventLog } from "@/components/demo/event-log";
import { Stage } from "@/components/demo/stage";
import { Stepper } from "@/components/demo/stepper";
import { FindingsTable } from "@/components/report-view";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDemo } from "@/lib/use-demo";

export function DemoPage() {
  const { state, events, conn, runStep, reset, next } = useDemo();
  const [sending, setSending] = useState(false);
  const busy = !!state?.busy || sending;

  const advance = useCallback(async () => {
    if (!next || busy) return;
    setSending(true);
    try {
      await runStep(next);
    } catch (e) {
      toast.error(`Step failed: ${(e as Error).message}`);
    } finally {
      setSending(false);
    }
  }, [next, busy, runStep]);

  // Presenter clicker / keyboard: → PageDown Space = next step.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea")) return;
      if (["ArrowRight", "PageDown", " "].includes(e.key)) {
        e.preventDefault();
        void advance();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [advance]);

  if (conn !== "online" || !state) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {conn === "connecting" ? <Loader2 className="size-5 animate-spin" /> : <Unplug className="size-5" />}
            {conn === "connecting" ? "Connecting to the demo server…" : "Demo server offline"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-muted-foreground">
          <p>The live demo runs on a local mainnet fork. Start it from the repo root:</p>
          <pre className="rounded-md bg-muted p-3 font-mono text-sm text-foreground">pnpm demo</pre>
          <p>The Scan tab works without it.</p>
        </CardContent>
      </Card>
    );
  }

  const focus = state.busy ?? next ?? "reattack";
  return (
    <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)_260px]">
      <aside className="space-y-6">
        <Stepper completed={state.completed} busy={state.busy} next={next} />
        <div className="flex flex-col gap-2">
          <Button size="lg" onClick={advance} disabled={!next || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <ArrowRight />}
            {next ? DEMO_STEP_META[next].title : "Done"}
          </Button>
          <Button variant="outline" onClick={() => reset().catch((e) => toast.error((e as Error).message))} disabled={busy}>
            <RotateCcw /> Reset
          </Button>
          <p className="text-xs text-muted-foreground">Tip: → / Space / clicker advances.</p>
        </div>
      </aside>

      <section className="min-w-0 space-y-6">
        {state.error && <div className="rounded-md border border-sev-exposed/40 bg-sev-exposed/10 p-3 text-sm text-sev-exposed">{state.error}</div>}
        <Stage state={state} focus={focus} />
        {state.report && <FindingsTable report={state.report} />}
      </section>

      <aside>
        <div className="mb-2 text-sm font-medium text-muted-foreground">Event log</div>
        <EventLog events={events} />
      </aside>
    </div>
  );
}
