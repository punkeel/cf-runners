import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";

const toolingIgnorePatterns = [
  ".agent/**",
  ".agents/**",
  ".claude/**",
  ".codex/**",
  ".conductor/**",
  ".context/**",
  ".continue/**",
  ".cursor/**",
  ".gemini/**",
  ".opencode/**",
  ".pi/**",
  ".roo/**",
  ".windsurf/**",
  "tools/oxlint/anti-slop/**",
];

export default defineConfig({
  plugins: process.env.VITEST === "true" ? [] : [cloudflare()],
  fmt: {
    printWidth: 120,
    ignorePatterns: toolingIgnorePatterns,
  },
  lint: {
    categories: {
      correctness: "error",
      perf: "warn",
      suspicious: "warn",
    },
    ignorePatterns: toolingIgnorePatterns,
    plugins: ["import", "vitest"],
    options: {
      denyWarnings: true,
      reportUnusedDisableDirectives: "error",
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: "anti-slop",
        specifier: "./tools/oxlint/anti-slop/index.ts",
      },
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
    rules: {
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
  },
  pack: {
    clean: true,
    entry: ["scripts/deploy.ts"],
    format: ["esm"],
    outDir: "dist",
    platform: "node",
  },
  test: {
    projects: [
      {
        test: {
          include: ["tests/*.test.ts"],
          name: "unit",
        },
      },
      {
        plugins: [
          cloudflareTest({
            miniflare: {
              compatibilityDate: "2026-08-12",
              bindings: { RUNNER_CACHE_MAX_BYTES: "20" },
            },
            wrangler: { configPath: "./tests/wrangler.test.jsonc" },
          }),
        ],
        test: {
          include: ["tests/durable/**/*.test.ts"],
          name: "durable",
          pool: "@cloudflare/vitest-pool-workers",
        },
      },
    ],
  },
});
