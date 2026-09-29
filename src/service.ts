/** FoliantService: holds the agent's Foliant account and the paying client for the runtime's lifetime. */
import { type IAgentRuntime, Service } from "@elizaos/core";
import { Agent, KeyPair, LedgerNode, PayingClient, Policy, PolicyViolation, type Receipt } from "@foliant/client";

export interface BudgetView {
  perWindowMax: number;
  windowSecs: number;
  spentInWindow: number;
  headroom: number;
  expiry: number | null;
  asset: string;
  balance: number;
  receipts: number;
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
        Number(s("FOLIANT_PER_TX_MAX") ?? 500),
        Number(s("FOLIANT_PER_WINDOW_MAX") ?? 200),
        Number(s("FOLIANT_WINDOW_SECS") ?? 3600),
      );
      svc.agent = await Agent.register(node, KeyPair.fromPrivateHex(ownerHex), signer, policy, Date.now());
    }
    svc.client = new PayingClient(svc.agent, { defaultDeposit: Number(s("FOLIANT_DEFAULT_DEPOSIT") ?? 100) });
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
    let headroom = pol.expiry !== null && now >= pol.expiry ? 0 : Math.max(0, pol.perWindowMax - acct.spent_in_window);
    // plus what is unspent in open channels and pool claims
    for (const [id, u] of this.agent.latest) {
      if (u.body.kind === "channel") {
        const ch = await this.agent.node.channel(id);
        if (!ch.closed && ch.closing_at === null) headroom += ch.deposit - (u.body.balance as number);
      } else {
        const pool = await this.agent.node.pool(id);
        const claim = pool.members[acct.id];
        if (claim && !claim.exited && claim.exit_at === null) headroom += claim.deposit - (u.body.balance as number);
      }
    }
    return {
      perWindowMax: pol.perWindowMax, windowSecs: pol.windowSecs, spentInWindow: acct.spent_in_window, headroom,
      expiry: pol.expiry, asset: this.asset, balance: acct.balances[this.asset] ?? 0, receipts: this.client.receipts.length,
    };
  }
}
