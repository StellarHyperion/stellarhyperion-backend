-- Up Migration

-- Persists enabled versus intentionally disabled watcher and rail poller state so API-only
-- replicas can distinguish intentional maintenance or disabled components from stalled workers.

CREATE TABLE watcher_runtime_state (
  component_key text PRIMARY KEY,
  component_kind text NOT NULL CHECK (component_kind IN ('chain_watcher', 'rail_poller')),
  enabled boolean NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS watcher_runtime_state;
