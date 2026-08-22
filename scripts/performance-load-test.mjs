#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  brotliCompressSync,
  brotliDecompress,
  gunzip,
  gzipSync,
  inflate,
} from 'node:zlib';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BUDGETS_PATH = path.join(PROJECT_ROOT, 'config', 'performance-budgets.json');
const DEFAULT_BASE_URL = 'https://magicbooklet.com';
const DEFAULT_DURATION_SECONDS = 30;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_RPS = 25;
const DEFAULT_ORIGIN_MAX_RPS = 2;
const DEFAULT_WARMUP_REQUESTS = 2;
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const MAX_AUTH_RESPONSE_BODY_BYTES = 64 * 1024;
const MAX_WARMUP_REQUESTS_PER_TARGET = 3;
const MAX_TOTAL_WARMUP_REQUESTS = 15;
const MAX_WARMUP_DURATION_MS = 30_000;
const MAX_WARMUP_REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SAFE_DURATION_SECONDS = 300;
const MAX_SAFE_CONCURRENCY = 20;
const MAX_SAFE_RPS = 50;
const MAX_SAFE_ORIGIN_DURATION_SECONDS = 60;
const MAX_SAFE_ORIGIN_CONCURRENCY = 2;
const MAX_SAFE_ORIGIN_RPS = 2;
const LOAD_PROFILES = new Set(['edge', 'origin']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const PRODUCTION_HOSTS = new Set(['magicbooklet.com', 'www.magicbooklet.com']);
const SUPPORTED_CONTENT_ENCODINGS = new Set(['br', 'deflate', 'gzip', 'identity']);
const brotliDecompressAsync = promisify(brotliDecompress);
const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);

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

export function validateBudgets(config, profile = 'edge', { includeSignedIn = false } = {}) {
  assert.equal(config?.version, 1, 'Performance budget version must be 1.');
  assert.ok(config?.load?.defaults, 'Load-test defaults are required.');
  assert.ok(LOAD_PROFILES.has(profile), `Unsupported load profile: ${profile}`);
  const rawTargets = profile === 'origin' ? config?.load?.originTargets : config?.load?.targets;
  assert.ok(Array.isArray(rawTargets), `${profile} load-test targets are required.`);
  assert.ok(rawTargets.length > 0, `At least one ${profile} load-test target is required.`);
  const rawSignedInTargets = profile === 'edge' ? config?.load?.signedInTargets : [];
  if (profile === 'edge') {
    assert.ok(Array.isArray(rawSignedInTargets), 'edge signed-in load-test targets are required.');
    assert.ok(rawSignedInTargets.length > 0, 'At least one signed-in edge target is required.');
  }

  const names = new Set();
  for (const [rawTarget, expectedAudience] of [
    ...rawTargets.map((target) => [target, 'signed-out']),
    ...rawSignedInTargets.map((target) => [target, 'signed-in']),
  ]) {
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
    assert.ok(Number.isFinite(target.p95EncodedBodyBytes) && target.p95EncodedBodyBytes > 0, `${target.name} p95EncodedBodyBytes must be positive.`);
    assert.ok(Number.isFinite(target.p95DecodedBytes) && target.p95DecodedBytes > 0, `${target.name} p95DecodedBytes must be positive.`);
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
    if (expectedAudience === 'signed-in') {
      assert.equal(target.auth, 'bearer', `${target.name} must explicitly require bearer authentication.`);
      assert.ok(
        Number.isInteger(target.maxRequestsPerRun) && target.maxRequestsPerRun >= target.minRequests,
        `${target.name} maxRequestsPerRun must be an integer at least as large as minRequests.`,
      );
    } else {
      assert.equal(target.auth, undefined, `${target.name} must remain signed out.`);
    }
  }

  const vitals = config.webVitals;
  assert.equal(vitals?.percentile, 75, 'Core Web Vitals budgets must use the standard P75 view.');
  assert.ok(vitals.LCP > 0 && vitals.INP > 0 && vitals.FCP > 0 && vitals.TTFB > 0, 'Web Vital time budgets must be positive.');
  assert.ok(vitals.CLS > 0 && vitals.CLS <= 0.1, 'CLS budget must be at most 0.1.');
  const selectedTargets = includeSignedIn
    ? [...rawTargets, ...rawSignedInTargets]
    : rawTargets;
  return selectedTargets.map((target) => mergeTargetBudget(config.load.defaults, target));
}

