-- The paid side of the product: who somebody is, what they asked us to watch,
-- and what they paid for.
--
-- D1 is SQLite, so this is plain SQL and is tested against Node's own SQLite
-- rather than against a deployed database. A schema whose constraints are only
-- exercised in production is a schema whose constraints are decoration.
--
-- Two rules run through the whole file. Money and identity are enforced by the
-- database, not by the code that calls it — a uniqueness rule in application
-- code is a race condition with good intentions. And nothing that reaches this
-- database stores a secret in a form that reading the database would reveal.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- accounts

CREATE TABLE IF NOT EXISTS accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Only 'github' today. Google was considered and dropped: every developer
  -- already has a GitHub account, and a second provider buys no new users while
  -- costing an account-linking rule where whoever controls an email address can
  -- take over somebody's GitHub-authenticated account.
  provider       TEXT    NOT NULL,

  -- GitHub's numeric id, never the login. A login is renamed and then reused by
  -- somebody else; keying on it hands one person another person's account.
  provider_id    TEXT    NOT NULL,

  -- Display only. Refreshed on each sign-in, never used to find anybody.
  login          TEXT    NOT NULL,

  created_at     TEXT    NOT NULL,

  UNIQUE (provider, provider_id)
);

-- ---------------------------------------------------------------- sessions

CREATE TABLE IF NOT EXISTS sessions (
  -- The hash, never the token. A leaked database read then hands the reader
  -- every live session; a leaked database of hashes hands them nothing.
  token_hash     TEXT    PRIMARY KEY,

  account_id     INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at     TEXT    NOT NULL,
  expires_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);

-- -------------------------------------------------------------- watchlists

CREATE TABLE IF NOT EXISTS watchlists (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name           TEXT    NOT NULL,
  created_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS watchlists_account ON watchlists (account_id);

CREATE TABLE IF NOT EXISTS watch_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  watchlist_id   INTEGER NOT NULL REFERENCES watchlists (id) ON DELETE CASCADE,
  registry       TEXT    NOT NULL,

  -- Folded on the way in: PyPI treats PyYAML and pyyaml as one package, and
  -- counting them separately has already happened once in this project.
  name           TEXT    NOT NULL,

  added_at       TEXT    NOT NULL,

  -- Adding the same package twice is a no-op, not two rows and two alerts.
  UNIQUE (watchlist_id, registry, name)
);

CREATE INDEX IF NOT EXISTS watch_items_list ON watch_items (watchlist_id);

-- ---------------------------------------------------------------- invoices

CREATE TABLE IF NOT EXISTS invoices (
  id             TEXT    PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  plan_id        TEXT    NOT NULL,

  -- The token's smallest unit, as a decimal string. Not a REAL: a float cannot
  -- hold eighteen decimal places exactly, and this figure has to compare equal
  -- to the last digit or the whole payment scheme falls over.
  amount         TEXT    NOT NULL,

  created_at     TEXT    NOT NULL,
  expires_at     TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'paid', 'expired'))
);

-- The constraint the entire no-wallet-connect scheme rests on.
--
-- A payment is tied to a buyer by its exact amount and nothing else, so two
-- live invoices quoting the same amount would make an incoming payment
-- ambiguous — and the safe resolution of an ambiguous payment is to credit
-- nobody, which means somebody paid and got nothing. Partial, so a settled
-- invoice does not reserve its amount forever.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_live_amount
  ON invoices (amount) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS invoices_account ON invoices (account_id);
CREATE INDEX IF NOT EXISTS invoices_expiry ON invoices (expires_at) WHERE status = 'pending';

-- ---------------------------------------------------------------- payments

CREATE TABLE IF NOT EXISTS payments (
  -- One transaction, one credit, ever. The hash is the primary key rather than
  -- a column with a uniqueness check in code, because the check has to hold
  -- against two requests arriving in the same millisecond and only the database
  -- can promise that.
  tx_hash        TEXT    PRIMARY KEY,

  invoice_id     TEXT    NOT NULL REFERENCES invoices (id),
  amount         TEXT    NOT NULL,
  block_number   INTEGER NOT NULL,
  credited_at    TEXT    NOT NULL
);

-- An invoice is settled once. Without this a retry could credit the same
-- invoice from two different transactions.
CREATE UNIQUE INDEX IF NOT EXISTS payments_invoice ON payments (invoice_id);

-- ------------------------------------------------------------ entitlements

CREATE TABLE IF NOT EXISTS entitlements (
  account_id       INTEGER PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  plan_id          TEXT    NOT NULL,

  -- Null for credit packs, which do not expire.
  valid_until      TEXT,

  -- Null for subscriptions, which are not metered by call.
  calls_remaining  INTEGER CHECK (calls_remaining IS NULL OR calls_remaining >= 0),

  updated_at       TEXT    NOT NULL
);

-- ------------------------------------------------------------------ apikeys

CREATE TABLE IF NOT EXISTS api_keys (
  -- Hashed, like a session. The plaintext is shown once at creation and never
  -- again, because a key this database could reveal is a key that leaks with it.
  key_hash       TEXT    PRIMARY KEY,

  account_id     INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,

  -- The first few characters, so somebody with several keys can tell which is
  -- which without the key itself being recoverable.
  prefix         TEXT    NOT NULL,

  created_at     TEXT    NOT NULL,
  last_used_at   TEXT,
  revoked_at     TEXT
);

CREATE INDEX IF NOT EXISTS api_keys_account ON api_keys (account_id);
