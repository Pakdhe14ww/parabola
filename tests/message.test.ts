import { describe, it, expect } from "vitest";
import { pad } from "viem";
import { decodeCctpMessage } from "../src/utils/message.js";
import { decodeStellarForwardHook, encodeStellarForwardHook, stellarAddressToBytes32 } from "../src/utils/encoding.js";
import { ARC_TESTNET, STELLAR_TESTNET } from "../src/constants.js";

/** CCTP left-pads address values inside 32-byte fields. */
function paddedAddress(address: string): string {
  return pad(address as `0x${string}`, { size: 32 });
}

/**
 * A real Arc -> Stellar testnet burn, fetched from Circle's Iris sandbox
 * (GET /v2/messages/26?transactionHash=0x24d19d75...). Kept verbatim because it is the only
 * fixture here that pins the byte offsets against bytes Circle actually produced, including
 * the forward hook. The burn moved 1.000000 USDC.
 */
const LIVE_TESTNET_BURN_MESSAGE =
  "0x000000010000001a0000001b57b2f1abb6cd742baaaeae7667bf6b2200336cccfa63812fd025c0ed21151c44" +
  "0000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa" +
  "da6f9ee0786c812344d82817ef19b648b4af120f8bd10bf658e6b99eacff24b8" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "000007d0000007d0" +
  "00000001" +
  "0000000000000000000000003600000000000000000000000000000000000000" +
  "3de86ac50b47eaf2840fe23e48179551660fd1072fba6f445d4a6bd7af4ab93e" +
  "00000000000000000000000000000000000000000000000000000000000f4240" +
  "00000000000000000000000019400f3b62f91c0f08eb8708e6d0228f7b53f0e6" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000038" +
  "47435933504c475a515a57564b51454c573747434851564c565a47524d4749355234484f445836515a4d3745544a5350484246564a505932";

const LIVE_TESTNET_FORWARD_RECIPIENT = "GCY3PLGZQZWVKQELW7GCHQVLVZGRMGI5R4HODX6QZM7ETJSPHBFVJPY2";

describe("decodeCctpMessage", () => {
  it("decodes a live testnet burn message at Circle's documented V2 offsets", () => {
    const decoded = decodeCctpMessage(LIVE_TESTNET_BURN_MESSAGE);

    expect(decoded.version).toBe(1);
    expect(decoded.sourceDomain).toBe(26);
    expect(decoded.destinationDomain).toBe(27);
    expect(decoded.minFinalityThreshold).toBe(2000);
    expect(decoded.finalityThresholdExecuted).toBe(2000);
    expect(decoded.burnBodyVersion).toBe(1);
    expect(decoded.amountRaw).toBe(1_000_000n);
    expect(decoded.maxFeeRaw).toBe(0n);
    expect(decoded.feeExecutedRaw).toBe(0n);
    expect(decoded.expirationBlockRaw).toBe(0n);
  });

  it("reads the header sender as Arc's TokenMessenger and the recipient as Stellar's", () => {
    const decoded = decodeCctpMessage(LIVE_TESTNET_BURN_MESSAGE);

    expect(decoded.sender.toLowerCase()).toBe(paddedAddress(ARC_TESTNET.tokenMessengerV2).toLowerCase());
    expect(decoded.recipient).toBe(stellarAddressToBytes32(STELLAR_TESTNET.tokenMessengerMinter));
  });

  it("reads the burn body's mintRecipient as the CctpForwarder the SDK routes through", () => {
    const decoded = decodeCctpMessage(LIVE_TESTNET_BURN_MESSAGE);

    expect(decoded.burnToken.toLowerCase()).toBe(paddedAddress(ARC_TESTNET.usdc).toLowerCase());
    expect(decoded.mintRecipient).toBe(stellarAddressToBytes32(STELLAR_TESTNET.cctpForwarder));
  });

  it("resolves the forward hook to the account the mint actually paid", () => {
    const decoded = decodeCctpMessage(LIVE_TESTNET_BURN_MESSAGE);

    expect(decoded.forwardRecipient).toBe(LIVE_TESTNET_FORWARD_RECIPIENT);
  });

  it("treats a message with no hook appended as having no forward recipient", () => {
    const noHook = LIVE_TESTNET_BURN_MESSAGE.slice(0, 2 + 376 * 2);

    const decoded = decodeCctpMessage(noHook);

    expect(decoded.hookData).toBeNull();
    expect(decoded.forwardRecipient).toBeNull();
  });

  it("rejects a message shorter than a V2 burn message rather than misreading it", () => {
    expect(() => decodeCctpMessage("0x00000001")).toThrow(/shorter than the 376-byte/);
  });

  it("rejects a non-hex message", () => {
    expect(() => decodeCctpMessage("0xzz")).toThrow(/valid hex/);
  });
});

