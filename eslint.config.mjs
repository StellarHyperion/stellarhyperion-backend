import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },

  // Type aware linting needs a program, and the program is the TypeScript one. The eslint and
  // vitest config files are plain ESM that TypeScript never compiles, so they are linted without
  // it rather than dragged into the project service, which would mean typechecking build config
  // as if it were library code.
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // Every row that comes back from pg is `any` until something narrows it. The narrowing
      // happens in one place per table, in db/rows.ts, and these rules are what force it to stay
      // there instead of spreading an unchecked row into a handler.
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      // A template literal is how a log line gets built, and a bigint in one is deliberate here.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },

  {
    files: ["**/*.mjs", "**/*.cjs"],
    extends: [tseslint.configs.base],
  },

  {
    // Migrations are DDL in a thin JavaScript wrapper. The pgm argument is typed by the tool and
    // the SQL is a string literal, so the rules that matter in application code have nothing to
    // say here.
    files: ["migrations/**/*.ts"],
    rules: {
      "@typescript-eslint/no-magic-numbers": "off",
    },
  },

  {
    // Tests state the quiet part out loud: fixed heights, hand written ledger pages, and
    // deliberately malformed input handed to a decoder to watch it refuse.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
);
