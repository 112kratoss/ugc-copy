import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = path.join(
  process.cwd(),
  'supabase/migrations/20260714193000_atomic_workflow_assistant_proposal_apply.sql',
);

describe('atomic workflow assistant proposal migration', () => {
  it('locks both records and commits canvas, history, and proposal changes in one invoker transaction', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('SECURITY INVOKER');
    expect(sql.match(/FOR UPDATE;/g)).toHaveLength(2);
    expect(sql).toContain('UPDATE public.workflow_canvases');
    expect(sql).toContain('INSERT INTO public.workflow_canvas_history');
    expect(sql).toContain('UPDATE public.workflow_canvas_assistant_proposals');
    expect(sql).toContain("AND status = 'ready'");
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.apply_workflow_canvas_assistant_proposal');
  });
});
