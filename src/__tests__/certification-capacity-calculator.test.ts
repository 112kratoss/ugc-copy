import { execFileSync, spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const SCRIPT = 'scripts/certification/calculate-capacity.mjs';

describe('certification capacity calculator', () => {
  it('applies headroom and chooses the lowest measured dimension', () => {
    const output = execFileSync('node', [
      SCRIPT,
      '--sustainable-rps', '50',
      '--provider-generations-per-day', '10000',
      '--media-generations-per-day', '5000',
      '--facts-per-session', '12',
      '--anonymous-excluded',
    ], { cwd: process.cwd(), encoding: 'utf8' });
    const report = JSON.parse(output);
    expect(report.afterHeadroom.sustainableRps).toBe(35);
    expect(report.scope).toBe('authenticated product mix only');
    expect(report.scenarios.base.conservativeMau).toBe(
      Math.min(...Object.values(report.scenarios.base.ceilings) as number[]),
    );
  });

  it('refuses to produce a claim when a measured dimension is missing', () => {
    const result = spawnSync('node', [SCRIPT, '--sustainable-rps', '50'], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--provider-generations-per-day');
  });
});
