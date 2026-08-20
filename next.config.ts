import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";
import { collectBackendEnvironmentHealth } from "./src/lib/backend-environment";
import { SHOWCASE_PUBLIC_MEDIA_MINIMUM_CACHE_TTL_SECONDS } from "./src/lib/showcase-media-cache";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL)
  : undefined;
const showcasePreconnectHeaders = supabaseUrl
  ? [{ key: "Link", value: `<${supabaseUrl.origin}>; rel=preconnect` }]
  : [];

const e2eAuthBypassRequested = process.env.E2E_AUTH_BYPASS === "1"
  || process.env.NEXT_PUBLIC_E2E_AUTH_BYPASS === "1";
if (
  e2eAuthBypassRequested
  && (process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production")
) {
  throw new Error("E2E authentication bypass must never be enabled in a production build.");
}

// Fail production builds fast when the backend environment contract is not
// met, instead of shipping a deploy that degrades at runtime. Only the
// requirement ids are ever printed — never values.
if (process.env.VERCEL_ENV === "production") {
  const { missing } = collectBackendEnvironmentHealth(process.env);
  if (missing.length > 0) {
    throw new Error(
      "Production build is missing required backend environment configuration: "
      + `${missing.join(", ")}. See src/lib/backend-environment.ts for the `
      + "environment variables that satisfy each requirement id."
    );
  }
}

// Report-Only content security policy. This is deliberately NOT enforcing:
// it exists to surface real-world violations in browser consoles and reports
// first; promotion to an enforcing Content-Security-Policy header is a later,
// separate step once the report stream is clean.
const mediaImportHostCspSources = (process.env.MEDIA_IMPORT_HOST_ALLOWLIST ?? "")
  .split(",")
  .map((host) => host.trim().toLowerCase().replace(/\.$/, ""))
  .filter(Boolean)
  .map((host) => `https://${host}`);
const supabaseCspSources = supabaseUrl
  ? [supabaseUrl.origin, `wss://${supabaseUrl.host}`]
  : [];
// Derived from the DSN rather than hard-coded, so pointing Sentry at a
// different org or region cannot leave the CSP behind. The CSP is
// report-only today, so a missing entry would not block reporting — it would
// quietly fill /api/security/csp-report with violations instead, which is
// noise that looks like a real finding.
const sentryIngestOrigin = (() => {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
  if (!dsn) return null;
  try {
    return new URL(dsn).origin;
  } catch {
    return null;
  }
})();
const sentryCspSources = sentryIngestOrigin ? [sentryIngestOrigin] : [];

function buildCspDirective(directive: string, sources: string[]): string {
  return [directive, ...sources].join(" ");
}

const contentSecurityPolicyReportOnly = [
  buildCspDirective("default-src", ["'self'"]),
  // 'unsafe-inline' covers the Next.js bootstrap scripts and the inline
  // Google Analytics snippet until a nonce pipeline exists.
  buildCspDirective("script-src", [
    "'self'",
    "'unsafe-inline'",
    ...(process.env.NODE_ENV === "development" ? ["'unsafe-eval'"] : []),
    "https://checkout.razorpay.com",
    "https://www.googletagmanager.com",
    "https://va.vercel-scripts.com",
  ]),
  buildCspDirective("style-src", ["'self'", "'unsafe-inline'"]),
  buildCspDirective("img-src", [
    "'self'",
    "blob:",
    "data:",
    ...supabaseCspSources,
    ...mediaImportHostCspSources,
  ]),
  buildCspDirective("media-src", [
    "'self'",
    "blob:",
    "data:",
    ...supabaseCspSources,
    ...mediaImportHostCspSources,
  ]),
  buildCspDirective("font-src", ["'self'", "data:"]),
  buildCspDirective("connect-src", [
    "'self'",
    ...supabaseCspSources,
    "https://api.razorpay.com",
    "https://lumberjack.razorpay.com",
    "https://checkout.razorpay.com",
    "https://www.googletagmanager.com",
    "https://www.google-analytics.com",
    "https://*.google-analytics.com",
    "https://va.vercel-scripts.com",
    ...sentryCspSources,
  ]),
  buildCspDirective("frame-src", [
    "https://api.razorpay.com",
    "https://checkout.razorpay.com",
  ]),
  buildCspDirective("worker-src", ["'self'", "blob:"]),
  buildCspDirective("object-src", ["'none'"]),
  buildCspDirective("base-uri", ["'self'"]),
  buildCspDirective("form-action", ["'self'"]),
  buildCspDirective("frame-ancestors", ["'none'"]),
  buildCspDirective("report-uri", ["/api/security/csp-report"]),
].join("; ");

// Only @img/sharp-libvips-* is shipped, not all of @img: sharp-wasm32 is another
// 8.7 MB that a linux-x64 lambda never loads. The glob resolves to whichever
// platform package the build installed, so it is correct on both macOS and CI.
const SHARP_TRACE = ["./node_modules/@img/sharp-libvips-*/**"];
const FFMPEG_TRACE = ["./node_modules/ffmpeg-static/**"];

// Every route whose trace pulls sharp's native .node, and therefore needs the
// libvips shared library beside it. Dynamic segments are "*" because a literal
// "[id]" would read as a character class and never match. Keep this in step with
// reality by running `npm run build:verify`, which fails the build if a route
// traces the .node without the library.
const SHARP_ROUTES = [
  // Not only API routes: the templates page renders server-side through the
  // same media helpers, which is exactly the kind of entry a hand-maintained
  // list misses -- `build:verify` found this one.
  "/templates",
  "/api/cron/*",
  "/api/generate-image",
  "/api/generations",
  "/api/posts/*/*",
  "/api/template-runs/*",
  "/api/template-runs/*/*",
  "/api/template-runs/*/*/*",
  "/api/template-runs/*/*/*/*",
  "/api/templates",
  "/api/templates/*",
  "/api/templates/*/*",
  "/api/webhooks/kie",
  "/api/workflow-canvases/*/*",
  "/api/workflow-canvases/*/*/*",
  "/api/workflow-canvases/*/*/*/*",
  "/api/workflow-canvases/*/*/*/*/*",
];

const nextConfig: NextConfig = {
  // Pin the workspace root instead of letting Next infer it from lockfiles.
  // Inference walks up from the project directory and selects the OUTERMOST
  // lockfile, so a build inside .claude/worktrees/<name>/ — which carries its
  // own package-lock.json beneath the primary checkout's — roots at the parent
  // checkout and inlines dependency paths as
  // "/ROOT/.claude/worktrees/<name>/node_modules/next/dist/...". `build:verify`
  // only allows "/ROOT/node_modules/next/dist/...", so it rejected worktree
  // builds that were in fact correct.
  //
  // `__dirname` is the project directory: next.config.ts is transpiled to
  // CommonJS and required as `<project>/next.config.compiled.js`, so it holds
  // wherever the build was invoked from. Next copies this into
  // `outputFileTracingRoot` too, which keeps the two roots in step.
  turbopack: {
    root: __dirname,
  },
  // Inline the source-scoped route CSS to remove the render-blocking stylesheet
  // round trip. Public routes still exclude utilities used only by authenticated
  // tools; private routes add their supplemental utilities from route layouts.
  experimental: {
    inlineCss: true,
  },
  // ffmpeg-static resolves its binary from `__dirname`. Bundled, Turbopack
  // inlines that as its virtual root ("/ROOT/node_modules/ffmpeg-static") — a
  // path that does not exist in a lambda — so every spawn failed with ENOENT
  // and no rendition or video poster could be produced in production. Keeping
  // it external preserves a real runtime require, so `__dirname` points at the
  // node_modules directory outputFileTracingIncludes already ships.
  // sharp is externalized too, but externalizing is not the same as tracing:
  // its .node binary dlopens libvips at runtime, and a dlopen is invisible to
  // static analysis. The tracer therefore ships @img/sharp-libvips-*'s
  // index.js, package.json and versions.json -- and omits the .so those exist
  // to describe -- so every route touching the media stack dies on load with
  // ERR_DLOPEN_FAILED. That took production's whole scheduler down on
  // 2026-08-19 while every gate stayed green. SHARP_ROUTES below ships the
  // library itself, and `build:verify` now fails any route that traces the
  // .node without it, so this cannot silently regress again.
  //
  // The @sentry/* entries are load-bearing now that src/instrumentation.ts
  // exists: bundling them inlined "/ROOT/node_modules/@sentry/..." into the
  // server chunks and dragged Sentry's own bundler-plugin machinery in behind
  // the package index. `build:verify` caught that; keeping them external is
  // what clears it.
  serverExternalPackages: [
    "ffmpeg-static",
    "@sentry/nextjs",
    "@sentry/node-core",
    "@sentry/server-utils",
    "@apm-js-collab/code-transformer-bundler-plugins",
  ],
  // Keys are matched as globs, so a literal "[id]" reads as a character class
  // and never matches its route. Use "*" for dynamic segments.
  outputFileTracingIncludes: {
    ...Object.fromEntries(SHARP_ROUTES.map((route) => [route, SHARP_TRACE])),
    "/api/cron/backend-jobs": [...FFMPEG_TRACE, ...SHARP_TRACE],
    "/api/cron/generation-completions": [...FFMPEG_TRACE, ...SHARP_TRACE],
    "/api/cron/media-preview-repair": [...FFMPEG_TRACE, ...SHARP_TRACE],
    "/api/generate": [...FFMPEG_TRACE, ...SHARP_TRACE],
    "/api/generate-video": [...FFMPEG_TRACE, ...SHARP_TRACE],
    "/api/posts": [...FFMPEG_TRACE, ...SHARP_TRACE],
    "/api/posts/*": [...FFMPEG_TRACE, ...SHARP_TRACE],
    "/api/showcase/publish": [...FFMPEG_TRACE, ...SHARP_TRACE],
    // Template publish derives the catalog poster frame from the demo video.
    "/api/templates/*/publish": [...FFMPEG_TRACE, ...SHARP_TRACE],
  },
  outputFileTracingExcludes: {
    "**/*": [
      "./audits/**",
      "./model_api_references/**",
      "./mockups/**",
      "./next.config.ts",
      "./output/**",
      "./package-lock.json",
      "./scripts/**",
      "./ugc-mobile/**",
    ],
  },
  images: {
    minimumCacheTTL: SHOWCASE_PUBLIC_MEDIA_MINIMUM_CACHE_TTL_SECONDS,
    // Static preview art is confined to the public image tree and never needs
    // a query string. Stored-media helpers deliberately return the separate
    // authenticated proxy path; omitting `search` only there permits its
    // validated bucket/path query without opening arbitrary local URLs.
    localPatterns: [
      { pathname: "/assets/images/**", search: "" },
      { pathname: "/api/media" },
    ],
    remotePatterns: supabaseUrl
      ? [
          {
            protocol: supabaseUrl.protocol.replace(":", "") as "http" | "https",
            hostname: supabaseUrl.hostname,
            port: supabaseUrl.port || undefined,
            pathname: "/storage/v1/object/**",
          },
        ]
      : [],
  },
  async headers() {
    return [
      ...(showcasePreconnectHeaders.length > 0
        ? [{ source: "/showcase", headers: showcasePreconnectHeaders }]
        : []),
      {
        source: "/(.*)",
        headers: [
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "X-DNS-Prefetch-Control",
            value: "on",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Content-Security-Policy-Report-Only",
            value: contentSecurityPolicyReportOnly,
          },
        ],
      },
    ];
  },
};

