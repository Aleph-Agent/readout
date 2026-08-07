/**
 * What may go on somebody's watchlist, and how many.
 *
 * Every rule here runs before anything is written, and every one of them exists
 * because the alternative is a row that is wrong in a way nobody notices: the
 * same package stored twice under two spellings, a name long enough to be a
 * denial-of-service, a registry that will never match a reading so the entry
 * sits there silently reporting nothing.
 *
 * Pure. The endpoint calls in, gets a decision, and does the database work.
 */

/**
 * The three registries the instrument actually reads.
 *
 * Accepting a fourth would be one line and it would be a lie: an entry for a
 * registry nothing is collected from can never produce a reading, so the
 * watchlist would quietly contain packages it is not watching. Refusing is the
 * honest answer until a collector exists.
 */
export const REGISTRIES = ['npm', 'pypi', 'crates'] as const;
export type Registry = (typeof REGISTRIES)[number];

/**
 * How many packages each plan may watch.
 *
 * The free tier is generous enough to be useful on a real project and small
 * enough that a team stack does not fit. That is the whole shape of the paid
 * offer, so it is one constant rather than a condition spread across handlers.
 */
export const LIMITS: Record<string, number> = {
  free: 10,
  watch: 200,
  team: 2000,
};

/** Longest name any of the three registries permits, plus scope and slash. */
const MAX_NAME = 214;

export interface Rejected {
  ok: false;
  status: number;
  error: string;
}

export interface Accepted {
  ok: true;
  registry: Registry;
  name: string;
}

/**
 * Fold a name to the one spelling it will be stored and compared under.
 *
 * PyPI treats `PyYAML` and `pyyaml` as one package and normalises runs of
 * `.`, `-` and `_` to a single `-`; this project has already counted those as
 * two different packages once. npm is lowercase-only for anything published
 * this decade. crates.io is case-insensitive and treats `-` and `_` alike, but
 * unlike PyPI it keeps them distinct in the URL, so only case is folded there.
 *
 * Getting this wrong does not fail. It produces a watchlist with a package on
 * it twice and an alert that arrives twice, which reads as a bug in the alerts.
 */
export function foldName(registry: Registry, raw: string): string {
  const trimmed = raw.trim();

  if (registry === 'pypi') {
    return trimmed.toLowerCase().replace(/[-_.]+/g, '-');
  }

  // npm scopes are case-sensitive in theory and lowercase in practice; the
  // registry has rejected uppercase in new names since 2017.
  return trimmed.toLowerCase();
}

function validName(registry: Registry, name: string): boolean {
  if (name === '' || name.length > MAX_NAME) return false;

  // A leading dot or slash is how a name becomes a path. Nothing here builds a
  // filesystem path from a package name today, but a URL is built from it, and
  // `../` in the middle of one is somebody else's endpoint.
  if (name.includes('..') || name.startsWith('.') || name.startsWith('/')) return false;

  if (registry === 'npm') return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(name);
  return /^[a-z0-9][a-z0-9._-]*$/.test(name);
}

/**
 * Is this something we can watch, said once so both the API and the MCP tool
 * answer the same way.
 */
export function checkItem(input: { registry?: unknown; name?: unknown }): Accepted | Rejected {
  const { registry, name } = input;

  if (typeof registry !== 'string' || typeof name !== 'string') {
    return { ok: false, status: 400, error: 'send a registry and a name' };
  }

  const lowered = registry.trim().toLowerCase();
  if (!(REGISTRIES as readonly string[]).includes(lowered)) {
    return {
      ok: false,
      status: 400,
      // Names what is accepted rather than only what was refused. An error that
      // says "invalid registry" makes the caller guess.
      error: `registry must be one of ${REGISTRIES.join(', ')}`,
    };
  }

  const folded = foldName(lowered as Registry, name);
  if (!validName(lowered as Registry, folded)) {
    return { ok: false, status: 400, error: 'that is not a package name' };
  }

  return { ok: true, registry: lowered as Registry, name: folded };
}

/**
 * Has this account run out of room.
 *
 * Returns the limit alongside the answer so the message can say what the limit
 * is. "Watchlist full" without a number is a message that makes somebody open a
 * pricing page to find out what they hit.
 */
export function checkRoom(plan: string, current: number): Rejected | { ok: true; limit: number } {
  const limit = LIMITS[plan] ?? LIMITS['free'] ?? 10;

  if (current >= limit) {
    return {
      ok: false,
      // 402, not 403. The request is well-formed and the account is real; what
      // is missing is a payment, and there is a status code that says exactly
      // that.
      status: 402,
      error: `the ${plan} plan watches ${limit} packages and this account has ${current}`,
    };
  }

  return { ok: true, limit };
}

/**
 * Which plan an entitlement row grants right now.
 *
 * An expired subscription is the free plan, not the plan it used to be. Reading
 * `plan_id` without checking the date is how somebody keeps a paid limit for
 * as long as the row exists.
 */
export function planFrom(
  entitlement: { plan_id: string; valid_until: string | null } | null,
  now: Date = new Date(),
): string {
  if (entitlement === null) return 'free';
  if (entitlement.valid_until === null) return entitlement.plan_id;

  const until = Date.parse(entitlement.valid_until);
  if (!Number.isFinite(until)) return 'free';

  return until > now.getTime() ? entitlement.plan_id : 'free';
}
