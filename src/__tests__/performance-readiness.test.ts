import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const readProjectFile = (relativePath: string) => (
  readFileSync(path.join(projectRoot, relativePath), 'utf8')
);

describe('production performance readiness', () => {
  it('inlines the scoped public Tailwind stylesheet without pulling in private utilities', () => {
    const nextConfig = readProjectFile('next.config.ts');
    const globalCss = readProjectFile('src/app/globals.css');

    // `inlineCss` is on so the public pages paint without a second,
    // render-blocking request: on the throttled mobile Lighthouse run that
    // request competed with the script chunks and moved the home page's first
    // paint from 0.8 s to 2.2 s. Next inlines the root sheet twice per response
    // (a <style> tag and a copy in the flight data for the root layout; the
    // global-error boundary's third copy is patched out, see the budget test
    // below), so the sheet a public page
    // inlines has to stay small: globals.css scans only public routes, and a
    // public route never links the supplement (route-style-readiness.test.ts
    // pins the split).
    expect(nextConfig).toContain('inlineCss: true');
    expect(nextConfig).toContain('`inlineCss` is deliberately on');
    expect(globalCss).toContain('@import "tailwindcss" source(none)');
    expect(globalCss).toContain('@source "./showcase"');
    expect(globalCss).toContain('@source "./marketplace"');
    expect(globalCss).toContain('@source "./blog"');
    expect(globalCss).toContain('@source "./templates"');
    expect(globalCss).not.toContain('@source "./post"');
    expect(globalCss).not.toContain('@source "./create-image"');
    expect(globalCss).not.toContain('@source "./admin"');
    expect(globalCss).not.toContain('@source "../components";');
    expect(globalCss).toContain('@source "../components/AppShell.tsx";');
    expect(globalCss).toContain('@source "../lib/client-generation-models.ts";');
  });

  it('bounds media-heavy first renders and yields the remaining showcase hydration work', () => {
    const nextConfig = readProjectFile('next.config.ts');
    const showcaseModel = readProjectFile('src/lib/showcase.ts');
    const showcaseClient = readProjectFile('src/app/showcase/ShowcaseClient.tsx');
    const showcaseBootstrap = readProjectFile('src/app/showcase/ShowcaseBootstrapClient.tsx');
    const showcaseReelLoader = readProjectFile('src/app/showcase/showcase-reel-loader.ts');
    const idleScheduler = readProjectFile('src/lib/schedule-idle-work.ts');
    const feedClient = readProjectFile('src/app/feed/FeedClient.tsx');
    const feedPostCard = readProjectFile('src/app/feed/FeedPostCard.tsx');
    const windowedFeedList = readProjectFile('src/app/feed/WindowedFeedList.tsx');
    const showcaseClientCache = readProjectFile('src/lib/showcase-client-cache.ts');
    const showcaseLayout = readProjectFile('src/app/showcase/showcase-layout.ts');
    const showcaseFeedStability = readProjectFile('src/lib/showcase-feed-stability.ts');
    const showcasePage = readProjectFile('src/app/showcase/(feed)/page.tsx');
    const priorityPoster = readProjectFile('src/lib/showcase-priority-poster.ts');
    const marketplacePolicy = readProjectFile('src/lib/marketplace-resource-list-cache-policy.ts');
    const marketplaceClient = readProjectFile('src/app/marketplace/MarketplaceBrowser.tsx');
    const marketplacePage = readProjectFile('src/app/marketplace/page.tsx');

    expect(showcaseModel).toContain('SHOWCASE_INITIAL_RENDER_COUNT = 6');
    expect(showcaseModel).toContain('SHOWCASE_INITIAL_PAGE_SIZE = 12');
    // The pre-activation shell paints the same prefix the client mounts with,
    // after filtering out feed-only text posts. Only the first usable media
    // poster is attached before activation, keeping later tiles off the wire.
    expect(showcaseBootstrap).toContain(".filter((item) => !isTextOnlyPost(item))");
    expect(showcaseBootstrap).toContain('isPriority && posterUrl');
    expect(showcaseBootstrap).toContain('fetchPriority="high"');
    expect(showcaseClient).toContain('tileableItems.slice(0, renderedItemCount)');
    expect(idleScheduler).toContain('requestIdleCallback(callback, { timeout })');
    expect(showcaseClient).not.toContain('hasDelayedFirstDeferredRevealRef');
    // The bootstrap fills on a short tick cadence after the priority card
    // paints; reveals must not wait on scroll boundaries or long fallbacks.
    expect(showcaseClient).toContain('SHOWCASE_DEFERRED_REVEAL_TICK_MS = 160');
    expect(showcaseClient).not.toContain('SHOWCASE_DEFERRED_REVEAL_FALLBACK_MS');
    expect(showcaseClient).not.toContain('data-showcase-deferred-reveal-sentinel');
    // The full client warms the reel after first-paint work and on intent. The
    // shared memoized loader keeps every reel surface on the same chunk promise.
    expect(showcaseClient).toContain('scheduleIdleWork(warmShowcaseReelViewer, SHOWCASE_REEL_WARM_IDLE_TIMEOUT_MS)');
    expect(showcaseClient).toContain('onPointerEnter={warmShowcaseReelViewer}');
    expect(showcaseClient).not.toContain("import('@/app/showcase/ShowcaseReelViewer')");
    expect(showcaseReelLoader).toContain("import('@/app/showcase/ShowcaseReelViewer')");
    expect(showcaseReelLoader).toContain('showcaseReelViewerPromise = null');
    // The restore-cache write serializes the whole feed, and the reveal ticks
    // change its inputs — it has to stay debounced onto idle, never eager.
    expect(showcaseClient).toContain('scheduleIdleWork(flushShowcaseSnapshot, SHOWCASE_SNAPSHOT_IDLE_TIMEOUT_MS)');
    expect(showcaseClient).not.toMatch(/^\s*writeShowcaseClientSnapshot\(showcaseClientCacheKey/m);
    expect(feedClient).toContain('scheduleIdleDebouncedWork(');
    expect(feedClient).toContain('FEED_SNAPSHOT_QUIET_PERIOD_MS');
    expect(feedClient).not.toMatch(/^\s*writeShowcaseClientSnapshot\(cacheKey/m);
    expect(feedPostCard).toContain('[content-visibility:auto]');
    expect(showcaseClient).toContain('[content-visibility:auto]');
    expect(windowedFeedList).toContain('FEED_WINDOW_MAX_MOUNTED_CARDS = 24');
    expect(windowedFeedList).toContain('data-feed-windowed-list="true"');
    expect(showcaseClientCache).toContain('SHOWCASE_SNAPSHOT_MAX_OFFSET_ITEMS = 36');
    expect(showcaseClient).toContain("rootMargin: '400px 0px'");
    expect(showcaseLayout).toContain("'grid grid-cols-1 items-start gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'");
    expect(showcaseClient).not.toContain('columns-');
    expect(showcaseBootstrap).not.toContain('columns-');
    expect(showcaseFeedStability).toContain('mergeShowcaseFeedKeepingVisibleItems');
    expect(showcaseClient).toContain('mergeShowcaseFeedKeepingVisibleItems(');
    expect(showcaseClient).toMatch(/href="\/marketplace"[\s\S]*?prefetch={false}/);
    expect(readProjectFile('src/lib/preview-images.ts')).toContain('if (isGeneratedPreviewImage(src))');
    expect(showcasePage).toContain('getInlineShowcasePriorityPoster(priorityVideoPoster.sourceUrl)');
    expect(priorityPoster).toContain('SHOWCASE_PRIORITY_POSTER_MAX_BYTES = 64 * 1024');
    expect(priorityPoster).toContain("return `data:image/webp;base64,${Buffer.from(bytes).toString('base64')}`");
    // A client component's props are written into the flight data of every
    // first load. The tool filters get each tool's slug and label alone, and
    // the first feed page drops the media fields only the app reads: 47 KB of
    // /showcase and 31 KB of /marketplace on 2026-10-20, margin under the
    // decoded budgets below (showcase-first-load-props.test.ts and the two
    // page tests hold what is left out).
    expect(showcasePage).toContain('initialFeed={toShowcaseBootstrapFeedPage(initialFeed)}');
    expect(showcasePage).toContain('sourceToolOptions={toSourceToolFilterOptions(sourceToolOptions)}');
    expect(marketplacePage).toContain('sourceToolOptions: toSourceToolFilterOptions(sourceToolOptions)');
    expect(nextConfig).toContain('value: `<${supabaseUrl.origin}>; rel=preconnect`');
    expect(nextConfig).toContain('["/", "/home", "/showcase", "/marketplace"]');
    expect(nextConfig).toContain('headers: publicMediaPreconnectHeaders');
    expect(marketplacePolicy).toContain('MARKETPLACE_INITIAL_PAGE_SIZE = 3');
    expect(marketplacePolicy).toContain('MARKETPLACE_COMPACT_PAGE_SIZE = 12');
    expect(marketplacePolicy).toContain('MARKETPLACE_DEFAULT_PAGE_SIZE = 24');
    expect(marketplaceClient).toContain('limit: MARKETPLACE_COMPACT_PAGE_SIZE');
    expect(marketplaceClient).not.toContain('bootstrapRevealSentinelRef');
  });

  it('ships Vercel real-user Core Web Vitals collection from the root layout', () => {
    const packageJson = JSON.parse(readProjectFile('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const layout = readProjectFile('src/app/layout.tsx');

    expect(packageJson.dependencies?.['@vercel/speed-insights']).toBe('2.0.0');
    expect(packageJson.devDependencies?.['@lhci/cli']).toBe('0.15.1');
    expect(layout).toContain("import { SpeedInsights } from \"@vercel/speed-insights/next\"");
    expect(layout).toContain("process.env.NEXT_PUBLIC_SPEED_INSIGHTS_ENABLED === '1'");
    expect(layout).toContain('<SpeedInsights sampleRate={getSpeedInsightsSampleRate()} />');
    expect(readProjectFile('.env.example')).toContain('NEXT_PUBLIC_SPEED_INSIGHTS_ENABLED=0');
    expect(readProjectFile('.env.example')).toContain('NEXT_PUBLIC_SPEED_INSIGHTS_SAMPLE_RATE=1');
  });

  it('keeps every production load target read-only, bounded, and explicitly budgeted', () => {
    const budgets = JSON.parse(readProjectFile('config/performance-budgets.json')) as {
      load: {
        defaults: Record<string, number>;
        targets: Array<{
          name: string;
          path: string;
          method: string;
          expectedStatuses: number[];
        }>;
        signedInTargets: Array<{
          name: string;
          path: string;
          method: string;
          auth: string;
          expectedStatuses: number[];
          minRequests: number;
          maxRequestsPerRun: number;
        }>;
        originTargets: Array<{
          name: string;
          path: string;
          method: string;
          cacheBust: boolean;
          expectedCacheStatuses: string[];
        }>;
      };
      webVitals: Record<string, number>;
    };

    expect(budgets.load.targets.length).toBeGreaterThanOrEqual(4);
    // With `inlineCss` on, every document carried the root stylesheet three
    // times: the <style> tag, its escaped copy in the RSC payload, and a second
    // escaped copy Next writes for the global-error boundary (the payload's
    // `G`), which Turbopack credits with the root layout's CSS. That was
    // 454 KB of /showcase's 602 KB on 2026-10-20, so the decoded size of a
    // page is dominated by the sheet rather than its content. The root
    // postinstall patches the third copy out (vercel/next.js#98110; the test
    // after this one): live on 2026-10-23, every page lost 160 KB. The three
    // page targets budget decoded bytes explicitly, re-based that evening on
    // the live documents by the rule the 2026-09-15 budgets used (the multiple
    // of 16 KiB nearest 1.1 times the page): home 604,990 B, marketplace
    // 410,806 B. /showcase moves with its first post: a video there inlines its
    // poster (up to SHOWCASE_PRIORITY_POSTER_MAX_BYTES) in the HTML and again in
    // the flight data, so the poster test after this one sets its budget, not
    // its image-first 415,168 B. Encoded budgets are untouched: brotli matches
    // the duplicate copies against the first, so the wire cost of inlining is
    // about one compressed copy (~20 KB).
    const pageTargets = Object.fromEntries(
      budgets.load.targets
        .filter((target) => !target.path.startsWith('/api/'))
        .map((target) => [target.name, target as typeof target & { p95DecodedBytes?: number }]),
    );
    expect(pageTargets['home-page']?.p95DecodedBytes).toBe(671_744);
    expect(pageTargets['showcase-page']?.p95DecodedBytes).toBe(638_976);
    expect(pageTargets['marketplace-page']?.p95DecodedBytes).toBe(458_752);
    expect(budgets.load.targets.every((target) => target.method === 'GET')).toBe(true);
    expect(budgets.load.targets.every((target) => target.path.startsWith('/'))).toBe(true);
    expect(budgets.load.targets.some((target) => target.path.includes('sort=recent'))).toBe(true);
    expect(budgets.load.targets.every((target) => !target.path.includes('sort=newest'))).toBe(true);
    expect(budgets.load.targets.every((target) => target.expectedStatuses.includes(200))).toBe(true);
    expect(budgets.load.defaults.maxErrorRate).toBeLessThanOrEqual(0.01);
    expect(budgets.load.defaults.p95EncodedBodyBytes).toBeGreaterThan(0);
    expect(budgets.load.defaults.p95DecodedBytes).toBeGreaterThan(0);
    expect(budgets.load.defaults.p95TtfbMs).toBeLessThan(budgets.load.defaults.p99TtfbMs);
    expect(budgets.load.originTargets).toHaveLength(1);
    expect(budgets.load.originTargets[0]).toMatchObject({
      method: 'GET',
      cacheBust: true,
      expectedCacheStatuses: ['MISS', 'BYPASS'],
    });
    expect(budgets.load.originTargets[0]?.path).toContain('sort=recent');
    expect(budgets.load.signedInTargets).toHaveLength(1);
    expect(budgets.load.signedInTargets[0]).toMatchObject({
      method: 'GET',
      auth: 'bearer',
      expectedStatuses: [200],
    });
    expect(budgets.load.signedInTargets[0]?.path).toContain('sort=for-you');
    expect(budgets.load.signedInTargets[0]?.maxRequestsPerRun).toBeGreaterThanOrEqual(
      budgets.load.signedInTargets[0]?.minRequests ?? Number.POSITIVE_INFINITY,
    );
    expect(budgets.webVitals).toMatchObject({
      percentile: 75,
      LCP: 2500,
      CLS: 0.1,
      INP: 200,
      FCP: 1800,
      TTFB: 800,
    });
  });

  it('leaves /showcase room under its decoded budget for the largest poster it inlines', () => {
    const packageJson = JSON.parse(readProjectFile('package.json')) as { scripts: Record<string, string> };
    const budgets = JSON.parse(readProjectFile('config/performance-budgets.json')) as {
      load: { targets: Array<{ name: string; p95DecodedBytes?: number }> };
    };
    const showcaseBudget = budgets.load.targets.find((target) => target.name === 'showcase-page')?.p95DecodedBytes;
    const capKilobytes = Number(/SHOWCASE_PRIORITY_POSTER_MAX_BYTES = (\d+) \* 1024/
      .exec(readProjectFile('src/lib/showcase-priority-poster.ts'))?.[1]);

    // When a video leads Explore's feed, the page inlines its poster (at most
    // SHOWCASE_PRIORITY_POSTER_MAX_BYTES) as a base64 data URL twice, in the
    // bootstrap <img> and again in the flight props: 8/3 of its bytes, measured
    // on a production build on 2026-10-23 (24 KB added 65,540 B, 64 KB 174,773 B).
    // While Next wrote the root sheet three times, any poster over 23.9 KB took
    // /showcase past this budget. With the patch live, /showcase read 415,168 B
    // with an image first (production, 2026-10-23 22:18 IST), so a poster at
    // the cap brings it to ~590 KB, 8% under the budget.
    const MEASURED_IMAGE_FIRST = 415_168;
    const posterAtTheCap = 2 * (Math.ceil((capKilobytes * 1024) / 3) * 4 + 'data:image/webp;base64,'.length);
    expect(MEASURED_IMAGE_FIRST + posterAtTheCap).toBeLessThan(showcaseBudget!);
    // So the patch has to keep applying, and the build has to say when it does not.
    expect(packageJson.scripts.postinstall).toContain('node scripts/build/patch-next-global-error-css.mjs');
    expect(packageJson.scripts['build:verify']).toContain('node scripts/build/check-inline-css-copies.mjs');
  });

  it('validates the harness in CI and schedules production budget checks', () => {
    const workflow = readProjectFile('.github/workflows/performance.yml');
    const qualityWorkflow = readProjectFile('.github/workflows/quality.yml');
    const loadHarness = readProjectFile('scripts/perf/performance-load-test.mjs');
    const lighthouseConfig = readProjectFile('config/lighthouse.cjs');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('schedule:');
    expect(workflow).toContain('PERF_BASE_URL: https://magicbooklet.com');
    expect(workflow).toContain('PERF_ALLOW_PRODUCTION: "1"');
    expect(workflow).toContain("PERF_MAX_RPS: ${{ inputs.max_rps || '25' }}");
    expect(workflow).toContain('PERF_PROFILE: edge');
    expect(workflow).toContain('PERF_AUTH_SUPABASE_URL: ${{ secrets.PERF_AUTH_SUPABASE_URL }}');
    expect(workflow).toContain('PERF_AUTH_SUPABASE_ANON_KEY: ${{ secrets.PERF_AUTH_SUPABASE_ANON_KEY }}');
    expect(workflow).toContain('PERF_AUTH_BOT_EMAIL: ${{ secrets.PERF_AUTH_BOT_EMAIL }}');
    expect(workflow).toContain('PERF_AUTH_BOT_PASSWORD: ${{ secrets.PERF_AUTH_BOT_PASSWORD }}');
    expect(workflow).toContain('PERF_REQUIRE_SIGNED_IN: "1"');
    expect(workflow).not.toContain('PERF_AUTH_BEARER_TOKEN');
    expect(workflow).not.toContain('PERF_ALLOW_ORIGIN_LOAD');
    expect(workflow).not.toContain('PERF_ALLOW_PRODUCTION_ORIGIN_LOAD');
    expect(workflow).toContain('node scripts/perf/performance-load-test.mjs --profile "$PERF_PROFILE" --require-signed-in --output performance-load-results.json');
    expect(workflow).toContain('Lighthouse ${{ matrix.form_factor }} budgets');
    expect(workflow).toContain('needs: production-load-budgets');
    expect(workflow).toContain('max-parallel: 1');
    expect(workflow).toContain('npm run perf:lighthouse');
    expect(lighthouseConfig).toContain("throttlingMethod: 'devtools'");
    expect(qualityWorkflow).toContain('npm run perf:load:self-test');
    expect(qualityWorkflow).toContain('npm run perf:lighthouse:self-test');
    expect(loadHarness).toContain('const MAX_WARMUP_REQUESTS_PER_TARGET = 3;');
    expect(loadHarness).toContain('const MAX_TOTAL_WARMUP_REQUESTS = 15;');
    expect(loadHarness).toContain('const MAX_WARMUP_DURATION_MS = 30_000;');
    expect(loadHarness).toContain('const MAX_WARMUP_REQUEST_TIMEOUT_MS = 10_000;');
    expect(loadHarness).toContain('const DEFAULT_AUTH_TIMEOUT_MS = 10_000;');
    expect(loadHarness).toContain('const MAX_AUTH_RESPONSE_BODY_BYTES = 64 * 1024;');
    expect(loadHarness).toContain('function buildWarmupPlan(targets, requestsPerTarget)');
    expect(loadHarness).toContain("'Accept-Encoding': 'br, gzip, deflate'");
    expect(loadHarness).toContain("certificationStatus === 'not-certified'");
    expect(loadHarness).toContain("new URL('/auth/v1/token?grant_type=password', authUrl)");
    expect(loadHarness).toContain('Signed-in coverage is required');
    expect(loadHarness).toContain('P95_ENCODED_BODY_BYTES');
    expect(loadHarness).toContain("response.headers, 'x-scaling-certification-timing'");
    expect(loadHarness).toContain('serverTimings,');
    expect(loadHarness).not.toContain('transferredBytes');
    expect(loadHarness).not.toContain('totalTransferredBytes');
    expect(loadHarness).toContain('if (!await reserveRateSlot(warmupDeadline))');
    expect(loadHarness).toContain('plan.length >= MAX_TOTAL_WARMUP_REQUESTS');
    expect(loadHarness).toMatch(
      /Math\.min\(\s*target\.timeoutMs,\s*MAX_WARMUP_REQUEST_TIMEOUT_MS,\s*remainingWarmupMs/,
    );

    const output = execFileSync(
      process.execPath,
      ['scripts/perf/performance-load-test.mjs', '--self-test'],
      { cwd: projectRoot, encoding: 'utf8' },
    );
    expect(output).toContain('Performance load-test self-check passed');
    const lighthouseOutput = execFileSync(
      process.execPath,
      ['config/lighthouse.cjs'],
      { cwd: projectRoot, encoding: 'utf8' },
    );
    expect(lighthouseOutput).toContain('Lighthouse config self-check passed');

    for (const localBaseUrl of [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
    ]) {
      const localLighthouseOutput = execFileSync(
        process.execPath,
        ['config/lighthouse.cjs'],
        {
          cwd: projectRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            PERF_BASE_URL: localBaseUrl,
          },
        },
      );
      expect(localLighthouseOutput).toContain('Lighthouse config self-check passed');
    }

    expect(() => execFileSync(
      process.execPath,
      ['config/lighthouse.cjs'],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          PERF_BASE_URL: 'http://example.com',
        },
      },
    )).toThrow();
  });

  it('documents every performance harness environment variable', () => {
    const environmentTemplate = readProjectFile('.env.example');
    const performanceSources = [
      readProjectFile('scripts/perf/performance-load-test.mjs'),
      readProjectFile('config/lighthouse.cjs'),
      readProjectFile('.github/workflows/performance.yml'),
    ].join('\n');
    const referencedVariables = [
      ...new Set(performanceSources.match(/\bPERF_[A-Z0-9_]+\b/g) ?? []),
    ].sort();
    const documentedVariables = new Set(
      [...environmentTemplate.matchAll(/^#\s*(PERF_[A-Z0-9_]+)=/gm)]
        .map((match) => match[1]),
    );

    expect(referencedVariables.filter((name) => !documentedVariables.has(name))).toEqual([]);
    expect(environmentTemplate).toMatch(/^# PERF_AUTH_BOT_EMAIL=/m);
    expect(environmentTemplate).toMatch(/^# PERF_AUTH_BOT_PASSWORD=/m);
    expect(environmentTemplate).not.toMatch(/^PERF_AUTH_(?:BOT_EMAIL|BOT_PASSWORD)=/m);
  });
});
