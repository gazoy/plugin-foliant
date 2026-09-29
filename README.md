# elizaos-plugin-foliant

Pay x402 endpoints from an [ElizaOS](https://github.com/elizaOS/eliza) agent through a **Foliant** account: a spending policy the agent cannot bypass, and one on-chain settlement per session instead of one per call.

This plugin is published independently and is not in the elizaOS first-party catalog. Install it from npm and list it in your character's `plugins`.

## What you get

| Piece | Name | Does |
|---|---|---|
| Service | `foliant` | Holds the agent's Foliant account and a paying HTTP client for the runtime's lifetime |
| Action | `PAY_X402` | Calls a URL; if it answers `402`, retries with a signed Foliant channel or pool update and returns the response plus a receipt id |
| Provider | `FOLIANT_BUDGET` | Puts the current budget (per-window cap, spent, headroom, balance) into the agent's context every turn |

A refusal by the policy is not an error: the action returns `success: false` with text `BUDGET REFUSED: <reason>` so the agent can say so and move on.

## Install

```bash
npm install elizaos-plugin-foliant
```

Character file:

```json
{ "plugins": ["elizaos-plugin-foliant"] }
```

The plugin auto-enables when `FOLIANT_NODE_URL` and `FOLIANT_SIGNER_KEY` are set.

## Configuration

| Setting | Required | Meaning |
|---|---|---|
| `FOLIANT_NODE_URL` | yes | Ledger node, e.g. `http://127.0.0.1:8402` for the reference devnet |
| `FOLIANT_SIGNER_KEY` | yes | Hex Ed25519 private key the agent signs payments with. Its power is bounded by the account's policy |
| `FOLIANT_ACCOUNT_ID` | one of | Attach to an existing account operated by the signer key |
| `FOLIANT_OWNER_KEY` | one of | Register a new account at start-up (devnet convenience; in production register once and set `FOLIANT_ACCOUNT_ID`) |
| `FOLIANT_ASSET` | | Asset symbol, default `USDC` |
| `FOLIANT_DEFAULT_DEPOSIT` | | Committed to each new channel or pool claim, default `100` |
| `FOLIANT_PER_TX_MAX` / `FOLIANT_PER_WINDOW_MAX` / `FOLIANT_WINDOW_SECS` | | Policy for a newly registered account (defaults 500 / 200 / 3600) |
| `FOLIANT_AUTOPAY` | | `false` disables the action while keeping the budget provider |

The policy bounds **committed** value, not per-call spend: opening a 100-unit channel counts 100 against the window, and the calls inside it are then free of further ledger checks until the channel is exhausted.

## Settlement and refunds

Because payments are off-ledger updates, it is worth being precise about when money actually moves:

- **Deposit.** A channel or pool claim is funded from the agent's account when opened. That is the only outbound transfer the ledger sees during a session, and it is what the policy checks.
- **Pay.** Each request carries a signed update raising the cumulative balance owed to the provider. Nothing moves on the ledger. The provider returns a signed receipt binding the update to the request and response hashes; `PAY_X402` reports its id.
- **Settle.** The provider presents the latest update and receives the balance owed. In a pool, one settlement covers every member.
- **Refund of the unspent remainder.** The unspent part of a deposit returns to the agent at close. A cooperative close (both signatures) returns it at once. If the provider is unresponsive, the agent starts a **unilateral exit**: the ledger holds the claim for the timeout (`timeoutSecs`, default 3600 s on the devnet), during which the provider may present a later update; after the timeout the remainder is returned to the agent without the provider's cooperation. Exited members are ignored by later pool settlements.
- **No chargebacks.** A signed update is final. If the provider returns a bad response, the receipt is the evidence, but this plugin does not reverse payments.
- **Refused payments** never touch the ledger; the client's local window counter is rolled back when the ledger refuses, so a refused call does not consume budget.

The `foliant` service exposes `agent` so a character can call `beginExit` / `finalizeExit` / `closeChannel` itself; this plugin does not initiate exits on its own.

## Try it against the reference devnet

```bash
git clone https://github.com/gazoy/concord && cd concord
python -m venv .venv && . .venv/bin/activate && pip install -e .
python demo/serve.py            # ledger + a 3 USDC/call x402 endpoint on :8402
```

Then, with `FOLIANT_NODE_URL=http://127.0.0.1:8402`, an owner key and a signer key (any 32-byte hex), ask the agent to call `http://127.0.0.1:8402/infer`. The devnet has a faucet at `POST /ledger/faucet`.

Tests: `npm test` (spawns the devnet from `../concord` or `$FOLIANT_REF`).

## Links

- Protocol, whitepaper and reference ledger: https://github.com/gazoy/concord
- TypeScript client this plugin is built on: `foliant-client`
- LangChain integration: `langchain-foliant` on PyPI

Apache-2.0.