function parseBearerToken(value) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.trim() !== value || /[\r\n]/.test(value)) {
    throw new Error('PERF_AUTH_BEARER_TOKEN must be a bare token without surrounding whitespace or line breaks.');
  }
  if (/^Bearer\s/i.test(value)) {
    throw new Error('PERF_AUTH_BEARER_TOKEN must contain only the token, without the Bearer prefix.');
  }
  if (/\s/.test(value)) {
    throw new Error('PERF_AUTH_BEARER_TOKEN must be a bare token without whitespace.');
  }
  return value;
}

function parseSingleLineAuthValue(value, name) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.trim() !== value || /\s/.test(value)) {
    throw new Error(`${name} must be a non-empty value without whitespace or line breaks.`);
  }
  return value;
}

function parseAuthPassword(value) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) {
    throw new Error('PERF_AUTH_BOT_PASSWORD must be non-empty and cannot contain line breaks or null bytes.');
  }
  return value;
}

function booleanOption(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  if (value === '1') return true;
  if (value === '0') return false;
  throw new Error(`${name} must be 0 or 1.`);
}

function parseArgs(argv) {
  const options = {
    allowProduction: process.env.PERF_ALLOW_PRODUCTION === '1',
    allowOriginLoad: process.env.PERF_ALLOW_ORIGIN_LOAD === '1',
    authBearerToken: parseBearerToken(process.env.PERF_AUTH_BEARER_TOKEN),
    authBotEmail: parseSingleLineAuthValue(process.env.PERF_AUTH_BOT_EMAIL, 'PERF_AUTH_BOT_EMAIL'),
    authBotPassword: parseAuthPassword(process.env.PERF_AUTH_BOT_PASSWORD),
    authSupabaseAnonKey: parseSingleLineAuthValue(
      process.env.PERF_AUTH_SUPABASE_ANON_KEY,
      'PERF_AUTH_SUPABASE_ANON_KEY',
    ),
    authSupabaseUrl: parseSingleLineAuthValue(
      process.env.PERF_AUTH_SUPABASE_URL,
      'PERF_AUTH_SUPABASE_URL',
    ),
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
    requireSignedIn: booleanOption(
      process.env.PERF_REQUIRE_SIGNED_IN,
      false,
      'PERF_REQUIRE_SIGNED_IN',
    ),
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
    } else if (argument === '--require-signed-in') {
      options.requireSignedIn = true;
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
  if (options.profile !== 'edge' && options.requireSignedIn) {
    throw new Error('Signed-in coverage can only be required for the edge profile.');
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

function validateAuthConfiguration(options) {
  const credentials = [
    options.authSupabaseUrl,
    options.authSupabaseAnonKey,
    options.authBotEmail,
    options.authBotPassword,
  ];
  const suppliedCredentialCount = credentials.filter(Boolean).length;
  if (suppliedCredentialCount > 0 && suppliedCredentialCount < credentials.length) {
    throw new Error(
      'PERF_AUTH_SUPABASE_URL, PERF_AUTH_SUPABASE_ANON_KEY, PERF_AUTH_BOT_EMAIL, and PERF_AUTH_BOT_PASSWORD must be supplied together.',
    );
  }
  if (options.authBearerToken && suppliedCredentialCount > 0) {
    throw new Error('Configure either PERF_AUTH_BEARER_TOKEN or the performance bot credentials, not both.');
  }
  return { hasBotCredentials: suppliedCredentialCount === credentials.length };
}

function parseSupabaseAuthUrl(value) {
  let authUrl;
  try {
    authUrl = new URL(value);
  } catch {
    throw new Error('PERF_AUTH_SUPABASE_URL must be a valid absolute HTTPS URL.');
  }
  if (
    authUrl.protocol !== 'https:'
    || authUrl.username
    || authUrl.password
    || authUrl.search
    || authUrl.hash
    || (authUrl.pathname !== '/' && authUrl.pathname !== '')
  ) {
    throw new Error('PERF_AUTH_SUPABASE_URL must be an HTTPS origin without credentials, a path, query, or fragment.');
  }
  return authUrl;
}

async function readBoundedAuthResponse(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AUTH_RESPONSE_BODY_BYTES) {
    await response.body?.cancel();
    throw new Error('Performance bot sign-in returned an oversized response.');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_AUTH_RESPONSE_BODY_BYTES) {
        await reader.cancel();
        throw new Error('Performance bot sign-in returned an oversized response.');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function resolveAuthBearerToken(options, fetchImpl = globalThis.fetch) {
  const { hasBotCredentials } = validateAuthConfiguration(options);
  if (options.authBearerToken) return options.authBearerToken;
  if (!hasBotCredentials) {
    if (options.requireSignedIn) {
      throw new Error(
        'Signed-in coverage is required, but the performance bot credentials are not configured.',
      );
    }
    return null;
  }

  const authUrl = parseSupabaseAuthUrl(options.authSupabaseUrl);
  const tokenUrl = new URL('/auth/v1/token?grant_type=password', authUrl);
  let response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        apikey: options.authSupabaseAnonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: options.authBotEmail,
        password: options.authBotPassword,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(DEFAULT_AUTH_TIMEOUT_MS),
    });
  } catch {
    throw new Error('Performance bot sign-in request failed before receiving a response.');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Performance bot sign-in failed with HTTP ${response.status}.`);
  }

  let payload;
  try {
    payload = JSON.parse(await readBoundedAuthResponse(response));
  } catch (error) {
    if (error instanceof Error && error.message === 'Performance bot sign-in returned an oversized response.') {
      throw error;
    }
    throw new Error('Performance bot sign-in returned an invalid response.');
  }
  const accessToken = payload?.access_token;
  if (
    typeof accessToken !== 'string'
    || accessToken.length === 0
    || /\s/.test(accessToken)
    || typeof payload?.user?.id !== 'string'
    || payload.user.id.length === 0
  ) {
    throw new Error('Performance bot sign-in did not return a valid user session.');
  }
  return accessToken;
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

function responseHeader(headers, name) {
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : value ?? null;
}

function normalizedContentEncodings(value) {
  const encodings = (value ?? 'identity')
    .split(',')
    .map((encoding) => encoding.trim().toLowerCase())
    .filter(Boolean);
  return encodings.length > 0 ? encodings : ['identity'];
}

export function parseServerTiming(value) {
  if (!value) return null;
  const timings = {};
  for (const entry of value.split(',')) {
    const match = entry.trim().match(/^([a-z0-9-]+)\s*;\s*dur=(\d+(?:\.\d+)?)$/i);
    if (!match) continue;
    const durationMs = Number(match[2]);
    if (Number.isFinite(durationMs)) timings[match[1].toLowerCase()] = durationMs;
  }
  return Object.keys(timings).length > 0 ? timings : null;
}

async function decodeResponseBody(body, contentEncodingHeader) {
  const encodings = normalizedContentEncodings(contentEncodingHeader);
  let decoded = body;
  for (const encoding of [...encodings].reverse()) {
    if (!SUPPORTED_CONTENT_ENCODINGS.has(encoding)) {
      throw new Error(`Unsupported response content encoding: ${encoding}`);
    }
    if (encoding === 'br') decoded = await brotliDecompressAsync(decoded);
    if (encoding === 'gzip') decoded = await gunzipAsync(decoded);
    if (encoding === 'deflate') decoded = await inflateAsync(decoded);
  }
  return {
    decoded,
    contentEncoding: encodings.join(','),
  };
}

function failedSample(error, startedAt) {
  const finishedAt = performance.now();
  return {
    ageSeconds: null,
    cacheControl: null,
    cacheStatus: 'NETWORK_ERROR',
    contentEncoding: null,
    decodedBodyBytes: 0,
    encodedBodyBytes: 0,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    ok: false,
    status: null,
    matchedPath: null,
    serverTiming: null,
    totalMs: finishedAt - startedAt,
    ttfbMs: finishedAt - startedAt,
  };
}

function createRequestHeaders(target, authBearerToken, warmup) {
  return {
    Accept: target.path.startsWith('/api/') ? 'application/json' : 'text/html,application/xhtml+xml',
    'Accept-Encoding': 'br, gzip, deflate',
    ...(target.auth === 'bearer' ? { Authorization: `Bearer ${authBearerToken}` } : {}),
    'User-Agent': 'MagicBooklet-Performance-Monitor/2.0',
    'X-Performance-Monitor': warmup ? 'warmup' : 'load',
  };
}

async function performRequest(
  baseUrl,
  target,
  authBearerToken,
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
  if (target.auth === 'bearer' && !authBearerToken) {
    throw new Error(`Authenticated target ${target.name} was selected without an authentication secret.`);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (sample) => {
      if (settled) return;
      settled = true;
      resolve(sample);
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: target.method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: createRequestHeaders(target, authBearerToken, warmup),
    }, (response) => {
      const headersAt = performance.now();
      const chunks = [];
      let encodedBodyBytes = 0;
      response.on('data', (chunk) => {
        if (settled) return;
        const buffer = Buffer.from(chunk);
        encodedBodyBytes += buffer.byteLength;
        if (encodedBodyBytes > MAX_RESPONSE_BODY_BYTES) {
          request.destroy();
          finish(failedSample(new Error(`Response body exceeded the ${MAX_RESPONSE_BODY_BYTES}-byte safety cap.`), startedAt));
          return;
        }
        chunks.push(buffer);
      });
      response.on('aborted', () => finish(failedSample(new Error('Response aborted before completion.'), startedAt)));
      response.on('error', (error) => finish(failedSample(error, startedAt)));
      response.on('end', async () => {
        try {
          const encodedBody = Buffer.concat(chunks);
          const contentEncodingHeader = responseHeader(response.headers, 'content-encoding');
          const { decoded, contentEncoding } = await decodeResponseBody(encodedBody, contentEncodingHeader);
          const finishedAt = performance.now();
          const ageHeader = responseHeader(response.headers, 'age');
          const parsedAge = ageHeader === null ? null : Number(ageHeader);
          finish({
            ageSeconds: parsedAge !== null && Number.isFinite(parsedAge) ? parsedAge : null,
            cacheControl: responseHeader(response.headers, 'cache-control'),
            cacheStatus: responseHeader(response.headers, 'x-vercel-cache')?.toUpperCase() ?? 'MISSING',
            contentEncoding,
            decodedBodyBytes: decoded.byteLength,
            encodedBodyBytes: encodedBody.byteLength,
            error: null,
            ok: target.expectedStatuses.includes(response.statusCode),
            status: response.statusCode,
            matchedPath: responseHeader(response.headers, 'x-matched-path'),
            serverTiming: parseServerTiming(
              responseHeader(response.headers, 'x-scaling-certification-timing')
                ?? responseHeader(response.headers, 'server-timing'),
            ),
            totalMs: finishedAt - startedAt,
            ttfbMs: headersAt - startedAt,
          });
        } catch (error) {
          finish(failedSample(error, startedAt));
        }
      });
    });
    request.on('error', (error) => finish(failedSample(error, startedAt)));
    request.end();
  });
}

function summarizeTarget(target, samples, elapsedSeconds) {
  const successful = samples.filter((sample) => sample.ok);
  const failed = samples.filter((sample) => !sample.ok);
  const edgeServed = successful.filter((sample) => ['HIT', 'STALE', 'REVALIDATED'].includes(sample.cacheStatus));
  const originServed = successful.filter((sample) => ['MISS', 'BYPASS'].includes(sample.cacheStatus));
  const statusCounts = {};
  const cacheStatusCounts = {};
  const contentEncodingCounts = {};
  const serverTimingSamples = {};
  for (const sample of samples) {
    const status = sample.status === null ? 'network-error' : String(sample.status);
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    cacheStatusCounts[sample.cacheStatus] = (cacheStatusCounts[sample.cacheStatus] ?? 0) + 1;
    if (sample.contentEncoding) {
      contentEncodingCounts[sample.contentEncoding] = (contentEncodingCounts[sample.contentEncoding] ?? 0) + 1;
    }
    if (sample.ok) {
      for (const [phase, durationMs] of Object.entries(sample.serverTiming ?? {})) {
        (serverTimingSamples[phase] ??= []).push(durationMs);
      }
    }
  }

  const serverTimings = Object.fromEntries(
    Object.entries(serverTimingSamples)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([phase, durations]) => [phase, {
        requests: durations.length,
        durationMs: summarizeDurations(durations),
      }]),
  );

  const result = {
    name: target.name,
    path: target.path,
    audience: target.auth === 'bearer' ? 'signed-in' : 'signed-out',
    requests: samples.length,
    successfulRequests: successful.length,
    failedRequests: failed.length,
    errorRate: samples.length === 0 ? 1 : Number((failed.length / samples.length).toFixed(4)),
    requestsPerSecond: Number((samples.length / elapsedSeconds).toFixed(2)),
    totalEncodedBodyBytes: samples.reduce((sum, sample) => sum + sample.encodedBodyBytes, 0),
    totalDecodedBodyBytes: samples.reduce((sum, sample) => sum + sample.decodedBodyBytes, 0),
    encodedBodyBytes: summarizeDurations(successful.map((sample) => sample.encodedBodyBytes)),
    decodedBytes: summarizeDurations(successful.map((sample) => sample.decodedBodyBytes)),
    statusCounts,
    cacheStatusCounts,
    contentEncodingCounts,
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
    serverTimings,
    ttfbMs: summarizeDurations(successful.map((sample) => sample.ttfbMs)),
    totalMs: summarizeDurations(successful.map((sample) => sample.totalMs)),
    sampleErrors: [...new Set(failed.map((sample) => sample.error).filter(Boolean))].slice(0, 3),
    budget: {
      minRequests: target.minRequests,
      maxRequestsPerRun: target.maxRequestsPerRun ?? null,
      maxErrorRate: target.maxErrorRate,
      p95EncodedBodyBytes: target.p95EncodedBodyBytes,
      p95DecodedBytes: target.p95DecodedBytes,
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
    ['P95_ENCODED_BODY_BYTES', result.encodedBodyBytes.p95 === null || result.encodedBodyBytes.p95 > target.p95EncodedBodyBytes, `${result.encodedBodyBytes.p95} bytes > ${target.p95EncodedBodyBytes} bytes`],
    ['P95_DECODED_BYTES', result.decodedBytes.p95 === null || result.decodedBytes.p95 > target.p95DecodedBytes, `${result.decodedBytes.p95} bytes > ${target.p95DecodedBytes} bytes`],
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

function buildCertificationCoverage(targetResults, { includeSignedIn, profile }) {
  const signedOutResults = targetResults.filter((target) => target.audience === 'signed-out');
  const signedInResults = targetResults.filter((target) => target.audience === 'signed-in');
  const hasViolations = targetResults.some((target) => target.violations.length > 0);
  const signedInSkipReason = profile === 'edge'
    ? 'Signed-in authentication was not requested for this ad-hoc run.'
    : 'Signed-in targets are certified by the edge profile and were not part of this origin run.';
  return {
    certificationStatus: hasViolations
      ? 'failed'
      : includeSignedIn ? 'certified' : 'not-certified',
    coverage: {
      signedOut: {
        status: signedOutResults.some((target) => target.violations.length > 0) ? 'failed' : 'passed',
        targetCount: signedOutResults.length,
      },
      signedIn: {
        status: !includeSignedIn
          ? 'not-certified'
          : signedInResults.some((target) => target.violations.length > 0) ? 'failed' : 'passed',
        targetCount: signedInResults.length,
        ...(!includeSignedIn ? { reason: signedInSkipReason } : {}),
      },
      encodedBodyBytes: {
        status: 'enforced',
        definition: 'Raw response body bytes before Content-Encoding decompression; excludes HTTP headers and framing.',
      },
    },
  };
}

function markdownSummary(report) {
  const lines = [
    '## Production performance load test',
    '',
    `Status: **${report.status.toUpperCase()}** · ${report.profile} profile · ${report.totalRequests} requests · ${report.elapsedSeconds}s · concurrency ${report.concurrency} · cap ${report.maxRequestsPerSecond} RPS`,
    '',
    `Certification: **${report.certificationStatus.toUpperCase()}** · signed-out ${report.coverage.signedOut.status} · signed-in ${report.coverage.signedIn.status} · encoded-body budget enforced`,
    '',
    '| Target | Audience | Requests | Errors | P95 encoded body | P95 decoded | P95 TTFB | P99 TTFB | P95 total | P99 total | Result |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const target of report.targets) {
    lines.push(`| ${target.name} | ${target.audience} | ${target.requests} | ${(target.errorRate * 100).toFixed(2)}% | ${target.encodedBodyBytes.p95 ?? 'n/a'} B | ${target.decodedBytes.p95 ?? 'n/a'} B | ${target.ttfbMs.p95 ?? 'n/a'}ms | ${target.ttfbMs.p99 ?? 'n/a'}ms | ${target.totalMs.p95 ?? 'n/a'}ms | ${target.totalMs.p99 ?? 'n/a'}ms | ${target.violations.length === 0 ? 'pass' : 'fail'} |`);
  }
  return `${lines.join('\n')}\n`;
}

async function runSelfTest(budgetsPath) {
  const config = JSON.parse(await readFile(budgetsPath, 'utf8'));
  const targets = validateBudgets(config, 'edge');
  const targetsWithSignedIn = validateBudgets(config, 'edge', { includeSignedIn: true });
  const signedInTargets = targetsWithSignedIn.filter((target) => target.auth === 'bearer');
  const originTargets = validateBudgets(config, 'origin');
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 99), 4);
  assert.equal(summarizeDurations([10, 20, 30, 40]).p95, 40);
  assert.deepEqual(
    parseServerTiming('auth;dur=12.50, invalid, feed-total;dur=101.25'),
    { auth: 12.5, 'feed-total': 101.25 },
  );
  assert.ok(targets.every((target) => target.method === 'GET'));
  assert.ok(targets.every((target) => target.auth === undefined));
  assert.ok(targets.every((target) => target.p95EncodedBodyBytes > 0));
  assert.ok(targets.every((target) => target.p95DecodedBytes > 0));
  assert.ok(signedInTargets.length > 0);
  assert.ok(signedInTargets.every((target) => target.maxRequestsPerRun >= target.minRequests));
  assert.ok(originTargets.every((target) => target.method === 'GET' && target.cacheBust));
  assert.ok(originTargets.every((target) => target.p95EncodedBodyBytes > 0));
  assert.ok(originTargets.every((target) => target.p95DecodedBytes > 0));
  assert.ok([
    ...targets,
    ...signedInTargets,
    ...originTargets,
  ].every((target) => target.p95DecodedBytes <= MAX_RESPONSE_BODY_BYTES));
  const bodyFixture = Buffer.from('encoded-body-measurement\n'.repeat(100));
  const gzipFixture = gzipSync(bodyFixture);
  const gzipDecoded = await decodeResponseBody(gzipFixture, 'gzip');
  const brotliDecoded = await decodeResponseBody(brotliCompressSync(bodyFixture), 'br');
  assert.deepEqual(gzipDecoded.decoded, bodyFixture);
  assert.deepEqual(brotliDecoded.decoded, bodyFixture);
  assert.ok(gzipFixture.byteLength < bodyFixture.byteLength);
  assert.equal(parseBearerToken(undefined), null);
  assert.equal(parseBearerToken('header.payload.signature'), 'header.payload.signature');
  assert.throws(() => parseBearerToken('Bearer token'), /without the Bearer prefix/);
  assert.throws(() => parseBearerToken('token\n'), /without surrounding whitespace/);
  assert.throws(() => parseBearerToken('two tokens'), /without whitespace/);
  assert.equal(
    createRequestHeaders(signedInTargets[0], 'self-test-token', false).Authorization,
    'Bearer self-test-token',
  );
  assert.equal(createRequestHeaders(targets[0], null, false).Authorization, undefined);
  const botAuthOptions = {
    authBearerToken: null,
    authBotEmail: 'performance-bot@example.com',
    authBotPassword: 'self-test-password',
    authSupabaseAnonKey: 'self-test-anon-key',
    authSupabaseUrl: 'https://project.supabase.co',
    requireSignedIn: true,
  };
  let capturedAuthRequest = null;
  const freshBotToken = await resolveAuthBearerToken(botAuthOptions, async (url, init) => {
    capturedAuthRequest = { url: String(url), init };
    return new Response(JSON.stringify({
      access_token: 'fresh.self-test.token',
      user: { id: '00000000-0000-4000-8000-000000000001' },
    }), { status: 200 });
  });
  assert.equal(freshBotToken, 'fresh.self-test.token');
  assert.equal(
    capturedAuthRequest.url,
    'https://project.supabase.co/auth/v1/token?grant_type=password',
  );
  assert.equal(capturedAuthRequest.init.method, 'POST');
  assert.equal(capturedAuthRequest.init.headers.apikey, 'self-test-anon-key');
  assert.deepEqual(JSON.parse(capturedAuthRequest.init.body), {
    email: 'performance-bot@example.com',
    password: 'self-test-password',
  });
  let manualBearerFetchCalled = false;
  assert.equal(await resolveAuthBearerToken({
    ...botAuthOptions,
    authBearerToken: 'manual.self-test.token',
    authBotEmail: null,
    authBotPassword: null,
    authSupabaseAnonKey: null,
    authSupabaseUrl: null,
  }, async () => {
    manualBearerFetchCalled = true;
    throw new Error('unreachable');
  }), 'manual.self-test.token');
  assert.equal(manualBearerFetchCalled, false);
  await assert.rejects(
    resolveAuthBearerToken({
      ...botAuthOptions,
      authBotPassword: null,
    }),
    /performance bot credentials are not configured|must be supplied together/,
  );
  await assert.rejects(
    resolveAuthBearerToken(botAuthOptions, async () => new Response(
      'x'.repeat(MAX_AUTH_RESPONSE_BODY_BYTES + 1),
      { status: 200 },
    )),
    /oversized response/,
  );
  const secretFixture = 'must-never-appear-in-an-error';
  await assert.rejects(
    resolveAuthBearerToken({
      ...botAuthOptions,
      authBotPassword: secretFixture,
    }, async () => new Response('sign-in rejected', { status: 401 })),
    (error) => {
      assert.match(error.message, /HTTP 401/);
      assert.ok(!error.message.includes(secretFixture));
      return true;
    },
  );
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
  const missingDecodedBudgetConfig = structuredClone(config);
  delete missingDecodedBudgetConfig.load.defaults.p95DecodedBytes;
  assert.throws(() => validateBudgets(missingDecodedBudgetConfig, 'edge'), /p95DecodedBytes must be positive/);
  const missingEncodedBudgetConfig = structuredClone(config);
  delete missingEncodedBudgetConfig.load.defaults.p95EncodedBodyBytes;
  assert.throws(() => validateBudgets(missingEncodedBudgetConfig, 'edge'), /p95EncodedBodyBytes must be positive/);
  const bodyBudgetResult = summarizeTarget({
    ...targets[0],
    minRequests: 1,
    p95DecodedBytes: 200,
    p95EncodedBodyBytes: 100,
  }, [{
    ageSeconds: null,
    cacheControl: null,
    cacheStatus: 'HIT',
    contentEncoding: 'gzip',
    decodedBodyBytes: 151,
    encodedBodyBytes: 101,
    error: null,
    matchedPath: null,
    ok: true,
    status: 200,
    totalMs: 1,
    ttfbMs: 1,
  }], 1);
  assert.equal(bodyBudgetResult.encodedBodyBytes.p95, 101);
  assert.equal(bodyBudgetResult.decodedBytes.p95, 151);
  assert.ok(bodyBudgetResult.violations.some(({ code }) => code === 'P95_ENCODED_BODY_BYTES'));
  assert.ok(!bodyBudgetResult.violations.some(({ code }) => code === 'P95_DECODED_BYTES'));
  const missingAuthCoverage = buildCertificationCoverage([{ ...bodyBudgetResult, violations: [] }], {
    includeSignedIn: false,
    profile: 'edge',
  });
  assert.equal(missingAuthCoverage.certificationStatus, 'not-certified');
  assert.equal(missingAuthCoverage.coverage.signedOut.status, 'passed');
  assert.equal(missingAuthCoverage.coverage.signedIn.status, 'not-certified');
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
  console.log(`Performance load-test self-check passed for ${targets.length} signed-out edge, ${signedInTargets.length} signed-in edge, and ${originTargets.length} origin read-only targets.`);
}

async function runLoadTest(options) {
  const baseUrl = validateRunOptions(options);
  const config = JSON.parse(await readFile(options.budgetsPath, 'utf8'));
  // Validate every declared edge target before contacting the auth service.
  validateBudgets(config, options.profile);
  const isLocalOrigin = options.profile === 'origin'
    && LOCAL_HOSTS.has(normalizeHostname(baseUrl.hostname));
  const authBearerToken = options.profile === 'edge'
    ? await resolveAuthBearerToken(options)
    : null;
  const includeSignedIn = options.profile === 'edge' && Boolean(authBearerToken);
  if (options.profile === 'edge' && !includeSignedIn) {
    console.warn('Signed-in feed target skipped for this ad-hoc run. This run cannot certify signed-in coverage.');
  }
  const targets = validateBudgets(config, options.profile, { includeSignedIn }).map((target) => {
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
      authBearerToken,
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
  const requestReservations = new Map(targets.map((target) => [target.name, 0]));
  const startedAt = Date.now();
  const deadline = startedAt + (options.durationSeconds * 1000);

  function reserveTarget() {
    for (let attempt = 0; attempt < cycle.length; attempt += 1) {
      const target = cycle[requestIndex % cycle.length];
      requestIndex += 1;
      const reserved = requestReservations.get(target.name) ?? 0;
      if (target.maxRequestsPerRun && reserved >= target.maxRequestsPerRun) continue;
      requestReservations.set(target.name, reserved + 1);
      return target;
    }
    return null;
  }

  async function worker() {
    while (Date.now() < deadline) {
      if (!await reserveRateSlot(deadline)) return;
      if (Date.now() >= deadline) return;
      const target = reserveTarget();
      if (!target) return;
      const sample = await performRequest(baseUrl, target, authBearerToken);
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
  const { certificationStatus, coverage } = buildCertificationCoverage(targetResults, {
    includeSignedIn,
    profile: options.profile,
  });
  const report = {
    schemaVersion: 2,
    status: violations.length === 0 ? 'passed' : 'failed',
    certificationStatus,
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
    totalEncodedBodyBytes: targetResults.reduce((sum, target) => sum + target.totalEncodedBodyBytes, 0),
    totalDecodedBodyBytes: targetResults.reduce((sum, target) => sum + target.totalDecodedBodyBytes, 0),
    coverage,
    violations,
    targets: targetResults,
  };

  console.table(targetResults.map((target) => ({
    target: target.name,
    audience: target.audience,
    requests: target.requests,
    errorRate: `${(target.errorRate * 100).toFixed(2)}%`,
    p95EncodedBodyBytes: target.encodedBodyBytes.p95,
    p95DecodedBytes: target.decodedBytes.p95,
    p95TtfbMs: target.ttfbMs.p95,
    p99TtfbMs: target.ttfbMs.p99,
    p95TotalMs: target.totalMs.p95,
    p99TotalMs: target.totalMs.p99,
    contentEncoding: Object.entries(target.contentEncodingCounts).map(([key, value]) => `${key}:${value}`).join(','),
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
  } else if (certificationStatus === 'not-certified') {
    console.warn('Performance budgets passed, but certification is NOT CERTIFIED because signed-in feed coverage was skipped.');
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
