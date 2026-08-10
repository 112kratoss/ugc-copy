import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const scriptPath = path.resolve(process.cwd(), 'scripts/certification/cert-load-test.mjs');
const source = fs.readFileSync(scriptPath, 'utf8');
const strictCasesSource = fs.readFileSync(
  path.resolve(process.cwd(), 'scripts/certification/cert-cases.mjs'),
  'utf8',
);

describe('certification load-driver guardrails', () => {
  it('is valid JavaScript in CI', () => {
    const result = spawnSync(process.execPath, ['--check', scriptPath], { encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
  });

  it('freezes warmup scoring at request start', () => {
    expect(source).toContain('const scored = Date.now() >= runtimeState.warmupUntil;');
    expect(source).toContain('if (scored) {');
    expect(source).toContain('scored,');
    expect(source).not.toContain('scored: Date.now() >= runtimeState.warmupUntil');
  });

  it('gates completed operations and every family error/throttle rate', () => {
    expect(source).toContain('report.achievedOperationRps >= options.rps');
    expect(source).toContain('`${entry.name}_error_rate`');
    expect(source).toContain('`${entry.name}_throttle_rate`');
    expect(source).toContain('`${entry.name}_completed_operations`');
  });

  it('bounds every HTTP request and rejects the production Supabase project', () => {
    expect(source).toContain('AbortSignal.timeout(options.requestTimeoutMs)');
    expect(source).toContain("=== 'ildfmhozpibwiopeavfg'");
  });

  it('binds each artifact to the exact build, schema, fixture, catalog, SLO config and stub', () => {
    expect(source).toContain('CERT_EXPECTED_BUILD_ID');
    expect(source).toContain('CERT_SCHEMA_FINGERPRINT');
    expect(source).toContain('CERT_FIXTURE_TIER');
    expect(source).toContain('CERT_CATALOG_REVISION');
    expect(source).toContain("createHash('sha256').update(SLO_CONFIG_SOURCE)");
    expect(source).toContain("fetch(new URL('/api/app-version', BASE_URL)");
    expect(source).toContain("fetch(new URL('/stub/stats', STUB_URL)");
    expect(source).toContain('environment: runtimeState.preflight');
  });

  it('does not declare a webhook burst drained before durable output imports finish', () => {
    expect(strictCasesSource).toContain('generation_output_import_jobs');
    expect(strictCasesSource).toContain("j.status = 'succeeded'");
    expect(strictCasesSource).toContain("status = 'succeeded' and output_url is not null");
    expect(strictCasesSource).toContain('Number(after[0]?.imports_succeeded ?? 0) === count');
    expect(strictCasesSource).toContain('Number(after[0]?.durable_outputs ?? 0) === count');
  });

  it('uses an isolated provider state and a runnable workflow fan-out fixture', () => {
    expect(strictCasesSource).toContain('truncate table public.provider_admission_buckets');
    expect(strictCasesSource).toContain("new Set(['text-input', 'image-generate', 'video-generate'])");
    expect(strictCasesSource).toContain("method: 'PATCH'");
    expect(strictCasesSource).toContain('keptNodeIds.has(edge?.source) && keptNodeIds.has(edge?.target)');
  });

  it('accepts the certification timing mirror when the platform strips Server-Timing', () => {
    expect(source).toContain("result.response.headers.get('server-timing')");
    expect(source).toContain("result.response.headers.get('x-scaling-certification-timing')");
  });
});
