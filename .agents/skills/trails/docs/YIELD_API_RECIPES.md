# Yield (Earn) via the Direct API

For yield deposits and withdrawals in an agent, backend, or CLI (anywhere without a
React UI), use the Direct API. Trails builds the transactions; you sign them with your own
wallet. Trails is wallet-agnostic and never holds keys, so this composes with any external
signer (a server signer, wagmi, or any agent wallet).

The key idea: a vault accepts one specific token, but the user can deposit with **any**
token on **any** chain. Trails swaps and bridges into the vault's token and runs the
deposit, and the user signs a single transaction. That swap-and-deposit path is the
default (section 2). Calling the yield enter endpoint directly is only a shortcut for when
the user already holds the vault's token (section 3).

Prefer this over the Earn widget whenever the caller is not a React app.

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
  "id": "polygon-wbtc-aave-v3-lending",                // earnMarketId
  "chainId": "137", "network": "polygon",
  "rewardRate": { "total": 0.0425, "rateType": "APY" },
  "statistics": { "tvlUsd": "93761.07" },              // string or null
  "status": { "enter": true, "exit": true },           // check before acting
  "token": { "symbol": "wBTC", "address": "0x1BFD...", "decimals": 8 }, // the vault's input token
  "inputTokens": [ { "symbol": "wBTC", "address": "0x1BFD..." } ],
  "metadata": { "name": "Aave V3 wBTC", "supportedStandards": ["ERC4626"] }
}
```

Notes:
- `limit` caps at 100. Requesting more returns an endpoint error. Page with `offset`.
- The `id` prefix is the network slug, so you can derive the chain without a second call.
- `market.token` (and `inputTokens`) is the token the vault takes. The user rarely holds
  exactly this, which is why section 2 is the default.

## 2. Deposit with any input token (recommended)

This is the default deposit path. The vault takes `market.token` (e.g. wBTC), but the user
usually holds something else (USDC, ETH). Trails swaps, and bridges if needed, the user's
token into the vault's token and executes the deposit in a **single signed transaction**,
using `QuoteIntent` with `destinationCallData`.

Do not use `YieldCreateEnterAction` for this case. That endpoint assumes the user already
holds the vault's token and builds a plain approve + supply on it. From a wallet holding a
different token, the supply reverts on `transferFrom`. Use the enter action only for the
shortcut in section 3.

**Steps**

1. Read the market's input token and deposit target.
   - `destinationTokenAddress` = `market.token.address` (the token the vault takes).
   - The deposit target contract (pool or vault) and the exact deposit function: call
     `YieldCreateEnterAction` once with any small amount and read its `SUPPLY` step. That
     transaction's `to` is the deposit target, and its `data` is the deposit call. (Or
     encode the call yourself per protocol.)
2. Build the deposit calldata with the amount set to `TRAILS_ROUTER_PLACEHOLDER_AMOUNT`
   (the uint256 sentinel `0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff`).
   Trails substitutes the actual post-swap amount at execution. Common shapes:
   - ERC-4626 vault: `deposit(uint256 assets, address receiver)` — placeholder in `assets`,
     `receiver` = the user.
   - Aave V3: `supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)`
     — placeholder in `amount`, `onBehalfOf` = the user.
   See `CALLDATA_GUIDE.md` for encoding.
3. Quote, commit, sign one transaction, execute, wait:

```ts
const { intent } = await rpc('QuoteIntent', {
  ownerAddress: owner,
  originChainId: 137,                          // chain the user funds from (any supported chain)
  originTokenAddress: USDC_POLYGON,            // what the user holds
  originTokenAmount: '1000000',                // 1 USDC (6 dp), wei
  destinationChainId: 137,                     // the market's chain
  destinationTokenAddress: vaultToken,         // market.token.address (e.g. wBTC)
  destinationToAddress: depositTarget,         // the pool/vault to call
  destinationApproveAddress: depositTarget,    // Trails approves vaultToken to it before the call
  destinationCallData: depositCallWithPlaceholder, // deposit(...PLACEHOLDER...)
  tradeType: 'EXACT_INPUT',
})

const { intentId } = await rpc('CommitIntent', { intent })
const depositTxHash = await signAndSend(toTx(JSON.stringify(intent.depositTransaction)))
await rpc('ExecuteIntent', { intentId, depositTransactionHash: depositTxHash })
let receipt
do { receipt = await rpc('WaitIntentReceipt', { intentId }) } while (!receipt.done)
if (receipt.intentReceipt.status !== 'SUCCEEDED') throw new Error('failed; origin deposit is refunded')
```

The user signs exactly one transaction (the origin deposit). Trails handles the swap, any
bridge, the approval of the vault token, and the deposit call.

Cross-chain is the same call: set `originChainId` to the source chain and Trails bridges as
part of the route. Quotes expire in about five minutes; re-quote if commit or execute fails
on expiry.

**Worked example, USDC into the wBTC Aave market on Polygon (verified live)**

```jsonc
POST /rpc/Trails/QuoteIntent
{
  "ownerAddress": "0xYourWallet",
  "originChainId": 137,
  "originTokenAddress": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",     // USDC you hold
  "originTokenAmount": 1000000,                                            // 1 USDC
  "destinationChainId": 137,
  "destinationTokenAddress": "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", // wBTC (market.token)
  "destinationToAddress":     "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // Aave V3 Pool (SUPPLY.to)
  "destinationApproveAddress":"0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  "destinationCallData": "0x617ba037<wBTC><PLACEHOLDER><onBehalfOf=you><referralCode=0>",
  "tradeType": "EXACT_INPUT"
}
```

Trails swaps the USDC to wBTC and calls `Pool.supply(wBTC, <swapped amount>, you, 0)`. You
signed one USDC transaction.

## 3. Deposit when the user already holds the vault token (shortcut)

If the user already holds the vault's input token on the vault's chain, skip the swap and
call `YieldCreateEnterAction` directly.

```ts
const { action } = await rpc('YieldCreateEnterAction', {
  earnMarketId: market.id,
  userWalletAddress: owner,         // the signer's address
  args: { amount: '10' },           // human units of the vault's token. Not wei.
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

Sign each with `toTx` in `stepIndex` order (approve, then supply). There is no batch
endpoint, so sign sequentially and wait for each to land. This endpoint is also the way to
read a protocol's exact deposit call when building the section 2 calldata.

## 4. Withdraw — `YieldCreateExitAction`

Same response shape as the enter shortcut. The `args` object requires exactly one of:

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
- To withdraw to a different token or chain, withdraw to the user's wallet, then run a
  `QuoteIntent` swap or bridge on the proceeds.

## Signing model

Every endpoint above returns an unsigned transaction. You provide the signer (a server
signer with viem or ethers, a wagmi connection, or any agent wallet). Parse the
`unsignedTransaction` with `toTx`, let your signer set nonce and gas, and broadcast.
Because Trails never signs, it composes with any wallet: Trails plans, your wallet signs.

## Chains used in examples

Polygon `137`, Katana `747474`, Arbitrum `42161`. USDC addresses:
Arbitrum `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`,
Polygon `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`.
Call `YieldGetMarkets` for the authoritative per-chain token list.
