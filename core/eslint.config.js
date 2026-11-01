import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["node_modules/**", "test/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { "@typescript-eslint/no-explicit-any": "off", "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrors: "none" }], "no-useless-assignment": "warn", "prefer-const": "warn", "no-useless-escape": "warn", "no-empty": ["error", { allowEmptyCatch: true }] } }
);

