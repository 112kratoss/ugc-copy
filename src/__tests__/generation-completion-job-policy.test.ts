import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MAX_COMPLETION_ATTEMPTS } from '@/lib/generation-completion-job-policy';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const FINISH_FUNCTION_HEADER = 'CREATE OR REPLACE FUNCTION public.finish_generation_completion_job(';

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

/** The body the database ends up with: the last migration to define the function wins. */
function latestFinishFunctionBody(): string {
  const definitions = fs.readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => fs.readFileSync(path.join(migrationsDirectory, name), 'utf8'))
    .filter((sql) => sql.includes(FINISH_FUNCTION_HEADER));
  const sql = definitions[definitions.length - 1] ?? '';
  const start = sql.lastIndexOf(FINISH_FUNCTION_HEADER);
  const dollarQuote = /\bAS (\$[a-z_]*\$)/.exec(sql.slice(start))?.[1];
  if (start < 0 || !dollarQuote) return '';
  const bodyStart = sql.indexOf(dollarQuote, start) + dollarQuote.length;
  return sql.slice(bodyStart, sql.indexOf(dollarQuote, bodyStart));
}

describe('generation completion attempt cap', () => {
  it('is the attempt count finish_generation_completion_job closes a job at', () => {
    // Backend health reports an open job above the cap as one that was reclaimed
    // without being closed. That reading holds only while the database closes
    // jobs at the same number, and the SQL cannot import it.
    const body = latestFinishFunctionBody();
    const comparisons = body.match(/attempt_count >= \d+/g) ?? [];

    expect(body).toContain(`WHEN attempt_count >= ${MAX_COMPLETION_ATTEMPTS} THEN 'failed'`);
    expect(comparisons.length).toBeGreaterThan(0);
    expect(new Set(comparisons)).toEqual(new Set([`attempt_count >= ${MAX_COMPLETION_ATTEMPTS}`]));
  });

  it('is read from the policy module by the worker and by backend health', () => {
    const worker = readSource('src/lib/generation-completion-jobs.ts');
    const backendHealth = readSource('src/lib/backend-health.ts');
    const importsTheCap = /import\s*\{[^}]*\bMAX_COMPLETION_ATTEMPTS\b[^}]*\}\s*from\s*'@\/lib\/generation-completion-job-policy'/;

    expect(worker).toMatch(importsTheCap);
    expect(backendHealth).toMatch(importsTheCap);
    // Neither keeps a number of its own to drift from the other.
    expect(worker).not.toMatch(/\bMAX_COMPLETION_ATTEMPTS\s*=/);
    expect(backendHealth).not.toMatch(/\bMAX_COMPLETION_ATTEMPTS\s*=/);
    // The worker reaches sharp and ffmpeg-static through generation-services.ts.
    // Health reading the cap from it would put both in the ops routes, which no
    // trace list in next.config.ts covers.
    expect(backendHealth).not.toContain("'@/lib/generation-completion-jobs'");
  });
});
