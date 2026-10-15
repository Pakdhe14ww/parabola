import { describe, it, expect } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  stellarAddressToBytes32,
  bytes32ToStellarAddress,
  encodeStellarForwardHook,
  evmAddressToBytes32,
  parseUsdcAmount,
  formatUsdcAmount,
  convertPrecision,
} from "../src/utils/encoding.js";

describe("stellarAddressToBytes32 / bytes32ToStellarAddress", () => {
  it("round-trips a Stellar ed25519 public key through bytes32", () => {
    const keypair = Keypair.random();
    const address = keypair.publicKey();

    const bytes32 = stellarAddressToBytes32(address);
    expect(bytes32).toMatch(/^0x[0-9a-f]{64}$/);

    const roundTripped = bytes32ToStellarAddress(bytes32);
    expect(roundTripped).toBe(address);
  });

  it("encodes a Stellar contract (CctpForwarder) strkey without throwing", () => {
    const raw = Buffer.alloc(32, 7);
    const contractAddress = StrKey.encodeContract(raw);

    const bytes32 = stellarAddressToBytes32(contractAddress);
    expect(bytes32).toBe(`0x${raw.toString("hex")}`);
  });

  it("throws on an invalid Stellar address", () => {
    expect(() => stellarAddressToBytes32("not-a-stellar-address")).toThrow(
      /Invalid Stellar address/,
    );
  });
});

describe("encodeStellarForwardHook", () => {
  it("encodes a G... recipient into the CctpForwarder hook payload format", () => {
    const keypair = Keypair.random();
    const recipient = keypair.publicKey();

    const hook = encodeStellarForwardHook(recipient);
    const bytes = Buffer.from(hook.slice(2), "hex");

    // 32-byte header (version at 24-27, strkey length at 28-31) + strkey utf8 bytes
    expect(bytes.length).toBe(32 + recipient.length);
    expect(bytes.readUInt32BE(24)).toBe(0); // version
    expect(bytes.readUInt32BE(28)).toBe(recipient.length);
    expect(bytes.subarray(32).toString("utf8")).toBe(recipient);
  });

  // A malformed recipient here has nowhere else to fail loudly: mint_and_forward
  // would eventually reject it on-chain, but only after the source-chain burn has
  // already spent real funds. This must throw before that burn is ever submitted.
  it("throws on a malformed recipient instead of silently encoding garbage", () => {
    expect(() => encodeStellarForwardHook("not-a-stellar-address")).toThrow(
      /Invalid Stellar address/,
    );
    expect(() => encodeStellarForwardHook("GTRUNCATED")).toThrow(/Invalid Stellar address/);
  });
});

describe("evmAddressToBytes32", () => {
  it("pads a valid 20-byte EVM address to 32 bytes", () => {
    const address = `0x${"1".repeat(39)}C`; // 40 hex chars, verified by construction
    expect(evmAddressToBytes32(address)).toBe(`0x000000000000000000000000${address.slice(2)}`);
  });

  // Before this validation existed, viem's pad() would silently accept a truncated
  // or non-hex string and produce a syntactically valid but wrong bytes32 -- the
  // burn would then succeed toward an address nobody controls, funds unrecoverable.
  it("throws on a truncated address instead of silently padding it into a wrong one", () => {
    expect(() => evmAddressToBytes32("0x1234")).toThrow(/Invalid EVM address/);
  });

  it("throws on a non-hex string instead of silently encoding it", () => {
    expect(() => evmAddressToBytes32("not-a-hex-address")).toThrow(/Invalid EVM address/);
  });

  it("throws on an address missing the 0x prefix", () => {
    expect(() => evmAddressToBytes32("70997970C51812dc3A010C7d01b50e0d17dc79C")).toThrow(
      /Invalid EVM address/,
    );
  });
});

