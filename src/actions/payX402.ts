/** PAY_X402: call an x402 endpoint and pay for it from the agent's Foliant account. */
import type { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { FoliantService } from "../service.js";

function param(options: unknown, key: string): string | undefined {
  const o = options as Record<string, unknown> | undefined;
  const p = (o?.parameters as Record<string, unknown> | undefined) ?? o;
  const v = p?.[key];
  return v === undefined || v === null ? undefined : String(v);
}

export const payX402Action: Action = {
  name: "PAY_X402",
  similes: ["PAY_FOR_URL", "X402_FETCH", "FOLIANT_PAY", "CALL_PAID_API"],
  description:
    "Call an HTTP API that charges per request over x402, paying from this agent's Foliant budget. " +
    "The payment is a signed channel or pool update; the provider settles on-chain later. " +
    "Refused if the agent's spending policy does not allow it.",
  routingHint: "user asks to call or fetch a paid API / endpoint that returns 402 -> PAY_X402; not for free URLs",
  tags: ["capability:send", "capability:execute", "effect:receipt-required"],
  parameters: [
    { name: "url", description: "Full URL of the x402 endpoint", required: true, schema: { type: "string" } },
    { name: "method", description: "HTTP method, GET or POST (default POST)", schema: { type: "string", enumValues: ["GET", "POST"], default: "POST" } },
    { name: "body", description: "Request body for POST, as text", schema: { type: "string", default: "" } },
  ],
  examples: [
    [
      { name: "user", content: { text: "Ask the pricing API at http://127.0.0.1:8402/infer what BTC is worth" } },
      { name: "agent", content: { text: "Calling the paid endpoint and settling through my Foliant budget.", actions: ["PAY_X402"] } },
    ],
  ],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const svc = runtime.getService<FoliantService>(FoliantService.serviceType);
    return !!svc && svc.autopay;
  },

  handler: async (runtime: IAgentRuntime, message: Memory, _state?: State, options?: unknown, callback?: HandlerCallback): Promise<ActionResult> => {
    const svc = runtime.getService<FoliantService>(FoliantService.serviceType);
    if (!svc) return { success: false, text: "Foliant service is not running" };
    const url = param(options, "url") ?? message.content?.text?.match(/https?:\/\/\S+/)?.[0];
    if (!url) return { success: false, text: "No URL given" };
    const method = (param(options, "method") ?? "POST").toUpperCase();
    const body = param(options, "body") ?? "";
    const res = await svc.pay(url, { method, body: method === "GET" ? undefined : body });
    if (!res.ok) {
      const text = `BUDGET REFUSED: ${res.refused}`;
      await callback?.({ text });
      return { success: false, text, userFacingText: text, data: { refused: res.refused } };
    }
    const rid = res.receipt ? res.receipt.body.updateId.slice(0, 16) : "none";
    const text = `${res.status} from ${url}\n${res.text}\n[receipt ${rid}]`;
    await callback?.({ text: res.text });
    return { success: true, text, userFacingText: res.text, data: { status: res.status, receipt: rid, body: res.text } };
  },
};
