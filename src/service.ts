/** FoliantService: holds the agent's Foliant account and the paying client for the runtime's lifetime. */
import { type IAgentRuntime, Service } from "@elizaos/core";
import { Agent, KeyPair, LedgerNode, PayingClient, Policy, PolicyViolation, type Receipt } from "foliant-client";

/**
 * The budget as the runtime sees it. Every value that comes from the ledger or the policy is a
 * decimal string, which is how the protocol carries amounts on the wire: `foliant-client` holds
 * them as `bigint` from 0.2.0, and a `bigint` cannot be JSON-serialised, so handing one to a
 * provider's `values` or `data` would throw inside ElizaOS rather than here. `receipts` is a local
 * array length, not a protocol integer, so it stays a number.
 */
export interface BudgetView {
  perWindowMax: string;
  windowSecs: string;
  spentInWindow: string;
  headroom: string;
  expiry: string | null;
  asset: string;
  balance: string;
  receipts: number;
}

/**
 * Reads a protocol integer from the runtime's settings. `BigInt` throws a bare `SyntaxError` on a
 * malformed value where `Number` quietly produced `NaN`, so the setting's name goes back into the
 * message: a typo in the environment should say which key it was.
 */
function bigSetting(get: (k: string) => string | undefined, key: string, fallback: bigint): bigint {
  const raw = get(key);
  if (raw === undefined || raw === "") return fallback;
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`${key} must be a whole number of base units, got ${JSON.stringify(raw)}`);
  }
}

export class FoliantService extends Service {
  static serviceType = "foliant";
  capabilityDescription = "Pays x402 endpoints from a Foliant account whose spending policy is enforced by the ledger; one settlement per session.";

  agent!: Agent;
  client!: PayingClient;
  asset = "USDC";
  autopay = true;

  static async start(runtime: IAgentRuntime): Promise<FoliantService> {
    const svc = new FoliantService(runtime);
    const s = (k: string): string | undefined => {
      const v = runtime.getSetting(k);
      return v === undefined || v === null ? undefined : String(v);
    };
    const nodeUrl = s("FOLIANT_NODE_URL");
    const signerHex = s("FOLIANT_SIGNER_KEY");
    if (!nodeUrl || !signerHex) throw new Error("FOLIANT_NODE_URL and FOLIANT_SIGNER_KEY are required");
    const node = new LedgerNode(nodeUrl);
    const signer = KeyPair.fromPrivateHex(signerHex);
    svc.asset = s("FOLIANT_ASSET") ?? "USDC";
    svc.autopay = (s("FOLIANT_AUTOPAY") ?? "true").toLowerCase() !== "false";
    const accountId = s("FOLIANT_ACCOUNT_ID");
    if (accountId) {
      svc.agent = await Agent.attach(node, accountId, signer);
    } else {
      const ownerHex = s("FOLIANT_OWNER_KEY");
      if (!ownerHex) throw new Error("FOLIANT_OWNER_KEY is required to register a new account when FOLIANT_ACCOUNT_ID is not set");
      const policy = new Policy(
        bigSetting(s, "FOLIANT_PER_TX_MAX", 500n),
        bigSetting(s, "FOLIANT_PER_WINDOW_MAX", 200n),
        bigSetting(s, "FOLIANT_WINDOW_SECS", 3600n),
      );
      svc.agent = await Agent.register(node, KeyPair.fromPrivateHex(ownerHex), signer, policy, BigInt(Date.now()));
    }
    svc.client = new PayingClient(svc.agent, { defaultDeposit: bigSetting(s, "FOLIANT_DEFAULT_DEPOSIT", 100n) });
    return svc;
  }

  async stop(): Promise<void> {}

  /** Pay for one request. Returns the response, or a refusal message if the policy does not allow it. */
  async pay(url: string, init: RequestInit = {}): Promise<{ ok: true; status: number; text: string; receipt: Receipt | null } | { ok: false; refused: string }> {
    try {
      const r = await this.client.fetch(url, init);
      const text = await r.text();
      const receipt = this.client.receipts.length ? this.client.receipts[this.client.receipts.length - 1] : null;
      return { ok: true, status: r.status, text, receipt };
    } catch (e) {
      if (e instanceof PolicyViolation || e instanceof RangeError) return { ok: false, refused: (e as Error).message };
      throw e;
    }
  }

  async budget(): Promise<BudgetView> {
    const acct = await this.agent.refresh();
    const pol = this.agent.signer.policy;
    const { now } = await this.agent.node.now();
    const remaining = pol.perWindowMax - acct.spent_in_window;
    // Math.max does not take bigint, and a window can be overspent only by an escalated per-tx lift.
    let headroom = pol.expiry !== null && now >= pol.expiry ? 0n : remaining > 0n ? remaining : 0n;
    // plus what is unspent in open channels and pool claims
    for (const [id, u] of this.agent.latest) {
      if (u.body.kind === "channel") {
        const ch = await this.agent.node.channel(id);
        if (!ch.closed && ch.closing_at === null) headroom += ch.deposit - (u.body.balance as bigint);
      } else {
        const pool = await this.agent.node.pool(id);
        const claim = pool.members[acct.id];
        if (claim && !claim.exited && claim.exit_at === null) headroom += claim.deposit - (u.body.balance as bigint);
      }
    }
    return {
      perWindowMax: pol.perWindowMax.toString(),
      windowSecs: pol.windowSecs.toString(),
      spentInWindow: acct.spent_in_window.toString(),
      headroom: headroom.toString(),
      expiry: pol.expiry === null ? null : pol.expiry.toString(),
      asset: this.asset,
      balance: (acct.balances[this.asset] ?? 0n).toString(),
      receipts: this.client.receipts.length,
    };
  }
}
