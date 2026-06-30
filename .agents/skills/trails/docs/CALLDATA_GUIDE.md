# Calldata Guide

How to encode and use calldata for destination contract execution with Trails.

## What is Calldata?

Calldata is the encoded function call that Trails will execute on the destination chain after bridging/swapping tokens. This enables:

- Depositing into DeFi vaults
- Staking tokens
- Executing any smart contract function
- Multi-step DeFi operations

## When to Use Calldata

| Scenario | Use Calldata? |
|----------|---------------|
| Simple token transfer | No |
| Swap and send to wallet | No |
| Deposit into vault after bridge | **Yes** |
| Stake tokens after cross-chain transfer | **Yes** |
| Call arbitrary contract function | **Yes** |

---

## Encoding Calldata with viem

Use viem's `encodeFunctionData` for type-safe encoding:

```typescript
import { encodeFunctionData } from 'viem';

// Define the ABI for the function you want to call
const vaultAbi = [
  {
    name: 'deposit',
    type: 'function',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
] as const;

// Encode the function call
const calldata = encodeFunctionData({
  abi: vaultAbi,
  functionName: 'deposit',
  args: [BigInt('1000000000'), '0xReceiverAddress'],
});

console.log(calldata);
// 0x6e553f65000000000000000000000000000000000000000000000000000000003b9aca00000000000000000000000000...
```

---

## The Placeholder Pattern (Fund / Earn, intent protocol v1.5)

When you don't know the exact output amount until execution, mark the amount slot with the
**hydration sentinel**. The v1.5 executor (`HydrateProxy`) replaces it with the wallet's
runtime balance. There is a matching **self-address sentinel** for address slots (e.g. a swap
`recipient`) that should resolve to the intent wallet.

```typescript
import { encodeFunctionData } from 'viem';
// Prefer importing these from the SDK instead of hardcoding:
//   import { TRAILS_HYDRATE_PLACEHOLDER_AMOUNT, TRAILS_HYDRATE_SELF_ADDRESS, dynamic, self } from '0xtrails';

// keccak256("sequence.trails.hydrate.amount.sentinel.v1") — the amount sentinel.
const PLACEHOLDER_AMOUNT = BigInt(
  '0xfcbc96b9628c6a4da70c90b9e80f5f4ef82922d86bd4cb54db481ae22ed79c53'
);
// uint160(keccak256("sequence.trails.hydrate.address.sentinel.v1")) — the self-address sentinel.
const SELF_ADDRESS = '0xd80d3a37a85094663c36c062e5ef689f2bf54fca';

const vaultAbi = [
  {
    name: 'deposit',
    type: 'function',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [],
  },
] as const;

const calldata = encodeFunctionData({
  abi: vaultAbi,
  functionName: 'deposit',
  args: [PLACEHOLDER_AMOUNT, '0xUserAddress'],
});
```

> ⚠️ **Do not use `0xffff…ff` (uint256 max).** That is not the sentinel — the executor treats
> it as a literal amount, the call tries to pull a near-infinite balance, and the intent ends
> `REFUNDED`. The sentinel is `0xfcbc96b9…`.

**Easier: let the SDK place the sentinels.** With `0xtrails` you compose typed actions and
pass `dynamic()` / `self()` instead of hand-encoding the sentinel:

```typescript
import { swap, lend, dynamic, resolveActionsToCalls, encodeMulticallHydrateExecute } from '0xtrails';

const calls = resolveActionsToCalls({
  chainId: 137,
  actions: [
    swap({ tokenIn: USDC, tokenOut: vaultToken, amountIn: '0.15' }),
    lend({ marketId, amount: dynamic() }),   // dynamic() == the amount sentinel
  ],
});
const destinationCallData = encodeMulticallHydrateExecute({ calls, token: vaultToken, sweepTarget: userAddress });
// then QuoteIntent with destinationToAddress = the Trails v1.5 executor, destinationCallData, EXACT_OUTPUT
```

### When to Use Placeholder

| Mode | Trade Type | Use Placeholder? |
|------|------------|------------------|
| Pay | EXACT_OUTPUT | No - you know the exact amount |
| Swap (exact output) | EXACT_OUTPUT | No - you know the exact amount |
| Fund | EXACT_INPUT | **Yes** - output varies |
| Earn | EXACT_INPUT | **Yes** - output varies |
| Swap (exact input) | EXACT_INPUT | **Yes** - output varies |

---

## Common Calldata Patterns

### ERC-4626 Vault Deposit

```typescript
import { encodeFunctionData } from 'viem';

const PLACEHOLDER = BigInt('0xfcbc96b9628c6a4da70c90b9e80f5f4ef82922d86bd4cb54db481ae22ed79c53');

const erc4626Abi = [
  {
    name: 'deposit',
    type: 'function',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
] as const;

const calldata = encodeFunctionData({
  abi: erc4626Abi,
  functionName: 'deposit',
  args: [PLACEHOLDER, receiverAddress],
});
```

### Staking Contract

```typescript
import { encodeFunctionData } from 'viem';

const PLACEHOLDER = BigInt('0xfcbc96b9628c6a4da70c90b9e80f5f4ef82922d86bd4cb54db481ae22ed79c53');

const stakingAbi = [
  {
    name: 'stake',
    type: 'function',
    inputs: [
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const calldata = encodeFunctionData({
  abi: stakingAbi,
  functionName: 'stake',
  args: [PLACEHOLDER],
});
```

### Liquidity Pool Deposit

