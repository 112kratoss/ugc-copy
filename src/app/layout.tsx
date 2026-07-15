import type { Metadata } from "next";
import { Geist } from "next/font/google";
import Script from "next/script";
import { SpeedInsights } from "@vercel/speed-insights/next";

import { siteConfig } from "@/lib/seo";

import "./globals.css";
import AppShell from "./components/AppShell";
import DeferredGenerationNotifications from "./components/DeferredGenerationNotifications";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  // Slow first visits can keep the metric-compatible fallback instead of
  // repainting the page when the custom font arrives.
  display: "optional",
  preload: false,
});

function getSpeedInsightsSampleRate(): number {
  const configured = Number(process.env.NEXT_PUBLIC_SPEED_INSIGHTS_SAMPLE_RATE ?? '1');
  return Number.isFinite(configured) && configured > 0 && configured <= 1 ? configured : 1;
}

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.siteUrl),
  title: {
    default: siteConfig.title,
    template: `%s | ${siteConfig.name}`,
  },
  description: siteConfig.description,
  applicationName: siteConfig.name,
  keywords: [
    "AI UGC ads",
    "AI video generator",
    "AI image generator",
    "motion transfer",
    "UGC creator software",
    "AI workflow builder",
  ],
  authors: [{ name: siteConfig.name, url: siteConfig.siteUrl }],
  creator: siteConfig.name,
  publisher: siteConfig.name,
  openGraph: {
    title: siteConfig.defaultTitle,
    description: siteConfig.description,
    type: "website",
    url: siteConfig.siteUrl,
    siteName: siteConfig.name,
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: `${siteConfig.name} preview`,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: siteConfig.defaultTitle,
    description: siteConfig.description,
    images: [siteConfig.ogImage],
  },
  verification: {
    google: siteConfig.googleSiteVerification,
    other: process.env.BING_SITE_VERIFICATION
      ? {
        "msvalidate.01": process.env.BING_SITE_VERIFICATION,
      }
      : undefined,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const gaMeasurementId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
  const speedInsightsEnabled = process.env.NEXT_PUBLIC_SPEED_INSIGHTS_ENABLED === '1';
  const buildId =
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.VERCEL_DEPLOYMENT_ID?.trim() ||
    process.env.VERCEL_URL?.trim() ||
    'dev';

  return (
    <html lang="en" suppressHydrationWarning data-build-id={buildId}>
      <body className={`${geistSans.variable} antialiased`}>
        <a
          href="#main-content"
          className="ui-focus-ring fixed left-4 top-3 z-[120] -translate-y-24 rounded-full bg-[var(--ui-primary)] px-4 py-3 text-sm font-bold text-[var(--ui-primary-on)] transition focus:translate-y-0"
        >
          Skip to content
        </a>
        <AppShell>{children}</AppShell>
        <DeferredGenerationNotifications />
        {speedInsightsEnabled ? (
          <SpeedInsights sampleRate={getSpeedInsightsSampleRate()} />
        ) : null}
        {gaMeasurementId ? (
          <>
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${gaMeasurementId}`}
              strategy="afterInteractive"
            />
            <Script id="google-analytics" strategy="afterInteractive">
              {`
                window.dataLayer = window.dataLayer || [];
                function gtag(){dataLayer.push(arguments);}
                gtag('js', new Date());
                gtag('config', '${gaMeasurementId}', { anonymize_ip: true });
              `}
            </Script>
          </>
        ) : null}
      </body>
    </html>
  );
}
