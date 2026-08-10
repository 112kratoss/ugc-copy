import { describe, expect, it } from 'vitest';

import {
  CERTIFICATION_BUNDLE_BATCH_SIZE,
  CERTIFICATION_FACT_SESSION_BATCH_SIZE,
  deriveFactResumePlan,
  parseArgs,
} from '../../scripts/certification/seed-fixtures.mjs';

describe('certification fixture seeder arguments', () => {
  it('keeps 1m fixture writes below the branch gateway transaction size', () => {
    expect(CERTIFICATION_BUNDLE_BATCH_SIZE).toBe(1_000);
    expect(CERTIFICATION_FACT_SESSION_BATCH_SIZE * 30).toBe(15_000);
  });

  it('seeds every component by default', () => {
    expect(parseArgs(['--tier', '1m'])).toEqual({
      tier: '1m',
      users: 2_000,
      only: ['users', 'posts', 'comments', 'bundles', 'facts'],
    });
  });

  it('supports a deduplicated partial resume', () => {
    expect(parseArgs(['--tier', '1m', '--users', '3', '--only', 'bundles,facts,bundles'])).toEqual({
      tier: '1m',
      users: 3,
      only: ['bundles', 'facts'],
    });
  });

  it('resumes facts only from a complete session boundary', () => {
    expect(deriveFactResumePlan({
      factCount: 1_000_000,
      existingFacts: 435_000,
      existingItems: 435_000,
      existingSessions: 33_334,
    })).toEqual({
      sessionCount: 33_334,
      expectedFacts: 1_000_020,
      startSessionOffset: 14_500,
      createSessions: false,
      complete: false,
    });
  });

  it.each([
    { factCount: 1_000, existingFacts: 30, existingItems: 29, existingSessions: 34 },
    { factCount: 1_000, existingFacts: 31, existingItems: 31, existingSessions: 34 },
    { factCount: 1_000, existingFacts: 30, existingItems: 30, existingSessions: 3 },
  ])('rejects an unsafe partial fact resume %#', (counts) => {
    expect(() => deriveFactResumePlan(counts)).toThrow();
  });

  it.each([
    ['--only', ''],
    ['--only', 'bundles,unknown'],
    ['--wat', '1'],
  ])('rejects invalid arguments %s %s', (...args) => {
    expect(() => parseArgs(args)).toThrow();
  });
});
