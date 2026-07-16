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

    expect(nextConfig).toContain('inlineCss: true');
    expect(nextConfig).toContain('Inline the source-scoped route CSS');
    expect(globalCss).toContain('@import "tailwindcss" source(none)');
    expect(globalCss).toContain('@source "./showcase"');
    expect(globalCss).toContain('@source "./marketplace"');
    expect(globalCss).not.toContain('@source "./components";');
    expect(globalCss).toContain('@source "./components/AppShell.tsx";');
    expect(globalCss).toContain('@source "../lib/client-generation-models.ts";');
  });

  it('bounds media-heavy first renders and yields the remaining showcase hydration work', () => {
    const nextConfig = readProjectFile('next.config.ts');
    const showcaseModel = readProjectFile('src/lib/showcase.ts');
    const showcaseClient = readProjectFile('src/app/showcase/ShowcaseClient.tsx');
    const showcasePage = readProjectFile('src/app/showcase/page.tsx');
    const priorityPoster = readProjectFile('src/lib/showcase-priority-poster.ts');
    const marketplacePolicy = readProjectFile('src/lib/marketplace-resource-list-cache-policy.ts');
    const marketplaceClient = readProjectFile('src/app/marketplace/MarketplaceBrowser.tsx');

    expect(showcaseModel).toContain('SHOWCASE_INITIAL_RENDER_COUNT = 1');
    expect(showcaseModel).toContain('SHOWCASE_INITIAL_PAGE_SIZE = 2');
    expect(showcaseClient).toContain('items.slice(0, renderedItemCount)');
    expect(showcaseClient).toContain('requestIdleCallback(callback, { timeout })');
    expect(showcaseClient).not.toContain('hasDelayedFirstDeferredRevealRef');
    expect(showcaseClient).toContain('SHOWCASE_DEFERRED_REVEAL_FALLBACK_MS = 8_000');
    expect(showcaseClient).toContain("SHOWCASE_DEFERRED_REVEAL_ROOT_MARGIN = '200px 0px'");
    expect(showcaseClient).toContain('data-showcase-deferred-reveal-sentinel="true"');
    expect(showcaseClient).toContain("rootMargin: '400px 0px'");
    expect(showcaseClient).toMatch(/href="\/post\/new"[\s\S]*?prefetch={false}/);
    expect(showcaseClient).toMatch(/href="\/marketplace"[\s\S]*?prefetch={false}/);
    expect(readProjectFile('src/lib/preview-images.ts')).toContain('if (isGeneratedPreviewImage(src))');
    expect(showcasePage).toContain('getInlineShowcasePriorityPoster(priorityVideoPoster.sourceUrl)');
    expect(priorityPoster).toContain('SHOWCASE_PRIORITY_POSTER_MAX_BYTES = 64 * 1024');
    expect(priorityPoster).toContain("return `data:image/webp;base64,${Buffer.from(bytes).toString('base64')}`");
    expect(nextConfig).toContain('value: `<${supabaseUrl.origin}>; rel=preconnect`');
    expect(nextConfig).toContain('{ source: "/showcase", headers: showcasePreconnectHeaders }');
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
    expect(budgets.load.targets.every((target) => target.method === 'GET')).toBe(true);
    expect(budgets.load.targets.every((target) => target.path.startsWith('/'))).toBe(true);
    expect(budgets.load.targets.some((target) => target.path.includes('sort=recent'))).toBe(true);
    expect(budgets.load.targets.every((target) => !target.path.includes('sort=newest'))).toBe(true);
    expect(budgets.load.targets.every((target) => target.expectedStatuses.includes(200))).toBe(true);
    expect(budgets.load.defaults.maxErrorRate).toBeLessThanOrEqual(0.01);
    expect(budgets.load.defaults.p95TtfbMs).toBeLessThan(budgets.load.defaults.p99TtfbMs);
    expect(budgets.load.originTargets).toHaveLength(1);
    expect(budgets.load.originTargets[0]).toMatchObject({
      method: 'GET',
      cacheBust: true,
      expectedCacheStatuses: ['MISS', 'BYPASS'],
    });
    expect(budgets.load.originTargets[0]?.path).toContain('sort=recent');
    expect(budgets.webVitals).toMatchObject({
      percentile: 75,
      LCP: 2500,
      CLS: 0.1,
      INP: 200,
      FCP: 1800,
      TTFB: 800,
    });
  });

  it('validates the harness in CI and schedules production budget checks', () => {
    const workflow = readProjectFile('.github/workflows/performance.yml');
    const qualityWorkflow = readProjectFile('.github/workflows/quality.yml');
    const loadHarness = readProjectFile('scripts/performance-load-test.mjs');
    const lighthouseConfig = readProjectFile('config/lighthouse.cjs');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('schedule:');
    expect(workflow).toContain('PERF_BASE_URL: https://magicbooklet.com');
    expect(workflow).toContain('PERF_ALLOW_PRODUCTION: "1"');
    expect(workflow).toContain("PERF_MAX_RPS: ${{ inputs.max_rps || '25' }}");
    expect(workflow).toContain('PERF_PROFILE: edge');
    expect(workflow).not.toContain('PERF_ALLOW_ORIGIN_LOAD');
    expect(workflow).not.toContain('PERF_ALLOW_PRODUCTION_ORIGIN_LOAD');
    expect(workflow).toContain('node scripts/performance-load-test.mjs --profile "$PERF_PROFILE" --output performance-load-results.json');
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
    expect(loadHarness).toContain('function buildWarmupPlan(targets, requestsPerTarget)');
    expect(loadHarness).toContain('if (!await reserveRateSlot(warmupDeadline))');
    expect(loadHarness).toContain('plan.length >= MAX_TOTAL_WARMUP_REQUESTS');
    expect(loadHarness).toMatch(
      /Math\.min\(\s*target\.timeoutMs,\s*MAX_WARMUP_REQUEST_TIMEOUT_MS,\s*remainingWarmupMs/,
    );

    const output = execFileSync(
      process.execPath,
      ['scripts/performance-load-test.mjs', '--self-test'],
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
});