```typescript
import { encodeFunctionData } from 'viem';

const PLACEHOLDER = BigInt('0xfcbc96b9628c6a4da70c90b9e80f5f4ef82922d86bd4cb54db481ae22ed79c53');

const lpAbi = [
  {
    name: 'addLiquidity',
    type: 'function',
    inputs: [
      { name: 'tokenAmount', type: 'uint256' },
      { name: 'minLpTokens', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'lpTokens', type: 'uint256' }],
  },
] as const;

const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour

const calldata = encodeFunctionData({
  abi: lpAbi,
  functionName: 'addLiquidity',
  args: [PLACEHOLDER, BigInt(0), deadline], // 0 minLpTokens for no slippage protection
});
```

### Approval + Deposit (Multi-call)

Some contracts require approval before deposit. If the destination contract handles this internally, you may need a multicall pattern:

```typescript
import { encodeFunctionData } from 'viem';

const PLACEHOLDER = BigInt('0xfcbc96b9628c6a4da70c90b9e80f5f4ef82922d86bd4cb54db481ae22ed79c53');

// If using a contract that supports multicall
const multicallAbi = [
  {
    name: 'multicall',
    type: 'function',
    inputs: [{ name: 'data', type: 'bytes[]' }],
    outputs: [{ name: 'results', type: 'bytes[]' }],
  },
] as const;

// Individual calls
const approveCall = encodeFunctionData({
  abi: [{ name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }],
  functionName: 'approve',
  args: [vaultAddress, PLACEHOLDER],
});

const depositCall = encodeFunctionData({
  abi: [{ name: 'deposit', type: 'function', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] }],
  functionName: 'deposit',
  args: [PLACEHOLDER],
});

// Note: Multicall approach depends on your target contract's support
```

---

## Using Calldata with Widget

```tsx
import { TrailsWidget } from '0xtrails';
import { encodeFunctionData } from 'viem';

const PLACEHOLDER = BigInt('0xfcbc96b9628c6a4da70c90b9e80f5f4ef82922d86bd4cb54db481ae22ed79c53');

const vaultAbi = [
  {
    name: 'deposit',
    type: 'function',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [],
  },
] as const;

function VaultDeposit({ vaultAddress, userAddress }: {
  vaultAddress: `0x${string}`;
  userAddress: `0x${string}`;
}) {
  const calldata = encodeFunctionData({
    abi: vaultAbi,
    functionName: 'deposit',
    args: [PLACEHOLDER, userAddress],
  });

  return (
    <TrailsWidget
      mode="fund"
      destinationChainId={42161}
      destinationTokenAddress="0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
      destinationRecipient={vaultAddress}
      destinationCalldata={calldata}
    />
  );
}
```

---

## Using Calldata with Headless SDK

```tsx
import { useQuote } from '0xtrails';
import { encodeFunctionData } from 'viem';
import { useState } from 'react';

const PLACEHOLDER = BigInt('0xfcbc96b9628c6a4da70c90b9e80f5f4ef82922d86bd4cb54db481ae22ed79c53');

function useVaultDeposit(vaultAddress: `0x${string}`, userAddress: `0x${string}`) {
  const [inputAmount, setInputAmount] = useState('');

  const calldata = inputAmount
    ? encodeFunctionData({
        abi: VAULT_ABI,
        functionName: 'deposit',
        args: [PLACEHOLDER, userAddress],
      })
    : undefined;

  const { quote, isPending, isSuccess } = useQuote(
    inputAmount && calldata
      ? {
          destinationChainId: 42161,
          destinationTokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
          destinationRecipient: vaultAddress,
          destinationCalldata: calldata,
          sourceAmount: inputAmount, // User's input amount
        }
      : null
  );

  return { quote, isPending, isSuccess, setInputAmount, inputAmount };
}
```

---

## Using Calldata with Direct API

```typescript
import { TrailsAPI } from '@0xtrails/api';
import { encodeFunctionData } from 'viem';

const trails = new TrailsAPI({ apiKey: process.env.TRAILS_API_KEY! });

const PLACEHOLDER = BigInt('0xfcbc96b9628c6a4da70c90b9e80f5f4ef82922d86bd4cb54db481ae22ed79c53');

async function depositToVault(
  vaultAddress: string,
  userAddress: string,
  inputAmount: string
) {
  const calldata = encodeFunctionData({
    abi: VAULT_ABI,
    functionName: 'deposit',
    args: [PLACEHOLDER, userAddress],
  });

  const quote = await trails.quoteIntent({
    sourceChainId: 1,
    sourceTokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    destinationChainId: 42161,
    destinationTokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    amount: inputAmount,
    tradeType: 'EXACT_INPUT',
    userAddress,
    destinationRecipient: vaultAddress,
    destinationCalldata: calldata,
  });

  // Continue with commit, execute, wait...
  return quote;
}
```

---

## Debugging Calldata

### Decode and Verify

```typescript
import { decodeFunctionData } from 'viem';

const decoded = decodeFunctionData({
  abi: vaultAbi,
  data: calldata,
});

console.log('Function:', decoded.functionName);
console.log('Args:', decoded.args);
```

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Transaction reverts | Wrong function signature | Verify ABI matches contract |
| Unexpected behavior | Wrong argument order | Check ABI input ordering |
| Amount mismatch | Forgot placeholder | Use `0xff...ff` for EXACT_INPUT |
| Gas estimation fails | Target contract issue | Test calldata on destination chain first |

---

## Security Considerations

1. **Verify target contract**: Ensure `destinationRecipient` is a trusted contract
2. **Validate ABI**: Use the official ABI from the contract
3. **Test on testnet**: Always test calldata flows on testnets first
4. **Slippage protection**: Consider adding minAmount checks in your contract calls
5. **Deadline parameters**: Include deadlines for time-sensitive operations
