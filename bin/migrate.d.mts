export declare const MIGRATION_CONNECTION_VAR: "HYPERION_MIGRATION_CONNECTION";

export interface MigrationConnection {
  readonly url: string;
  readonly source: "MIGRATION_DATABASE_URL" | "DATABASE_URL";
}

export declare function resolveMigrationConnection(
  env: Readonly<Record<string, string | undefined>>,
): MigrationConnection;

export declare function migrationEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  url: string,
): Record<string, string | undefined>;
