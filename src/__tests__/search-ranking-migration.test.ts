import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// What the migration does to real rows is held by
// supabase/tests/database/search_ranking.test.sql: the orderings, the pages,
// the blocks, the call of the app live during the release. This file holds
// the parts a later CREATE OR REPLACE or a retune could quietly undo: no part
// of a score can cross a tier, the text rank stays normalised, both searches
// stay the service role's and read nothing a visitor cannot see, and the
// release-window signature keeps its first five parameters.

const migrationsDirectory = join(process.cwd(), 'supabase/migrations');
const migrationNames = readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort();
const MIGRATION = '20261112103547_search_ranking_tiers_decay_latest.sql';
const migration = readFileSync(join(migrationsDirectory, MIGRATION), 'utf8');
const statements = migration.replace(/--.*$/gm, '');

const POST_SCORE_SIGNATURE = 'public.search_post_score(boolean, boolean, boolean, double precision, double precision, integer, integer, integer, double precision, boolean)';
const CREATOR_SCORE_SIGNATURE = 'public.search_creator_score(boolean, boolean, boolean, boolean, double precision, double precision, integer, integer, boolean)';
const POSTS_SIGNATURE = 'public.search_public_posts(text, uuid, double precision, uuid, integer, timestamptz, text, timestamptz)';
const CREATORS_SIGNATURE = 'public.search_public_creators(text, uuid, double precision, uuid, integer)';

