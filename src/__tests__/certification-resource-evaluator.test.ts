import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

function sample(index: number, overrides: Record<string, unknown> = {}) {
  return {
    at: new Date(Date.UTC(2026, 7, 10, 0, 0, index * 15)).toISOString(),
    poolUsedPct: 20,
    idleInTransaction: 0,
    idleInTransactionMaxSeconds: 0,
    lockWaiters: 0,
    ungrantedLocks: 0,
    trackIoTiming: true,
    sampleFailures: 0,
    sampleGapSeconds: index === 0 ? null : 15,
    deadlocks: 0,
    tempBytes: 0,
    walBytes: index * 100,
    walRecords: index * 2,
    checkpoints: 0,
    databaseBytes: 1000 + index,
    completionDue: 0,
    completionOldestDueSeconds: 0,
    workflowStepsDue: 0,
    workflowOldestDueSeconds: 0,
    templateDue: 0,
    templateOldestDueSeconds: 0,
    outputImportDue: 0,
    outputImportOldestDueSeconds: 0,
    renditionOpen: 0,
    renditionOldestSeconds: 0,
    feedRetention: [{ table: 'feed_delivery_facts', oldestRowAgeDays: 20 }],
    ...overrides,
  };
}

function writeSamples(samples: unknown[]) {
  const directory = mkdtempSync(path.join(tmpdir(), 'cert-resources-'));
  const file = path.join(directory, 'resources.jsonl');
  writeFileSync(file, `${samples.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return file;
}

describe('certification resource evaluator', () => {
  it('passes a complete, drained resource sample set', () => {
    const file = writeSamples(Array.from({ length: 5 }, (_, index) => sample(index)));
    const output = execFileSync('node', [
      'scripts/certification/evaluate-resources.mjs', '--in', file,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    expect(JSON.parse(output).passed).toBe(true);
  });

  it('fails non-zero on an absolute pool breach or growing queue', () => {
    const samples = Array.from({ length: 5 }, (_, index) => sample(index, {
      poolUsedPct: index === 2 ? 71 : 20,
      completionDue: index,
    }));
    const result = spawnSync('node', [
      'scripts/certification/evaluate-resources.mjs', '--in', writeSamples(samples),
    ], { cwd: process.cwd(), encoding: 'utf8' });
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'pool_absolute_max', passed: false }),
      expect.objectContaining({ name: 'completion_queue_drained', passed: false }),
    ]));
  });

  it('allows transaction boundaries but fails an aged idle transaction', () => {
    const boundarySamples = Array.from({ length: 5 }, (_, index) => sample(index, {
      idleInTransaction: index === 2 ? 6 : 0,
      idleInTransactionMaxSeconds: index === 2 ? 0.04 : 0,
    }));
    const boundaryOutput = execFileSync('node', [
      'scripts/certification/evaluate-resources.mjs', '--in', writeSamples(boundarySamples),
    ], { cwd: process.cwd(), encoding: 'utf8' });
    expect(JSON.parse(boundaryOutput).passed).toBe(true);

    const agedSamples = Array.from({ length: 5 }, (_, index) => sample(index, {
      idleInTransaction: index === 3 ? 1 : 0,
      idleInTransactionMaxSeconds: index === 3 ? 5.01 : 0,
    }));
    const result = spawnSync('node', [
      'scripts/certification/evaluate-resources.mjs', '--in', writeSamples(agedSamples),
    ], { cwd: process.cwd(), encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'idle_in_transaction_age', passed: false }),
    ]));
  });
});
