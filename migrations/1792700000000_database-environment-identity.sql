-- Up Migration
CREATE TABLE hyperion_database_identity (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
 environment text NOT NULL CHECK (environment IN ('development','preview','production')),
 provisioned_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE hyperion_database_identity IS 'Environment identity provisioned explicitly by a database administrator. Hosting labels cannot substitute for this durable environment binding.';
-- Down Migration
DROP TABLE hyperion_database_identity;
