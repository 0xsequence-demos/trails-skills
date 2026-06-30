# Yield (Earn) via the Direct API

For yield deposits and withdrawals in an agent, backend, or CLI (anywhere without a
React UI), use the Direct API. Trails builds the transactions; you sign them with your own
wallet. Trails is wallet-agnostic and never holds keys, so this composes with any external
signer (a server signer, wagmi, or any agent wallet).

A vault accepts one specific token, but the user can deposit with **any** token on **any**
chain — Trails swaps and bridges into the vault's token and runs the deposit. There are two
ways to express that:

- **Two-step (recommended for the raw API):** a `QuoteIntent` swap into the vault's token,
  then `YieldCreateEnterAction` to deposit. Pure API, no SDK, no hand-built calldata.
  Costs a few extra signatures but is robust and easy to reason about. See section 4.
- **Single transaction (intent protocol v1.5):** one `QuoteIntent` whose `destinationCallData`
  is a *hydrate-multicall* that swaps and deposits atomically. The multicall is normally
  built by the `0xtrails` SDK, not by hand. See section 5.

Prefer the Earn widget only when the caller is a React app.

> **Intent protocol v1.5.** Trails moved from the old `TrailsRouter` model to a
> `HydrateProxy` executor. The single-transaction swap-and-deposit (section 5) routes
> through an **executor contract** and marks the post-swap amount with a **hydration
> sentinel** that the executor fills in at runtime. The older pattern — pointing
> `destinationToAddress` straight at the vault with a bare `supply(...)` and a placeholder —
> is deprecated and will revert against the v1.5 API. Do not use it.

## Setup

- Base URL: `https://trails-api.sequence.app`
- Auth header: `X-Access-Key: $TRAILS_API_KEY`
- Get a key: https://dashboard.trails.build
- Endpoints are RPC-style: `POST /rpc/Trails/{Method}` with a JSON body.

The recipes below use raw `fetch` so they port to any language. The `@0xtrails/api`
SDK wraps the same calls if you are in TypeScript.

```ts
async function rpc(method: string, body: unknown) {
  const res = await fetch(`https://trails-api.sequence.app/rpc/Trails/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Access-Key': process.env.TRAILS_API_KEY! },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok || data?.error) throw new Error(`${method}: ${data?.msg ?? data?.error ?? res.status}`)
  return data
}

// Parse the transaction your signer needs out of an unsignedTransaction JSON string.
function toTx(unsignedTransaction: string) {
  const t = JSON.parse(unsignedTransaction)
  return {
    chainId: Number(t.chainId),
    to: t.to,
    data: t.data ?? '0x',
    value: t.value ? `0x${BigInt(t.value).toString(16)}` : '0x0', // ERC-20 calls omit value
  }
  // Let your signer set nonce and gas. Do not forward Trails' gas estimate to the signer.
}
```

## The hydration sentinel (read this before building calldata)

When a deposit call's amount depends on the post-swap balance, you cannot know the exact
number ahead of time. Trails solves this with a **hydration sentinel**: a fixed 32-byte
value you place in the amount slot, which the executor replaces with the wallet's actual
runtime balance at execution.

```ts
// keccak256("sequence.trails.hydrate.amount.sentinel.v1"). Exported by the SDK as
// TRAILS_ROUTER_PLACEHOLDER_AMOUNT / TRAILS_HYDRATE_PLACEHOLDER_AMOUNT — import it, don't retype it.
const TRAILS_HYDRATE_PLACEHOLDER_AMOUNT =
  '0xfcbc96b9628c6a4da70c90b9e80f5f4ef82922d86bd4cb54db481ae22ed79c53'

