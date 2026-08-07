/**
 * Proving somebody paid, without ever asking them to connect a wallet.
 *
 * The naive version of this is a form that takes a transaction hash and credits
 * the account. It has a hole big enough to drive through: anybody can open the
 * block explorer, copy a stranger's transaction to the same address, and paste
 * it. The transaction is real, the amount is right, the recipient is right, and
 * the person pasting it paid nothing. With no wallet connected there is no
 * signature to prove they control the sending address.
 *
 * The fix is older than wallet-connect and does not need it: **make the amount
 * identify the buyer.** An invoice quotes not 1000 tokens but 1000.0003947, the
 * tail drawn at random and bound to one account. A stolen hash fails not
 * because we can tell whose wallet it came from, but because it is the wrong
 * amount for the invoice being redeemed.
 *
 * Six things are checked and every one of them is load-bearing:
 *
 *   the transfer went to our address        — otherwise it is somebody else's payment
 *   the amount is exactly the invoiced one  — this is the whole anti-theft mechanism
 *   the hash has never been redeemed        — one transaction, one credit, ever
 *   the block is after the invoice          — a hash cannot pay a debt that did not exist
 *   the invoice has not expired             — the unique amount is not reserved forever
 *   there are enough confirmations          — a reorg must not leave credit behind
 *
 * Nothing here touches the network. It is handed a transaction and a receipt
 * that somebody else fetched, which is what makes it testable against fixtures
 * rather than against whatever the chain happens to be doing — a payment
 * verifier whose tests depend on live network state is a verifier nobody runs.
 */

/**
 * `keccak256("Transfer(address,address,uint256)")`.
 *
 * The token is an ERC-20, so `tx.value` is zero and the amount lives in a log.
 * Reading `value` for an ERC-20 payment credits every buyer with nothing and
 * rejects every genuine payment — and reading it for a native-token payment
 * while the token is ERC-20 would do the same in reverse. Which one is being
 * read has to be decided once, deliberately, and this decides ERC-20.
 */
export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface ChainLog {
  /** Contract that emitted it. For a token transfer, the token itself. */
  address: string;
  topics: string[];
  data: string;
}

export interface ChainReceipt {
  /** `0x1` on success. A reverted transaction moved nothing. */
  status: string;
  blockNumber: string;
  logs: ChainLog[];
}

export interface Invoice {
  id: string;
  /** GitHub account the invoice belongs to. Only this account may redeem it. */
  githubId: string;
  planId: string;
  /** Exact amount owed, in the token's smallest unit. Carries the random tail. */
  amount: bigint;
  /** Unix seconds. A payment mined before this cannot be for this invoice. */
  createdAt: number;
  expiresAt: number;
}

export interface Settlement {
  /** Token contract that must have emitted the transfer. */
  token: string;
  /** Address that must have received it. */
  recipient: string;
  /** Block height at verification time, for the confirmation count. */
  head: number;
  minConfirmations: number;
  /** Unix seconds now, for the expiry check. */
  now: number;
  /** True when this hash has already been redeemed. */
  alreadyRedeemed: boolean;
}

export type Rejection =
  | 'reverted'
  | 'no-transfer-to-us'
  | 'wrong-amount'
  | 'already-redeemed'
  | 'before-invoice'
  | 'invoice-expired'
  | 'too-few-confirmations';

export type Verdict =
  | { ok: true; amount: bigint; confirmations: number }
  | { ok: false; reason: Rejection; detail: string };

/** Lower-cased and zero-padded, so two spellings of one address compare equal. */
function normalise(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, '').padStart(40, '0');
  return `0x${hex.slice(-40)}`;
}

/** A 32-byte topic holds an address in its last 20 bytes. */
function addressFromTopic(topic: string): string {
  return normalise(`0x${topic.toLowerCase().replace(/^0x/, '').slice(-40)}`);
}

function toBigInt(hex: string): bigint {
  const clean = hex.trim();
  if (clean === '' || clean === '0x') return 0n;
  return BigInt(clean.startsWith('0x') ? clean : `0x${clean}`);
}

