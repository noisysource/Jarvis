// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Project rule: pure functions and types only, no classes. */
export const noClassesRule = {
  "no-restricted-syntax": [
    "error",
    {
      selector: "ClassDeclaration",
      message: "Jarvis uses pure functions and types, not classes.",
    },
    {
      selector: "ClassExpression",
      message: "Jarvis uses pure functions and types, not classes.",
    },
  ],
};

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      ...noClassesRule,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // The chat page runs in the browser as plain ES modules.
    files: ["src/web/**/*.js"],
    languageOptions: { globals: { ...globals.browser }, sourceType: "module" },
  },
);
