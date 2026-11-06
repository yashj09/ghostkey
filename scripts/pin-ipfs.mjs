// Pin the static web build (apps/web/dist) to IPFS via Pinata, then print the CID for the ENS contenthash.
// Usage: PINATA_JWT=... node scripts/pin-ipfs.mjs   (or put PINATA_JWT in .env and run `pnpm web:pin`)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "apps/web/dist");

// minimal .env loader (no values are printed)
try {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const jwt = process.env.PINATA_JWT;
if (!jwt) {
  console.error("PINATA_JWT missing (create a free API key at app.pinata.cloud → API Keys, put it in .env)");
  process.exit(1);
}

const files = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    statSync(p).isDirectory() ? walk(p) : files.push(p);
  }
})(dist);

const form = new FormData();
for (const f of files) form.append("file", new Blob([readFileSync(f)]), `ghostkey/${relative(dist, f)}`);
form.append("pinataMetadata", JSON.stringify({ name: `ghostkey-web-${new Date().toISOString()}` }));
form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", headers: { Authorization: `Bearer ${jwt}` }, body: form });
if (!res.ok) {
  console.error(`Pinata error ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const { IpfsHash } = await res.json();
console.log(`Pinned ${files.length} files.`);
console.log(`CID:          ${IpfsHash}`);
console.log(`Gateway:      https://${IpfsHash}.ipfs.dweb.link/`);
console.log(`ENS content:  ipfs://${IpfsHash}   (set this as the Content Hash of your name in app.ens.domains)`);
