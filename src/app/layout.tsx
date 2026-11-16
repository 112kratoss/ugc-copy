import type { Metadata } from "next";
import { Geist } from "next/font/google";
import Script from "next/script";
import { Suspense } from "react";
import { SpeedInsights } from "@vercel/speed-insights/next";

import { siteConfig } from "@/lib/seo";
import { TYPED_BEFORE_HYDRATION_CAPTURE } from "@/lib/typed-before-hydration";
import { buildAppShellAccountRestore } from "@/lib/app-shell-account-restore";
import { APP_SHELL_SIDEBAR_RESTORE } from "@/lib/app-shell-sidebar-restore";
import { WELCOME_PROMISE_RESTORE } from "@/lib/welcome-promise-restore";
import { REEL_OPENING_RESTORE } from "@/lib/reel-opening-restore";
import { ADDRESS_FIRST_PAINT_RESTORE } from "@/lib/address-first-paint";
import { RELOAD_OPENS_AT_TOP } from "@/lib/reload-opens-at-top";

import "./globals.css";
import AppShell from "@/components/AppShell";
import DeferredGenerationNotifications from "@/components/DeferredGenerationNotifications";
import DeferredWelcomeCreditsPopup from "@/components/DeferredWelcomeCreditsPopup";
import FeedbackViewport from "@/components/FeedbackViewport";
import NavigationProgress from "@/components/NavigationProgress";
import ReelOpeningCover from "@/components/ReelOpeningCover";
import AddressFirstPaintRelease from "@/components/AddressFirstPaintRelease";

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
    "AI creator community",
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
    process.env.RELEASE_GIT_SHA?.trim() ||
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.VERCEL_DEPLOYMENT_ID?.trim() ||
    process.env.VERCEL_URL?.trim() ||
    'dev';
  const appShellAccountRestore = buildAppShellAccountRestore();

  return (
    <html lang="en" suppressHydrationWarning data-build-id={buildId}>
      <body className={`${geistSans.variable} antialiased`}>
        {/*
          Ahead of every field the page draws: text typed into a textarea, or an
          input marked for it, before the page's script runs stays on the field,
          for the page to take in as it mounts (`useTypedBeforeHydration`). A raw script, as
          next/script's beforeInteractive runs inline code only once Next's own
          code has loaded. Only a full load draws it: a client navigation never
          builds the root layout again, so React never makes it in the browser.
        */}
        <script dangerouslySetInnerHTML={{ __html: TYPED_BEFORE_HYDRATION_CAPTURE }} />
        {/* The sidebar hidden in this browser, marked on the root element before the shell is drawn (`src/lib/app-shell-sidebar-restore.ts`). */}
        <script dangerouslySetInnerHTML={{ __html: APP_SHELL_SIDEBAR_RESTORE }} />
        {/* No promise of the welcome credits where an account has signed in on this browser, from the first paint (`src/lib/welcome-promise-restore.ts`). */}
        <script dangerouslySetInnerHTML={{ __html: WELCOME_PROMISE_RESTORE }} />
        {/* A browser that holds a session, and the width of its last balance, marked on the root element so the top bar's account slot draws its signed-in shape from the first paint (`src/lib/app-shell-account-restore.ts`). */}
        <script dangerouslySetInnerHTML={{ __html: appShellAccountRestore }} />
        {/* An address that opens a post in its page's reel (`?post=`), marked on the root element so the reel's stage, below, covers the page from the first paint until the reel attaches (`src/lib/reel-opening-restore.ts`). */}
        <script dangerouslySetInnerHTML={{ __html: REEL_OPENING_RESTORE }} />
        <ReelOpeningCover />
        {/* The choice a page drawn ahead of time keeps in its address, drawn from the first
            paint (src/lib/address-first-paint.ts). */}
        <script dangerouslySetInnerHTML={{ __html: ADDRESS_FIRST_PAINT_RESTORE }} />
        <AddressFirstPaintRelease />
        {/* A refresh of Home, Explore or Marketplace opens at the top, not at the old offset on a page
            drawn afresh; the browser's restore is given back afterwards (src/lib/reload-opens-at-top.ts). */}
        <script dangerouslySetInnerHTML={{ __html: RELOAD_OPENS_AT_TOP }} />
        <a
          href="#main-content"
          className="ui-focus-ring fixed left-4 top-3 z-[120] -translate-y-24 rounded-full bg-[var(--ui-primary)] px-4 py-3 text-sm font-bold text-[var(--ui-primary-on)] transition focus:translate-y-0"
        >
          Skip to content
        </a>
        {/*
          Outside <AppShell> so it also covers the routes that render without
          the shell, and so the shell's hydration-pinned tree stays untouched.
          It is `fixed`, so its position here does not matter to layout.
        */}
        <NavigationProgress />
        <AppShell>{children}</AppShell>
        <DeferredGenerationNotifications />
        {/* The welcome credits, offered once an account has its name (Home, the creators, the page a sign-up returned to). It reads the query: a boundary of its own keeps every page drawn ahead of time. */}
        <Suspense fallback={null}>
          <DeferredWelcomeCreditsPopup />
        </Suspense>
        {/* Toasts and confirmations for every route; talks to feedback-state. */}
        <FeedbackViewport />
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
