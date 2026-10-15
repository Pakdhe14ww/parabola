import { StrKey } from "@stellar/stellar-sdk";
import { toHex, pad } from "viem";

/**
 * Translates a Stellar address (G... account or C... contract strkey) into the
 * bytes32 hex format CCTP expects as a mint recipient / hook payload field.
 *
 * Circle's CCTP V2 message format encodes non-EVM recipients as 32-byte values.
 * For Stellar this is the raw ed25519 public key (G...) or contract id (C...)
 * left-padded to 32 bytes, matching StrKey.decodeContract / decodeEd25519PublicKey.
 */
export function stellarAddressToBytes32(address: string): `0x${string}` {
  let raw: Buffer;
  if (StrKey.isValidEd25519PublicKey(address)) {
    raw = StrKey.decodeEd25519PublicKey(address);
  } else if (StrKey.isValidContract(address)) {
    raw = StrKey.decodeContract(address);
  } else {
    throw new Error(`Invalid Stellar address: ${address}`);
  }
  if (raw.length !== 32) {
    throw new Error(`Expected 32-byte Stellar key, got ${raw.length} bytes`);
  }
  return pad(toHex(raw), { size: 32 });
}

const STELLAR_KEY_BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Inverse of stellarAddressToBytes32: reads a CCTP 32-byte recipient field back into a
 * Stellar strkey.
 *
 * The 32 bytes are a raw ed25519 public key or contract id with the strkey version byte
 * stripped, so the bytes alone do not say which strkey kind they came from — both are 32
 * bytes and both pad to the same width. `strkeyKind` states that, defaulting to the
 * ed25519 public key (`"ed25519"`, a G... account) that this function has always returned.
 * Pass `"contract"` for a C... contract id such as the CctpForwarder, which is decoded with
 * StrKey.encodeContract instead; leaving it at the default would produce a valid-looking
 * G... address that is not the contract that was encoded.
 */
export function bytes32ToStellarAddress(
  bytes32: `0x${string}`,
  strkeyKind: "ed25519" | "contract" = "ed25519",
): string {
  // Buffer.from(hex, "hex") is forgiving in two ways that matter here: it stops at the first
  // non-hex character and it drops the leading nibble of an odd-length string. Either one
  // turns a malformed recipient into a plausible-looking address, and since this value
  // decides where a mint is sent, that is a funds-loss path rather than a cosmetic bug.
  // Validate the shape before decoding anything.
  if (typeof bytes32 !== "string" || !STELLAR_KEY_BYTES32_PATTERN.test(bytes32)) {
    throw new Error(
      `Invalid CCTP recipient: expected a 0x-prefixed 32-byte hex string, got ${JSON.stringify(bytes32)}`,
    );
  }
  const raw = Buffer.from(bytes32.slice(2), "hex");
  return strkeyKind === "contract"
    ? StrKey.encodeContract(raw)
    : StrKey.encodeEd25519PublicKey(raw);
}

/**
 * Encodes a Stellar strkey recipient into the CCTP depositForBurnWithHook payload
 * format CctpForwarder expects: a single 32-byte header (bytes 0-23 zero, bytes
 * 24-27 hook version as uint32, bytes 28-31 strkey byte length as uint32) followed
 * immediately by the UTF-8 strkey bytes at offset 32. There is no separate length
 * field beyond the header: the strkey starts right after byte 31. Verified
 * against Circle's reference implementation; re-verify there before changing.
 */
export function encodeStellarForwardHook(recipientStrkey: string): `0x${string}` {
  if (!StrKey.isValidEd25519PublicKey(recipientStrkey) && !StrKey.isValidContract(recipientStrkey)) {
    // A malformed recipient here isn't caught anywhere else: mint_and_forward would
    // fail on-chain eventually, but only after the source-chain burn has already
    // spent real funds. Reject it before that burn is ever submitted.
    throw new Error(`Invalid Stellar address: ${recipientStrkey}`);
  }
  const recipientBytes = Buffer.from(recipientStrkey, "utf8");
  const hookData = Buffer.alloc(32 + recipientBytes.length);
  hookData.writeUInt32BE(0, 24); // hook version = 0
  hookData.writeUInt32BE(recipientBytes.length, 28); // strkey byte length
  recipientBytes.copy(hookData, 32);
  return toHex(hookData);
}

/**
 * Reads the Stellar recipient back out of a CctpForwarder hook payload, the inverse of
 * encodeStellarForwardHook. Returns undefined when the payload cannot be read: too short
 * for the header, an unrecognized hook version (whose layout is unknown), a length field
 * that overruns the payload, or bytes that are not a valid Stellar strkey. Callers must
 * treat undefined as "destination unknown" rather than as an empty recipient.
 */
export function decodeStellarForwardHook(hookData: string): string | undefined {
  const hex = hookData.startsWith("0x") ? hookData.slice(2) : hookData;
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    return undefined;
  }
  const raw = Buffer.from(hex, "hex");
  if (raw.length < 32) {
    return undefined;
  }
  if (raw.readUInt32BE(24) !== 0) {
    return undefined;
  }
  const length = raw.readUInt32BE(28);
  if (length === 0 || raw.length < 32 + length) {
    return undefined;
  }
  const strkey = raw.subarray(32, 32 + length).toString("utf8");
  if (!StrKey.isValidEd25519PublicKey(strkey) && !StrKey.isValidContract(strkey)) {
    return undefined;
  }
  return strkey;
}

/**
 * Converts a human-readable USDC amount string (e.g. "10.50") into raw subunits
 * for the given number of decimals, as a bigint. Avoids floating point error by
 * operating on the string directly.
 */
export function parseUsdcAmount(amount: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new Error(`Invalid USDC amount: ${amount}`);
  }
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > decimals) {
    throw new Error(
      `Amount ${amount} has more precision than ${decimals} decimals supports`,
    );
  }
  const paddedFraction = fraction.padEnd(decimals, "0");
  return BigInt(whole + paddedFraction);
}

/** Converts raw USDC subunits back into a human-readable decimal string. */
export function formatUsdcAmount(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const str = abs.toString().padStart(decimals + 1, "0");
  const whole = str.slice(0, str.length - decimals);
  const fraction = str.slice(str.length - decimals).replace(/0+$/, "");
  const formatted = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${formatted}` : formatted;
}

const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

/** Pads a 20-byte EVM address (Arc) out to the 32-byte recipient format CCTP messages use. */
export function evmAddressToBytes32(address: string): `0x${string}` {
  // address is typed `0x${string}` at every call site, but that's a compile-time
  // assertion only; a caller passing a truncated or malformed string at runtime hits
  // no check downstream, since viem's pad() just pads bytes, it doesn't validate hex.
  // A garbage recipient here would silently become a syntactically valid but wrong
  // bytes32, and the source-chain burn would succeed toward it, funds gone. Reject
  // it before that burn is ever submitted.
  if (!EVM_ADDRESS_PATTERN.test(address)) {
    throw new Error(`Invalid EVM address: ${address}`);
  }
  return pad(address as `0x${string}`, { size: 32 });
}

/**
 * Converts a raw amount from one decimal precision to another, e.g. Stellar's
 * 7-decimal USDC to Arc's 6-decimal USDC. Truncates any excess precision.
 */
export function convertPrecision(
  raw: bigint,
  fromDecimals: number,
  toDecimals: number,
): bigint {
  if (fromDecimals === toDecimals) return raw;
  if (toDecimals > fromDecimals) {
    return raw * 10n ** BigInt(toDecimals - fromDecimals);
  }
  return raw / 10n ** BigInt(fromDecimals - toDecimals);
}
