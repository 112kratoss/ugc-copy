import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { normalizeMarketplaceResourceSort } from '@/lib/post-resource-bundles';

// What the migration does to real rows is held by
// supabase/tests/database/recipe_search_recall.test.sql. This file holds the
// paywall to the newest definitions, so a later CREATE OR REPLACE cannot
// quietly undo it: a recipe search matches only its search document, the
// document holds only what a visitor who has not unlocked the recipe sees,
// its vector is generated from that text alone, the dictionary's rebuild takes
// only a listed recipe's document words, flagged as recipe words so post search
// is never corrected to one, no save writes it, and the app rechecks a page on
// the text its cards show.

const migrationsDirectory = join(process.cwd(), 'supabase/migrations');
// Version order: every name starts with its UTC stamp.
const migrationNames = readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort();
const MIGRATION = '20261111231942_recipe_search_recall_and_relevance.sql';
const withoutComments = (sql: string) => sql.replace(/--.*$/gm, '');
const migration = readFileSync(join(migrationsDirectory, MIGRATION), 'utf8');
const statements = withoutComments(migration);
const serverSource = readFileSync(join(process.cwd(), 'src/lib/post-resource-bundles-server.ts'), 'utf8');
const searchServiceSource = readFileSync(join(process.cwd(), 'src/lib/public-search-service.ts'), 'utf8');

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

