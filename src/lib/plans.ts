/**
 * What is for sale, and what never will be.
 *
 * The free tier is not a trial. Every reading this project publishes today —
 * every page, every JSON bundle, all seven MCP tools, the GitHub Action — stays
 * free permanently, and that is a product decision rather than generosity. The
 * credibility argument is that anybody can check any number, and a paywall in
 * front of the numbers destroys the only thing here that cannot be copied. The
 * MCP server is also listed in the official registry as free and keyless, and
 * quietly making that false would burn the best distribution this project has.
 *
 * So nothing that is free becomes paid. What is sold is the thing the free
 * version structurally cannot do: point the instrument at somebody else's list.
 *
 * The public watchlist is 388 repositories chosen by a stranger. Nobody wakes
 * up wanting to know their fork velocity. Everybody has forty dependencies they
 * have never checked, and the free stack checker already tells them what is
 * wrong with those today — in the browser, once, with no memory. The paid
 * product is memory: watch mine, and tell me when one of them changes.
 *
 * Every collector needed for that already exists and already runs. The marginal
 * cost of a paying customer is a few rows in a database and a handful of
 * requests that were going to be spent anyway.
 */

export type PlanId = 'free' | 'watch' | 'team' | 'credits';

export interface Plan {
  id: PlanId;
  name: string;
  /**
   * Price in US cents, converted to tokens at invoice time.
   *
   * Denominated in cents rather than tokens on purpose. A price fixed in tokens
   * silently becomes ten times more expensive when the token does, and free
   * when it does not — neither of which anybody chose. The conversion rate is a
   * committed number in this repository, so a buyer can read the rate that
   * produced their invoice out of git history and check the arithmetic. That is
   * the same standard every other figure here is held to, and it needs no
   * oracle and offers nothing to manipulate.
   */
  cents: number;
  /** Days of access. Null for credit packs, which do not expire. */
  days: number | null;
  /** Paid calls included. Null where calls are not the unit. */
  calls: number | null;
  /** Private watchlists allowed. */
  watchlists: number;
  /** Packages or repositories across all of them. */
  items: number;
  summary: string;
  includes: readonly string[];
}

/**
 * Tokens per US cent, committed rather than fetched.
 *
 * Set by hand and changed by a commit, which means every invoice this project
 * has ever issued can be recomputed from the repository at the rate that was
 * live when it was issued. An on-chain price feed would be more responsive and
 * would also be a thing somebody can move against a pending invoice; a number
 * in git can only be changed in public.
 *
 * Zero until the token is live. Nothing can be invoiced at a rate of zero, and
 * refusing to quote is the correct behaviour before there is a price.
 */
export const TOKENS_PER_CENT = 0;

/** Confirmations before a payment counts. A reorg must not create credit. */
export const MIN_CONFIRMATIONS = 12;

/** How long an invoice stays payable. Long enough to fund a wallet, short
 *  enough that the unique amount is not reserved forever. */
export const INVOICE_MINUTES = 60;

export const PLANS: readonly Plan[] = [
  {
    id: 'free',
    name: 'Free',
    cents: 0,
    days: null,
    calls: null,
    watchlists: 0,
    items: 0,
    summary:
      'Everything published here, permanently. This does not shrink when the paid tiers grow.',
    includes: [
      'Every page and every JSON bundle',
      'All seven MCP tools, no key and no account',
      'The GitHub Action, against the public index',
      'The stack checker, which reads your manifest in your browser and sends it nowhere',
      'Per-repository feeds and badges',
    ],
  },
  {
    id: 'watch',
    name: 'Watch',
    cents: 1200,
    days: 30,
    calls: null,
    watchlists: 1,
    items: 50,
    summary: 'Point the instrument at your own dependencies and be told when one of them changes.',
    includes: [
      'One private watchlist, up to 50 packages or repositories',
      'Read daily: archived, relicensed, advisories, end-of-life, last release, bus factor',
      'MCP tools scoped to your list, so an agent reads your stack rather than ours',
      'A private feed, and a webhook when something changes',
      'The GitHub Action checking against your list instead of the public one',
    ],
  },
  {
    id: 'team',
    name: 'Team',
    cents: 4900,
    days: 30,
    calls: null,
    watchlists: 5,
    items: 500,
    summary: 'The same, at the size of a real dependency tree, split across several lists.',
    includes: [
      'Five private watchlists, 500 items across them',
      'Everything in Watch',
      'History kept per item, so you can see when a thing started going wrong',
      'Bulk export of your own readings',
    ],
  },
  {
    id: 'credits',
    name: 'Credits',
    cents: 1000,
    days: null,
    calls: 1000,
    watchlists: 1,
    items: 50,
    summary:
      'For an agent doing one audit rather than subscribing. Credits do not expire and no card is involved.',
    includes: [
      '1,000 calls to the paid MCP tools',
      'One private watchlist while any credit remains',
      'Never expires',
    ],
  },
];

export function planById(id: string): Plan | undefined {
  return PLANS.find((plan) => plan.id === id);
}

/**
 * What to charge, in the token's smallest unit.
 *
 * Returns null when there is no rate, which is the honest answer before the
 * token exists. A caller that treats null as zero would issue a free invoice.
 */
export function tokensFor(plan: Plan, tokensPerCent = TOKENS_PER_CENT): number | null {
  if (tokensPerCent <= 0) return null;
  if (plan.cents === 0) return null;
  return plan.cents * tokensPerCent;
}
