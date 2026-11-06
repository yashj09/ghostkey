// Infrastructure: .env loading, the anvil fork process, and the SSE hub that pushes state + events to the cockpit.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toWire, type DemoEvent, type DemoLevel, type DemoState, type DemoStepId } from "@ghostkey/core/demo-api";
import type { Hex } from "viem";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Minimal .env loader (KEY=VALUE lines); never logs values. */
export function loadEnv(): void {
  try {
    for (const line of readFileSync(resolve(REPO_ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // no .env: fall back to process env
  }
}

export interface AnvilHandle {
  rpcUrl: string;
  stop(): void;
}

/** Spawns a dedicated anvil mainnet fork for the demo (separate port from dev/test forks). */
export async function startAnvil(opts: { forkUrl: string; forkBlock: number; port: number }): Promise<AnvilHandle> {
  const rpcUrl = `http://127.0.0.1:${opts.port}`;
  if (await rpcAlive(rpcUrl)) {
    // A leftover fork from an earlier run holds dirty state (e.g. the ENS name is already registered): reset it.
    await rpc(rpcUrl, "anvil_reset", [{ forking: { jsonRpcUrl: opts.forkUrl, blockNumber: opts.forkBlock } }]);
    console.log(`[anvil] reset leftover fork on ${rpcUrl} to block ${opts.forkBlock}`);
    return { rpcUrl, stop: () => {} };
  }
  const proc: ChildProcess = spawn(
    "anvil",
    ["--fork-url", opts.forkUrl, "--fork-block-number", String(opts.forkBlock), "--hardfork", "osaka", "--port", String(opts.port), "--silent"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  proc.stderr?.on("data", (d) => process.stderr.write(`[anvil] ${d}`));
  for (let i = 0; i < 60; i++) {
    if (await rpcAlive(rpcUrl)) return { rpcUrl, stop: () => proc.kill() };
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error("anvil did not start (is foundry installed and MAINNET_RPC_URL valid?)");
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function rpcAlive(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Holds the cockpit state and fans it out over Server-Sent Events. */
export class Hub {
  state: DemoState = { ready: false, busy: null, completed: [] };
  private events: DemoEvent[] = [];
  private clients = new Set<ServerResponse>();
  private nextId = 1;

  attach(res: ServerResponse) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`event: state\ndata: ${toWire(this.state)}\n\n`);
    for (const e of [...this.events].reverse()) res.write(`event: event\ndata: ${toWire(e)}\n\n`);
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  private send(type: string, payload: unknown) {
    const msg = `event: ${type}\ndata: ${toWire(payload)}\n\n`;
    for (const c of this.clients) c.write(msg);
  }

  patch(p: Partial<DemoState>) {
    this.state = { ...this.state, ...p };
    this.send("state", this.state);
  }

  log(step: DemoEvent["step"], level: DemoLevel, msg: string, extra?: { tx?: Hex; data?: DemoEvent["data"] }) {
    const ev: DemoEvent = { id: this.nextId++, ts: Date.now(), step, level, msg, ...extra };
    this.events.unshift(ev);
    this.events = this.events.slice(0, 300);
    this.send("event", ev);
    console.log(`[${step}] ${msg}`);
  }

  clearLog() {
    this.events = [];
    this.send("reset-log", {});
  }

  markDone(step: DemoStepId) {
    if (!this.state.completed.includes(step)) this.patch({ completed: [...this.state.completed, step] });
  }
}
