import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SEARCH_STARTER_CREATOR_LIMIT,
  SEARCH_STARTER_ENTITY_LIMIT,
  SEARCH_STARTER_MAX_TERMS,
  SEARCH_STARTER_SEARCH_LIMIT,
  SEARCH_STARTER_SUGGESTED_SEARCHES,
} from '@/lib/search-starter';

// What the function does to real rows is held by
// supabase/tests/database/search_starter.test.sql: who and what is never
// offered, the orders, the window. This file holds the parts a later CREATE
// OR REPLACE could quietly undo: the read stays bounded (the window, the
// caps, the steered term check), every rule that keeps a row out is still
// written, the functions stay the service role's, and the service calls the
// function by the names of its parameters.

const migrationsDirectory = join(process.cwd(), 'supabase/migrations');
const migrationNames = readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort();
const MIGRATION = '20261113100423_search_starter.sql';
const withoutComments = (sql: string) => sql.replace(/--.*$/gm, '');
const migration = readFileSync(join(migrationsDirectory, MIGRATION), 'utf8');
const statements = withoutComments(migration);
const serviceSource = readFileSync(join(process.cwd(), 'src/lib/search-starter-service.ts'), 'utf8');

const STARTER_SIGNATURE = 'public.search_starter(uuid, text[], integer, integer, integer)';
const TERM_SIGNATURE = 'public.search_starter_term_finds_post(text, uuid)';
const OFFER_SIGNATURE = 'public.search_starter_entity_offer(text, text, uuid)';