describe("parseUsdcAmount / formatUsdcAmount", () => {
  it("parses whole amounts", () => {
    expect(parseUsdcAmount("10", 6)).toBe(10_000_000n);
  });

  it("parses fractional amounts at Arc's 6 decimals", () => {
    expect(parseUsdcAmount("10.50", 6)).toBe(10_500_000n);
  });

  it("parses fractional amounts at Stellar's 7 decimals", () => {
    expect(parseUsdcAmount("10.5000001", 7)).toBe(105_000_001n);
  });

  it("rejects excess precision", () => {
    expect(() => parseUsdcAmount("10.1234567", 6)).toThrow(/more precision/);
  });

  it("rejects malformed amounts", () => {
    expect(() => parseUsdcAmount("abc", 6)).toThrow(/Invalid USDC amount/);
    expect(() => parseUsdcAmount("-1", 6)).toThrow(/Invalid USDC amount/);
  });

  it("formats raw subunits back into human-readable amounts", () => {
    expect(formatUsdcAmount(10_500_000n, 6)).toBe("10.5");
    expect(formatUsdcAmount(10_000_000n, 6)).toBe("10");
    expect(formatUsdcAmount(105_000_001n, 7)).toBe("10.5000001");
  });

  it("round-trips parse -> format", () => {
    const amounts = ["0.000001", "1234.56", "1", "999999.999999"];
    for (const amount of amounts) {
      expect(formatUsdcAmount(parseUsdcAmount(amount, 6), 6)).toBe(amount);
    }
  });
});

describe("convertPrecision", () => {
  it("converts Stellar's 7-decimal USDC down to Arc's 6-decimal USDC, truncating excess precision", () => {
    // 10.5000001 on Stellar (7 decimals) -> 10.500000 on Arc (6 decimals), truncated
    expect(convertPrecision(105_000_001n, 7, 6)).toBe(10_500_000n);
  });

  it("converts Arc's 6-decimal USDC up to Stellar's 7-decimal USDC", () => {
    expect(convertPrecision(10_500_000n, 6, 7)).toBe(105_000_000n);
  });

  it("is a no-op when decimals match", () => {
    expect(convertPrecision(123n, 6, 6)).toBe(123n);
  });
});

describe("bytes32ToStellarAddress input validation", () => {
  const valid = `0x${"ab".repeat(32)}` as const;

  it("rejects a value with no 0x prefix", () => {
    expect(() => bytes32ToStellarAddress("ab".repeat(32) as `0x${string}`)).toThrow(
      /expected a 0x-prefixed 32-byte hex string/,
    );
  });

  it("rejects an odd-length hex string instead of dropping the leading nibble", () => {
    // Buffer.from would decode this to 31 bytes after discarding the first nibble.
    expect(() => bytes32ToStellarAddress(`0x${"a".repeat(63)}` as `0x${string}`)).toThrow(
      /expected a 0x-prefixed 32-byte hex string/,
    );
  });

  it("rejects non-hex characters instead of truncating at them", () => {
    // Buffer.from stops at "zz" and would have silently decoded the 62 hex chars before it.
    expect(() => bytes32ToStellarAddress(`0x${"a".repeat(62)}zz` as `0x${string}`)).toThrow(
      /expected a 0x-prefixed 32-byte hex string/,
    );
  });

  it("rejects a 31-byte and a 33-byte value", () => {
    expect(() => bytes32ToStellarAddress(`0x${"ab".repeat(31)}` as `0x${string}`)).toThrow(
      /expected a 0x-prefixed 32-byte hex string/,
    );
    expect(() => bytes32ToStellarAddress(`0x${"ab".repeat(33)}` as `0x${string}`)).toThrow(
      /expected a 0x-prefixed 32-byte hex string/,
    );
  });

  it("round-trips a G... account through both directions", () => {
    const address = Keypair.random().publicKey();

    expect(bytes32ToStellarAddress(stellarAddressToBytes32(address))).toBe(address);
  });

  it("reads a C... contract id back as a contract strkey when told the bytes are one", () => {
    const raw = Buffer.alloc(32, 9);
    const contractAddress = StrKey.encodeContract(raw);

    expect(bytes32ToStellarAddress(stellarAddressToBytes32(contractAddress), "contract")).toBe(
      contractAddress,
    );
  });

  it("defaults to an ed25519 strkey for the same 32 bytes, which is a different G... address", () => {
    // Documents the ambiguity: the strkey version byte is not part of the CCTP payload, so
    // the default produces the G... form of the same key rather than the C... id.
    const raw = Buffer.alloc(32, 9);
    const contractAddress = StrKey.encodeContract(raw);

    const asEd25519 = bytes32ToStellarAddress(stellarAddressToBytes32(contractAddress));

    expect(asEd25519).not.toBe(contractAddress);
    expect(StrKey.isValidEd25519PublicKey(asEd25519)).toBe(true);
    expect(raw.equals(StrKey.decodeEd25519PublicKey(asEd25519))).toBe(true);
  });
});
