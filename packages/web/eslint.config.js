import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import root from "../../eslint.config.js";

export default [
  ...root,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
];