describe('recipe search recall migration', () => {
  it('sorts after phase 1, whose helpers it uses', () => {
    expect(migrationNames.indexOf(MIGRATION)).toBeGreaterThan(
      migrationNames.indexOf('20261111224010_search_recall_models_prefixes_stems_typos.sql'),
    );
    expect(migrationNames.indexOf('20261111224010_search_recall_models_prefixes_stems_typos.sql')).toBeGreaterThanOrEqual(0);
  });

  it('leaves the document’s text as it was: the visible fields, never an item, card or hidden caption', () => {
    // This migration does not re-project the text.
    expect(statements).not.toMatch(/FUNCTION public\.refresh_marketplace_bundle_search_documents/);
    const { definition } = newestDefinition('refresh_marketplace_bundle_search_documents');
    for (const unlocked of [
      'prompt_text', 'notes_markdown', 'workflow_share_url', 'workflow_snapshot', 'attachments',
      'resource_sections', 'textContent', "->>'title'", "->>'description'", 'posts.prompt',
    ]) {
      expect(definition, unlocked).not.toContain(unlocked);
    }
    // The items are read for their kinds only, and the caption through the public rule.
    expect(definition).toContain('public.post_resource_bundle_kinds(');
    expect(definition).not.toMatch(/posts\.body(?!, bundles\.access_mode\))/);
    expect(definition).toContain('public.recipe_post_public_body(posts.body, bundles.access_mode)');
  });

  it('generates the vector from the document’s text alone', () => {
    expect(statements).toMatch(
      /ALTER TABLE public\.marketplace_bundle_search_documents\s+ADD COLUMN search_vector tsvector\s+GENERATED ALWAYS AS \(public\.marketplace_search_vector\(search_text\)\) STORED;/,
    );
    const { definition } = newestDefinition('marketplace_search_vector');
    expect(definition).toMatch(/RETURNS tsvector\s+LANGUAGE sql\s+IMMUTABLE\s+PARALLEL SAFE\s+SET search_path = ''/);
    // Its one input is the text: no table, no other argument.
    expect(definition).not.toMatch(/\bFROM\b|\bJOIN\b/i);
    expect(definition).toMatch(/marketplace_search_vector\(p_text text\)/);
    expect(statements).not.toMatch(/UPDATE public\.marketplace_bundle_search_documents/i);
  });

  it('matches a search on the document only, and corrects it by its words only', () => {
    const { file, definition } = newestDefinition('list_marketplace_resource_bundles');
    expect(file).toBe(MIGRATION);
    expect(definition).toContain('(search.search_vector @@ $7 OR search.search_text ILIKE $8)');
    expect(definition).toContain('v_tsquery := public.search_query_tsquery(v_query, true);');
    expect(definition).toContain('v_corrected := public.search_corrected_query(v_query, true);');
    expect(definition).toMatch(/v_query := v_corrected;\s+v_tsquery := public\.search_query_tsquery\(v_query, true\);\s+v_like := NULL;/);
    // The correction is decided with no offset and no limit.
    expect(definition).toMatch(/EXECUTE 'SELECT EXISTS \(SELECT 1 ' \|\| v_from \|\| '\)'/);
    expect(definition.slice(definition.indexOf('v_from := format('), definition.indexOf('IF v_searching AND'))).not.toMatch(/OFFSET|LIMIT/);
    // The query's \, % and _ match themselves in the run-of-characters reading.
    expect(definition).toContain("replace(replace(replace(v_query, '\\', '\\\\'), '%', '\\%'), '_', '\\_')");
    expect(definition).toContain('AND char_length($9) >= 3');
  });

  it('adds relevance and keeps every other sort, an unknown one reading as recent', () => {
    const { definition } = newestDefinition('list_marketplace_resource_bundles');
    expect(definition).toMatch(/IF p_sort = 'relevance' AND v_searching THEN\s+[\s\S]*?ts_rank_cd\(search\.search_vector, \$7, 1 \| 32\)/);
    expect(definition).toMatch(/END DESC,\s+listings\.created_at DESC, listings\.bundle_id DESC\$order\$;/);
    // A title lift outweighs any rank, which 1 | 32 holds below 1.
    expect(definition).toMatch(/END\) = \$9 THEN 2\.0\s+WHEN[\s\S]*?END\) LIKE \$10 THEN 1\.0\s+ELSE 0\.0/);
    for (const order of [
      "WHEN 'top-sales' THEN 'listings.sales_count DESC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'",
      "WHEN 'price-low' THEN 'listings.price_usd_cents ASC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'",
      "WHEN 'price-high' THEN 'listings.price_usd_cents DESC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'",
      "ELSE 'listings.created_at DESC, listings.bundle_id DESC'",
    ]) {
      expect(definition).toContain(order);
    }
    // The marketplace page keeps its own sorts; only unified search asks for relevance.
    expect(normalizeMarketplaceResourceSort('relevance')).toBe('recent');
    // Latest (2026-11-12) is the list's own newest-first order.
    expect(searchServiceSource).toMatch(/getMarketplaceResourceList\(\{\s+q: options\.normalizedQuery,[\s\S]*?sort: sort === 'latest' \? 'recent' : 'relevance',/);
  });

  it('rechecks with the list’s own reading of the query', () => {
    const { definition } = newestDefinition('marketplace_search_texts_match');
    expect(definition).toContain('public.marketplace_search_vector(lower(coalesce(texts.text, \'\'))) @@ public.search_query_tsquery(v_query, true)');
    expect(definition).toContain('v_corrected := public.search_corrected_query(v_query, true);');
    expect(definition).toContain('public.marketplace_search_vector(lower(coalesce(texts.text, \'\'))) @@ public.search_query_tsquery(v_corrected, true)');
    expect(definition).toMatch(/IF char_length\(v_query\) < 3 THEN\s+RETURN ARRAY\(SELECT false FROM unnest\(p_texts\)\);/);
    // A text is read from what it is given, never from a table.
    expect(definition).not.toMatch(/public\.(?:post_resource_bundles|posts|marketplace_bundle_search_documents)\b/);
  });

  it('rebuilds the dictionary from unlabelled posts and listed recipes, and nothing else writes it', () => {
    const { file, definition } = newestDefinition('rebuild_search_terms');
    // Re-created by the typeahead migration, which counts the posts and
    // creators that write each word (search-suggest-migration.test.ts holds
    // the counting). What this file holds of it is unchanged: which words the
    // table holds, the recipes' words, the flags, the shape the job reads.
    expect(file).toBe('20261112144018_search_suggestions_typeahead.sql');
    expect(definition).toContain('SECURITY DEFINER');
    expect(definition).toContain("SET search_path = ''");
    expect(definition).toContain("IF NOT pg_try_advisory_xact_lock(hashtext('public.rebuild_search_terms')) THEN");
    // The posts' words exactly as 20261111224010 reads them: a labelled post's
    // words never become a correction.
    expect(definition).toContain('WHERE posts.is_nsfw = false');
    // Read from the same documents by the same reading as 20261111224010
    // (the simple lexemes of a document's text), and held to the same words
    // (letters, 4 to 40), now asked once per lexeme after the counting.
    expect(definition).toMatch(
      /WITH post_lexemes AS \(\s+SELECT[\s\S]*?FROM public\.post_search_documents AS documents\s+JOIN public\.posts AS posts ON posts\.id = documents\.post_id[\s\S]*?CROSS JOIN LATERAL unnest\(to_tsvector\('pg_catalog\.simple', documents\.search_text\)\) AS words\s+WHERE posts\.is_nsfw = false\s+\),/,
    );
    expect(definition).toMatch(
      /post_words AS \(\s+SELECT counted\.term, counted\.post_count, counted\.creator_count\s+FROM counted\s+WHERE counted\.term ~ '\^\[\[:alpha:\]\]\{4,40\}\$'\s+\),/,
    );
    // And the listed recipes' documents, their visible text only.
    expect(definition).toMatch(
      /recipe_words AS \(\s+SELECT DISTINCT words\.lexeme AS term\s+FROM public\.marketplace_bundle_search_documents AS recipe_documents\s+JOIN public\.marketplace_bundle_listings AS listings\s+ON listings\.bundle_id = recipe_documents\.bundle_id\s+AND listings\.listable\s+CROSS JOIN LATERAL unnest\(to_tsvector\('pg_catalog\.simple', recipe_documents\.search_text\)\) AS words\s+WHERE words\.lexeme ~ '\^\[\[:alpha:\]\]\{4,40\}\$'\s+\),/,
    );
    expect(definition).not.toMatch(/post_resource_bundles|resource_items/);
    // Each word flagged with the surfaces that show it; a word neither shows is removed.
    expect(definition).toMatch(/post_words\.term IS NOT NULL AS in_posts,\s+recipe_words\.term IS NOT NULL AS in_recipes\s+FROM post_words\s+FULL JOIN recipe_words ON recipe_words\.term = post_words\.term/);
    expect(definition).toContain('DELETE FROM public.search_terms AS terms\n    WHERE NOT EXISTS (SELECT 1 FROM shown WHERE shown.term = terms.term)');
    expect(definition).toMatch(/ON CONFLICT \(term\) DO UPDATE\s+SET in_posts = excluded\.in_posts, in_recipes = excluded\.in_recipes/);
    // Its shape as the job reads it.
    expect(definition).toMatch(/^CREATE OR REPLACE FUNCTION public\.rebuild_search_terms\(\)\s+RETURNS TABLE\(added integer, removed integer\)/);
    expect(definition).toContain('RETURN QUERY SELECT v_added, v_removed;');
    expect(statements).toContain('REVOKE ALL ON FUNCTION public.rebuild_search_terms() FROM PUBLIC, anon, authenticated;');
    expect(statements).toContain('GRANT EXECUTE ON FUNCTION public.rebuild_search_terms() TO service_role;');
    expect(statements.trim()).toMatch(/SELECT \* FROM public\.rebuild_search_terms\(\);\s+COMMIT;$/);

    // Only the rebuild and the table's own definition name search_terms in a
    // statement after 20261111224010: no trigger or save writes it.
    const writers = migrationNames
      .filter((file) => file > '20261111224010')
      .flatMap((file) => {
        const sql = withoutComments(readFileSync(join(migrationsDirectory, file), 'utf8'));
        const outsideRebuild = sql.replace(/CREATE OR REPLACE FUNCTION public\.rebuild_search_terms\(\)[\s\S]*?\n\$function\$;/g, '');
        return /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+public\.search_terms\b/i.test(outsideRebuild) ? [file] : [];
      });
    expect(writers).toEqual([]);
    expect(statements).not.toMatch(/CREATE (?:OR REPLACE )?TRIGGER/);
    expect(statements).not.toContain('add_marketplace_search_terms');
  });

  it('corrects each surface against its own words only, post search unchanged', () => {
    expect(statements).toMatch(
      /ALTER TABLE public\.search_terms\s+ADD COLUMN in_posts boolean NOT NULL DEFAULT true,\s+ADD COLUMN in_recipes boolean NOT NULL DEFAULT false,\s+ADD CONSTRAINT search_terms_on_a_surface CHECK \(in_posts OR in_recipes\);/,
    );
    const twoArgument = /CREATE OR REPLACE FUNCTION public\.search_corrected_query\(p_query text, p_in_recipes boolean\)[\s\S]*?\n\$function\$;/.exec(statements);
    expect(twoArgument).not.toBeNull();
    // The candidate and the spelt-right-so-far test both read the surface's words.
    expect(twoArgument![0].match(/AND CASE WHEN p_in_recipes THEN (?:terms|known)\.in_recipes ELSE (?:terms|known)\.in_posts END/g)).toHaveLength(2);
    // The one-argument form, which search_public_posts calls, means posts.
    const oneArgument = /CREATE OR REPLACE FUNCTION public\.search_corrected_query\(p_query text\)[\s\S]*?\n\$function\$;/.exec(statements);
    expect(oneArgument?.[0]).toMatch(/AS \$function\$\s+SELECT public\.search_corrected_query\(p_query, false\);\s+\$function\$;$/);
    expect(newestDefinition('search_corrected_query').file).toBe(MIGRATION);
    const posts = newestDefinition('search_public_posts');
    expect(posts.file).toBe('20261112174210_search_entities_filters_corrected_reading.sql');
    expect(posts.definition).toContain('v_corrected := public.search_corrected_query(v_query);');
    // Recipe search, in the list and the recheck, reads recipes' words.
    for (const name of ['list_marketplace_resource_bundles', 'marketplace_search_texts_match']) {
      const { definition } = newestDefinition(name);
      expect(definition, name).toContain('public.search_corrected_query(v_query, true)');
      expect(definition, name).not.toMatch(/search_corrected_query\(v_query\)/);
    }
  });

  it('keeps every function the service role’s', () => {
    for (const signature of [
      'public.marketplace_search_vector(text)',
      'public.marketplace_search_texts_match(text[], text)',
      'public.search_corrected_query(text, boolean)',
      'public.search_corrected_query(text)',
    ]) {
      expect(statements).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`);
      expect(statements).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`);
    }
    expect(statements).toMatch(
      /REVOKE ALL ON FUNCTION public\.list_marketplace_resource_bundles\(text, text, text, text, text, integer, integer\)\s+FROM PUBLIC, anon, authenticated;\s+GRANT EXECUTE ON FUNCTION public\.list_marketplace_resource_bundles\(text, text, text, text, text, integer, integer\)\s+TO service_role;/,
    );
    expect(newestDefinition('list_marketplace_resource_bundles').definition).toMatch(/STABLE\s+SECURITY DEFINER\s+SET search_path TO 'public', 'pg_temp'/);
  });

  it('runs as one transaction that gives up on a busy table, and never drops a trigger or function', () => {
    expect(statements.trim()).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '5s';/);
    expect(statements).toMatch(
      /LOCK TABLE public\.posts IN SHARE ROW EXCLUSIVE MODE;\s+LOCK TABLE public\.post_resource_bundles IN SHARE ROW EXCLUSIVE MODE;\s+LOCK TABLE public\.marketplace_bundle_search_documents IN ACCESS EXCLUSIVE MODE;\s+LOCK TABLE public\.search_terms IN ACCESS EXCLUSIVE MODE;/,
    );
    expect(statements).not.toMatch(/DROP (?:TRIGGER|FUNCTION)/i);
    expect(statements.trim()).toMatch(/COMMIT;$/);
  });

  it('has the app recheck a searched page on the text its cards show, counting a dropped row', () => {
    expect(serverSource).toMatch(
      /adminSupabase\.rpc\('marketplace_search_texts_match', \{\s+p_texts: unsure\.map\(\(\{ text \}\) => text\),\s+p_query: normalizedQuery,\s+\}\)/,
    );
    expect(serverSource).toMatch(/const text = marketplaceItemSearchText\(item\);/);
    expect(serverSource).toContain('&& (searchMatchedIds === null || searchMatchedIds.has(item.id));');
    // A dropped row still occupies its raw position.
    expect(serverSource).toMatch(/consumedRowCount \+= 1;\s+if \(isEligible\) \{\s+pageItems\.push\(item\);/);
    expect(serverSource).toContain('nextOffset: hasMore ? offset + consumedRowCount : null,');
  });
});
