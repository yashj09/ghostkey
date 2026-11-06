// Shared viem clients + small tx helpers for the demo world (anvil mainnet fork).
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  publicActions,
  type Account,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

/** Fast polling: anvil automines, so receipts are available right away. */
const POLL = 50;

export function createDemoClients(rpcUrl: string) {
  const transport = http(rpcUrl, { retryCount: 0 });
  const publicClient = createPublicClient({ chain: mainnet, transport, pollingInterval: POLL, cacheTime: 0 });
  const testClient = createTestClient({ chain: mainnet, mode: "anvil", transport, pollingInterval: POLL, cacheTime: 0 }).extend(publicActions);
  const wallet = (keyOrAccount: Hex | Account) =>
    createWalletClient({
      chain: mainnet,
      transport,
      pollingInterval: POLL,
      cacheTime: 0,
      account: typeof keyOrAccount === "string" ? privateKeyToAccount(keyOrAccount) : keyOrAccount,
    });
  return { publicClient: publicClient as PublicClient, testClient, wallet };
}

export type DemoClients = ReturnType<typeof createDemoClients>;
export type DemoTestClient = DemoClients["testClient"];

const cache = new Map<string, DemoClients>();
/** Cached clients per RPC URL. */
export function clientsFor(rpcUrl: string): DemoClients {
  let c = cache.get(rpcUrl);
  if (!c) cache.set(rpcUrl, (c = createDemoClients(rpcUrl)));
  return c;
}

/** anvil `evm_snapshot`. Note: anvil deletes a snapshot when you revert to it, so take a new one afterwards. */
export async function snapshot(target: string | { rpcUrl: string }): Promise<Hex> {
  return clientsFor(typeof target === "string" ? target : target.rpcUrl).testClient.snapshot();
}

/** anvil `evm_revert` to a snapshot id from {@link snapshot}. */
export async function revert(target: string | { rpcUrl: string }, id: Hex): Promise<void> {
  await clientsFor(typeof target === "string" ? target : target.rpcUrl).testClient.revert({ id });
}

/** Wait for a tx and throw if it reverted. */
export async function waitOk(pc: PublicClient, hash: Hex, what: string): Promise<TransactionReceipt> {
  const r = await pc.waitForTransactionReceipt({ hash, pollingInterval: POLL });
  if (r.status !== "success") throw new Error(`${what} reverted (tx ${hash})`);
  return r;
}

/** Best-effort human reason from a viem error (revert reason / custom error name / short message). */
export function errReason(e: unknown): string {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (rev) {
      if (rev.reason) return rev.reason;
      if (rev.data?.errorName) return `${rev.data.errorName}(${(rev.data.args ?? []).map(String).join(", ")})`;
      if (rev.signature) return `custom error ${rev.signature}`;
      return rev.shortMessage;
    }
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}
