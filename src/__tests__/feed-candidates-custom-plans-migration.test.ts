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

  // A convenience at the text's level: it names the migration at fault before a
  // replay does. The guard on what the database holds is the pgTAP file
  // feed_candidates_custom_plans.test.sql, which reads the live function.
  it('is not undone by a later migration that defines the function again without the setting, or resets it', () => {
    const later = fs.readdirSync(MIGRATIONS).filter((file) => file.endsWith('.sql') && file > MIGRATION).sort();
    for (const file of later) expect(undoneBy(statements(file)), file).toEqual([]);
  });

  it('reads a definition or a reset however it is spelled', () => {
    const header = 'p uuid)\nRETURNS void\nLANGUAGE plpgsql\nSET search_path = public, pg_temp\n';
    const body = 'AS $$ begin end $$;';
    expect(undoneBy(`CREATE OR REPLACE FUNCTION ${FUNCTION_NAME}(${header}${body}`)).toHaveLength(1);
    expect(undoneBy(`create or replace\n  function get_ranked_feed_candidates_v4 (${header}${body}`)).toHaveLength(1);
    expect(undoneBy(`create function "public"."get_ranked_feed_candidates_v4"(${header}as $fn$ begin end $fn$;`)).toHaveLength(1);
    expect(undoneBy(`ALTER FUNCTION ${FUNCTION_NAME}(uuid) RESET plan_cache_mode;`)).toHaveLength(1);
    expect(undoneBy(`alter function ${FUNCTION_NAME}(uuid) reset all;`)).toHaveLength(1);
    expect(undoneBy(`ALTER FUNCTION ${FUNCTION_NAME}(uuid) SET plan_cache_mode = auto;`)).toHaveLength(1);
    expect(undoneBy(
      `CREATE OR REPLACE FUNCTION ${FUNCTION_NAME}(${header}SET plan_cache_mode = force_custom_plan\n${body}`,
    )).toEqual([]);
    expect(undoneBy(`ALTER FUNCTION ${FUNCTION_NAME}(uuid) SET plan_cache_mode TO 'force_custom_plan';`)).toEqual([]);
    expect(undoneBy(`GRANT EXECUTE ON FUNCTION ${FUNCTION_NAME}(uuid) TO service_role;`)).toEqual([]);
    expect(undoneBy('CREATE OR REPLACE FUNCTION public.get_ranked_feed_candidates_v40(p uuid) RETURNS void AS $$ $$;'))
      .toEqual([]);
  });
});

const NAMED = String.raw`(?:"?public"?\s*\.\s*)?"?get_ranked_feed_candidates_v4"?\s*\(`;
const KEEPS_SETTING = /\bset\s+plan_cache_mode\s*(?:=|\bto\b)\s*'?force_custom_plan\b/i;

/** Each statement in `sql` that would leave the function without force_custom_plan. */
function undoneBy(sql: string) {
  const found: string[] = [];
  for (const match of sql.matchAll(new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?function\s+${NAMED}`, 'gi'))) {
    const rest = sql.slice(match.index);
    const body = rest.search(/\bas\s+\$/i);
    const header = body === -1 ? rest : rest.slice(0, body);
    if (!KEEPS_SETTING.test(header)) found.push(`defined without the setting: ${match[0]}`);
  }
  for (const match of sql.matchAll(new RegExp(String.raw`\balter\s+function\s+${NAMED}[^;]*;`, 'gi'))) {
    const statement = match[0];
    const resets = /\breset\s+(?:all|plan_cache_mode)\b/i.test(statement);
    const setsAnother = /\bset\s+plan_cache_mode\b/i.test(statement) && !KEEPS_SETTING.test(statement);
    if (resets || setsAnother) found.push(`changed: ${statement.replace(/\s+/g, ' ')}`);
  }
  return found;
}
