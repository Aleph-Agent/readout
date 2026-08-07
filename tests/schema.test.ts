import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The schema, run as SQL against a real database.
 *
 * D1 is SQLite, and Node ships one, so every constraint here is exercised by
 * the same statements production will run rather than by a description of them.
 * A schema whose rules are only tested in production is a schema whose rules
 * are decoration.
 *
 * Everything below is a rule the database enforces rather than the application.
 * A uniqueness check in application code is a race condition with good
 * intentions: two requests a millisecond apart both read "no row exists", both
 * insert, and the money is credited twice.
 */

const SCHEMA = readFileSync(
  fileURLToPath(new URL('../migrations/0001_init.sql', import.meta.url)),
  'utf8',
);

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
});

function account(providerId = '4242'): number {
  db.prepare(
    `INSERT INTO accounts (provider, provider_id, login, created_at)
     VALUES ('github', ?, 'someone', '2026-08-07T00:00:00Z')`,
  ).run(providerId);
  return Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
}

function invoice(id: string, accountId: number, amount: string, status = 'pending'): void {
  db.prepare(
    `INSERT INTO invoices (id, account_id, plan_id, amount, created_at, expires_at, status)
     VALUES (?, ?, 'watch', ?, '2026-08-07T00:00:00Z', '2026-08-07T01:00:00Z', ?)`,
  ).run(id, accountId, amount, status);
}

