import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends(
    "next/core-web-vitals", 
    "next/typescript",
    "plugin:react/recommended",
    "plugin:react-hooks/recommended",
    "prettier"
  ),
  {
    rules: {
      "react/react-in-jsx-scope": "off",
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars":"off",
      "@typescript-eslint/ban-ts-comment":"off",
      "react/display-name": "off",
      "@next/next/no-img-element": "off",
    }
  }
];

export default eslintConfig;