/** `CREATE [OR REPLACE] FUNCTION public.<name>(` through its closing `$function$;`, comments left out. */
function definitionOf(name: string): string {
  const start = statements.search(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(`));
  expect(start, `${name} must be defined`).toBeGreaterThanOrEqual(0);
  const end = statements.indexOf('\n$function$;', start);
  expect(end, `${name} has no closing $function$;`).toBeGreaterThan(start);
  return statements.slice(start, end);
}

/** The newest migration that defines `public.<name>`. */
function newestDefiner(name: string): string {
  const pattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`, 'i');
  const definers = migrationNames.filter((file) => (
    pattern.test(readFileSync(join(migrationsDirectory, file), 'utf8').replace(/--.*$/gm, ''))
  ));
  return definers[definers.length - 1];
}

/** Every `c_<name> CONSTANT double precision := <number>;` of a definition. */
function constantsOf(definition: string): Record<string, number> {
  const constants: Record<string, number> = {};
  for (const [, name, value] of definition.matchAll(/\bc_(\w+) CONSTANT double precision := ([\d.]+);/g)) {
    constants[name] = Number(value);
  }
  return constants;
}

function smallestGap(tiers: number[]): number {
  const steps = [0, ...tiers].sort((left, right) => left - right);
  return Math.min(...steps.slice(1).map((value, index) => value - steps[index]));
}

const BLOCKED_BY_VIEWER = /AND NOT EXISTS \(\s+SELECT 1\s+FROM public\.user_blocks AS blocks\s+WHERE blocks\.blocker_user_id = p_viewer_user_id\s+AND blocks\.blocked_user_id = documents\.creator_user_id\s+\)/g;
const BLOCKED_THE_VIEWER = /AND NOT EXISTS \(\s+SELECT 1\s+FROM public\.user_blocks AS blocks\s+WHERE blocks\.blocker_user_id = documents\.creator_user_id\s+AND blocks\.blocked_user_id = p_viewer_user_id\s+\)/g;

describe('search ranking migration', () => {
  it('runs after the recall and log migrations, as one transaction that gives up on a busy table', () => {
    expect(MIGRATION > '20261112084002').toBe(true);
    expect(statements.trim().startsWith("BEGIN;\nSET LOCAL lock_timeout = '5s';")).toBe(true);
    expect(statements.trim().endsWith('COMMIT;')).toBe(true);
    for (const name of ['search_post_score', 'search_creator_score', 'search_public_posts', 'search_public_creators']) {
      expect(newestDefiner(name), name).toBe(MIGRATION);
    }
  });

  it('holds the post score in one function whose parts cannot cross a tier', () => {
    const definition = definitionOf('search_post_score');
    expect(definition).toMatch(/LANGUAGE plpgsql\s+IMMUTABLE\s+PARALLEL SAFE\s+SET search_path = ''/);
    const c = constantsOf(definition);
    const tiers = [c.tier_title_is_query, c.tier_title_starts_with_query, c.tier_headline_holds_query];
    expect(tiers).toEqual([30, 20, 10]);
    // Every part is its weight times a factor held between 0 and 1.
    const mostInsideATier = c.text_weight + c.similarity_weight + c.engagement_weight + c.freshness_weight + c.follow_weight;
    expect(mostInsideATier).toBeCloseTo(8.8, 10);
    expect(mostInsideATier).toBeLessThan(smallestGap(tiers));
    expect(definition).toContain('c_text_weight * least(greatest(coalesce(p_text_rank, 0.0), 0.0), 1.0)');
    expect(definition).toContain('c_similarity_weight * least(greatest(coalesce(p_similarity, 0.0), 0.0), 1.0)');
    expect(definition).toContain('* least(1.0, ln(1.0 + v_points) / ln(1.0 + c_engagement_full_points))');
    // Engagement decays with the post's age to a floor, never to nothing and never above its weight.
    expect(c.engagement_floor).toBeGreaterThan(0);
    expect(c.engagement_floor).toBeLessThan(1);
    expect(definition).toMatch(
      /c_engagement_floor\s+\+ \(1\.0 - c_engagement_floor\) \* power\(0\.5::double precision, v_age_days \/ c_engagement_half_life_days\)/,
    );
    expect(definition).toContain('c_freshness_weight * power(0.5::double precision, v_age_days / c_freshness_half_life_days)');
    // power() raises on underflow and the age comes from a cursor: it is held to a range first.
    expect(definition).toMatch(/v_age_days double precision := least\(\s+greatest\(coalesce\(p_age_seconds, 0\.0\), 0\.0\) \/ 86400\.0,\s+c_max_age_days\s+\);/);
    expect(c.max_age_days / Math.min(c.engagement_half_life_days, c.freshness_half_life_days)).toBeLessThan(1000);
    // The tiers are exclusive: the highest one a post reaches, never a sum of them.
    expect(definition).toMatch(
      /CASE\s+WHEN coalesce\(p_title_is_query, false\) THEN c_tier_title_is_query\s+WHEN coalesce\(p_title_starts_with_query, false\) THEN c_tier_title_starts_with_query\s+WHEN coalesce\(p_headline_holds_query, false\) THEN c_tier_headline_holds_query\s+ELSE 0\.0\s+END/,
    );
  });

  it('holds the creator score the same way', () => {
    const definition = definitionOf('search_creator_score');
    expect(definition).toMatch(/LANGUAGE plpgsql\s+IMMUTABLE\s+PARALLEL SAFE\s+SET search_path = ''/);
    const c = constantsOf(definition);
    const tiers = [c.tier_handle_is_query, c.tier_handle_starts_with_query, c.tier_name_is_query, c.tier_name_holds_query];
    expect(tiers).toEqual([40, 30, 20, 10]);
    const mostInsideATier = c.text_weight + c.similarity_weight + c.audience_weight + c.activity_weight + c.follow_weight;
    expect(mostInsideATier).toBeLessThan(smallestGap(tiers));
    // The search counts followers no further than where the term is full.
    expect(c.audience_full_followers).toBe(1000);
    expect(definitionOf('search_public_creators')).toMatch(
      /FROM public\.follows AS followers\s+WHERE followers\.following_id = documents\.creator_user_id\s+LIMIT 1000/,
    );
  });

  it('scores posts by that function, on a normalised rank, at the search’s instant', () => {
    const definition = definitionOf('search_public_posts');
    expect(definition).toContain('public.search_post_score(');
    // Flags 1 | 32: divided by the document's length and held below 1, so a
    // caption repeating the query cannot outgrow a title.
    expect(definition).toContain('ts_rank_cd(documents.search_vector, v_tsquery, 1 | 32)');
    expect(definition).not.toMatch(/ts_rank_cd\(documents\.search_vector, v_tsquery\)/);
    // The title and models (A) and the tool names (C); never the caption or prompt (B).
    expect(definition).toMatch(/documents\.tool_normalized = v_query\s+OR ts_filter\(documents\.search_vector, '\{a,c\}'\) @@ v_tsquery/);
    expect(definition).toContain('v_as_of timestamptz := coalesce(p_as_of, now());');
    expect(definition).toContain('extract(epoch FROM (v_as_of - documents.created_at))');
    // The clock is read once, into the instant: nothing else in the search moves with it.
    expect(definition.match(/\bnow\(\)/g)).toHaveLength(1);
    expect(definition).toContain('ORDER BY scored.search_score DESC, scored.post_id ASC');
  });

  it('reads Latest as the same matches newest first, keyset on created_at and id', () => {
    const definition = definitionOf('search_public_posts');
    expect(definition).toContain("IF v_sort NOT IN ('top', 'latest') THEN");
    expect(definition).toMatch(
      /p_after_created_at IS NULL\s+OR documents\.created_at < p_after_created_at\s+OR \(documents\.created_at = p_after_created_at AND documents\.post_id > p_after_id\)/,
    );
    expect(definition).toContain('ORDER BY documents.created_at DESC, documents.post_id ASC');
    expect(definition).toContain(
      'IF (p_after_score IS NOT NULL OR p_after_created_at IS NOT NULL) AND p_after_id IS NULL THEN',
    );
  });

  it('leaves both sides of a block out before the limit, by the two reads loadBlockedCreatorIds makes', () => {
    const posts = definitionOf('search_public_posts');
    // The check that decides how a query is read, the ranked search and Latest.
    expect(posts.match(BLOCKED_BY_VIEWER)).toHaveLength(3);
    expect(posts.match(BLOCKED_THE_VIEWER)).toHaveLength(3);
    expect(posts.match(/posts\.is_nsfw = false/g)).toHaveLength(3);
    const creators = definitionOf('search_public_creators');
    expect(creators.match(BLOCKED_BY_VIEWER)).toHaveLength(1);
    expect(creators.match(BLOCKED_THE_VIEWER)).toHaveLength(1);
    // Every exclusion sits inside the scored set, ahead of ORDER BY and LIMIT.
    expect(posts.lastIndexOf('blocks.blocked_user_id = p_viewer_user_id')).toBeLessThan(posts.lastIndexOf('LIMIT p_limit'));
    expect(creators.lastIndexOf('blocks.blocked_user_id = p_viewer_user_id')).toBeLessThan(creators.lastIndexOf('LIMIT p_limit'));

    // The source of truth for who is blocked: if these two reads change, the SQL above must.
    const moderation = readFileSync(join(process.cwd(), 'src/lib/moderation-service.ts'), 'utf8');
    const loader = moderation.slice(moderation.indexOf('export async function loadBlockedCreatorIds'));
    const body = loader.slice(0, loader.indexOf('\n}\n'));
    expect(body).toMatch(/\.from\('user_blocks'\)\s+\.select\('blocked_user_id'\)\s+\.eq\('blocker_user_id', viewerUserId\)\s+\.in\('blocked_user_id', uniqueCreatorIds\)/);
    expect(body).toMatch(/\.from\('user_blocks'\)\s+\.select\('blocker_user_id'\)\s+\.eq\('blocked_user_id', viewerUserId\)\s+\.in\('blocker_user_id', uniqueCreatorIds\)/);
    expect(body.match(/\.from\('user_blocks'\)/g)).toHaveLength(2);
  });

  it('reads nothing a visitor cannot see', () => {
    const posts = definitionOf('search_public_posts');
    // The document alone carries a post's text (its caption through
    // recipe_post_public_body, 20261111224010); the post row gives counters and the label.
    expect(posts).not.toMatch(/\bposts\.(?:title|body|prompt|description)\b/);
    expect(posts.match(/\bposts\.\w+/g)?.filter((column, index, all) => all.indexOf(column) === index).sort()).toEqual([
      'posts.comment_count', 'posts.id', 'posts.is_nsfw', 'posts.remix_count', 'posts.save_count',
    ]);
    for (const table of posts.match(/\bpublic\.[a-z_]+ AS\b/g) ?? []) {
      expect(['public.post_search_documents AS', 'public.posts AS', 'public.user_blocks AS']).toContain(table);
    }
    const creators = definitionOf('search_public_creators');
    expect(creators).not.toMatch(/\bpublic\.(?:profiles|posts)\b/);
  });

  it('keeps the call of the app live during the release resolving to one function', () => {
    // Dropped and re-created in this transaction: the old five parameters
    // first and in order, the new ones after them, each with a default.
    expect(statements).toMatch(
      /DROP FUNCTION public\.search_public_posts\(text, uuid, double precision, uuid, integer\);\s+CREATE FUNCTION public\.search_public_posts\(\s+p_query text,\s+p_viewer_user_id uuid DEFAULT NULL,\s+p_after_score double precision DEFAULT NULL,\s+p_after_id uuid DEFAULT NULL,\s+p_limit integer DEFAULT 20,\s+p_as_of timestamptz DEFAULT NULL,\s+p_sort text DEFAULT 'top',\s+p_after_created_at timestamptz DEFAULT NULL\s+\)/,
    );
    // One drop and one create: never a second overload beside the first.
    expect(statements.match(/(?:DROP|CREATE(?: OR REPLACE)?) FUNCTION public\.search_public_posts\(/g))
      .toEqual(['DROP FUNCTION public.search_public_posts(', 'CREATE FUNCTION public.search_public_posts(']);
    // Creator search keeps its signature, so it is replaced in place.
    expect(statements).toMatch(
      /CREATE OR REPLACE FUNCTION public\.search_public_creators\(\s+p_query text,\s+p_viewer_user_id uuid DEFAULT NULL,\s+p_after_score double precision DEFAULT NULL,\s+p_after_id uuid DEFAULT NULL,\s+p_limit integer DEFAULT 20\s+\)/,
    );
    expect(statements).not.toContain('DROP FUNCTION public.search_public_creators');
    // What the app sends now.
    const service = readFileSync(join(process.cwd(), 'src/lib/public-search-service.ts'), 'utf8');
    expect(service).toMatch(
      /rpc\('search_public_posts', \{\s+p_query: query,\s+p_viewer_user_id: viewerUserId,\s+p_after_score: after\?\.score \?\? null,\s+p_after_id: after\?\.id \?\? null,\s+p_limit: limit,\s+p_as_of: asOf\.toISOString\(\),\s+p_sort: sort,\s+p_after_created_at: after\?\.createdAt \?\? null,\s+\}\)/,
    );
  });

  it('keeps every function the service role’s, the searches with definer rights and a pinned path', () => {
    for (const signature of [POST_SCORE_SIGNATURE, CREATOR_SCORE_SIGNATURE, POSTS_SIGNATURE, CREATORS_SIGNATURE]) {
      expect(statements, signature).toContain(`REVOKE ALL ON FUNCTION ${signature}\n  FROM PUBLIC, anon, authenticated;`);
      expect(statements, signature).toContain(`GRANT EXECUTE ON FUNCTION ${signature}\n  TO service_role;`);
    }
    for (const name of ['search_public_posts', 'search_public_creators']) {
      expect(definitionOf(name), name).toMatch(/LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path TO 'public', 'pg_temp'/);
    }
    for (const name of ['search_post_score', 'search_creator_score']) {
      expect(definitionOf(name), name).not.toContain('SECURITY DEFINER');
    }
  });

  it('leaves the dictionary, the documents and the report alone, and adds one nullable log column', () => {
    for (const name of [
      'rebuild_search_terms', 'search_corrected_query', 'refresh_post_search_documents',
      'refresh_creator_search_documents', 'search_query_tsquery', 'search_query_report',
      'list_marketplace_resource_bundles',
    ]) {
      expect(statements, name).not.toMatch(new RegExp(`FUNCTION public\\.${name}\\(`));
    }
    expect(statements).not.toMatch(/\b(?:CREATE|DROP) (?:OR REPLACE )?(?:TRIGGER|TABLE|INDEX)\b/);
    expect(statements.match(/ALTER TABLE/g)).toHaveLength(1);
    expect(statements).toContain(
      "ALTER TABLE public.search_query_events\n  ADD COLUMN sort text CHECK (sort IS NULL OR sort IN ('top', 'latest'));",
    );
  });
});
