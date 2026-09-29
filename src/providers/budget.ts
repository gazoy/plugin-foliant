/** FOLIANT_BUDGET: puts the agent's remaining budget into the model's context. */
import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { FoliantService } from "../service.js";

export const foliantBudgetProvider: Provider = {
  name: "FOLIANT_BUDGET",
  description: "The agent's Foliant spending budget: what it can still pay for x402 calls in the current window.",
  dynamic: true,
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    const svc = runtime.getService<FoliantService>(FoliantService.serviceType);
    if (!svc) return { text: "" };
    const b = await svc.budget();
    const text =
      `Foliant budget: ${b.headroom} ${b.asset} payable now ` +
      `(policy ${b.perWindowMax} per ${b.windowSecs}s, ${b.spentInWindow} committed this window; ` +
      `balance ${b.balance}; ${b.receipts} paid calls so far).`;
    return {
      text,
      values: { foliantHeadroom: b.headroom, foliantSpentInWindow: b.spentInWindow, foliantPerWindowMax: b.perWindowMax },
      data: { budget: b as unknown as Record<string, unknown> },
    };
  },
};
