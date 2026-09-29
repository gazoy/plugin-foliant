/** elizaos-plugin-foliant — pay x402 endpoints from a Foliant account with a budget the agent cannot bypass. */
import type { Plugin } from "@elizaos/core";
import { payX402Action } from "./actions/payX402.js";
import { foliantBudgetProvider } from "./providers/budget.js";
import { FoliantService } from "./service.js";

export const foliantPlugin: Plugin = {
  name: "foliant",
  description:
    "Pays x402 endpoints through Foliant payment channels and pools: one on-chain settlement per session, " +
    "and a spending policy enforced by the ledger rather than by plugin code. Unilateral exit recovers unspent deposits.",
  services: [FoliantService],
  actions: [payX402Action],
  providers: [foliantBudgetProvider],
  autoEnable: { envKeys: ["FOLIANT_NODE_URL", "FOLIANT_SIGNER_KEY"] },
};

export { FoliantService, payX402Action, foliantBudgetProvider };
export type { BudgetView } from "./service.js";
export default foliantPlugin;