// uint160(keccak256("sequence.trails.hydrate.address.sentinel.v1")). Marks an address slot
// (e.g. a swap `recipient`) that should become the intent wallet at runtime.
const TRAILS_HYDRATE_SELF_ADDRESS = '0xd80d3a37a85094663c36c062e5ef689f2bf54fca'
```

> **Do not use `0xffff…ff` (uint256 max) as the placeholder.** It is *not* the sentinel —
> the executor treats it as a literal amount, the deposit tries to pull a near-infinite
> balance, the destination call reverts, and the intent ends `REFUNDED`. This is the single
> most common cause of a failed swap-and-deposit. See Troubleshooting.

## 1. Discover markets — `YieldGetMarkets`

```ts
const { items } = await rpc('YieldGetMarkets', {
  chainId: '137',      // string. Polygon 137, Katana 747474, etc. Omit for all chains.
  type: 'lending',     // optional: 'vault' | 'lending'
  search: 'USDC',      // optional free-text over names and tokens
  sort: 'rewardRateDesc',
  limit: 100,          // max 100. Use offset to page.
  offset: 0,
})
```

Each market in `items`:

```jsonc
{
  "id": "polygon-usdt-aave-v3-lending",                // earnMarketId
  "chainId": "137", "network": "polygon",
  "rewardRate": { "total": 0.0302, "rateType": "APY" },
  "statistics": { "tvlUsd": "30684196" },              // string or null
  "status": { "enter": true, "exit": true },           // check before acting
  "token": { "symbol": "USDT", "address": "0xc213...", "decimals": 6 }, // the vault's token
  "inputTokens": [ { "symbol": "USDT", "address": "0xc213..." } ],
  "metadata": { "name": "Aave v3 USDT Lending", "supportedStandards": ["ERC4626"] }
}
```

Notes:
- `limit` caps at 100. Requesting more returns an endpoint error. Page with `offset`.
- The `id` prefix is the network slug, so you can derive the chain without a second call.
- `status.enter`/`status.exit` reflect Trails' view. It is still worth sanity-checking the
  underlying reserve is open (not frozen/paused, supply cap not reached) before depositing —
  a market can be listed as enterable while the on-chain `supply` reverts.
- `market.token` is the token the vault takes. The user rarely holds exactly this, which is
  why sections 4 and 5 exist.
- `GetEarnPools` is a higher-level, curated view of the same data (the React Earn widget uses
  it); it returns a `depositAddress` per pool. For the raw API, `YieldGetMarkets` plus
  `YieldCreateEnterAction` is the lower-level, fully composable path.

## 2. Deposit when the user already holds the vault token — `YieldCreateEnterAction`

This is the simplest, most reliable path. If the user already holds the vault's token on the
vault's chain, no swap is needed.

```ts
const { action } = await rpc('YieldCreateEnterAction', {
  earnMarketId: market.id,
  userWalletAddress: owner,         // the signer's address (becomes onBehalfOf)
  args: { amount: '10' },           // human units of the vault's token. Not wei.
  // optional: receiverAddress, useMaxAllowance (approve uint256.max instead of exact)
})
```

`action.transactions` is an ordered list. Each item has a `type` (`APPROVAL`, `SUPPLY`, ...),
a `stepIndex`, and `unsignedTransaction` as a JSON **string**:

```jsonc
{ "action": { "transactions": [
  { "type": "APPROVAL", "stepIndex": 0,
    "unsignedTransaction": "{\"to\":\"0x<token>\",\"data\":\"0x095ea7b3...\",\"chainId\":137}" },
  { "type": "SUPPLY", "stepIndex": 1,
    "unsignedTransaction": "{\"to\":\"0x<pool>\",\"data\":\"0x617ba037...\",\"chainId\":137}" }
], "executionPattern": "synchronous" } }
```

Sign each with `toTx` in `stepIndex` order (approve, then supply), waiting for each to land.
There is no batch endpoint.

This endpoint is also how you read a protocol's exact deposit call: the `SUPPLY` step's `to`
is the deposit target (e.g. the Aave V3 Pool) and its `data` is the encoded deposit call.

## 3. Withdraw — `YieldCreateExitAction`

Same response shape as the enter action. The `args` object requires exactly one of:

```ts
await rpc('YieldCreateExitAction', { earnMarketId: market.id, userWalletAddress: owner,
  args: { amount: '5' } })            // withdraw 5 (human units), OR
  // args: { shareAmount: '5' }       // withdraw 5 vault shares, OR
  // args: { useMaxAmount: true }     // withdraw the entire position
```

Notes:
- Passing none returns `MissingArgumentsError` listing `amount`, `shareAmount`, `useMaxAmount`.
- Exit validates against the live on-chain position. Requesting more than you hold returns
  `412 MaximumAmountExceededError`. There is no positions endpoint, so use `useMaxAmount: true`
  to exit fully rather than trying to read a balance first.
- To withdraw to a different token or chain, withdraw to the user's wallet, then run a
  `QuoteIntent` swap or bridge on the proceeds.

## 4. Deposit with any input token, two-step (recommended for the raw API)

When the user holds a different token than the vault, the most robust API-only path is two
steps: swap into the vault's token, then deposit it. No SDK and no hand-built multicall.

```ts
// Step 1 — swap origin token into the vault's token, delivered to the user's own wallet.
// A plain QuoteIntent with no destinationCallData. (This is the same shape used to bridge.)
const { intent } = await rpc('QuoteIntent', {
  ownerAddress: owner,
  originChainId: 137,                          // chain the user funds from (any supported chain)
  originTokenAddress: USDC_POLYGON,            // what the user holds
  originTokenAmount: '150000',                 // 0.15 USDC (6 dp), wei
  destinationChainId: market.chainId,          // the vault's chain
  destinationTokenAddress: vaultToken,         // market.token.address (e.g. USDT)
  destinationToAddress: owner,                 // deliver to the user — no destination call
  tradeType: 'EXACT_INPUT',
})
const { intentId } = await rpc('CommitIntent', { intent })
const swapHash = await signAndSend(toTx(JSON.stringify(intent.depositTransaction)))
await rpc('ExecuteIntent', { intentId, depositTransactionHash: swapHash })
let receipt
do { receipt = await rpc('WaitIntentReceipt', { intentId }) } while (!receipt.done)
if (receipt.intentReceipt.status !== 'SUCCEEDED') throw new Error('swap failed; origin deposit refunded')

// How much of the vault token landed (smallest units). Convert to human units for the enter action.
const received = receipt.intentReceipt.summary.destinationTokenAmount
const human = (Number(received) / 10 ** market.tokenDecimals).toString()

