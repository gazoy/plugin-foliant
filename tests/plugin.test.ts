/** The plugin against a real Python ledger node: service start, action pays, provider reports, policy refuses. */
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { KeyPair } from "foliant-client";
import foliantPlugin, { FoliantService, foliantBudgetProvider, payX402Action } from "../src/index.js";

const PORT = 8413;
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;

function mockRuntime(settings: Record<string, string>): IAgentRuntime & { services: Map<string, unknown> } {
  const services = new Map<string, unknown>();
  return {
    services,
    getSetting: (k: string) => settings[k] ?? null,
    getService: <T>(type: string) => (services.get(type) as T) ?? null,
  } as unknown as IAgentRuntime & { services: Map<string, unknown> };
}

async function startService(settings: Record<string, string>) {
  const rt = mockRuntime(settings);
  const svc = await FoliantService.start(rt);
  rt.services.set(FoliantService.serviceType, svc);
  return { rt, svc };
}

const msg = (text: string): Memory => ({ content: { text } } as unknown as Memory);
const state = {} as State;

beforeAll(async () => {
  server = spawn("python3", ["demo/serve.py", String(PORT)], { cwd: process.env.FOLIANT_REF ?? "/home/claude/concord", stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/ledger/now`)).ok) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("node did not start");
}, 30_000);

afterAll(() => server.kill());

describe("elizaos-plugin-foliant", () => {
  it("declares a service, an action and a provider, auto-enabled by its two required settings", () => {
    expect(foliantPlugin.services?.[0]).toBe(FoliantService);
    expect(foliantPlugin.actions?.[0].name).toBe("PAY_X402");
    expect(foliantPlugin.providers?.[0].name).toBe("FOLIANT_BUDGET");
    expect(foliantPlugin.autoEnable?.envKeys).toEqual(["FOLIANT_NODE_URL", "FOLIANT_SIGNER_KEY"]);
  });

  it("registers a devnet account, pays through the action, and reports the budget through the provider", async () => {
    const owner = KeyPair.fromSeed("eliza-owner"), signer = KeyPair.fromSeed("eliza-signer");
    const { rt, svc } = await startService({
      FOLIANT_NODE_URL: BASE, FOLIANT_SIGNER_KEY: signer.privateHex, FOLIANT_OWNER_KEY: owner.privateHex,
      FOLIANT_PER_WINDOW_MAX: "200", FOLIANT_DEFAULT_DEPOSIT: "100",
    });
    await svc.agent.node.faucet(svc.agent.address, "USDC", 5_000n);
    expect(await payX402Action.validate(rt, msg("x"), state)).toBe(true);

    const said: string[] = [];
    const cb = async (c: { text?: string }) => { said.push(c.text ?? ""); return []; };
    const res = await payX402Action.handler(rt, msg("call the api"), state, { parameters: { url: `${BASE}/infer`, method: "POST", body: "hello" } }, cb);
    expect(res.success).toBe(true);
    expect(res.userFacingText).toContain("hello");
    expect(said[0]).toContain("hello");
    expect(String(res.text)).toMatch(/\[receipt [0-9a-f]{16}\]/);

    const p = await foliantBudgetProvider.get(rt, msg(""), state);
    expect(p.text).toContain("Foliant budget:");
    expect(p.values?.foliantSpentInWindow).toBe("100"); // one pool deposit is the committed value
    expect(p.values?.foliantHeadroom).toBe("197"); // 100 policy headroom + 97 unspent in the pool claim
  });

  it("falls back to a URL in the message text, and refuses cleanly when the policy is exhausted", async () => {
    const owner = KeyPair.fromSeed("eliza-owner-2"), signer = KeyPair.fromSeed("eliza-signer-2");
    const { rt, svc } = await startService({
      FOLIANT_NODE_URL: BASE, FOLIANT_SIGNER_KEY: signer.privateHex, FOLIANT_OWNER_KEY: owner.privateHex,
      FOLIANT_PER_WINDOW_MAX: "100", FOLIANT_DEFAULT_DEPOSIT: "100",
    });
    await svc.agent.node.faucet(svc.agent.address, "USDC", 5_000n);
    // 100-unit pool claim at 3 per call: 33 calls fit; the 34th needs a new deposit the policy will not allow
    let last: Awaited<ReturnType<typeof payX402Action.handler>> | undefined;
    for (let i = 0; i < 34; i++) {
      last = await payX402Action.handler(rt, msg(`please fetch ${BASE}/infer`), state, {}, undefined);
      if (!last.success) break;
    }
    expect(last?.success).toBe(false);
    expect(String(last?.text)).toMatch(/^BUDGET REFUSED: /);
    expect(String(last?.text)).toMatch(/per_window_max 100|pool deposit exhausted/);
  });

  it("attaches to an existing account when FOLIANT_ACCOUNT_ID is set, and rejects the wrong signer", async () => {
    const owner = KeyPair.fromSeed("eliza-owner-3"), signer = KeyPair.fromSeed("eliza-signer-3");
    const first = await startService({ FOLIANT_NODE_URL: BASE, FOLIANT_SIGNER_KEY: signer.privateHex, FOLIANT_OWNER_KEY: owner.privateHex });
    const id = first.svc.agent.account.id;
    const second = await startService({ FOLIANT_NODE_URL: BASE, FOLIANT_SIGNER_KEY: signer.privateHex, FOLIANT_ACCOUNT_ID: id });
    expect(second.svc.agent.account.id).toBe(id);
    await expect(startService({ FOLIANT_NODE_URL: BASE, FOLIANT_SIGNER_KEY: KeyPair.fromSeed("wrong").privateHex, FOLIANT_ACCOUNT_ID: id }))
      .rejects.toThrow(/does not operate/);
  });
});
