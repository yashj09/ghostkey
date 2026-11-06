// GhostKey live-demo server. LOCAL ONLY: binds 127.0.0.1, holds demo keys for a throwaway anvil fork.
import { createServer } from "node:http";
import { DEMO_STEPS, toWire, type DemoStepId } from "@ghostkey/core/demo-api";
import { Hub, loadEnv, startAnvil } from "./infra.js";
import { createSimulator } from "./sim.js";
import { createDemo } from "./steps.js";

loadEnv();
const PORT = Number(process.env.DEMO_SERVER_PORT ?? 8787);
const ANVIL_PORT = Number(process.env.DEMO_ANVIL_PORT ?? 8547);
const SIM_ANVIL_PORT = Number(process.env.SIM_ANVIL_PORT ?? 8548);
const forkUrl = process.env.MAINNET_RPC_URL;
const forkBlock = Number(process.env.FORK_BLOCK ?? 26352043);
if (!forkUrl) {
  console.error("MAINNET_RPC_URL missing: copy .env.example to .env");
  process.exit(1);
}

// Refuse to start (before touching anvil!) if another demo server already owns the port.
const existing = await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.ok, () => false);
if (existing) {
  console.error(`A GhostKey demo server is already running on http://127.0.0.1:${PORT}: use it, or stop it first (lsof -i :${PORT}).`);
  process.exit(1);
}

const hub = new Hub();
const anvil = await startAnvil({ forkUrl, forkBlock, port: ANVIL_PORT });
const demo = await createDemo(hub, anvil.rpcUrl, forkBlock);
demo.ready();

// Q-day simulator: its own fork, pinned to the latest block at startup (pinned => Foundry caches fetched state)
const latest = Number(
  ((await (await fetch(forkUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) })).json()) as { result: string }).result,
);
const simAnvil = await startAnvil({ forkUrl, forkBlock: latest, port: SIM_ANVIL_PORT });
const sim = createSimulator(hub, simAnvil.rpcUrl, forkUrl);
if (process.env.SIM_PREWARM !== "0") sim.prewarm();
console.log(`Q-day simulator fork: ${simAnvil.rpcUrl} at block ${latest}`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/^\/api/, "");
  try {
    if (req.method === "GET" && path === "/stream") return hub.attach(res);
    if (req.method === "GET" && path === "/health") return void res.end("ok");
    if (req.method === "GET" && path === "/state") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(toWire({ ...hub.state, rpcUrl: anvil.rpcUrl }));
    }
    if (req.method === "POST" && path === "/simulate") {
      const target = (url.searchParams.get("target") ?? "").trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(target) && !/^[^\s]+\.[a-z]+$/i.test(target)) {
        res.writeHead(400);
        return void res.end("target must be an address or an ENS name");
      }
      if (sim.busy()) {
        res.writeHead(409);
        return void res.end("a simulation is already running");
      }
      void sim.run(target);
      res.writeHead(202);
      return void res.end("started");
    }
    if (req.method === "POST" && path === "/reset") {
      await demo.reset();
      return void res.end("ok");
    }
    const m = path.match(/^\/step\/([a-z]+)$/);
    if (req.method === "POST" && m && (DEMO_STEPS as readonly string[]).includes(m[1])) {
      if (hub.state.busy) {
        res.writeHead(409);
        return void res.end(`busy with ${hub.state.busy}`);
      }
      // run in the background; progress is streamed over SSE
      void demo.run(m[1] as DemoStepId);
      res.writeHead(202);
      return void res.end("started");
    }
    res.writeHead(404);
    res.end("not found");
  } catch (e) {
    res.writeHead(500);
    res.end((e as Error).message);
  }
});

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") console.error(`Port ${PORT} is busy: another demo server is running? Stop it (lsof -i :${PORT}) or set DEMO_SERVER_PORT.`);
  else console.error(e);
  anvil.stop();
  simAnvil.stop();
  process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => console.log(`GhostKey demo server on http://127.0.0.1:${PORT} (anvil ${anvil.rpcUrl}, fork block ${forkBlock})`));
const shutdown = () => {
  anvil.stop();
  simAnvil.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