// Step 2 — now the user holds the vault token, so deposit it (section 2).
const { action } = await rpc('YieldCreateEnterAction', {
  earnMarketId: market.id, userWalletAddress: owner, args: { amount: human },
})
// sign action.transactions in stepIndex order (approve, then supply)
```

Cross-chain is the same call: set `originChainId` to the source chain and Trails bridges as
part of the swap. Quotes expire in ~5 minutes; re-quote if commit/execute fails on expiry.

## 5. Deposit with any input token, single transaction (intent protocol v1.5)

For a one-signature deposit, build a `QuoteIntent` whose `destinationCallData` is a v1.5
**hydrate-multicall**: it swaps the origin token into the vault token and runs the deposit
in one atomic destination call, with amounts hydrated at runtime. The shape that matters:

- `destinationToAddress` is the **Trails v1.5 executor**, not the vault. (Observed on
  Polygon: `0x000000004f702C8398e158108937814d074cD74b`.)
- `destinationTokenAddress` is the token the user **holds** (the origin token), because the
  swap happens *inside* the multicall, not at the route level.
- `tradeType: 'EXACT_OUTPUT'`, `fundMethod: 'WALLET'`, `options: { intentProtocol: 'v1.5' }`.
- `destinationCallData` packs `[approve input→DEX, swap input→vaultToken, approve vaultToken→pool,
  supply(vaultToken, <hydrated amount>, owner, …)]` with the **hydration sentinels** in the
  amount/recipient slots.

**Build the multicall with the SDK, not by hand.** `0xtrails` exposes the encoders
(`encodeMulticallHydrateExecute` and friends) that assemble this calldata and place the
sentinels correctly; hand-encoding the packed sub-call format is error-prone. The `supply`
sub-call's `onBehalfOf` **must be the depositor's address**, or the position is credited to
the wrong account.

```jsonc
// Verified live on Polygon: 0.15 USDC -> swap to USDT -> supply to the Aave v3 USDT vault,
// in one signed USDC transaction. (destinationCallData abbreviated.)
POST /rpc/Trails/QuoteIntent
{
  "ownerAddress": "0xYourWallet",
  "originChainId": 137,
  "originTokenAddress": "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",   // USDC you hold
  "originTokenAmount": "150000",                                         // 0.15 USDC
  "destinationChainId": 137,
  "destinationToAddress": "0x000000004f702C8398e158108937814d074cD74b", // Trails v1.5 executor
  "destinationTokenAddress": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // == origin token
  "destinationTokenAmount": "150000",
  "destinationCallData": "0x80df36a0…",   // SDK-built hydrate-multicall: swap USDC->USDT, supply to Aave
  "destinationCallValue": "0",
  "onlyNativeGasFee": false,
  "options": { "intentProtocol": "v1.5" },
  "tradeType": "EXACT_OUTPUT",
  "fundMethod": "WALLET"
}
```

Then commit, sign the single origin transaction, execute, and wait — same as section 4. The
user signs exactly one transaction (the origin deposit); Trails does the swap, approvals, and
the supply inside the executor.

## Signing model

Every endpoint above returns an unsigned transaction. You provide the signer (a server signer
with viem or ethers, a wagmi connection, or any agent wallet). Parse the `unsignedTransaction`
with `toTx`, let your signer set nonce and gas, and broadcast. Because Trails never signs, it
composes with any wallet: Trails plans, your wallet signs.

## Troubleshooting

- **Intent ends `REFUNDED` with `destinationTransaction.status: REVERTED` and
  `statusReason: "call reverted: refund triggered on destination"`.** The destination call
  reverted, so Trails refunded the origin deposit (you get the origin or swapped token back in
  your wallet — funds are not lost). Most common causes, in order:
  1. **Wrong placeholder.** You used `0xffff…ff` (uint256 max) instead of the hydration
     sentinel `0xfcbc96b9…`. The supply tried to pull a near-infinite amount and reverted.
     Use the sentinel (or the SDK), or fall back to the two-step path (section 4).
  2. **Deprecated single-tx shape.** You pointed `destinationToAddress` at the vault with a
     bare `supply(...)` placeholder (the pre-v1.5 `TrailsRouter` pattern). Use the v1.5
     executor multicall (section 5) or the two-step path (section 4).
  3. **Reserve not actually open.** The vault is listed as enterable but the underlying
     reserve is frozen/paused or its supply cap is full, so `supply` reverts. Pick another
     market.
- **Quote expired.** Quotes live ~5 minutes. Re-quote and review the new numbers before
  committing.
- **`mm`/signer rejects `value`.** Normalize the `unsignedTransaction.value` to a 0x-prefixed
  hex quantity (`toTx` above does this); `"0"` is not accepted by some signers.

## Chains used in examples

Polygon `137`, Katana `747474`, Arbitrum `42161`. USDC addresses:
Arbitrum `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`,
Polygon `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`.
USDT Polygon `0xc2132D05D31c914a87C6611C10748AEb04B58e8F`.
Call `YieldGetMarkets` for the authoritative per-chain token list.