/**
 * Sentry's build-time wrapper (F15b). Its only job here is source maps: without
 * it every stack trace in Sentry points at minified code, which makes the error
 * tracker able to tell you that something broke but not where.
 *
 * THIS WRAPPER IS THE RISKY PART OF THE INTEGRATION, so each option below is a
 * decision rather than a default:
 *
 * - `widenClientFileUpload: false` — uploading extra client bundles costs quota
 *   and buys nothing until traces are actually unreadable without it.
 * - `disableLogger: true` — strips Sentry's own debug logging from the bundle.
 * - `automaticVercelMonitors: false` — it would create Vercel Cron monitors in
 *   Sentry. The cron already has `backend_job_runs` plus the external watchdog,
 *   and a second, quota-consuming monitor for the same thing is noise.
 * - `sourcemaps.deleteSourcemapsAfterUpload: true` — the maps go to Sentry, not
 *   to the public. This repository is public and the deployed site is public;
 *   shipping `.map` files would hand out readable source to anyone.
 * - `tunnelRoute` is deliberately NOT set. It would proxy Sentry traffic through
 *   the app's own domain to dodge ad blockers, at the cost of a route and of
 *   every event crossing our own serverless functions.
 *
 * `silent` is tied to CI so local builds stay quiet while CI keeps the upload
 * log — if source-map upload ever silently stops, the CI log is where that
 * shows up.
 *
 * Verify after changing anything here with `npm run build:verify`. The wrapper
 * rewrites the bundler configuration that `outputFileTracingIncludes` uses to
 * force `ffmpeg-static` into the media routes, and that check is what caught
 * both the original ffmpeg breakage and this integration's earlier attempts.
 */
export default withSentryConfig(nextConfig, {
  org: "magicbooklet",
  project: "magicbooklet-web",
  // Absent locally and in CI forks; the upload is skipped rather than failing
  // the build, so a checkout never depends on having the token.
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: false,
  disableLogger: true,
  automaticVercelMonitors: false,
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
  /**
   * Source-map upload must never be the reason a deploy fails.
   *
   * This is not hypothetical caution: CI builds *without* `SENTRY_AUTH_TOKEN`
   * (it is a Vercel environment variable, not a GitHub secret), so the
   * production build on Vercel is the FIRST build that ever exercises the
   * upload path. A wrong-scoped, expired or revoked token would surface there
   * and nowhere earlier — after Quality has already gone green.
   *
   * Same posture as the missing-DSN case: degrade to "no source maps", loudly,
   * rather than to "no deploy". The log line is what stops it being silent.
   */
  errorHandler: (error) => {
    console.warn(
      '[sentry] source map upload failed — the build continues and the deploy is '
      + 'unaffected, but stack traces for this release will be minified. '
      + 'Check SENTRY_AUTH_TOKEN scope/expiry.',
      error instanceof Error ? error.message : error,
    );
  },
});
