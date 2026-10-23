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
  // Two pages open on one `next dev` reload each other (the third gotcha in
  // .claude/rules/e2e.md): with two workers every cold run reloaded a page under a test.
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

  // The dev server answers the server-side Supabase reads of the pages specs draw (the creator
  // page) from a stub it loads, which answers only one host: pointed at any other, it answers
  // nothing, and those pages draw their error state again.
  it('answers the server\'s Supabase reads on the project the job points the app at', () => {
    const workflow = read('.github/workflows/quality.yml');
    const step = workflow.slice(
      workflow.indexOf('- name: Run E2E smoke tests'),
      workflow.indexOf('- name: Upload the traces of failed tests'),
    );
    const projectUrl = /NEXT_PUBLIC_SUPABASE_URL: (\S+)/.exec(step)?.[1];
    const config = read('playwright.config.ts');

    expect(projectUrl).toBeDefined();
    expect(read('tests/e2e/support/supabase-server-stub.cjs')).toContain(`const HOST = '${new URL(projectUrl!).host}';`);
    expect(config).toContain("'tests/e2e/support/supabase-server-stub.cjs'");
    expect(config).toContain('NODE_OPTIONS: [process.env.NODE_OPTIONS, SUPABASE_SERVER_STUB]');
  });
});
