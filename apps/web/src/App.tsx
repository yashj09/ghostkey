import { Ghost } from "lucide-react";
import { useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ThemeToggle } from "@/lib/theme";
import { DemoPage } from "@/pages/demo";
import { ScanPage } from "@/pages/scan";

type Mode = "scan" | "demo";
const modeFromHash = (): Mode => (location.hash === "#demo" ? "demo" : "scan");

export default function App() {
  const [mode, setMode] = useState<Mode>(modeFromHash);
  useEffect(() => {
    const onHash = () => setMode(modeFromHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <a href="#scan" className="flex items-center gap-2 font-semibold tracking-tight">
            <Ghost className="size-5 text-primary" aria-hidden />
            GhostKey
          </a>
          <span className="hidden text-sm text-muted-foreground md:inline">You migrated. Your old key didn't.</span>
          <div className="ml-auto flex items-center gap-2">
            <Tabs value={mode} onValueChange={(v) => (location.hash = v)}>
              <TabsList>
                <TabsTrigger value="scan">Scan</TabsTrigger>
                <TabsTrigger value="demo">Live demo</TabsTrigger>
              </TabsList>
            </Tabs>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">{mode === "scan" ? <ScanPage /> : <DemoPage />}</main>

      <footer className="mx-auto max-w-6xl px-4 pb-10 text-sm text-muted-foreground">
        Open source (MIT) · no analytics, no trackers · reads go only to the RPC you choose ·{" "}
        <a className="underline underline-offset-4 hover:text-foreground" href="https://github.com/yashj09/ghostkey">github.com/yashj09/ghostkey</a>
      </footer>
      <Toaster />
    </div>
  );
}
