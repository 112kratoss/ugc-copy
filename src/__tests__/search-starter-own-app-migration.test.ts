import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { isAppSourceToolLabel } from '@/lib/source-tools';

// What the migration does to rows is held by
// supabase/tests/database/search_starter_own_app_and_best_query.test.sql. This
// file holds what a later re-creation could quietly undo: the app's own tool
// stays out of the starter's candidates, by identity and before the cut, and
// both functions keep their signatures, settings and grants.

const migrationsDirectory = join(process.cwd(), 'supabase/migrations');
const migrationNames = readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort();
const MIGRATION = '20261113152020_search_starter_own_app_and_best_query.sql';
const withoutComments = (sql: string) => sql.replace(/--.*$/gm, '');
const statements = withoutComments(readFileSync(join(migrationsDirectory, MIGRATION), 'utf8'));

/** The newest migration that defines `public.<name>`, and that definition, comments left out. */
function newestDefinition(name: string): { file: string; definition: string } {
  const pattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`, 'i');
  const definers = migrationNames.filter((file) => pattern.test(withoutComments(readFileSync(join(migrationsDirectory, file), 'utf8'))));
  const file = definers[definers.length - 1];
  const sql = withoutComments(readFileSync(join(migrationsDirectory, file), 'utf8'));
  const fromDefinition = sql.slice(sql.search(pattern));
  return { file, definition: fromDefinition.slice(0, fromDefinition.search(/\n\$(?:function)?\$;/)) };
}

describe('search starter follow-up migration', () => {
  it('runs after the starter, as one transaction that re-creates its two functions and changes no table', () => {
    expect(migrationNames.indexOf(MIGRATION)).toBeGreaterThan(migrationNames.indexOf('20261113100423_search_starter.sql'));
    expect(statements).toMatch(/^BEGIN;\s*SET LOCAL lock_timeout = '5s';/m);
    expect(statements.trim()).toMatch(/COMMIT;$/);
    expect(Array.from(statements.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.(\w+)\s*\(/gi), (m) => m[1]))
      .toEqual(['search_starter_entity_offer', 'search_starter']);
    expect(statements).not.toMatch(/\b(?:ALTER|CREATE|DROP)\s+(?:TABLE|INDEX|VIEW|TRIGGER)\b/i);
    expect(statements).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    expect(statements).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
    // Not through the withdrawn-words table, which is production data.
    expect(statements).not.toMatch(/search_suggestion_denylist[\s\S]*magicbooklet/);
  });

  it('keeps both functions’ signatures, settings and grants', () => {
    for (const [name, signature] of [
      ['search_starter_entity_offer', 'public.search_starter_entity_offer(text, text, uuid)'],
      ['search_starter', 'public.search_starter(uuid, text[], integer, integer, integer)'],
    ] as const) {
      const { file, definition } = newestDefinition(name);
      expect(file, name).toBe(MIGRATION);
      expect(definition).toMatch(/SECURITY DEFINER/);
      expect(definition).toMatch(/SET search_path = ''/);
      const escaped = signature.replace(/[()[\]]/g, '\\$&');
      expect(statements).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${escaped} FROM PUBLIC, anon, authenticated;`));
      expect(statements).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${escaped} TO service_role;`));
    }
    for (const setting of [
      'SET enable_hashjoin = off', 'SET enable_mergejoin = off',
      'SET max_parallel_workers_per_gather = 0', 'SET plan_cache_mode = force_custom_plan',
    ]) expect(newestDefinition('search_starter_entity_offer').definition).toContain(setting);
  });

  it('leaves the app’s own tool out of the candidates before they are cut, read as the app reads its name', () => {
    const sql = newestDefinition('search_starter').definition;
    const candidates = sql.slice(sql.indexOf('FROM recent\n            JOIN public.post_search_entities'), sql.indexOf('LIMIT c_entity_candidates'));
    expect(candidates).toMatch(/WHERE NOT \(\s*members\.kind = 'tool'\s+AND replace\(members\.key, '-', ''\) IN \('magicbooklet', 'emptybooklet'\)\s*\)\s+GROUP BY/);
    // The names the SQL leaves out are the ones the app's own reading calls the app.
    expect(isAppSourceToolLabel('magicbooklet')).toBe(true);
    expect(isAppSourceToolLabel('magic-booklet')).toBe(true);
    expect(isAppSourceToolLabel('Magic Booklet')).toBe(true);
  });

  it('tries the printed name, then the key, and keeps the one that opens more', () => {
    const sql = newestDefinition('search_starter_entity_offer').definition;
    expect(sql).toContain('FOREACH v_candidate IN ARRAY ARRAY[v_label, p_key] LOOP');
    expect(sql).toContain('IF v_named AND v_total > v_best_total THEN');
    expect(sql).toMatch(/RETURN QUERY SELECT v_best_query, v_label, least\(v_best_total, c_count_cap\), v_best_total > c_count_cap;/);
    expect(sql.match(/LIMIT c_count_cap \+ 1/g)).toHaveLength(2);
  });
});
