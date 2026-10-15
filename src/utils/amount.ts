import type { ChainId } from "../types.js";
import { ARC_MAINNET, STELLAR_MAINNET } from "../constants.js";
import { parseUsdcAmount, formatUsdcAmount } from "./encoding.js";
import { AmountPrecisionError } from "../errors.js";

/**
 * USDC's subunit precision is a property of the asset rather than of the deployment, so one
 * constant answers for both networks: Arc USDC has 6 decimals on testnet and mainnet alike,
 * Stellar USDC has 7 on both. Reading the mainnet constants here is deliberate and is not a
 * network selection.
 *
 * This is the ERC-20 / SEP-41 view of USDC. It is not the same scale as Arc's native
 * balance, which reports the same asset at 18 decimals; see README's "Amounts and decimals".
 */
export function decimalsForChain(chain: ChainId): number {
  return chain === "arc" ? ARC_MAINNET.usdcDecimals : STELLAR_MAINNET.usdcDecimals;
}

/** Parses a human-readable USDC amount into raw subunits native to the given chain. */
export function toRawAmount(amount: string, chain: ChainId): bigint {
  return parseUsdcAmount(amount, decimalsForChain(chain));
}

/** Formats raw subunits native to the given chain back into a human-readable USDC amount. */
export function fromRawAmount(raw: bigint, chain: ChainId): string {
  return formatUsdcAmount(raw, decimalsForChain(chain));
}

/**
 * Counts the decimal places in a human-readable amount that carry meaning, ignoring trailing
 * zeros. "1.1230000" is 3, not 7: the zeros add no precision the caller asked for, and treating
 * them as significant would reject an amount that fits the destination exactly. Returns 0 for a
 * whole number or a string with no fractional part.
 */
export function significantDecimals(amount: string): number {
  const fraction = amount.split(".")[1] ?? "";
  return fraction.replace(/0+$/, "").length;
}

/**
 * Rejects an amount that carries more precision than the destination chain's USDC can represent.
 *
 * transfer() parses the amount in source-chain decimals, so a Stellar-sourced amount with seven
 * decimal places parses cleanly and then has to land on Arc's six-decimal token. Nothing in the
 * transfer path surfaced that mismatch before the pre-flight check here, which runs before any
 * approve or burn: the caller gets a typed error naming the amount, its precision and the
 * destination's supported decimals, and no funds have moved.
 */
export function assertAmountFitsDestination(amount: string, to: ChainId): void {
  const supportedDecimals = decimalsForChain(to);
  const precision = significantDecimals(amount);
  if (precision > supportedDecimals) {
    throw new AmountPrecisionError(
      `Amount ${amount} has ${precision} decimal places, more than the ${supportedDecimals} that ${to} USDC supports; it would be truncated on arrival. Pass an amount with at most ${supportedDecimals} decimal places.`,
      amount,
      precision,
      supportedDecimals,
    );
  }
}
