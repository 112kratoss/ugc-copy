#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BUDGETS_PATH = path.join(PROJECT_ROOT, 'config', 'performance-budgets.json');
const DEFAULT_BASE_URL = 'https://magicbooklet.com';
const DEFAULT_DURATION_SECONDS = 30;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_RPS = 25;
const DEFAULT_ORIGIN_MAX_RPS = 2;
const DEFAULT_WARMUP_REQUESTS = 2;
const MAX_WARMUP_REQUESTS_PER_TARGET = 3;
const MAX_TOTAL_WARMUP_REQUESTS = 15;
const MAX_WARMUP_DURATION_MS = 30_000;
const MAX_WARMUP_REQUEST_TIMEOUT_MS = 10_000;
const MAX_SAFE_DURATION_SECONDS = 300;
const MAX_SAFE_CONCURRENCY = 20;
const MAX_SAFE_RPS = 50;
const MAX_SAFE_ORIGIN_DURATION_SECONDS = 60;
const MAX_SAFE_ORIGIN_CONCURRENCY = 2;
const MAX_SAFE_ORIGIN_RPS = 2;
const LOAD_PROFILES = new Set(['edge', 'origin']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const PRODUCTION_HOSTS = new Set(['magicbooklet.com', 'www.magicbooklet.com']);

function normalizeHostname(hostname) {
  return hostname.trim().toLowerCase().replace(/\.+$/, '');
}

function numberOption(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}

function integerOption(value, fallback, name) {
  const parsed = numberOption(value, fallback, name);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer.`);
  return parsed;
}

export function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)];
}

function rounded(value) {
  return value === null ? null : Number(value.toFixed(1));
}

export function summarizeDurations(values) {
  if (values.length === 0) {
    return { min: null, mean: null, p50: null, p75: null, p90: null, p95: null, p99: null, max: null };
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    min: rounded(Math.min(...values)),
    mean: rounded(total / values.length),
    p50: rounded(percentile(values, 50)),
    p75: rounded(percentile(values, 75)),
    p90: rounded(percentile(values, 90)),
    p95: rounded(percentile(values, 95)),
    p99: rounded(percentile(values, 99)),
    max: rounded(Math.max(...values)),
  };
}

function mergeTargetBudget(defaults, target) {
  return {
    ...defaults,
    ...target,
    expectedStatuses: target.expectedStatuses ?? [200],
    method: target.method ?? 'GET',
    weight: target.weight ?? 1,
  };
}

export function validateBudgets(config, profile = 'edge') {
  assert.equal(config?.version, 1, 'Performance budget version must be 1.');
  assert.ok(config?.load?.defaults, 'Load-test defaults are required.');
  assert.ok(LOAD_PROFILES.has(profile), `Unsupported load profile: ${profile}`);
  const rawTargets = profile === 'origin' ? config?.load?.originTargets : config?.load?.targets;
  assert.ok(Array.isArray(rawTargets), `${profile} load-test targets are required.`);
  assert.ok(rawTargets.length > 0, `At least one ${profile} load-test target is required.`);

  const names = new Set();
  for (const rawTarget of rawTargets) {
    const target = mergeTargetBudget(config.load.defaults, rawTarget);
    assert.match(target.name, /^[a-z0-9][a-z0-9-]*$/, `Invalid target name: ${target.name}`);
    assert.ok(!names.has(target.name), `Duplicate target name: ${target.name}`);
    names.add(target.name);
    assert.equal(target.method, 'GET', `${target.name} must remain a read-only GET target.`);
    assert.match(target.path, /^\/(?!\/)/, `${target.name} must use a same-origin path.`);
    assert.ok(!target.path.includes('\\'), `${target.name} must not contain backslashes.`);
    assert.ok(!target.path.includes('#'), `${target.name} must not contain a URL fragment.`);
    const resolvedTarget = new URL(target.path, 'https://performance.invalid');
    assert.equal(resolvedTarget.origin, 'https://performance.invalid', `${target.name} must resolve on the configured origin.`);
    assert.ok(target.weight > 0 && Number.isInteger(target.weight), `${target.name} weight must be a positive integer.`);
    assert.ok(target.minRequests > 0, `${target.name} minRequests must be positive.`);
    assert.ok(target.maxErrorRate >= 0 && target.maxErrorRate <= 1, `${target.name} maxErrorRate must be between 0 and 1.`);
    assert.ok(target.p95TtfbMs <= target.p99TtfbMs, `${target.name} TTFB budgets are inverted.`);
    assert.ok(target.p95TotalMs <= target.p99TotalMs, `${target.name} total-time budgets are inverted.`);
    assert.ok(Array.isArray(target.expectedStatuses) && target.expectedStatuses.length > 0, `${target.name} expectedStatuses are required.`);
    if (target.expectedCacheStatuses) {
      assert.ok(Array.isArray(target.expectedCacheStatuses), `${target.name} expectedCacheStatuses must be an array.`);
      assert.ok(target.expectedCacheStatuses.length > 0, `${target.name} expectedCacheStatuses cannot be empty.`);
    }
    if (profile === 'origin') {
      assert.equal(target.cacheBust, true, `${target.name} must use a unique cache key for origin measurement.`);
    }
  }

  const vitals = config.webVitals;
  assert.equal(vitals?.percentile, 75, 'Core Web Vitals budgets must use the standard P75 view.');
  assert.ok(vitals.LCP > 0 && vitals.INP > 0 && vitals.FCP > 0 && vitals.TTFB > 0, 'Web Vital time budgets must be positive.');
  assert.ok(vitals.CLS > 0 && vitals.CLS <= 0.1, 'CLS budget must be at most 0.1.');
  return rawTargets.map((target) => mergeTargetBudget(config.load.defaults, target));
}

function parseArgs(argv) {
  const options = {
    allowProduction: process.env.PERF_ALLOW_PRODUCTION === '1',
    allowOriginLoad: process.env.PERF_ALLOW_ORIGIN_LOAD === '1',
    baseUrl: process.env.PERF_BASE_URL || DEFAULT_BASE_URL,
    budgetsPath: process.env.PERF_BUDGETS_PATH || DEFAULT_BUDGETS_PATH,
    concurrency: integerOption(process.env.PERF_CONCURRENCY, DEFAULT_CONCURRENCY, 'PERF_CONCURRENCY'),
    durationSeconds: integerOption(process.env.PERF_DURATION_SECONDS, DEFAULT_DURATION_SECONDS, 'PERF_DURATION_SECONDS'),
    maxRps: process.env.PERF_MAX_RPS
      ? numberOption(process.env.PERF_MAX_RPS, null, 'PERF_MAX_RPS')
      : null,
    originNonProductionData: process.env.PERF_ORIGIN_NON_PRODUCTION_DATA === '1',
    outputPath: process.env.PERF_OUTPUT_PATH || null,
    profile: process.env.PERF_PROFILE || 'edge',
    smoke: false,
    warmupRequests: integerOption(process.env.PERF_WARMUP_REQUESTS, DEFAULT_WARMUP_REQUESTS, 'PERF_WARMUP_REQUESTS'),
    selfTest: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--allow-production') {
      options.allowProduction = true;
    } else if (argument === '--allow-origin-load') {
      options.allowOriginLoad = true;
    } else if (argument === '--base-url') {
      options.baseUrl = value;
      index += 1;
    } else if (argument === '--budgets') {
      options.budgetsPath = path.resolve(value);
      index += 1;
    } else if (argument === '--concurrency') {
      options.concurrency = integerOption(value, null, '--concurrency');
      index += 1;
    } else if (argument === '--duration-seconds') {
      options.durationSeconds = integerOption(value, null, '--duration-seconds');
      index += 1;
    } else if (argument === '--max-rps') {
      options.maxRps = numberOption(value, null, '--max-rps');
      index += 1;
    } else if (argument === '--output') {
      options.outputPath = path.resolve(value);
      index += 1;
    } else if (argument === '--profile') {
      options.profile = value;
      index += 1;
    } else if (argument === '--warmup-requests') {
      options.warmupRequests = integerOption(value, null, '--warmup-requests');
      index += 1;
    } else if (argument === '--smoke') {
      options.durationSeconds = 10;
      options.concurrency = 1;
      options.smoke = true;
      options.warmupRequests = 1;
    } else if (argument === '--self-test') {
      options.selfTest = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }

  options.maxRps ??= options.profile === 'origin' ? DEFAULT_ORIGIN_MAX_RPS : DEFAULT_MAX_RPS;
  return options;
}

function validateRunOptions(options) {
  const baseUrl = new URL(options.baseUrl);
  const normalizedHostname = normalizeHostname(baseUrl.hostname);
  const isLocal = LOCAL_HOSTS.has(normalizedHostname);
  const isProduction = PRODUCTION_HOSTS.has(normalizedHostname);
  if (baseUrl.protocol !== 'https:' && !(isLocal && baseUrl.protocol === 'http:')) {
    throw new Error('The load target must use HTTPS, except for an explicit local host.');
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('The base URL must not contain credentials, a query, or a fragment.');
  }
  if (isProduction && !options.allowProduction) {
    throw new Error('Production load requires --allow-production or PERF_ALLOW_PRODUCTION=1.');
  }
  if (!LOAD_PROFILES.has(options.profile)) {
    throw new Error(`Profile must be one of: ${[...LOAD_PROFILES].join(', ')}.`);
  }
  if (options.profile === 'origin' && !options.allowOriginLoad) {
    throw new Error('Origin load requires --allow-origin-load or PERF_ALLOW_ORIGIN_LOAD=1.');
  }
  if (options.profile === 'origin' && isProduction) {
    throw new Error('Cache-bypassing origin load is prohibited against production. Use an isolated local environment.');
  }
  if (options.profile === 'origin' && !isLocal) {
    throw new Error('Cache-bypassing origin load is restricted to localhost.');
  }
  if (options.profile === 'origin' && !options.originNonProductionData) {
    throw new Error('Origin load requires PERF_ORIGIN_NON_PRODUCTION_DATA=1 to acknowledge an isolated non-production dataset.');
  }
  if (options.warmupRequests > MAX_WARMUP_REQUESTS_PER_TARGET) {
    throw new Error(`Warmup requests are capped at ${MAX_WARMUP_REQUESTS_PER_TARGET} per target.`);
  }
  if (process.env.PERF_ALLOW_HIGH_LOAD !== '1') {
    if (options.durationSeconds > MAX_SAFE_DURATION_SECONDS) {
      throw new Error(`Duration is capped at ${MAX_SAFE_DURATION_SECONDS}s. Set PERF_ALLOW_HIGH_LOAD=1 to override intentionally.`);
    }
    if (options.concurrency > MAX_SAFE_CONCURRENCY) {
      throw new Error(`Concurrency is capped at ${MAX_SAFE_CONCURRENCY}. Set PERF_ALLOW_HIGH_LOAD=1 to override intentionally.`);
    }
    if (options.maxRps > MAX_SAFE_RPS) {
      throw new Error(`Request rate is capped at ${MAX_SAFE_RPS} RPS. Set PERF_ALLOW_HIGH_LOAD=1 to override intentionally.`);
    }
    if (options.profile === 'origin' && options.durationSeconds > MAX_SAFE_ORIGIN_DURATION_SECONDS) {
      throw new Error(`Origin duration is capped at ${MAX_SAFE_ORIGIN_DURATION_SECONDS}s. Set PERF_ALLOW_HIGH_LOAD=1 to override intentionally.`);
    }
    if (options.profile === 'origin' && options.concurrency > MAX_SAFE_ORIGIN_CONCURRENCY) {
      throw new Error(`Origin concurrency is capped at ${MAX_SAFE_ORIGIN_CONCURRENCY}. Set PERF_ALLOW_HIGH_LOAD=1 to override intentionally.`);
    }
    if (options.profile === 'origin' && options.maxRps > MAX_SAFE_ORIGIN_RPS) {
      throw new Error(`Origin request rate is capped at ${MAX_SAFE_ORIGIN_RPS} RPS. Set PERF_ALLOW_HIGH_LOAD=1 to override intentionally.`);
    }
  }
  return baseUrl;
}

function targetCycle(targets) {
  return targets.flatMap((target) => Array.from({ length: target.weight }, () => target));
}

function buildWarmupPlan(targets, requestsPerTarget) {
  const plan = [];
  for (const target of targets) {
    for (let count = 0; count < requestsPerTarget; count += 1) {
      if (plan.length >= MAX_TOTAL_WARMUP_REQUESTS) return plan;
      plan.push(target);
    }
  }
  return plan;
}

function createRateLimiter(maxRps) {
  const intervalMs = 1000 / maxRps;
  let nextRequestAt = performance.now();
  return async (deadlineEpochMs = null) => {
    const now = performance.now();
    const scheduledAt = Math.max(now, nextRequestAt);
    const delayMs = scheduledAt - now;
    if (deadlineEpochMs !== null && Date.now() + delayMs >= deadlineEpochMs) {
      return false;
    }
    nextRequestAt = scheduledAt + intervalMs;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return true;
  };
}

async function performRequest(
  baseUrl,
  target,
  warmup = false,
  timeoutMs = target.timeoutMs
) {
  const url = new URL(target.path, baseUrl);
  if (url.origin !== baseUrl.origin) {
    throw new Error(`${target.name} resolved outside the configured origin.`);
  }
  if (target.cacheBust) {
    url.searchParams.set('_perf', `${Date.now()}-${randomUUID()}`);
  }
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      method: target.method,
      // Redirect responses are regressions to measure, not destinations to load.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: target.path.startsWith('/api/') ? 'application/json' : 'text/html,application/xhtml+xml',
        'User-Agent': 'MagicBooklet-Performance-Monitor/1.0',
        'X-Performance-Monitor': warmup ? 'warmup' : 'load',
      },
    });
    const headersAt = performance.now();
    const body = await response.arrayBuffer();
    const finishedAt = performance.now();
    const ageHeader = response.headers.get('age');
    const parsedAge = ageHeader === null ? null : Number(ageHeader);
    return {
      ageSeconds: parsedAge !== null && Number.isFinite(parsedAge) ? parsedAge : null,
      bytes: body.byteLength,
      cacheControl: response.headers.get('cache-control'),
      cacheStatus: response.headers.get('x-vercel-cache')?.toUpperCase() ?? 'MISSING',
      error: null,
      ok: target.expectedStatuses.includes(response.status),
      status: response.status,
      matchedPath: response.headers.get('x-matched-path'),
      totalMs: finishedAt - startedAt,
      ttfbMs: headersAt - startedAt,
    };
  } catch (error) {
    const finishedAt = performance.now();
    return {
      ageSeconds: null,
      bytes: 0,
      cacheControl: null,
      cacheStatus: 'NETWORK_ERROR',
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      ok: false,
      status: null,
      matchedPath: null,
      totalMs: finishedAt - startedAt,
      ttfbMs: finishedAt - startedAt,
    };
  }
}

function summarizeTarget(target, samples, elapsedSeconds) {
  const successful = samples.filter((sample) => sample.ok);
  const failed = samples.filter((sample) => !sample.ok);
  const edgeServed = successful.filter((sample) => ['HIT', 'STALE', 'REVALIDATED'].includes(sample.cacheStatus));
  const originServed = successful.filter((sample) => ['MISS', 'BYPASS'].includes(sample.cacheStatus));
  const statusCounts = {};
  const cacheStatusCounts = {};
  for (const sample of samples) {
    const status = sample.status === null ? 'network-error' : String(sample.status);
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    cacheStatusCounts[sample.cacheStatus] = (cacheStatusCounts[sample.cacheStatus] ?? 0) + 1;
  }

  const result = {
    name: target.name,
    path: target.path,
    requests: samples.length,
    successfulRequests: successful.length,
    failedRequests: failed.length,
    errorRate: samples.length === 0 ? 1 : Number((failed.length / samples.length).toFixed(4)),
    requestsPerSecond: Number((samples.length / elapsedSeconds).toFixed(2)),
    transferredBytes: samples.reduce((sum, sample) => sum + sample.bytes, 0),
    statusCounts,
    cacheStatusCounts,
    cacheTiming: {
      edge: {
        requests: edgeServed.length,
        ttfbMs: summarizeDurations(edgeServed.map((sample) => sample.ttfbMs)),
        totalMs: summarizeDurations(edgeServed.map((sample) => sample.totalMs)),
      },
      origin: {
        requests: originServed.length,
        ttfbMs: summarizeDurations(originServed.map((sample) => sample.ttfbMs)),
        totalMs: summarizeDurations(originServed.map((sample) => sample.totalMs)),
      },
      unclassifiedRequests: successful.length - edgeServed.length - originServed.length,
    },
    cacheAgeSeconds: summarizeDurations(successful.map((sample) => sample.ageSeconds).filter((value) => value !== null)),
    cacheControls: [...new Set(successful.map((sample) => sample.cacheControl).filter(Boolean))],
    matchedPaths: [...new Set(successful.map((sample) => sample.matchedPath).filter(Boolean))],
    ttfbMs: summarizeDurations(successful.map((sample) => sample.ttfbMs)),
    totalMs: summarizeDurations(successful.map((sample) => sample.totalMs)),
    sampleErrors: [...new Set(failed.map((sample) => sample.error).filter(Boolean))].slice(0, 3),
    budget: {
      minRequests: target.minRequests,
      maxErrorRate: target.maxErrorRate,
      p95TtfbMs: target.p95TtfbMs,
      p99TtfbMs: target.p99TtfbMs,
      p95TotalMs: target.p95TotalMs,
      p99TotalMs: target.p99TotalMs,
    },
    violations: [],
  };

  const checks = [
    ['INSUFFICIENT_SAMPLES', result.requests < target.minRequests, `${result.requests} requests < ${target.minRequests}`],
    ['ERROR_RATE', result.errorRate > target.maxErrorRate, `${result.errorRate} > ${target.maxErrorRate}`],
    ['P95_TTFB', result.ttfbMs.p95 === null || result.ttfbMs.p95 > target.p95TtfbMs, `${result.ttfbMs.p95}ms > ${target.p95TtfbMs}ms`],
    ['P99_TTFB', result.ttfbMs.p99 === null || result.ttfbMs.p99 > target.p99TtfbMs, `${result.ttfbMs.p99}ms > ${target.p99TtfbMs}ms`],
    ['P95_TOTAL', result.totalMs.p95 === null || result.totalMs.p95 > target.p95TotalMs, `${result.totalMs.p95}ms > ${target.p95TotalMs}ms`],
    ['P99_TOTAL', result.totalMs.p99 === null || result.totalMs.p99 > target.p99TotalMs, `${result.totalMs.p99}ms > ${target.p99TotalMs}ms`],
  ];
  if (target.expectedCacheStatuses) {
    const unexpected = successful.filter((sample) => (
      !target.expectedCacheStatuses.includes(sample.cacheStatus)
    ));
    checks.push([
      'CACHE_MODE',
      unexpected.length > 0,
      `${unexpected.length} successful request(s) had unexpected cache status`,
    ]);
  }
  result.violations = checks
    .filter(([, failedCheck]) => failedCheck)
    .map(([code, , detail]) => ({ code, detail }));
  return result;
}

function markdownSummary(report) {
  const lines = [
    '## Production performance load test',
    '',
    `Status: **${report.status.toUpperCase()}** · ${report.profile} profile · ${report.totalRequests} requests · ${report.elapsedSeconds}s · concurrency ${report.concurrency} · cap ${report.maxRequestsPerSecond} RPS`,
    '',
    '| Target | Requests | Errors | P95 TTFB | P99 TTFB | P95 total | P99 total | Result |',
    '|---|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const target of report.targets) {
    lines.push(`| ${target.name} | ${target.requests} | ${(target.errorRate * 100).toFixed(2)}% | ${target.ttfbMs.p95 ?? 'n/a'}ms | ${target.ttfbMs.p99 ?? 'n/a'}ms | ${target.totalMs.p95 ?? 'n/a'}ms | ${target.totalMs.p99 ?? 'n/a'}ms | ${target.violations.length === 0 ? 'pass' : 'fail'} |`);
  }
  return `${lines.join('\n')}\n`;
}

async function runSelfTest(budgetsPath) {
  const config = JSON.parse(await readFile(budgetsPath, 'utf8'));
  const targets = validateBudgets(config, 'edge');
  const originTargets = validateBudgets(config, 'origin');
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 99), 4);
  assert.equal(summarizeDurations([10, 20, 30, 40]).p95, 40);
  assert.ok(targets.every((target) => target.method === 'GET'));
  assert.ok(originTargets.every((target) => target.method === 'GET' && target.cacheBust));
  assert.equal(
    buildWarmupPlan(Array.from({ length: 100 }, (_, index) => ({ name: `target-${index}` })), 3).length,
    MAX_TOTAL_WARMUP_REQUESTS,
  );
  const deadlineLimiter = createRateLimiter(0.001);
  assert.equal(await deadlineLimiter(), true);
  assert.equal(await deadlineLimiter(Date.now() + 1), false);
  const unsafeConfig = structuredClone(config);
  unsafeConfig.load.targets[0].path = '/\\evil.example/performance';
  assert.throws(() => validateBudgets(unsafeConfig, 'edge'), /backslashes/);
  for (const baseUrl of [DEFAULT_BASE_URL, 'https://magicbooklet.com.']) {
    assert.throws(
      () => validateRunOptions({
        allowProduction: true,
        allowOriginLoad: true,
        baseUrl,
        concurrency: 1,
        durationSeconds: 10,
        maxRps: 1,
        profile: 'origin',
      }),
      /prohibited against production/,
    );
  }
  assert.throws(
    () => validateRunOptions({
      allowProduction: false,
      allowOriginLoad: true,
      baseUrl: 'https://preview.example',
      concurrency: 1,
      durationSeconds: 10,
      maxRps: 1,
      originNonProductionData: false,
      profile: 'origin',
    }),
    /restricted to localhost/,
  );
  assert.throws(
    () => validateRunOptions({
      allowProduction: false,
      allowOriginLoad: true,
      baseUrl: 'http://localhost:3000',
      concurrency: 1,
      durationSeconds: 10,
      maxRps: 1,
      profile: 'origin',
    }),
    /non-production dataset/,
  );
  assert.throws(
    () => validateRunOptions({
      allowProduction: false,
      allowOriginLoad: false,
      baseUrl: 'http://localhost:3000',
      concurrency: 1,
      durationSeconds: 10,
      maxRps: 1,
      profile: 'edge',
      warmupRequests: MAX_WARMUP_REQUESTS_PER_TARGET + 1,
    }),
    /Warmup requests are capped/,
  );
  console.log(`Performance load-test self-check passed for ${targets.length} edge and ${originTargets.length} origin read-only targets.`);
}

async function runLoadTest(options) {
  const baseUrl = validateRunOptions(options);
  const config = JSON.parse(await readFile(options.budgetsPath, 'utf8'));
  const isLocalOrigin = options.profile === 'origin'
    && LOCAL_HOSTS.has(normalizeHostname(baseUrl.hostname));
  const targets = validateBudgets(config, options.profile).map((target) => {
    const expectedCacheStatuses = isLocalOrigin && target.expectedCacheStatuses
      ? [...new Set([...target.expectedCacheStatuses, 'MISSING'])]
      : target.expectedCacheStatuses;
    return {
      ...target,
      ...(options.smoke ? { minRequests: 1 } : {}),
      ...(expectedCacheStatuses ? { expectedCacheStatuses } : {}),
    };
  });

  const reserveRateSlot = createRateLimiter(options.maxRps);
  const warmupPlan = buildWarmupPlan(targets, options.warmupRequests);
  const warmupStartedAt = Date.now();
  const warmupDeadline = warmupStartedAt + MAX_WARMUP_DURATION_MS;
  let completedWarmupRequests = 0;
  let warmupDeadlineReached = false;
  console.log(`Warming ${targets.length} targets with ${warmupPlan.length} bounded request(s)...`);
  for (const target of warmupPlan) {
    if (!await reserveRateSlot(warmupDeadline)) {
      warmupDeadlineReached = true;
      break;
    }
    const remainingWarmupMs = warmupDeadline - Date.now();
    if (remainingWarmupMs <= 0) {
      warmupDeadlineReached = true;
      break;
    }
    await performRequest(
      baseUrl,
      target,
      true,
      Math.max(1, Math.min(
        target.timeoutMs,
        MAX_WARMUP_REQUEST_TIMEOUT_MS,
        remainingWarmupMs
      ))
    );
    completedWarmupRequests += 1;
  }
  if (warmupDeadlineReached) {
    console.warn(`Warmup stopped at its ${MAX_WARMUP_DURATION_MS / 1000}s safety deadline.`);
  }
  const warmupElapsedSeconds = Number(((Date.now() - warmupStartedAt) / 1000).toFixed(2));

  const samplesByName = new Map(targets.map((target) => [target.name, []]));
  const cycle = targetCycle(targets);
  let requestIndex = 0;
  const startedAt = Date.now();
  const deadline = startedAt + (options.durationSeconds * 1000);

  async function worker() {
    while (Date.now() < deadline) {
      if (!await reserveRateSlot(deadline)) return;
      if (Date.now() >= deadline) return;
      const target = cycle[requestIndex % cycle.length];
      requestIndex += 1;
      const sample = await performRequest(baseUrl, target);
      samplesByName.get(target.name).push(sample);
    }
  }

  console.log(`Running bounded ${options.profile} load for ${options.durationSeconds}s at concurrency ${options.concurrency}, capped at ${options.maxRps} RPS, against ${baseUrl.origin}...`);
  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));

  const finishedAt = Date.now();
  const elapsedSeconds = Number(((finishedAt - startedAt) / 1000).toFixed(2));
  const targetResults = targets.map((target) => (
    summarizeTarget(target, samplesByName.get(target.name), elapsedSeconds)
  ));
  const violations = targetResults.flatMap((target) => (
    target.violations.map((violation) => ({ target: target.name, ...violation }))
  ));
  const report = {
    schemaVersion: 1,
    status: violations.length === 0 ? 'passed' : 'failed',
    profile: options.profile,
    baseUrl: baseUrl.origin,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    elapsedSeconds,
    requestedDurationSeconds: options.durationSeconds,
    concurrency: options.concurrency,
    maxRequestsPerSecond: options.maxRps,
    warmup: {
      requestedPerTarget: options.warmupRequests,
      completedRequests: completedWarmupRequests,
      elapsedSeconds: warmupElapsedSeconds,
      deadlineReached: warmupDeadlineReached,
    },
    totalRequests: targetResults.reduce((sum, target) => sum + target.requests, 0),
    totalTransferredBytes: targetResults.reduce((sum, target) => sum + target.transferredBytes, 0),
    violations,
    targets: targetResults,
  };

  console.table(targetResults.map((target) => ({
    target: target.name,
    requests: target.requests,
    errorRate: `${(target.errorRate * 100).toFixed(2)}%`,
    p95TtfbMs: target.ttfbMs.p95,
    p99TtfbMs: target.ttfbMs.p99,
    p95TotalMs: target.totalMs.p95,
    p99TotalMs: target.totalMs.p99,
    cache: Object.entries(target.cacheStatusCounts).map(([key, value]) => `${key}:${value}`).join(','),
    result: target.violations.length === 0 ? 'pass' : 'FAIL',
  })));

  if (options.outputPath) {
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Wrote detailed results to ${options.outputPath}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, markdownSummary(report));
  }
  if (violations.length > 0) {
    console.error('Performance budget violations:');
    for (const violation of violations) {
      console.error(`- ${violation.target} ${violation.code}: ${violation.detail}`);
    }
    process.exitCode = 1;
  }
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    await runSelfTest(options.budgetsPath);
    return;
  }
  await runLoadTest(options);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
