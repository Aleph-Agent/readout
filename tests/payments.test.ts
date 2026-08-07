import { describe, expect, it } from 'vitest';

import {
  TRANSFER_TOPIC,
  transferredTo,
  uniqueAmount,
  verifyPayment,
  type ChainReceipt,
  type Invoice,
  type Settlement,
} from '../src/lib/payments.ts';
import { PLANS, planById, tokensFor, TOKENS_PER_CENT } from '../src/lib/plans.ts';

/**
 * Money, and the one attack this design has to survive.
 *
 * With no wallet connected there is no signature proving who controls the
 * sending address, so a form that takes a transaction hash will happily accept
 * a stranger's — copied off the block explorer, real, correct amount, correct
 * recipient, paid by somebody else. Every test here that matters is a variation
 * on that theft.
 *
 * The defence is that the invoiced amount carries a random tail bound to one
 * account, so a stolen hash fails on the amount rather than on an identity
 * check that cannot be made. If `wrong-amount` ever stops rejecting, this is
 * free money for anybody watching the chain.
 */

const TOKEN = '0xAbC0000000000000000000000000000000000001';
const RECIPIENT = '0xDeF0000000000000000000000000000000000002';
const SOMEBODY_ELSE = '0x9990000000000000000000000000000000000003';

function pad(address: string): string {
  return `0x000000000000000000000000${address.toLowerCase().replace(/^0x/, '')}`;
}

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function receipt(
  over: { to?: string; token?: string; amount?: bigint; status?: string; block?: number; logs?: ChainReceipt['logs'] } = {},
): ChainReceipt {
  return {
    status: over.status ?? '0x1',
    blockNumber: hex(BigInt(over.block ?? 1000)),
    logs:
      over.logs ??
      [
        {
          address: over.token ?? TOKEN,
          topics: [TRANSFER_TOPIC, pad(SOMEBODY_ELSE), pad(over.to ?? RECIPIENT)],
          data: hex(over.amount ?? 1_000_000_000_003_947n),
        },
      ],
  };
}

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv_1',
    githubId: '4242',
    planId: 'watch',
    amount: 1_000_000_000_003_947n,
    createdAt: 1_000,
    expiresAt: 100_000,
    ...over,
  };
}

function settlement(over: Partial<Settlement> = {}): Settlement {
  return {
    token: TOKEN,
    recipient: RECIPIENT,
    head: 1_020,
    minConfirmations: 12,
    now: 2_000,
    alreadyRedeemed: false,
    ...over,
  };
}

describe('reading the transfer', () => {
  it('reads an ERC-20 amount out of the log, not out of tx.value', () => {
    // The token is ERC-20, so `value` is zero on every genuine payment. Reading
    // it would reject all of them.
    expect(transferredTo(receipt(), TOKEN, RECIPIENT)).toBe(1_000_000_000_003_947n);
  });

  it('ignores a transfer of a different token', () => {
    // Anybody can mint a worthless token and send a billion of it.
    expect(transferredTo(receipt({ token: SOMEBODY_ELSE }), TOKEN, RECIPIENT)).toBe(0n);
  });

  it('ignores a transfer to somebody else', () => {
    expect(transferredTo(receipt({ to: SOMEBODY_ELSE }), TOKEN, RECIPIENT)).toBe(0n);
  });

  it('compares addresses regardless of how they are spelled', () => {
    // Checksummed, lower case and unpadded are the same address.
    expect(transferredTo(receipt(), TOKEN.toLowerCase(), RECIPIENT.toUpperCase())).toBe(
      1_000_000_000_003_947n,
    );
  });

  it('sums several transfers in one transaction', () => {
    // A router splitting a payment, or a token that emits twice. Taking only
    // the first would reject a payment that did arrive in full.
    const split = receipt({
      logs: [
        { address: TOKEN, topics: [TRANSFER_TOPIC, pad(SOMEBODY_ELSE), pad(RECIPIENT)], data: hex(600n) },
        { address: TOKEN, topics: [TRANSFER_TOPIC, pad(SOMEBODY_ELSE), pad(RECIPIENT)], data: hex(400n) },
      ],
    });

    expect(transferredTo(split, TOKEN, RECIPIENT)).toBe(1000n);
  });

  it('skips a malformed log rather than guessing at it', () => {
    const broken = receipt({ logs: [{ address: TOKEN, topics: [TRANSFER_TOPIC], data: hex(999n) }] });
    expect(transferredTo(broken, TOKEN, RECIPIENT)).toBe(0n);
  });
});

