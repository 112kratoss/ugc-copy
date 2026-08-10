import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const scriptPath = path.resolve(process.cwd(), 'scripts/certification/cert-load-test.mjs');
const source = fs.readFileSync(scriptPath, 'utf8');

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
});
