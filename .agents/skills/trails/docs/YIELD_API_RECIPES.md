# Yield (Earn) via the Direct API

For yield deposits and withdrawals in an agent, backend, or CLI (anywhere without a
React UI), use the Direct API with the Yield endpoints. Trails builds the transactions;
you sign them with your own wallet. Trails is wallet-agnostic and never holds keys, so
this composes with any external signer (a server signer, wagmi, or any agent wallet).

Prefer this path over the Earn widget whenever the caller is not a React app.

## Setup

- Base URL: `https://trails-api.sequence.app`
- Auth header: `X-Access-Key: $TRAILS_API_KEY`
- Get a key: https://dashboard.trails.build
- Endpoints are RPC-style: `POST /rpc/Trails/{Method}` with a JSON body.

The recipes below use raw `fetch` so they port to any language. The `@0xtrails/trails-api`
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
```

## 1. Discover markets — `YieldGetMarkets`

```ts
const { items } = await rpc('YieldGetMarkets', {
  chainId: '137',      // string. Polygon 137, Katana 747474, etc. Omit for all chains.
  type: 'vault',       // optional: 'vault' | 'lending'
  search: 'USDC',      // optional free-text over names and tokens
  sort: 'rewardRateDesc',
  limit: 100,          // max 100. Use offset to page.
  offset: 0,
})
```

Each market in `items`:

```jsonc
{
  "id": "polygon-yearn-v3-0x34b9421Fe3d52191B64bC32ec1aB764dcBcDbF5e", // earnMarketId
  "chainId": "137", "network": "polygon",
  "rewardRate": { "total": 0.0425, "rateType": "APY" },
  "statistics": { "tvlUsd": "93761.07" },           // string or null
  "status": { "enter": true, "exit": true },         // check before acting
  "token": { "symbol": "USDC", "address": "0x3c49...", "decimals": 6 },
  "metadata": { "name": "USDC Yearn Vault V3", "supportedStandards": ["ERC4626"] },
  "mechanics": { "arguments": { "enter": { "fields": [...] }, "exit": { "fields": [...] } } }
}
```

Notes:
- `limit` caps at 100. Requesting more returns an endpoint error. Page with `offset`.
- The `id` prefix is the network slug, so you can derive the chain without a second call.
- `mechanics.arguments.enter/exit.fields` lists the exact args a market accepts.

## 2. Deposit — `YieldCreateEnterAction`

```ts
const { action } = await rpc('YieldCreateEnterAction', {
  earnMarketId: market.id,
  userWalletAddress: owner,         // the signer's address
  args: { amount: '10' },           // human units, e.g. "10" USDC. Not wei.
  // optional: receiverAddress, useMaxAllowance (approve uint256.max instead of exact)
})
```

`action.transactions` is an ordered list. Each item has a `type` (`APPROVAL`, `SUPPLY`,
...), a `stepIndex`, and `unsignedTransaction` as a JSON **string**:

```jsonc
{ "action": { "transactions": [
  { "type": "APPROVAL", "stepIndex": 0,
    "unsignedTransaction": "{\"to\":\"0x<token>\",\"data\":\"0x095ea7b3...\",\"chainId\":137}" },
  { "type": "SUPPLY", "stepIndex": 1,
    "unsignedTransaction": "{\"to\":\"0x<vault>\",\"data\":\"0x6e553f65...\",\"chainId\":137}" }
], "executionPattern": "synchronous" } }
```

Sign and broadcast each transaction in `stepIndex` order with your wallet. An ERC-4626
vault deposit is an `approve` then a `deposit(assets, receiver)`. There is no batch
endpoint, so sign sequentially and wait for each to land before the next.

Parse the transaction the wallet needs out of the JSON string:

```ts
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

## 3. Withdraw — `YieldCreateExitAction`

Same response shape as enter. The `args` object requires exactly one of:

```ts
await rpc('YieldCreateExitAction', { earnMarketId: market.id, userWalletAddress: owner,
  args: { amount: '5' } })            // withdraw 5 (human units), OR
  // args: { shareAmount: '5' }       // withdraw 5 vault shares, OR
  // args: { useMaxAmount: true }     // withdraw the entire position
```

Notes:
- Passing none returns `MissingArgumentsError` listing `amount`, `shareAmount`,
  `useMaxAmount`.
- Exit validates against the live on-chain position. Requesting more than you hold returns
  `412 MaximumAmountExceededError`. There is no positions endpoint, so use
  `useMaxAmount: true` to exit fully rather than trying to read a balance first.

## 4. Cross-chain deposit (funds on a different chain)

The Yield endpoints build same-chain transactions. To deposit from another chain, bridge
first with the intent flow, then enter the market on the destination chain.

```ts
// a) Quote a USDC -> USDC bridge into the market's chain
const { intent } = await rpc('QuoteIntent', {
  ownerAddress: owner,
  originChainId: 42161, originTokenAddress: USDC_ARBITRUM, originTokenAmount: '10000000', // wei, 6dp
  destinationChainId: 137, destinationTokenAddress: USDC_POLYGON, destinationToAddress: owner,
  tradeType: 'EXACT_INPUT',
})
// intent.intentId, intent.depositTransaction {to,data,value,chainId}, intent.quote.toAmountMin,
// intent.fees.totalFeeUsd, intent.expiresAt (~5 minutes)

// b) Commit, then sign the single deposit transaction with your wallet
const { intentId } = await rpc('CommitIntent', { intent })
const depositTxHash = await signAndSend(toTx(JSON.stringify(intent.depositTransaction)))

// c) Execute and wait for settlement
await rpc('ExecuteIntent', { intentId, depositTransactionHash: depositTxHash })
let receipt
do { receipt = await rpc('WaitIntentReceipt', { intentId }) } while (!receipt.done)
if (receipt.intentReceipt.status !== 'SUCCEEDED') throw new Error('bridge failed; origin deposit is refunded')

// d) Deposit the bridged proceeds on the destination chain
const human = (Number(intent.quote.toAmountMin) / 1e6).toString()
const { action } = await rpc('YieldCreateEnterAction', {
  earnMarketId: market.id, userWalletAddress: owner, args: { amount: human },
})
// sign action.transactions in stepIndex order
```

Quotes expire in about five minutes. If commit or execute fails on expiry, re-quote.

## Signing model

Every endpoint above returns an unsigned transaction. You provide the signer (a server
signer with viem or ethers, a wagmi connection, or any agent wallet). Parse the
`unsignedTransaction`, let your signer set nonce and gas, and broadcast. Because Trails
never signs, it composes with any wallet: Trails plans, your wallet signs.

## Chains used in examples

Polygon `137`, Katana `747474`, Arbitrum `42161`. USDC addresses:
Arbitrum `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`,
Polygon `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`.
Call `YieldGetMarkets` for the authoritative per-chain token list.
