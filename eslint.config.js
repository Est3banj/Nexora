import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "apps/api/drizzle/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // D1-4 lint gate: the scopedRepo in src/db/ is the ONLY path to the database.
    // No db.select/insert/update/delete/execute outside src/db/**.
    files: ["apps/api/src/**/*.ts"],
    ignores: ["apps/api/src/db/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='db'][property.name=/^(select|insert|update|delete|execute|query|transaction)$/]",
          message:
            "Raw db access outside apps/api/src/db/ is forbidden. Use scopedRepo(db, tenantId) from src/db/scope.ts (design §5 / task D1-4).",
        },
      ],
    },
  },
);
