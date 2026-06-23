import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('workflow run catalog revision migration', () => {
  it('stores the reviewed generation catalog revision on workflow runs', () => {
    const migration = fs.readFileSync(
      path.join(process.cwd(), 'supabase/migrations/20260622043100_workflow_run_catalog_revision.sql'),
      'utf8'
    );

    expect(migration).toContain('ALTER TABLE public.workflow_canvas_runs');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS catalog_revision text');
  });
});
