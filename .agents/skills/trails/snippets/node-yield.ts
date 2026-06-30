/**
 * Yield (Earn) via the Trails Direct API, with an external signer.
 *
 * Trails builds the transactions; you sign them. Trails is wallet-agnostic and never
 * holds keys, so plug in any signer in `signAndSend` (a server signer, wagmi, or any
 * agent wallet).
 *
 * Run: TRAILS_API_KEY=... tsx node-yield.ts
 */

const BASE = 'https://trails-api.sequence.app'

// Hydration sentinel = keccak256("sequence.trails.hydrate.amount.sentinel.v1"). The v1.5
// executor swaps it for the wallet's runtime balance. Prefer importing
// TRAILS_HYDRATE_PLACEHOLDER_AMOUNT from `0xtrails` over hardcoding.
// NOTE: it is NOT 0xffff...ff — that is uint256 max and makes the destination call revert.
const TRAILS_HYDRATE_PLACEHOLDER_AMOUNT = '0xfcbc96b9628c6a4da70c90b9e80f5f4ef82922d86bd4cb54db481ae22ed79c53'

async function rpc<T = any>(method: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}/rpc/Trails/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Access-Key': process.env.TRAILS_API_KEY! },
    body: JSON.stringify(body),
  })
  const data: any = await res.json()
  if (!res.ok || data?.error) throw new Error(`${method}: ${data?.msg ?? data?.error ?? res.status}`)
  return data
}

interface WalletTx { chainId: number; to: string; value: string; data: string }

/** Parse the `unsignedTransaction` JSON string into the fields a signer needs. */
function toTx(unsignedTransaction: string): WalletTx {
  const t = JSON.parse(unsignedTransaction)
  return {
    chainId: Number(t.chainId),
    to: t.to,
    data: t.data ?? '0x',
    value: t.value ? `0x${BigInt(t.value).toString(16)}` : '0x0',
  }
}

/**
 * Replace this with your wallet. The transaction is already built by Trails; the signer
 * only sets nonce and gas and broadcasts. For example, sign with viem/ethers and send,
 * or shell out to your wallet's CLI, then return the broadcast transaction hash.
 */
async function signAndSend(tx: WalletTx): Promise<string> {
  throw new Error(`Implement signAndSend with your wallet. Got: ${JSON.stringify(tx)}`)
}

/**
 * RECOMMENDED for the raw API: deposit with ANY input token in two steps —
 *   1) a QuoteIntent swap into the vault's token, delivered to the user's own wallet, then
 *   2) YieldCreateEnterAction to deposit it.
 * No hand-built calldata, no placeholder. Robust because each step is a plain, supported call.
 *
 * For a SINGLE-signature deposit, build a v1.5 hydrate-multicall with the `0xtrails` SDK
 * (compose `swap(...)` + `lend/deposit({ amount: dynamic() })`, then `encodeMulticallHydrateExecute`)
 * and pass it as `destinationCallData` to the Trails v1.5 executor. See YIELD_API_RECIPES.md §5.
 * Do NOT point destinationToAddress at the vault with a bare supply() + placeholder — that is
 * the deprecated pre-v1.5 shape and reverts against the current API.
 */
async function depositAnyToken(opts: {
  owner: string
  market: { id: string; chainId: number; token: string; tokenDecimals: number } // the vault
  origin: { chainId: number; token: string; amountWei: string }                  // what the user holds
}): Promise<{ swapHash: string; depositHashes: string[] }> {
  // 1) Swap origin token -> vault token, delivered to the user (no destinationCallData).
  //    Same shape bridges automatically when origin and market chains differ.
  const { intent } = await rpc('QuoteIntent', {
    ownerAddress: opts.owner,
    originChainId: opts.origin.chainId,
    originTokenAddress: opts.origin.token,
    originTokenAmount: opts.origin.amountWei,
    destinationChainId: opts.market.chainId,
    destinationTokenAddress: opts.market.token,
    destinationToAddress: opts.owner,
    tradeType: 'EXACT_INPUT',
  })
  const { intentId } = await rpc('CommitIntent', { intent })
  const swapHash = await signAndSend(toTx(JSON.stringify(intent.depositTransaction)))
  await rpc('ExecuteIntent', { intentId, depositTransactionHash: swapHash })
  let receipt: any
  do { receipt = await rpc('WaitIntentReceipt', { intentId }) } while (!receipt.done)
  if (receipt.intentReceipt.status !== 'SUCCEEDED') throw new Error('swap failed; origin deposit refunded')

  // 2) Deposit the vault token we now hold (approve + supply via the enter action).
  const received = receipt.intentReceipt.summary.destinationTokenAmount as string
  const human = (Number(received) / 10 ** opts.market.tokenDecimals).toString()
  const depositHashes = await deposit(opts.market.id, opts.owner, human)
  return { swapHash, depositHashes }
}