describe('accounts', () => {
  it('keys on the provider id, never on the login', () => {
    // A GitHub login is renamed and then taken by somebody else. Keying on it
    // hands one person another person's account and everything they paid for.
    const first = account('4242');
    db.prepare('UPDATE accounts SET login = ? WHERE id = ?').run('renamed', first);

    // Somebody else takes the abandoned login. Different id, different account.
    db.prepare(
      `INSERT INTO accounts (provider, provider_id, login, created_at)
       VALUES ('github', '9999', 'someone', '2026-08-08T00:00:00Z')`,
    ).run();

    const rows = db.prepare('SELECT count(*) AS n FROM accounts').get() as { n: number };
    expect(rows.n).toBe(2);
  });

  it('refuses the same provider account twice', () => {
    account('4242');
    expect(() => account('4242')).toThrow(/UNIQUE/i);
  });

  it('takes everything with it when an account goes', () => {
    const id = account();
    db.prepare(
      `INSERT INTO sessions (token_hash, account_id, created_at, expires_at)
       VALUES ('h', ?, '2026-08-07T00:00:00Z', '2026-08-14T00:00:00Z')`,
    ).run(id);
    db.prepare(
      `INSERT INTO watchlists (account_id, name, created_at)
       VALUES (?, 'mine', '2026-08-07T00:00:00Z')`,
    ).run(id);

    db.exec('PRAGMA foreign_keys = ON');
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);

    expect((db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT count(*) AS n FROM watchlists').get() as { n: number }).n).toBe(0);
  });
});

describe('the unique amount', () => {
  it('refuses two live invoices quoting the same amount', () => {
    // The constraint the whole no-wallet-connect scheme rests on. A payment is
    // tied to a buyer by its exact amount and nothing else, so two live
    // invoices for one amount make an incoming payment ambiguous — and the safe
    // resolution of an ambiguous payment is to credit nobody, which means
    // somebody paid and got nothing.
    const a = account('1');
    const b = account('2');

    invoice('inv_a', a, '1000000000003947');
    expect(() => invoice('inv_b', b, '1000000000003947')).toThrow(/UNIQUE/i);
  });

  it('frees the amount once the invoice is settled', () => {
    // Partial index. A settled invoice must not reserve its amount forever, or
    // the space of quotable amounts drains as the product is used.
    const a = account('1');
    const b = account('2');

    invoice('inv_a', a, '1000000000003947', 'paid');
    expect(() => invoice('inv_b', b, '1000000000003947')).not.toThrow();
  });

  it('keeps the amount exact, to the last digit', () => {
    // Stored as text rather than as a number. A float cannot hold eighteen
    // decimal places, and an amount that compares nearly-equal identifies
    // nobody.
    const a = account();
    invoice('inv_a', a, '1000000000000003947');

    const row = db.prepare('SELECT amount FROM invoices WHERE id = ?').get('inv_a') as {
      amount: string;
    };
    expect(row.amount).toBe('1000000000000003947');
  });

  it('will not take a status nobody defined', () => {
    const a = account();
    expect(() =>
      db
        .prepare(
          `INSERT INTO invoices (id, account_id, plan_id, amount, created_at, expires_at, status)
           VALUES ('x', ?, 'watch', '1', 'a', 'b', 'refunded')`,
        )
        .run(a),
    ).toThrow(/CHECK/i);
  });
});

describe('payments', () => {
  it('credits one transaction exactly once', () => {
    // Enforced by the database rather than by a read-then-write in the worker,
    // because two requests a millisecond apart both read "not credited yet".
    const a = account();
    invoice('inv_a', a, '1000');
    invoice('inv_b', a, '2000');

    const insert = db.prepare(
      `INSERT INTO payments (tx_hash, invoice_id, amount, block_number, credited_at)
       VALUES (?, ?, ?, ?, '2026-08-07T00:00:00Z')`,
    );
    insert.run('0xabc', 'inv_a', '1000', 100);

    expect(() => insert.run('0xabc', 'inv_b', '2000', 101)).toThrow(/UNIQUE|PRIMARY/i);
  });

  it('settles one invoice exactly once', () => {
    // Without this a retry could credit the same invoice from two different
    // transactions — the buyer pays twice and is charged for one.
    const a = account();
    invoice('inv_a', a, '1000');

    const insert = db.prepare(
      `INSERT INTO payments (tx_hash, invoice_id, amount, block_number, credited_at)
       VALUES (?, 'inv_a', '1000', 100, '2026-08-07T00:00:00Z')`,
    );
    insert.run('0xabc');

    expect(() => insert.run('0xdef')).toThrow(/UNIQUE/i);
  });
});

describe('watch items', () => {
  it('adding the same package twice is a no-op, not two alerts', () => {
    const id = account();
    db.prepare(
      `INSERT INTO watchlists (account_id, name, created_at)
       VALUES (?, 'mine', '2026-08-07T00:00:00Z')`,
    ).run(id);

    const add = db.prepare(
      `INSERT INTO watch_items (watchlist_id, registry, name, added_at)
       VALUES (1, 'npm', ?, '2026-08-07T00:00:00Z')`,
    );
    add.run('react');

    expect(() => add.run('react')).toThrow(/UNIQUE/i);
  });
});

describe('what the database never holds', () => {
  it('stores a hash where a session token would be', () => {
    // A leaked database of tokens hands the reader every live session. A leaked
    // database of hashes hands them nothing.
    const columns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    const names = columns.map((column) => column.name);

    expect(names).toContain('token_hash');
    expect(names).not.toContain('token');
  });

  it('stores a hash where an API key would be', () => {
    const columns = db.prepare('PRAGMA table_info(api_keys)').all() as { name: string }[];
    const names = columns.map((column) => column.name);

    expect(names).toContain('key_hash');
    expect(names).not.toContain('key');
    // A prefix so somebody with several keys can tell them apart without the
    // key itself being recoverable.
    expect(names).toContain('prefix');
  });

  it('holds no column that could carry a wallet key', () => {
    // The design says production never holds anything that can spend. That is
    // worth asserting rather than remembering.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];

    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info(${table.name})`).all() as { name: string }[];
      for (const column of columns) {
        expect(
          /private|seed|mnemonic|secret/i.test(column.name),
          `${table.name}.${column.name} looks like somewhere a key could end up`,
        ).toBe(false);
      }
    }
  });
});

describe('entitlements', () => {
  it('refuses a negative call balance', () => {
    const id = account();
    expect(() =>
      db
        .prepare(
          `INSERT INTO entitlements (account_id, plan_id, valid_until, calls_remaining, updated_at)
           VALUES (?, 'credits', NULL, -1, '2026-08-07T00:00:00Z')`,
        )
        .run(id),
    ).toThrow(/CHECK/i);
  });

  it('allows a subscription with no call metering and a pack with no expiry', () => {
    const a = account('1');
    const b = account('2');

    expect(() =>
      db
        .prepare(
          `INSERT INTO entitlements (account_id, plan_id, valid_until, calls_remaining, updated_at)
           VALUES (?, 'watch', '2026-09-07T00:00:00Z', NULL, '2026-08-07T00:00:00Z')`,
        )
        .run(a),
    ).not.toThrow();

    expect(() =>
      db
        .prepare(
          `INSERT INTO entitlements (account_id, plan_id, valid_until, calls_remaining, updated_at)
           VALUES (?, 'credits', NULL, 1000, '2026-08-07T00:00:00Z')`,
        )
        .run(b),
    ).not.toThrow();
  });
});
