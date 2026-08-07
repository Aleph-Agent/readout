import { describe, expect, it } from 'vitest';

import {
  checkItem,
  checkRoom,
  foldName,
  LIMITS,
  planFrom,
  REGISTRIES,
} from '../src/lib/watchlist-api.ts';

describe('folding a name', () => {
  it('folds PyPI the way PyPI does', () => {
    // Already got this wrong once in this project, on the adoption collector:
    // PyYAML and pyyaml were counted as two packages. PyPI normalises case and
    // any run of dot, dash or underscore to a single dash.
    expect(foldName('pypi', 'PyYAML')).toBe('pyyaml');
    expect(foldName('pypi', 'ruamel.yaml')).toBe('ruamel-yaml');
    expect(foldName('pypi', 'zope__interface')).toBe('zope-interface');
    expect(foldName('pypi', 'Flask-SQLAlchemy')).toBe('flask-sqlalchemy');
  });

  it('leaves the dash and underscore alone for crates', () => {
    // crates.io is case-insensitive but keeps the separator in the URL, so
    // folding them together would produce a name that 404s.
    expect(foldName('crates', 'Serde_JSON')).toBe('serde_json');
    expect(foldName('crates', 'actix-web')).toBe('actix-web');
  });

  it('keeps an npm scope intact', () => {
    expect(foldName('npm', '@Babel/Core')).toBe('@babel/core');
  });

  it('trims what a paste brings with it', () => {
    expect(foldName('npm', '  react\n')).toBe('react');
  });
});

describe('what may be watched', () => {
  it('takes a real package from each registry', () => {
    expect(checkItem({ registry: 'npm', name: '@angular/compiler' })).toEqual({
      ok: true,
      registry: 'npm',
      name: '@angular/compiler',
    });
    expect(checkItem({ registry: 'crates', name: 'serde_json' }).ok).toBe(true);
    expect(checkItem({ registry: 'PyPI', name: 'PyYAML' })).toEqual({
      ok: true,
      registry: 'pypi',
      name: 'pyyaml',
    });
  });

  it('refuses a registry nothing is collected from, and says which are', () => {
    // Accepting it would be one line and a lie: an entry for a registry with no
    // collector can never produce a reading, so the watchlist would contain
    // packages it is not watching and report nothing about them forever.
    const result = checkItem({ registry: 'maven', name: 'guava' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      for (const registry of REGISTRIES) expect(result.error).toContain(registry);
    }
  });

  it('refuses a name that is a path', () => {
    // Nothing builds a filesystem path from these today. Something builds a URL
    // from them, and `../` in the middle of one reaches somebody else's
    // endpoint.
    expect(checkItem({ registry: 'npm', name: '../../etc/passwd' }).ok).toBe(false);
    expect(checkItem({ registry: 'npm', name: '/absolute' }).ok).toBe(false);
    expect(checkItem({ registry: 'pypi', name: 'a/../b' }).ok).toBe(false);
    expect(checkItem({ registry: 'npm', name: '.hidden' }).ok).toBe(false);
  });

  it('refuses a name long enough to be an attack', () => {
    expect(checkItem({ registry: 'npm', name: 'a'.repeat(500) }).ok).toBe(false);
  });

  it('refuses the empty and the missing', () => {
    expect(checkItem({ registry: 'npm', name: '' }).ok).toBe(false);
    expect(checkItem({ registry: 'npm', name: '   ' }).ok).toBe(false);
    expect(checkItem({}).ok).toBe(false);
    expect(checkItem({ registry: 'npm', name: 42 }).ok).toBe(false);
    expect(checkItem({ registry: null, name: 'react' }).ok).toBe(false);
  });

  it('refuses markup rather than storing it to be escaped later', () => {
    // Defence in depth. The page escapes on output, but a name that cannot be
    // stored is a name that cannot be rendered wrong by the next page somebody
    // writes.
    expect(checkItem({ registry: 'npm', name: '<script>alert(1)</script>' }).ok).toBe(false);
    expect(checkItem({ registry: 'crates', name: "x'; DROP TABLE watch_items;--" }).ok).toBe(false);
  });
});

describe('how many', () => {
  it('lets a free account fill its ten slots and not the eleventh', () => {
    expect(checkRoom('free', 9).ok).toBe(true);
    expect(checkRoom('free', 10).ok).toBe(false);
  });

  it('answers 402, not 403', () => {
    // The request is well-formed and the account is real. What is missing is a
    // payment, and there is a status code that says exactly that — an agent
    // reading 403 retries with different arguments forever.
    const full = checkRoom('free', 10);

    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.status).toBe(402);
  });

  it('says what the limit was', () => {
    // "Watchlist full" without a number makes somebody open a pricing page to
    // find out what they hit.
    const full = checkRoom('free', 10);

    expect(full.ok).toBe(false);
    if (!full.ok) {
      expect(full.error).toContain('10');
      expect(full.error).toContain('free');
    }
  });

  it('gives a paid account the room it paid for', () => {
    expect(checkRoom('watch', 150).ok).toBe(true);
    expect(checkRoom('team', 1999).ok).toBe(true);
    expect(checkRoom('watch', LIMITS['watch'] ?? 0).ok).toBe(false);
  });

  it('treats a plan nobody defined as free', () => {
    // A typo in a plan id must fall to the smallest limit, never to unlimited.
    expect(checkRoom('enterprise-gold', 10).ok).toBe(false);
  });
});

describe('which plan is in force', () => {
  const now = new Date('2026-08-07T12:00:00Z');

  it('is free when nothing was ever bought', () => {
    expect(planFrom(null, now)).toBe('free');
  });

  it('is the plan while the subscription runs', () => {
    expect(planFrom({ plan_id: 'watch', valid_until: '2026-09-01T00:00:00Z' }, now)).toBe('watch');
  });

  it('is free again the moment it lapses', () => {
    // Reading plan_id without checking the date is how somebody keeps a paid
    // limit for as long as the row exists, which is forever.
    expect(planFrom({ plan_id: 'team', valid_until: '2026-08-01T00:00:00Z' }, now)).toBe('free');
  });

  it('keeps a credit pack, which has no expiry', () => {
    expect(planFrom({ plan_id: 'credits', valid_until: null }, now)).toBe('credits');
  });

  it('treats an unreadable date as lapsed', () => {
    expect(planFrom({ plan_id: 'team', valid_until: 'sometime' }, now)).toBe('free');
  });
});
