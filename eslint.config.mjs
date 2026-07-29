import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const ROUTE_ADAPTER_IMPORT_PATTERNS = [
  "@/lib/*-route-adapter-service",
  "./*-route-adapter-service",
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".vercel/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Expo has its own TypeScript/test gates; the root config is Next.js-specific.
    "ugc-mobile/**",
    // Agent worktrees are full repo copies (including a nested ugc-mobile that
    // escapes the ignore above); they lint inside their own checkout.
    ".claude/worktrees/**",
  ]),
  {
    // Backend modules log through the structured logger so production lines are
    // queryable by field and carry the ambient request id, `ts`, and redaction.
    // `src/lib` is clean, so this is an error and cannot regress.
    files: ["src/lib/**/*.ts"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // The logger is the one module allowed to reach the console.
    files: ["src/lib/backend-logger.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // Layering: routes -> route adapters -> services -> domain modules.
    // An adapter importing another adapter smuggles HTTP concerns sideways and
    // hides the real dependency; share through a service or `*-route-shared`.
    files: ["src/lib/*-route-adapter-service.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ROUTE_ADAPTER_IMPORT_PATTERNS,
              message:
                "Route adapters must not import other route adapters. Extract the shared behavior into a service or a *-route-shared module.",
            },
          ],
        },
      ],
    },
  },
  {
    // Domain and service modules must stay independent of the HTTP layer so
    // they remain callable from cron jobs, scripts, and tests.
    files: ["src/lib/**/*.ts"],
    ignores: ["src/lib/*-route-adapter-service.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ROUTE_ADAPTER_IMPORT_PATTERNS,
              message:
                "Domain and service modules must not import route adapters. Dependencies point from the route layer inward, never back out.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