describe('verifying a payment', () => {
  it('accepts a payment that matches the invoice exactly', () => {
    const verdict = verifyPayment(receipt(), invoice(), settlement());

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.amount).toBe(1_000_000_000_003_947n);
      expect(verdict.confirmations).toBe(21);
    }
  });

  it('refuses a stranger’s transaction pasted into somebody else’s invoice', () => {
    // The attack the whole design exists to stop. The transaction is real, the
    // recipient is right, the token is right — and the amount belongs to a
    // different invoice, which is the only thing tying a payment to a person
    // when no wallet has been connected.
    const theirs = receipt({ amount: 1_000_000_000_007_211n });
    const verdict = verifyPayment(theirs, invoice(), settlement());

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('wrong-amount');
  });

  it('refuses a payment larger than the invoice', () => {
    // Deliberately not "at least". Accepting an overpayment would let somebody
    // redeem a stranger's bigger transfer against their own smaller invoice.
    const generous = receipt({ amount: 9_000_000_000_000_000n });
    const verdict = verifyPayment(generous, invoice(), settlement());

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('wrong-amount');
  });

  it('refuses a hash that has already been credited', () => {
    const verdict = verifyPayment(receipt(), invoice(), settlement({ alreadyRedeemed: true }));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('already-redeemed');
  });

  it('puts the replay check ahead of every other rejection', () => {
    // The only rejection that means somebody is trying it on rather than
    // getting something wrong, so it must not be masked by an expiry or a
    // confirmation count.
    const verdict = verifyPayment(
      receipt({ status: '0x0' }),
      invoice({ expiresAt: 0 }),
      settlement({ alreadyRedeemed: true, now: 999_999 }),
    );

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('already-redeemed');
  });

  it('refuses a reverted transaction', () => {
    const verdict = verifyPayment(receipt({ status: '0x0' }), invoice(), settlement());

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('reverted');
  });

  it('waits for confirmations rather than crediting into a possible reorg', () => {
    const verdict = verifyPayment(receipt({ block: 1_015 }), invoice(), settlement({ head: 1_020 }));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe('too-few-confirmations');
      // Says how far off it is, because the answer is "wait", not "you failed".
      expect(verdict.detail).toContain('6 of 12');
    }
  });

  it('refuses an expired invoice', () => {
    const verdict = verifyPayment(receipt(), invoice({ expiresAt: 1_500 }), settlement({ now: 2_000 }));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('invoice-expired');
  });

  it('refuses a transaction carrying no transfer to us at all', () => {
    const verdict = verifyPayment(receipt({ to: SOMEBODY_ELSE }), invoice(), settlement());

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('no-transfer-to-us');
  });
});

describe('the unique amount', () => {
  it('adds a tail below the base price', () => {
    expect(uniqueAmount(1_000_000n, 10_000n, 0.5)).toBe(1_005_000n);
    expect(uniqueAmount(1_000_000n, 10_000n, 0)).toBe(1_000_000n);
  });

  it('never spills past the spread', () => {
    // A tail that overflowed into the base price would overcharge.
    expect(uniqueAmount(1_000_000n, 10_000n, 1)).toBeLessThan(1_010_000n);
    expect(uniqueAmount(1_000_000n, 10_000n, 42)).toBeLessThan(1_010_000n);
  });

  it('returns the base price when there is no spread to draw from', () => {
    expect(uniqueAmount(1_000_000n, 0n, 0.7)).toBe(1_000_000n);
  });
});

describe('what is for sale', () => {
  it('keeps the free tier free and says so', () => {
    // Not a trial. The credibility argument is that anybody can check any
    // number, and the MCP server is listed in the official registry as free and
    // keyless. Making either false quietly is the one change forbidden here.
    const free = planById('free');

    expect(free?.cents).toBe(0);
    expect(free?.summary).toContain('permanently');
    expect(free?.includes.some((line) => line.includes('seven MCP tools'))).toBe(true);
  });

  it('refuses to quote a price before there is a rate', () => {
    // Zero is the committed rate until the token exists. A caller treating null
    // as zero would issue a free invoice for a paid plan; returning null makes
    // that a type error rather than a giveaway.
    expect(TOKENS_PER_CENT).toBe(0);
    for (const plan of PLANS) expect(tokensFor(plan)).toBe(null);
  });

  it('quotes in the token once a rate is set, and never quotes for free', () => {
    const watch = planById('watch');
    expect(watch).toBeDefined();
    expect(tokensFor(watch as never, 100)).toBe(120_000);
    expect(tokensFor(planById('free') as never, 100)).toBe(null);
  });

  it('gives every paid plan a limit rather than an open door', () => {
    for (const plan of PLANS.filter((entry) => entry.cents > 0)) {
      expect(plan.watchlists, `${plan.id} has no watchlist limit`).toBeGreaterThan(0);
      expect(plan.items, `${plan.id} has no item limit`).toBeGreaterThan(0);
    }
  });
});
