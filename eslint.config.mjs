import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Compiled output of backend and workspace packages:
    "backend/dist/**",
    "apps/*/dist/**",
    "packages/*/dist/**",
    // The docs site is its own Next.js app with its own build output; the
    // root-level ".next/**" ignore only covers the marketing site's.
    "apps/docs/.next/**",
    "apps/docs/out/**",
    // The publishable CLI bundle (bundle-release.mjs output).
    "apps/cli/release/**",
    ".muon/**",
  ]),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // eslint-config-next is the root marketing site's preset. MUON's Electron,
    // Ink, backend, CLI, and library packages are not Next.js applications and
    // do not run the React Compiler. Keep the shared correctness rules, but do
    // not apply framework/compiler-only rules to those independent runtimes.
    files: [
      "apps/**/*.{js,jsx,mjs,cjs,ts,tsx}",
      "backend/**/*.{js,jsx,mjs,cjs,ts,tsx}",
      "packages/**/*.{js,jsx,mjs,cjs,ts,tsx}",
      "scripts/**/*.{js,jsx,mjs,cjs,ts,tsx}",
    ],
    rules: {
      "@next/next/no-assign-module-variable": "off",
      "@next/next/no-img-element": "off",
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/static-components": "off",
      "react/no-unescaped-entities": "off",
    },
  },
  {
    // Test doubles intentionally model incomplete vendor/API objects. Requiring
    // production-grade concrete types for every seam makes the tests less clear
    // without strengthening the shipped boundary, which is typechecked above.
    files: ["**/tests/**/*.{js,jsx,mjs,cjs,ts,tsx}", "**/*.test.{js,jsx,ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