/**
 * Shortcut: deposit when the user already holds the vault's token, on the vault's chain.
 * For any other token, use depositAnyToken (the recommended path above).
 */
async function deposit(marketId: string, owner: string, amount: string): Promise<string[]> {
  const { action } = await rpc('YieldCreateEnterAction', {
    earnMarketId: marketId, userWalletAddress: owner, args: { amount },
  })
  const txs = action.transactions
    .sort((a: any, b: any) => a.stepIndex - b.stepIndex)
    .map((t: any) => toTx(t.unsignedTransaction))
  const hashes: string[] = []
  for (const tx of txs) hashes.push(await signAndSend(tx)) // approve, then supply
  return hashes
}

/** Withdraw from a market. Pass an amount, or omit it to exit the full position. */
async function withdraw(marketId: string, owner: string, amount?: string): Promise<string[]> {
  const args = amount ? { amount } : { useMaxAmount: true }
  const { action } = await rpc('YieldCreateExitAction', {
    earnMarketId: marketId, userWalletAddress: owner, args,
  })
  const txs = action.transactions
    .sort((a: any, b: any) => a.stepIndex - b.stepIndex)
    .map((t: any) => toTx(t.unsignedTransaction))
  const hashes: string[] = []
  for (const tx of txs) hashes.push(await signAndSend(tx))
  return hashes
}

/** Deposit from another chain: bridge first, then enter on the destination chain. */
async function depositCrossChain(
  marketId: string, owner: string,
  origin: { chainId: number; usdc: string; amountWei: string }, destUsdc: string,
): Promise<{ bridgeHash: string; depositHashes: string[] }> {
  const network = marketId.split('-')[0]
  const destChainId = { polygon: 137, katana: 747474, arbitrum: 42161, base: 8453, optimism: 10 }[network]!

  const { intent } = await rpc('QuoteIntent', {
    ownerAddress: owner,
    originChainId: origin.chainId, originTokenAddress: origin.usdc, originTokenAmount: origin.amountWei,
    destinationChainId: destChainId, destinationTokenAddress: destUsdc, destinationToAddress: owner,
    tradeType: 'EXACT_INPUT',
  })
  const { intentId } = await rpc('CommitIntent', { intent })
  const bridgeHash = await signAndSend(toTx(JSON.stringify(intent.depositTransaction)))
  await rpc('ExecuteIntent', { intentId, depositTransactionHash: bridgeHash })

  let receipt: any
  do { receipt = await rpc('WaitIntentReceipt', { intentId }) } while (!receipt.done)
  if (receipt.intentReceipt.status !== 'SUCCEEDED') {
    throw new Error('Bridge intent failed; Trails refunds the origin deposit.')
  }

  const human = (Number(intent.quote.toAmountMin) / 1e6).toString() // USDC has 6 decimals
  const depositHashes = await deposit(marketId, owner, human)
  return { bridgeHash, depositHashes }
}

// Discover markets, then act. Wire up `signAndSend` before running for real.
async function main() {
  const owner = process.env.OWNER ?? '0xYourAddress'
  const { items } = await rpc('YieldGetMarkets', { chainId: '137', type: 'vault', limit: 10 })
  console.log(items.map((m: any) => `${m.id}  ${(m.rewardRate.total * 100).toFixed(2)}% APY  ${m.token.symbol}`))
  // await deposit(items[0].id, owner, '10')
  // await withdraw(items[0].id, owner) // full exit
}

main().catch((e) => { console.error(e); process.exit(1) })

export { depositAnyToken, deposit, withdraw, depositCrossChain, TRAILS_HYDRATE_PLACEHOLDER_AMOUNT }
