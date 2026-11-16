-- Up Migration

-- Durable per-rail rate-limit and Retry-After cooldown state so process restarts and concurrent
-- rail pollers retain active provider backoff decisions without hammering rate-limited APIs.
CREATE TABLE rail_cooldown (
  rail           text PRIMARY KEY,
  cooldown_until timestamptz NOT NULL,
  reason         text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE rail_cooldown IS
  'Durable per-rail Retry-After and rate-limit cooldown state shared across restarts and concurrent rail pollers.';

-- Down Migration

DROP TABLE IF EXISTS rail_cooldown;
