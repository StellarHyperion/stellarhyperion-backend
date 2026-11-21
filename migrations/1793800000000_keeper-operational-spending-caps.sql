-- Up Migration

CREATE TABLE keeper_spending_window (
  chain_key text NOT NULL,
  signer text NOT NULL CHECK (signer ~ '^G[A-Z2-7]{55}$'),
  window_kind text NOT NULL CHECK (window_kind IN ('daily','ledger')),
  window_key text NOT NULL,
  spent_stroops numeric(20,0) NOT NULL CHECK (spent_stroops >= 0),
  cap_stroops numeric(20,0) NOT NULL CHECK (cap_stroops >= 0),
  override_stroops numeric(20,0),
  override_reason text,
  reset_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_key, signer, window_kind, window_key)
);

CREATE TABLE keeper_spending_audit (
  id bigserial PRIMARY KEY,
  chain_key text NOT NULL,
  signer text NOT NULL,
  window_kind text NOT NULL CHECK (window_kind IN ('daily','ledger')),
  window_key text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('reset','override','reserved','paused')),
  amount_stroops numeric(20,0) NOT NULL CHECK (amount_stroops >= 0),
  detail text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX keeper_spending_audit_signer_created
  ON keeper_spending_audit (signer, created_at DESC);

COMMENT ON TABLE keeper_spending_window IS
  'Atomic bounded Stellar keeper fee reservations per signer. Window keys implement explicit UTC-day or ledger-window reset semantics.';
COMMENT ON TABLE keeper_spending_audit IS
  'Auditable keeper cap resets, overrides, reservations and pause decisions. No credentials are stored.';

-- Down Migration

DROP TABLE keeper_spending_audit;
DROP TABLE keeper_spending_window;