/** The newest migration that defines `public.<name>`, and that definition, comments left out. */
function newestDefinition(name: string): { file: string; definition: string } {
  const pattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`, 'i');
  const definers = migrationNames.filter((file) => pattern.test(withoutComments(readFileSync(join(migrationsDirectory, file), 'utf8'))));
  expect(definers.length, `${name} must be defined`).toBeGreaterThan(0);
  const file = definers[definers.length - 1];
  const sql = withoutComments(readFileSync(join(migrationsDirectory, file), 'utf8'));
  const fromDefinition = sql.slice(sql.search(pattern));
  const closing = fromDefinition.search(/\n\$(?:function)?\$;/);
  expect(closing, `the newest definition of ${name} must close`).toBeGreaterThan(0);
  return { file, definition: fromDefinition.slice(0, closing) };
}

const starter = () => newestDefinition('search_starter').definition;
const termCheck = () => newestDefinition('search_starter_term_finds_post').definition;
const entityOffer = () => newestDefinition('search_starter_entity_offer').definition;
const oneLine = (sql: string) => sql.replace(/\s+/g, ' ');
// search_public_posts' match, the text search_public_entities holds a fourth time
// (search-entities-filters-migration.test.ts): the offer holds it a fifth.
const SEARCH_MATCH = "posts.is_nsfw = false AND ( documents.search_vector @@ v_tsquery"
  + " OR documents.search_text ILIKE ('%' || v_like || '%')"
  + ' OR documents.title_normalized OPERATOR(extensions.%) v_query'
  + ' OR documents.tool_normalized OPERATOR(extensions.%) v_query )';

describe('search starter migration', () => {
  it('runs after the migrations whose functions and tables it reads, as one transaction that changes no table', () => {
    for (const before of [
      '20261112144018_search_suggestions_typeahead.sql', // search_suggestion_denylist
      '20261112174210_search_entities_filters_corrected_reading.sql', // post_search_entities, search_public_entities
      '20261112192423_search_suggestions_entities.sql',
    ]) {
      expect(migrationNames.indexOf(MIGRATION), before).toBeGreaterThan(migrationNames.indexOf(before));
    }
    expect(statements).toMatch(/^BEGIN;\s*SET LOCAL lock_timeout = '5s';/m);
    expect(statements.trim()).toMatch(/COMMIT;$/);
    expect(statements).not.toMatch(/\b(?:ALTER|CREATE|DROP)\s+(?:TABLE|INDEX|VIEW|TRIGGER)\b/i);
    expect(statements).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
    // Three new functions, nothing re-created that the live app calls.
    expect(Array.from(statements.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)/gi), (m) => m[1]))
      .toEqual(['search_starter_term_finds_post', 'search_starter_entity_offer', 'search_starter']);
    expect(statements).not.toMatch(/OR\s+REPLACE/i);
  });

  it('keeps both functions the service role’s, run as their owner with an empty search path', () => {
    for (const [name, signature] of [
      ['search_starter', STARTER_SIGNATURE],
      ['search_starter_term_finds_post', TERM_SIGNATURE],
      ['search_starter_entity_offer', OFFER_SIGNATURE],
    ] as const) {
      const { definition } = newestDefinition(name);
      expect(definition, name).toMatch(/SECURITY DEFINER/);
      expect(definition, name).toMatch(/SET search_path = ''/);
      expect(definition, name).toMatch(/\bSTABLE\b/);
      const escaped = signature.replace(/[()[\]]/g, '\\$&');
      expect(statements).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${escaped} FROM PUBLIC, anon, authenticated;`));
      expect(statements).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${escaped} TO service_role;`));
    }
  });

  it('reads entities and creators from a bounded window of the newest posts search may show, by the recent-posts index', () => {
    const sql = starter();
    expect(sql).toMatch(/c_window CONSTANT integer := 2000;/);
    // However many of the newest are labelled or blocked, no more index entries than this are read.
    expect(sql).toMatch(/c_scan_ceiling CONSTANT integer := 10000;/);
    expect(sql).toMatch(/FROM public\.posts AS scanned[\s\S]*?ORDER BY scanned\.created_at DESC, scanned\.id DESC\s+LIMIT c_scan_ceiling/);
    const window = sql.slice(sql.indexOf('WITH recent AS MATERIALIZED'), sql.indexOf('LIMIT c_window') + 'LIMIT c_window'.length);
    // posts_public_review_recent_idx: (visibility, review_status, created_at DESC, id DESC) WHERE archived_at IS NULL.
    expect(window).toMatch(/scanned\.visibility = 'public'/);
    expect(window).toMatch(/scanned\.review_status = 'visible'/);
    expect(window).toMatch(/scanned\.archived_at IS NULL/);
    expect(window).toMatch(/ORDER BY posts\.created_at DESC, posts\.id DESC\s+LIMIT c_window/);
    // Search's own rules, before the cut: a document, no label, neither side of a block.
    expect(window).toMatch(/posts\.is_nsfw = false/);
    expect(window).toMatch(/FROM public\.post_search_documents AS documents\s+WHERE documents\.post_id = posts\.id/);
    expect(window).toMatch(/blocks\.blocker_user_id = p_viewer_user_id\s+AND blocks\.blocked_user_id = posts\.user_id/);
    expect(window).toMatch(/blocks\.blocker_user_id = posts\.user_id\s+AND blocks\.blocked_user_id = p_viewer_user_id/);
    // No other read of posts in the entity and creator lists.
    expect(sql.match(/FROM public\.posts\b/g)).toHaveLength(1);
  });

  it('offers an entity only two creators use, with no withdrawn word, counted as a made-with filter counts it', () => {
    const sql = starter();
    expect(sql).toMatch(/HAVING count\(DISTINCT members\.creator_user_id\) >= 2/);
    expect(sql).toMatch(/c_entity_candidates CONSTANT integer := 12;/);
    expect(sql).toMatch(/LIMIT c_entity_candidates/);
    // Counted for the search a press runs, by the offer; none it finds nothing for.
    expect(sql).toMatch(/CROSS JOIN LATERAL public\.search_starter_entity_offer\(\s*candidates\.kind,\s*candidates\.key,\s*p_viewer_user_id\s*\) AS counted/);
    expect(sql).not.toMatch(/search_public_entities/);
    expect(sql).toMatch(/counted\.query,/);
    expect(sql).toMatch(/'query', offered\.query/);
    expect(sql).toMatch(/FROM public\.search_suggestion_denylist AS denied[\s\S]*?search_term_variants\(counted\.label\)[\s\S]*?search_term_variants\(candidates\.key\)/);
    expect(sql).toMatch(/ORDER BY counted\.post_count DESC/);
  });

  it('counts an entity for the search its row runs, by search’s own match, read for that one entity', () => {
    const sql = entityOffer();
    // The query: the name most of the viewer's posts with it print, read as search reads a query.
    expect(sql).toMatch(/ORDER BY \(printed\.label = p_key\), count\(\*\) DESC, printed\.label/);
    expect(sql).toMatch(/v_query := lower\(btrim\(regexp_replace\(v_label, '\[\[:space:\]\]\+', ' ', 'g'\)\)\);/);
    expect(sql).toMatch(/IF char_length\(v_query\) < 3 OR char_length\(v_query\) > 100 THEN\s+RETURN;/);
    expect(sql).toContain('v_tsquery := public.search_query_tsquery(v_query, true);');
    expect(sql).toContain('v_name_tsquery := public.search_query_tsquery(v_query, false);');
    expect(sql).toContain(String.raw`v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');`);
    // The match, the same text as search_public_posts'.
    expect(oneLine(sql).split(SEARCH_MATCH)).toHaveLength(2);
    expect(oneLine(newestDefinition('search_public_posts').definition).split(SEARCH_MATCH).length).toBeGreaterThan(1);
    // Named as the query names it, by the entity's own rows, both sides of a block.
    expect(sql).toContain('members.name_vector @@ v_name_tsquery AS names_it');
    expect(sql).toMatch(/WHERE members\.kind = p_kind\s+AND members\.key = p_key/g);
    expect(sql.match(/blocks\.blocker_user_id = p_viewer_user_id/g)).toHaveLength(2);
    expect(sql.match(/blocks\.blocked_user_id = p_viewer_user_id/g)).toHaveLength(2);
    expect(sql).toMatch(/IF v_total = 0 OR NOT v_named THEN\s+RETURN;/);
    // Bounded: 201 rows a count, planned for its own values, nested loops, one process.
    expect(sql).toMatch(/c_count_cap CONSTANT integer := 200;/);
    expect(sql.match(/LIMIT c_count_cap \+ 1/g)).toHaveLength(2);
    for (const setting of [
      'SET enable_hashjoin = off', 'SET enable_mergejoin = off',
      'SET max_parallel_workers_per_gather = 0', 'SET plan_cache_mode = force_custom_plan',
    ]) expect(sql).toContain(setting);
  });

  it('offers a creator only as an active, unblocked account the viewer does not follow, and counts no more than it needs', () => {
    const sql = starter();
    expect(sql).toMatch(/users\.is_anonymous IS NOT TRUE/);
    expect(sql).toMatch(/users\.banned_until IS NULL OR users\.banned_until <= now\(\)/);
    expect(sql).toMatch(/profiles\.identity_state = 'active'/);
    expect(sql).toMatch(/recent\.creator_user_id IS DISTINCT FROM p_viewer_user_id/);
    expect(sql).toMatch(/follows\.follower_id = p_viewer_user_id\s+AND follows\.following_id = recent\.creator_user_id/);
    expect(sql).toMatch(/FROM public\.creator_search_documents AS documents\s+WHERE documents\.creator_user_id = recent\.creator_user_id/);
    expect(sql).toMatch(/c_creator_period CONSTANT interval := interval '30 days';/);
    expect(sql).toMatch(/c_creator_post_cap CONSTANT integer := 10;/);
    expect(sql).toMatch(/c_creator_candidates CONSTANT integer := 50;/);
    expect(sql).toMatch(/LIMIT c_creator_candidates/);
    // Followers as search_creator_score counts them, to 1,000.
    expect(sql).toMatch(/WHERE followers\.following_id = active\.creator_user_id\s+LIMIT 1000/);
    expect(sql).toMatch(/'is_following', false/);
  });

  it('offers a search only while a post search may show holds it, with no withdrawn word, at most twenty read', () => {
    const sql = starter();
    expect(sql).toMatch(/c_term_cap CONSTANT integer := 20;/);
    expect(SEARCH_STARTER_MAX_TERMS).toBe(20);
    expect(sql).toMatch(/p_terms\[1:c_term_cap\]/);
    expect(sql).toMatch(/char_length\(v_term_query\) < 3 OR char_length\(v_term_query\) > 100/);
    expect(sql).toMatch(/FROM public\.search_suggestion_denylist AS denied[\s\S]*?search_term_variants\(v_term_query\)/);
    expect(sql).toMatch(/CONTINUE WHEN NOT public\.search_starter_term_finds_post\(v_term_query, p_viewer_user_id\);/);
  });

  it('checks a term by the word index alone, steered off the scans that grow with the posts', () => {
    const sql = termCheck();
    expect(sql).toMatch(/SET enable_seqscan = off/);
    expect(sql).toMatch(/SET enable_indexscan = off/);
    expect(sql).toMatch(/plainto_tsquery\('pg_catalog\.simple'/);
    expect(sql).toMatch(/documents\.search_vector @@ v_tsquery/);
    expect(sql).not.toMatch(/ILIKE|OPERATOR\(extensions\.%\)|search_query_tsquery/);
    expect(sql).toMatch(/posts\.is_nsfw = false/);
    expect(sql).toMatch(/blocks\.blocker_user_id = p_viewer_user_id\s+AND blocks\.blocked_user_id = documents\.creator_user_id/);
    expect(sql).toMatch(/blocks\.blocker_user_id = documents\.creator_user_id\s+AND blocks\.blocked_user_id = p_viewer_user_id/);
  });

  it('is called by the service under its parameters’ names, with the caps the clients draw', () => {
    const header = starter().match(/search_starter\(([\s\S]*?)\)\s*RETURNS jsonb/);
    expect(header).not.toBeNull();
    const parameters = header![1].split(',').map((parameter) => parameter.trim().split(/\s+/)[0]);
    expect(parameters).toEqual(['p_viewer_user_id', 'p_terms', 'p_entity_limit', 'p_creator_limit', 'p_search_limit']);
    for (const parameter of parameters) expect(serviceSource).toContain(`${parameter}:`);
    expect(serviceSource).toMatch(/client\.rpc\('search_starter'/);
    // The SQL clamps every limit to 10, so the caps must fit.
    expect(starter()).toMatch(/least\(greatest\(coalesce\(p_entity_limit, 8\), 0\), 10\)/);
    for (const cap of [SEARCH_STARTER_ENTITY_LIMIT, SEARCH_STARTER_CREATOR_LIMIT, SEARCH_STARTER_SEARCH_LIMIT]) {
      expect(cap).toBeGreaterThan(0);
      expect(cap).toBeLessThanOrEqual(10);
    }
  });

  it('keeps the hand-picked searches to terms the function will read', () => {
    expect(SEARCH_STARTER_SUGGESTED_SEARCHES.length).toBeGreaterThan(SEARCH_STARTER_SEARCH_LIMIT);
    expect(SEARCH_STARTER_SUGGESTED_SEARCHES.length).toBeLessThanOrEqual(SEARCH_STARTER_MAX_TERMS);
    const read = SEARCH_STARTER_SUGGESTED_SEARCHES.map((term) => term.trim().replace(/\s+/g, ' ').toLowerCase());
    expect(new Set(read).size, 'no term listed twice').toBe(read.length);
    for (const term of read) {
      expect(term.length, term).toBeGreaterThanOrEqual(3);
      expect(term.length, term).toBeLessThanOrEqual(100);
      // Words only: the check reads whole words, so punctuation would only hide a term.
      expect(term, term).toMatch(/^[a-z0-9]+(?: [a-z0-9]+)*$/);
    }
  });
});
