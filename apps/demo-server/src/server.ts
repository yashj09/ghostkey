// GhostKey live-demo server. LOCAL ONLY: binds 127.0.0.1, holds demo keys for a throwaway anvil fork.
import { createServer } from "node:http";
import { DEMO_STEPS, type DemoStepId } from "@ghostkey/core/demo-api";
import { Hub, loadEnv, startAnvil } from "./infra.js";
import { createDemo } from "./steps.js";

loadEnv();
const PORT = Number(process.env.DEMO_SERVER_PORT ?? 8787);
const ANVIL_PORT = Number(process.env.DEMO_ANVIL_PORT ?? 8547);
const forkUrl = process.env.MAINNET_RPC_URL;
const forkBlock = Number(process.env.FORK_BLOCK ?? 26352043);
if (!forkUrl) {
  console.error("MAINNET_RPC_URL missing: copy .env.example to .env");
  process.exit(1);
}

const hub = new Hub();
const anvil = await startAnvil({ forkUrl, forkBlock, port: ANVIL_PORT });
const demo = await createDemo(hub, anvil.rpcUrl, forkBlock);
demo.ready();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/^\/api/, "");
  try {
    if (req.method === "GET" && path === "/stream") return hub.attach(res);
    if (req.method === "GET" && path === "/health") return void res.end("ok");
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

server.listen(PORT, "127.0.0.1", () => console.log(`GhostKey demo server on http://127.0.0.1:${PORT} (anvil ${anvil.rpcUrl}, fork block ${forkBlock})`));
const shutdown = () => {
  anvil.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
