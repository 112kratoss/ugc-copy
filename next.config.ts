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

const nextConfig: NextConfig = {
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
  // sharp needs no entry; Next externalizes it by default.
  //
  // The @sentry/* entries are kept for when server-side Sentry lands: with a
  // root instrumentation.ts present, bundling them inlined
  // "/ROOT/node_modules/@sentry/..." into the server chunks and dragged
  // Sentry's own bundler-plugin machinery in behind the package index.
  // `build:verify` caught that; these entries cleared it. They are inert while
  // only the browser SDK ships, and removing them would just have to be undone.
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
    "/api/cron/backend-jobs": ["./node_modules/ffmpeg-static/**"],
    "/api/cron/generation-completions": ["./node_modules/ffmpeg-static/**"],
    "/api/cron/media-preview-repair": ["./node_modules/ffmpeg-static/**"],
    "/api/generate": ["./node_modules/ffmpeg-static/**"],
    "/api/generate-video": ["./node_modules/ffmpeg-static/**"],
    "/api/posts": ["./node_modules/ffmpeg-static/**"],
    "/api/posts/*": ["./node_modules/ffmpeg-static/**"],
    "/api/showcase/publish": ["./node_modules/ffmpeg-static/**"],
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

export default nextConfig;
