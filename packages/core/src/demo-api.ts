// Wire contract between apps/demo-server (local only) and the Live Demo cockpit in apps/web.
import type { Address, Hex } from "viem";
import type { ResidualReport } from "./types.js";

export const DEMO_STEPS = ["setup", "migrate", "crack", "scan", "attack", "rewind", "fix", "reattack"] as const;
export type DemoStepId = (typeof DEMO_STEPS)[number];

export const DEMO_STEP_META: Record<DemoStepId, { title: string; act: 1 | 2 | 3; blurb: string }> = {
  setup: { act: 1, title: "Alice's wallet today", blurb: "A mainnet fork: DAI, UNI, USDC, wstETH, a Permit2 approval, a 1/1 Safe and ghostkeyalice.eth on ENSv2." },
  migrate: { act: 1, title: "Migrate to a PQ wallet", blurb: "EIP-7702: Alice's EOA now runs a post-quantum (leanSphincs-s) wallet." },
  crack: { act: 1, title: "The canary trips", blurb: "A laptop 'quantum computer' cracks the weak canary key. The wallet killswitch flips: ECDSA disabled." },
  scan: { act: 2, title: "GhostKey scan", blurb: "What can the old ECDSA key still do?" },
  attack: { act: 2, title: "Q-day", blurb: "The attacker holds Alice's old key. Every surface, live." },
  rewind: { act: 3, title: "Rewind", blurb: "Back to just after the migration: same wallet, same killswitch." },
  fix: { act: 3, title: "Complete the migration", blurb: "One leanSphincs-s-signed batch: move assets, swap the Safe owner, hand over ENS and revoke the old key's roles." },
  reattack: { act: 3, title: "Q-day again", blurb: "Same attacks, same key. Nothing left to take." },
};

export type DemoLevel = "info" | "success" | "danger" | "warn";

export interface DemoEvent {
  id: number;
  ts: number;
  step: DemoStepId | "system" | "sim";
  level: DemoLevel;
  msg: string;
  tx?: Hex;
  data?: Record<string, string | number | boolean>;
}

export interface PartyBalances {
  usd: number;
  /** symbol → human amount */
  tokens: Record<string, number>;
}

export interface AttackSummary {
  surface: string;
  label: string;
  ok: boolean;
  usdTaken: number;
  detail: string;
  tx?: Hex;
}

export interface DemoState {
  ready: boolean;
  busy: DemoStepId | null;
  completed: DemoStepId[];
  error?: string;
  forkBlock?: number;
  world?: {
    alice: Address;
    attacker: Address;
    pqAccount: Address;
    delegate: Address;
    safe: Address;
    canary: Address;
    ensName: string;
  };
  delegatedTo?: Address | null;
  killswitch?: boolean;
  canary?: { tripped: boolean; bits: number; crackMs?: number; bountyEth?: number };
  balances?: { alice: PartyBalances; safe: PartyBalances; pqAccount: PartyBalances; attacker: PartyBalances };
  ensResolvesTo?: Address;
  /** who owns Alice's Safe right now */
  safeOwner?: "alice" | "pq" | "other";
  report?: ResidualReport;
  attacks?: AttackSummary[];
  /** total USD the attacker walked away with in the latest attack round */
  attackerUsd?: number;
  /** Q-day simulator for any address */
  sim?: SimView;
}

// ---- Q-day simulator (any address, live mainnet fork) ----
export type SimStatus = "idle" | "queued" | "forking" | "scanning" | "attacking" | "rewinding" | "fixing" | "reattacking" | "done" | "error";

export interface SimActionView {
  surface: string;
  label: string;
  ok: boolean;
  usdTaken: number;
  detail: string;
  tx?: Hex;
}

export interface SimView {
  status: SimStatus;
  target?: string;
  address?: Address;
  name?: string;
  forkBlock?: number;
  startedAt?: number;
  /** USD in the target / its Safes / attacker / GhostKey vault, updated after every action */
  holdings?: { targetUsd: number; safesUsd: number; attackerUsd: number; vaultUsd: number; ens: Record<string, Address | null> };
  /** the target's value at the start (for "drained x%" bars) */
  startUsd?: number;
  before?: ResidualReport;
  after?: ResidualReport;
  attack: SimActionView[];
  reattack: SimActionView[];
  fixSteps: string[];
  stolenUsd?: number;
  stolenAfterUsd?: number;
  remaining?: string[];
  error?: string;
  /** addresses already warmed on this fork (instant-ish) */
  warm: string[];
}

// ---- JSON transport with bigint support (reports contain bigints) ----
export function toWire(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? { $big: v.toString() } : v));
}

export function fromWire<T>(text: string): T {
  return JSON.parse(text, (_k, v) => (v && typeof v === "object" && typeof v.$big === "string" && Object.keys(v).length === 1 ? BigInt(v.$big) : v)) as T;
}
