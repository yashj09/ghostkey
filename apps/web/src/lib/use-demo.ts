import { DEMO_STEPS, fromWire, type DemoEvent, type DemoState, type DemoStepId } from "@ghostkey/core/demo-api";
import { useCallback, useEffect, useRef, useState } from "react";

const API = "/api"; // proxied to apps/demo-server (127.0.0.1:8787) by Vite in dev

export type Conn = "connecting" | "online" | "offline";

/** Live Demo cockpit state: polls nothing; the server pushes state + events over SSE. */
export function useDemo() {
  const [state, setState] = useState<DemoState | null>(null);
  const [events, setEvents] = useState<DemoEvent[]>([]);
  const [conn, setConn] = useState<Conn>("connecting");
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const es = new EventSource(`${API}/stream`);
      esRef.current = es;
      es.addEventListener("state", (e) => {
        setConn("online");
        setState(fromWire<DemoState>((e as MessageEvent).data));
      });
      es.addEventListener("event", (e) => {
        const ev = fromWire<DemoEvent>((e as MessageEvent).data);
        setEvents((prev) => (prev.some((p) => p.id === ev.id) ? prev : [ev, ...prev].slice(0, 300)));
      });
      es.addEventListener("reset-log", () => setEvents([]));
      es.onerror = () => {
        es.close();
        if (closed) return;
        setConn("offline");
        retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      esRef.current?.close();
    };
  }, []);

  const post = useCallback(async (path: string) => {
    const res = await fetch(`${API}${path}`, { method: "POST" });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
  }, []);

  const runStep = useCallback((step: DemoStepId) => post(`/step/${step}`), [post]);
  const reset = useCallback(() => post("/reset"), [post]);
  const simulate = useCallback((target: string) => post(`/simulate?target=${encodeURIComponent(target)}`), [post]);

  const next: DemoStepId | undefined = state ? DEMO_STEPS.find((s) => !state.completed.includes(s)) : undefined;

  return { state, events, conn, runStep, reset, next, simulate };
}
