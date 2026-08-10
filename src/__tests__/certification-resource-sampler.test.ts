import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const sampler = fs.readFileSync(
  path.resolve(process.cwd(), 'scripts/certification/sample-resources.mjs'),
  'utf8',
);

function queueSql(table: string, nextTable: string | null): string {
  const start = sampler.indexOf(`from public.${table}`);
  const end = nextTable
    ? sampler.indexOf(`from public.${nextTable}`, start)
    : sampler.indexOf('`;', start);
  return start >= 0 && end > start ? sampler.slice(start, end) : '';
}

describe('certification resource sampler schema contract', () => {
  it('uses the completion queue locked_at-only lease contract', () => {
    const completionSql = queueSql('generation_completion_jobs', 'workflow_run_step_jobs');

    expect(completionSql).toContain("status = 'processing' and locked_at <=");
    expect(completionSql).not.toContain('heartbeat_at');
  });

  it('keeps heartbeat-aware recovery for workflow jobs, where the column exists', () => {
    const workflowSql = queueSql('workflow_run_step_jobs', 'post_media');

    expect(workflowSql).toContain('coalesce(heartbeat_at, locked_at)');
  });
});