/**
 * Every transfer of one token to one address in this receipt, summed.
 *
 * Summed rather than taking the first, because a transaction can legitimately
 * contain several transfers — a router splitting a payment, a fee-on-transfer
 * token emitting twice. Reading only the first would reject a payment that did
 * arrive in full.
 */
export function transferredTo(
  receipt: ChainReceipt,
  token: string,
  recipient: string,
): bigint {
  const wantedToken = normalise(token);
  const wantedTo = normalise(recipient);
  let total = 0n;

  for (const log of receipt.logs ?? []) {
    if (normalise(log.address) !== wantedToken) continue;
    if ((log.topics?.[0] ?? '').toLowerCase() !== TRANSFER_TOPIC) continue;
    // topics: [signature, from, to]. A malformed log is skipped rather than
    // guessed at.
    const to = log.topics[2];
    if (to === undefined) continue;
    if (addressFromTopic(to) !== wantedTo) continue;

    total += toBigInt(log.data);
  }

  return total;
}

/**
 * Whether this transaction settles this invoice.
 *
 * Ordered so the cheapest and most decisive checks come first, and so the
 * rejection a caller sees is the most useful one. "Already redeemed" outranks
 * everything because it is the only rejection that means somebody is trying it
 * on rather than getting something wrong.
 */
export function verifyPayment(
  receipt: ChainReceipt,
  invoice: Invoice,
  settlement: Settlement,
): Verdict {
  if (settlement.alreadyRedeemed) {
    return {
      ok: false,
      reason: 'already-redeemed',
      detail: 'This transaction has already been credited to an account.',
    };
  }

  if (toBigInt(receipt.status) !== 1n) {
    return {
      ok: false,
      reason: 'reverted',
      detail: 'The transaction failed on chain, so nothing moved.',
    };
  }

  if (settlement.now > invoice.expiresAt) {
    return {
      ok: false,
      reason: 'invoice-expired',
      detail: 'This invoice has expired. Start a new one and it will quote a fresh amount.',
    };
  }

  const height = Number(toBigInt(receipt.blockNumber));
  const confirmations = settlement.head - height + 1;
  if (confirmations < settlement.minConfirmations) {
    return {
      ok: false,
      reason: 'too-few-confirmations',
      detail: `Seen, with ${confirmations} of ${settlement.minConfirmations} confirmations. Try again shortly.`,
    };
  }

  const paid = transferredTo(receipt, settlement.token, settlement.recipient);
  if (paid === 0n) {
    return {
      ok: false,
      reason: 'no-transfer-to-us',
      detail: 'That transaction contains no transfer of this token to the payment address.',
    };
  }

  // The mechanism. Not "at least" — exactly. An approximate match would let
  // somebody redeem a stranger's larger payment against their own invoice, and
  // the whole scheme rests on the amount being an identifier rather than a
  // quantity.
  if (paid !== invoice.amount) {
    return {
      ok: false,
      reason: 'wrong-amount',
      detail: `That transaction moved ${paid} and this invoice is for exactly ${invoice.amount}. The amount has to match to the last digit — that is what ties the payment to your account.`,
    };
  }

  return { ok: true, amount: paid, confirmations };
}

/**
 * An amount that belongs to one invoice and no other.
 *
 * The base price with a random tail below it. `spread` is how many of the
 * token's smallest units the tail occupies: large enough that two live invoices
 * colliding is negligible, small enough that the tail is worth far less than a
 * cent and nobody is being overcharged for the privilege.
 *
 * Takes its randomness rather than reaching for it, so a test can pin it and
 * the caller decides what "random" means.
 */
export function uniqueAmount(base: bigint, spread: bigint, random: number): bigint {
  if (spread <= 0n) return base;
  const bounded = Math.min(Math.max(random, 0), 0.999_999_999);
  const tail = BigInt(Math.floor(bounded * Number(spread)));
  return base + tail;
}
