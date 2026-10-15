import { describe, it, expect, vi, afterEach } from "vitest";
import { Account, Contract, Keypair, StrKey, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import {
  burnUsdcOnStellar,
  mintAndForwardOnStellar,
  approveUsdcOnStellar,
  checkStellarRecipientReady,
} from "../src/chains/stellar.js";
import { STELLAR_TESTNET, STELLAR_MAX_CONSECUTIVE_RPC_FAILURES } from "../src/constants.js";
import { SubmissionTimeoutError } from "../src/errors.js";
import { stellarAddressToBytes32 } from "../src/utils/encoding.js";

function contractIdOf(contract: Contract): string {
  return StrKey.encodeContract((contract as unknown as { _id: Buffer })._id);
}

const FAKE_HASH = "a".repeat(64);

function mockHappyPathRpc() {
  const signerKeypair = Keypair.random();

  vi.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(
    new Account(signerKeypair.publicKey(), "1"),
  );
  vi.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(
    async (tx) => tx as any,
  );
  vi.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue({
    status: "PENDING",
    hash: FAKE_HASH,
  } as any);
  vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({
    status: "SUCCESS",
  } as any);

  return signerKeypair;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("burnUsdcOnStellar (TokenMessengerMinter.deposit_for_burn)", () => {
  it("invokes TokenMessengerMinter with deposit_for_burn and returns the tx hash", async () => {
    const signerKeypair = mockHappyPathRpc();
    const callSpy = vi.spyOn(Contract.prototype, "call");

    const recipient = Keypair.random().publicKey();
    const hash = await burnUsdcOnStellar({
      amountRaw: 10_000_000n,
      destinationDomain: 26,
      mintRecipientBytes32: stellarAddressToBytes32(recipient),
      maxFeeRaw: 1000n,
      minFinalityThreshold: 2000,
      signer: { publicKey: signerKeypair.publicKey(), keypair: signerKeypair },
      network: "testnet",
    });

    expect(hash).toBe(FAKE_HASH);
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(contractIdOf(callSpy.mock.instances[0] as unknown as Contract)).toBe(STELLAR_TESTNET.tokenMessengerMinter);
    expect(callSpy.mock.calls[0]?.[0]).toBe("deposit_for_burn");
  });

  it("retries once on a transient 'not enough allowance' error and then succeeds", async () => {
    const signerKeypair = mockHappyPathRpc();
    vi.spyOn(rpc.Server.prototype, "prepareTransaction")
      .mockRejectedValueOnce(
        new Error('HostError: ... data:["not enough allowance to spend", 0, 10000000] ...'),
      )
      .mockImplementation(async (tx) => tx as any);

    const recipient = Keypair.random().publicKey();
    const hash = await burnUsdcOnStellar({
      amountRaw: 10_000_000n,
      destinationDomain: 26,
      mintRecipientBytes32: stellarAddressToBytes32(recipient),
      maxFeeRaw: 1000n,
      minFinalityThreshold: 2000,
      signer: { publicKey: signerKeypair.publicKey(), keypair: signerKeypair },
      network: "testnet",
    });

    expect(hash).toBe(FAKE_HASH);
  }, 10_000);

  it("retries once on a transient txBadSeq error and then succeeds", async () => {
    const signerKeypair = mockHappyPathRpc();
    vi.spyOn(rpc.Server.prototype, "sendTransaction")
      .mockResolvedValueOnce({
        status: "ERROR",
        errorResult: { _switch: { name: "txBadSeq", value: -5 } },
      } as any)
      .mockResolvedValue({ status: "PENDING", hash: FAKE_HASH } as any);

    const recipient = Keypair.random().publicKey();
    const hash = await burnUsdcOnStellar({
      amountRaw: 10_000_000n,
      destinationDomain: 26,
      mintRecipientBytes32: stellarAddressToBytes32(recipient),
      maxFeeRaw: 1000n,
      minFinalityThreshold: 2000,
      signer: { publicKey: signerKeypair.publicKey(), keypair: signerKeypair },
      network: "testnet",
    });

    expect(hash).toBe(FAKE_HASH);
  }, 10_000);

  it("does not retry a non-allowance failure", async () => {
    const signerKeypair = mockHappyPathRpc();
    vi.spyOn(rpc.Server.prototype, "prepareTransaction").mockRejectedValue(
      new Error("some unrelated simulation failure"),
    );

    const recipient = Keypair.random().publicKey();
    await expect(
      burnUsdcOnStellar({
        amountRaw: 10_000_000n,
        destinationDomain: 26,
        mintRecipientBytes32: stellarAddressToBytes32(recipient),
        maxFeeRaw: 1000n,
        minFinalityThreshold: 2000,
        signer: { publicKey: signerKeypair.publicKey(), keypair: signerKeypair },
        network: "testnet",
      }),
    ).rejects.toThrow("some unrelated simulation failure");
  });
});

describe("approveUsdcOnStellar", () => {
  it("waits for the allowance to actually be readable before returning", async () => {
    const signerKeypair = mockHappyPathRpc();
    vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockResolvedValue({ sequence: 100 } as any);

    // Simulates the RPC read-after-write lag this polling exists to cover: the first
    // simulateTransaction call still sees the pre-approval allowance (0), the second
    // reflects the just-confirmed approve. approveUsdcOnStellar must not return until
    // the real on-chain state agrees with the approve it just submitted.
    const simulate = vi
      .spyOn(rpc.Server.prototype, "simulateTransaction")
      .mockResolvedValueOnce({
        transactionData: {},
        result: { retval: nativeToScVal(0n, { type: "i128" }) },
      } as any)
      .mockResolvedValueOnce({
        transactionData: {},
        result: { retval: nativeToScVal(10_000_000n, { type: "i128" }) },
      } as any);

    const hash = await approveUsdcOnStellar(10_000_000n, {
      publicKey: signerKeypair.publicKey(),
      keypair: signerKeypair,
    }, "testnet");

    expect(hash).toBe(FAKE_HASH);
    expect(simulate).toHaveBeenCalledTimes(2);
  });

  it("throws a clear error if the allowance never reflects the approval", async () => {
    mockHappyPathRpc();
    vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockResolvedValue({ sequence: 100 } as any);
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue({
      transactionData: {},
      result: { retval: nativeToScVal(0n, { type: "i128" }) },
    } as any);

    const signerKeypair = Keypair.random();
    await expect(
      approveUsdcOnStellar(10_000_000n, { publicKey: signerKeypair.publicKey(), keypair: signerKeypair }, "testnet"),
    ).rejects.toThrow(/did not reach/);
  }, 15_000);
});

describe("checkStellarRecipientReady", () => {
  it("reports not-existing when the account has never been funded", async () => {
    vi.spyOn(rpc.Server.prototype, "getAccount").mockRejectedValue(
      new Error("Account not found: G..."),
    );

    const status = await checkStellarRecipientReady(Keypair.random().publicKey());

    expect(status).toEqual({ exists: false, hasTrustline: false, ready: false });
  });

  it("reports missing-trustline when the account exists but has never held USDC", async () => {
    const recipient = Keypair.random().publicKey();
    vi.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(recipient, "1"));
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue({
      error:
        'HostError: Error(Contract, #13)\n\nEvent log (newest first):\n   0: [Diagnostic Event] ... data:["trustline entry is missing for account", "' +
        recipient +
        '"]',
    } as any);

    const status = await checkStellarRecipientReady(recipient);

    expect(status).toEqual({ exists: true, hasTrustline: false, ready: false });
  });

  it("reports ready when the account exists and holds the USDC trustline", async () => {
    const recipient = Keypair.random().publicKey();
    vi.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(recipient, "1"));
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue({
      transactionData: {},
      result: { retval: nativeToScVal(0n, { type: "i128" }) },
    } as any);

    const status = await checkStellarRecipientReady(recipient);

    expect(status).toEqual({ exists: true, hasTrustline: true, ready: true });
  });

  it("rethrows an unrelated simulation error instead of misreporting it as a missing trustline", async () => {
    const recipient = Keypair.random().publicKey();
    vi.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(recipient, "1"));
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue({
      error: "HostError: some unrelated simulation failure",
    } as any);

    await expect(checkStellarRecipientReady(recipient)).rejects.toThrow(
      /Failed to check Stellar recipient's USDC trustline/,
    );
  });
});

