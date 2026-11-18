import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = path.resolve(process.cwd(), 'supabase/migrations');
const MIGRATION = '20261118192524_feed_candidates_v4_custom_plans.sql';
const FUNCTION_NAME = 'public.get_ranked_feed_candidates_v4';

/** The statements of a migration, without its comments. */
function statements(file: string) {
  return fs.readFileSync(path.join(MIGRATIONS, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('For You candidates are planned for each call', () => {
  it('sets force_custom_plan on the 25-argument function and changes nothing else', () => {
    const sql = statements(MIGRATION).replace(/\s+/g, ' ').trim();
    expect(sql).toBe(
      `ALTER FUNCTION ${FUNCTION_NAME}( `
      + 'uuid, text, text, integer, integer, integer, integer, integer, integer, '
      + 'double precision, double precision, timestamptz, integer, integer, integer, '
      + 'integer, integer, integer, double precision, integer, double precision, '
      + 'integer, integer, boolean, boolean '
      + ') SET plan_cache_mode = force_custom_plan;',
    );
  });

  it('names the signature the function was created with', () => {
    const created = statements('20261012061058_feed_ranking_v4_industry_parity.sql');
    const start = created.indexOf(`CREATE OR REPLACE FUNCTION ${FUNCTION_NAME}(`);
    expect(start).toBeGreaterThan(-1);
    const parameters = created.slice(start, created.indexOf('RETURNS TABLE', start));
    const types = [...parameters.matchAll(/^\s+p_\w+\s+(.+?)(?:\s+DEFAULT\b.*)?,?$/gm)].map((match) => match[1]);
    const altered = statements(MIGRATION);
    const named = altered
      .slice(altered.indexOf('(') + 1, altered.indexOf(')'))
      .split(',')
      .map((type) => type.trim());
    expect(types).toHaveLength(25);
    expect(named).toEqual(types);
  });

  it('is not undone by a later migration that defines the function again without the setting', () => {
    const later = fs.readdirSync(MIGRATIONS).filter((file) => file.endsWith('.sql') && file > MIGRATION).sort();
    for (const file of later) {
      const sql = statements(file);
      let from = sql.indexOf(`FUNCTION ${FUNCTION_NAME}(`);
      while (from !== -1) {
        const isDefinition = /CREATE (OR REPLACE )?$/.test(sql.slice(Math.max(0, from - 18), from));
        if (isDefinition) {
          const header = sql.slice(from, sql.indexOf('AS $', from));
          expect(header, `${file} defines the function without force_custom_plan`)
            .toContain('SET plan_cache_mode = force_custom_plan');
        }
        from = sql.indexOf(`FUNCTION ${FUNCTION_NAME}(`, from + 1);
      }
    }
  });
});
