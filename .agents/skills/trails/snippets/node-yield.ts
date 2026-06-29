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

/** Deposit `amount` (human units) into a market on its own chain. */
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

export { deposit, withdraw, depositCrossChain }