describe("mintAndForwardOnStellar (CctpForwarder.mint_and_forward)", () => {
  it("routes inbound transfers through the CctpForwarder contract, not a direct mint", async () => {
    const signerKeypair = mockHappyPathRpc();
    const callSpy = vi.spyOn(Contract.prototype, "call");

    const hash = await mintAndForwardOnStellar({
      message: `0x${"11".repeat(32)}`,
      attestation: `0x${"22".repeat(65)}`,
      signer: { publicKey: signerKeypair.publicKey(), keypair: signerKeypair },
      network: "testnet",
    });

    expect(hash).toBe(FAKE_HASH);
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(contractIdOf(callSpy.mock.instances[0] as unknown as Contract)).toBe(STELLAR_TESTNET.cctpForwarder);
    expect(callSpy.mock.calls[0]?.[0]).toBe("mint_and_forward");
  });
});


describe("confirmation polling tolerance", () => {
  const TRANSIENT = "connect ECONNRESET";

  function mockSubmitWithTransactionSequence(
    answers: Array<{ status: string } | Error>,
  ) {
    const signerKeypair = mockHappyPathRpc();
    let calls = 0;
    vi.spyOn(rpc.Server.prototype, "getTransaction").mockImplementation(async () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      if (answer instanceof Error) throw answer;
      return answer as any;
    });
    return { signerKeypair, calls: () => calls };
  }

  function burn(signerKeypair: Keypair) {
    return {
      amountRaw: 10_000_000n,
      destinationDomain: 26,
      mintRecipientBytes32: stellarAddressToBytes32(Keypair.random().publicKey()) as `0x${string}`,
      maxFeeRaw: 1000n,
      minFinalityThreshold: 2000,
      signer: { publicKey: signerKeypair.publicKey(), keypair: signerKeypair },
      network: "testnet" as const,
    };
  }

  it("returns the hash when N-1 transient RPC errors are followed by a confirmation", async () => {
    const transientCount = STELLAR_MAX_CONSECUTIVE_RPC_FAILURES - 1;
    const answers: Array<{ status: string } | Error> = [
      ...Array.from({ length: transientCount }, () => new Error(TRANSIENT)),
      { status: "SUCCESS" },
    ];
    const { signerKeypair, calls } = mockSubmitWithTransactionSequence(answers);

    await expect(burnUsdcOnStellar(burn(signerKeypair))).resolves.toBe(FAKE_HASH);
    expect(calls()).toBe(transientCount + 1);
  }, 30_000);

  it("surfaces the hash via SubmissionTimeoutError when every poll fails transiently", async () => {
    const { signerKeypair, calls } = mockSubmitWithTransactionSequence([new Error(TRANSIENT)]);

    const error = await burnUsdcOnStellar(burn(signerKeypair)).catch((err) => err);

    expect(error).toBeInstanceOf(SubmissionTimeoutError);
    expect((error as SubmissionTimeoutError).hash).toBe(FAKE_HASH);
    // Sustained failure ends the poll instead of waiting out the 120s confirmation deadline.
    expect(calls()).toBe(STELLAR_MAX_CONSECUTIVE_RPC_FAILURES);
  }, 30_000);

  it("rejects immediately on a terminal FAILED status without exhausting retries", async () => {
    const { signerKeypair, calls } = mockSubmitWithTransactionSequence([
      new Error(TRANSIENT),
      { status: "FAILED" },
    ]);

    await expect(burnUsdcOnStellar(burn(signerKeypair))).rejects.toThrow(/failed/);
    expect(calls()).toBe(2);
  }, 30_000);
});
