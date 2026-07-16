import type { NextConfig } from "next";

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

const nextConfig: NextConfig = {
  // Keep global CSS external. Next 16's experimental inlineCss mode repeats
  // the full stylesheet in both the document and the RSC payload, adding more
  // than 400 KiB of main-thread parse work to every uncached navigation.
  outputFileTracingIncludes: {
    "/api/cron/backend-jobs": ["./node_modules/ffmpeg-static/**"],
    "/api/cron/generation-completions": ["./node_modules/ffmpeg-static/**"],
    "/api/cron/media-preview-repair": ["./node_modules/ffmpeg-static/**"],
    "/api/generate": ["./node_modules/ffmpeg-static/**"],
    "/api/generate-video": ["./node_modules/ffmpeg-static/**"],
    "/api/generations/[id]/restore-media": ["./node_modules/ffmpeg-static/**"],
    "/api/posts": ["./node_modules/ffmpeg-static/**"],
    "/api/posts/[postId]": ["./node_modules/ffmpeg-static/**"],
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
        ],
      },
    ];
  },
};

export default nextConfig;
