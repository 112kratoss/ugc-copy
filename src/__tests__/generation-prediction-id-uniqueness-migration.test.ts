import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260714111000_unique_generation_prediction_ids.sql',
), 'utf8');

describe('generation provider id integrity migration', () => {
  it('fails explicitly on legacy blanks or normalized duplicates before adding uniqueness', () => {
    expect(migration).toContain('LOCK TABLE public.generations IN SHARE ROW EXCLUSIVE MODE');
    expect(migration).toContain("btrim(prediction_id) = ''");
    expect(migration).toContain('HAVING count(*) > 1');
    expect(migration).toContain('RAISE EXCEPTION');
    expect(migration).toContain('CREATE UNIQUE INDEX generations_prediction_id_unique_idx');
    expect(migration).toContain('WHERE prediction_id IS NOT NULL');
    expect(migration).toContain('prediction_id = btrim(prediction_id)');
  });

  it('maps attach races to a stable conflict without replacing another generation task id', () => {
    expect(migration).toContain('v_conflicting_generation_id');
    expect(migration).toContain('WHEN unique_violation THEN');
    expect(migration).toContain("'status', 'prediction_conflict'");
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.attach_generation_provider_task(uuid, text) TO service_role');
  });
});
