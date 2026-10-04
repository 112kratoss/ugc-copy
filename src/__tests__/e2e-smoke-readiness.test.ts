import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

function read(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// A failed Quality run on main skips the production release without a word, so
// the E2E job has to fail only for a reason in the code.
describe('E2E smoke job', () => {
  // Two pages open on one `next dev` reload each other (AGENTS.md, the third E2E
  // gotcha): with two workers every cold run reloaded a page under a test.
  it('runs the suite on one worker in CI', () => {
    expect(read('playwright.config.ts')).toContain('workers: process.env.CI ? 1 : undefined,');
  });

  it('keeps the trace of a failed test after the runner is gone', () => {
    const workflow = read('.github/workflows/quality.yml');
    const run = workflow.indexOf('run: npm run test:e2e');
    const start = workflow.indexOf('- name: Upload the traces of failed tests');
    // The step, up to the job that follows it.
    const upload = workflow.slice(start, workflow.indexOf('\n  mobile:', start));

    expect(read('playwright.config.ts')).toContain("trace: 'retain-on-failure'");
    expect(run).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(run);
    expect(upload).toContain('if: ${{ failure() }}');
    expect(upload).toContain('path: test-results/');
    // A second attempt of the same run must not collide with the first one's upload.
    expect(upload).toContain('name: e2e-test-results-attempt-${{ github.run_attempt }}');
  });
});
