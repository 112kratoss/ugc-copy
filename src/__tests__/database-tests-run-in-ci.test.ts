// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// A `*-database.test.ts` file runs only where SUPABASE_TEST_DB_URL is set, and skips itself
// everywhere else, `npm test` included. Quality's migration job names each one in a step of its
// own, so a file nobody added there passes every run by never running. Two were left out that way
// on 2026-11-27 (the generation terminal-state and sitemap creator tests) and were found by hand.

const root = process.cwd();
const workflow = readFileSync(path.join(root, '.github/workflows/quality.yml'), 'utf8');

describe('database-backed tests in the Quality workflow', () => {
  it('names every *-database.test.ts file in a step', () => {
    const files = readdirSync(path.join(root, 'src/__tests__')).filter((name) => /-database\.test\.tsx?$/.test(name));
    expect(files.length).toBeGreaterThan(20);

    const unlisted = files.filter((name) => !workflow.includes(`src/__tests__/${name}`));
    expect(unlisted).toEqual([]);
  });
});