describe("decodeStellarForwardHook", () => {
  it("round-trips every recipient encodeStellarForwardHook produces", () => {
    const encoded = encodeStellarForwardHook(LIVE_TESTNET_FORWARD_RECIPIENT);

    expect(decodeStellarForwardHook(encoded)).toBe(LIVE_TESTNET_FORWARD_RECIPIENT);
  });

  it("returns undefined for payloads it cannot trust", () => {
    expect(decodeStellarForwardHook("0x00")).toBeUndefined();
    // Length field claims 56 bytes but none follow.
    expect(
      decodeStellarForwardHook(
        "0x0000000000000000000000000000000000000000000000000000000000000038",
      ),
    ).toBeUndefined();
    // Right shape, but the bytes are not a Stellar strkey.
    expect(
      decodeStellarForwardHook(
        "0x0000000000000000000000000000000000000000000000000000000000000004" + "6e6f7065",
      ),
    ).toBeUndefined();
  });
});

/**
 * Rewrites one 4-byte uint32 field in a message fixture, so a version-rejection case is built
 * from the same bytes Circle produced instead of a hand-assembled message that could differ
 * from the real layout in other ways.
 */
function withUint32At(message: string, byteOffset: number, value: number): string {
  const head = message.slice(0, 2 + byteOffset * 2);
  const field = message.slice(2 + byteOffset * 2, 2 + (byteOffset + 4) * 2);
  const tail = message.slice(2 + (byteOffset + 4) * 2);
  return head + value.toString(16).padStart(field.length, "0") + tail;
}

describe("decodeCctpMessage version validation", () => {
  it("rejects a message whose header version is not the supported one", () => {
    const wrongHeaderVersion = withUint32At(LIVE_TESTNET_BURN_MESSAGE, 0, 3);

    expect(() => decodeCctpMessage(wrongHeaderVersion)).toThrow(
      /Unsupported CCTP message header version 3; this decoder supports version 1 only/,
    );
  });

  it("rejects a burn body whose version is not the supported one", () => {
    const wrongBodyVersion = withUint32At(LIVE_TESTNET_BURN_MESSAGE, 148, 2);

    expect(() => decodeCctpMessage(wrongBodyVersion)).toThrow(
      /Unsupported CCTP burn body version 2; this decoder supports version 1 only/,
    );
  });

  it("names both the found and the expected version in the error", () => {
    const wrongBodyVersion = withUint32At(LIVE_TESTNET_BURN_MESSAGE, 148, 0);

    // A caller needs to tell "Circle shipped a newer format" (expected > found) apart from
    // "this is not a CCTP burn message at all" (found 0), and the message has to say which.
    expect(() => decodeCctpMessage(wrongBodyVersion)).toThrow(/version 0/);
    expect(() => decodeCctpMessage(wrongBodyVersion)).toThrow(/supports version 1/);
  });

  it("does not decode any other field once the header version is unsupported", () => {
    // A V3 header would be rejected before the amount at the V2 offset could be reported, so
    // a concurrent 99_999_999 amount never reaches the caller.
    const tampered = withUint32At(withUint32At(LIVE_TESTNET_BURN_MESSAGE, 0, 3), 216, 99_999_999);

    expect(() => decodeCctpMessage(tampered)).toThrow(/Unsupported CCTP message header version/);
  });
});
