import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getPostResourceKinds,
  POST_RESOURCE_ITEM_TYPES,
  POST_RESOURCE_KIND_ORDER,
  resolveRecipeAllowRemix,
} from '@/lib/post-resource-bundles';

const migrationsDirectory = 'supabase/migrations';
const migrationFile = '20261101040316_marketplace_filter_card_kinds.sql';
const sql = readFileSync(join(migrationsDirectory, migrationFile), 'utf8');
// The statements alone: the header names the legacy columns the flags no longer read.
const statements = sql.replace(/--.*$/gm, '');
const serverSource = readFileSync('src/lib/post-resource-bundles-server.ts', 'utf8');
// This file and the ones before it: a later migration has its own test.
const migrationsSoFar = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith('.sql') && file <= migrationFile)
  .sort();

function readMigration(name: string) {
  return readFileSync(join(migrationsDirectory, name), 'utf8');
}

/** One function's last CREATE [OR REPLACE] statement in `source`, through its closing dollar quote. */
function functionDefinition(source: string, name: string) {
  const matches = [...source.matchAll(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(`, 'g'))];
  expect(matches.length, `${name} is not defined`).toBeGreaterThan(0);
  const start = matches[matches.length - 1].index;
  const tag = /\bAS (\$[a-z_]*\$)/.exec(source.slice(start));
  if (!tag) throw new Error(`${name} has no dollar-quoted body`);
  const bodyStart = start + tag.index + tag[0].length;
  return source.slice(start, source.indexOf(`${tag[1]};`, bodyStart) + tag[1].length + 1);
}

/** A definition without comments, on one line, as CREATE FUNCTION. */
function comparable(definition: string) {
  return definition
    .replace(/--.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^CREATE (?:OR REPLACE )?FUNCTION/, 'CREATE FUNCTION');
}

/** The text from the first `from` up to the first `to` after it. */
function between(source: string, from: string, to: string) {
  const start = source.indexOf(from);
  expect(start, `${from} is missing`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start);
  expect(end, `${to} is missing`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function quotedItems(source: string): string[] {
  return [...source.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

function columnsRead(definition: string, alias: string): string[] {
  const columns = [...comparable(definition).matchAll(new RegExp(`\\b${alias}\\.([a-z_]+)`, 'g'))].map((match) => match[1]);
  return [...new Set(columns)].filter((column) => column !== 'id').sort();
}

function columnsFollowed(trigger: string): string[] {
  return [...trigger.matchAll(/OLD\.([a-z_]+) IS DISTINCT FROM NEW\.\1/g)].map((match) => match[1]).sort();
}

/**
 * The function as the migrations before this one leave it. Compared against
 * that, not a named file: a migration that redefines it first (another
 * branch's, merged before this one) must be carried here, or the diff shows
 * its change dropped.
 */
function previousDefinition(name: string) {
  const pattern = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(`);
  const file = migrationsSoFar.filter((candidate) => candidate < migrationFile && pattern.test(readMigration(candidate))).at(-1);
  expect(file, `${name} is never defined before this migration`).toBeDefined();
  return comparable(functionDefinition(readMigration(file!), name));
}

/** The last statement in this migration or one before it that makes the named trigger. */
function latestTrigger(name: string): string {
  const pattern = new RegExp(`CREATE (?:OR REPLACE )?TRIGGER ${name}\\b[\\s\\S]*?;`, 'g');
  const definitions = migrationsSoFar
    .flatMap((file) => [...readMigration(file).replace(/--.*$/gm, '').matchAll(pattern)].map((match) => match[0]));
  expect(definitions.length, `${name} is never made`).toBeGreaterThan(0);
  return definitions[definitions.length - 1];
}

const kinds = comparable(functionDefinition(sql, 'post_resource_bundle_kinds'));
const kindsBody = between(kinds, 'AS $function$ ', ' $function$;').slice('AS $function$ '.length);
const listing = functionDefinition(sql, 'refresh_marketplace_bundle_listings');
const searchDocument = functionDefinition(sql, 'refresh_marketplace_bundle_search_documents');
const kindsCall = 'public.post_resource_bundle_kinds( bundles.resource_items, bundles.allow_remix, bundles.status, posts.generation_id )';

// supabase/tests/database/marketplace_filter_card_kinds.test.sql runs the
// filter, its triggers and the search beside it; this file holds the rule to
// the app code it mirrors, keeps both projections otherwise as they were, and
// pins how the file takes its locks.
describe('marketplace filter card kinds migration', () => {
  it('lists the kinds in the order the app lists them', () => {
    expect([...kinds.matchAll(/THEN '([a-z]+)'/g)].map((match) => match[1])).toEqual(POST_RESOURCE_KIND_ORDER);
    expect(kinds).toMatch(/^CREATE FUNCTION public\.post_resource_bundle_kinds\( p_resource_items jsonb, p_allow_remix boolean, p_status text, p_post_generation_id uuid \) RETURNS text\[\] LANGUAGE sql IMMUTABLE SET search_path = '' AS \$function\$ SELECT array_remove\(ARRAY\[/);
    // A STRICT function returns NULL for a recipe whose switch or creation is
    // NULL, and the listing's NOT NULL flags would refuse that recipe's write.
    expect(kinds).not.toMatch(/\bSTRICT\b|RETURNS NULL ON NULL INPUT|SECURITY DEFINER/);
    // Its arguments only: no table, and none of the legacy columns.
    expect(kindsBody).not.toMatch(/\bpublic\.|prompt_text|notes_markdown|workflow_share_url|workflow_snapshot|attachments/);
  });

  it('gives each item type the kind getPostResourceKinds gives it', () => {
    const knownTypes = quotedItems(/WHERE btrim\(item->>'type'\) IN \(([^)]*)\)/.exec(kinds)?.[1] ?? '');
    const files = quotedItems(/THEN 'workflow' END, CASE WHEN items\.types && ARRAY\[([^\]]*)\] THEN 'files' END/.exec(kinds)?.[1] ?? '');
    const notes = quotedItems(/CASE WHEN items\.types && ARRAY\[([^\]]*)\] THEN 'notes' END/.exec(kinds)?.[1] ?? '');
    const remix = quotedItems(/OR items\.types && ARRAY\[([^\]]*)\]/.exec(kinds)?.[1] ?? '');

    expect([...knownTypes].sort()).toEqual([...POST_RESOURCE_ITEM_TYPES].sort());
    expect(kinds).toContain("CASE WHEN 'prompt' = ANY (items.types) THEN 'prompt' END");
    expect(kinds).toContain("CASE WHEN 'workflow' = ANY (items.types) THEN 'workflow' END");
    for (const type of knownTypes) {
      const sqlKind = type === 'prompt' || type === 'workflow'
        ? type
        : files.includes(type) ? 'files' : notes.includes(type) ? 'notes' : remix.includes(type) ? 'remix' : null;
      expect([type, sqlKind]).toEqual([type, getPostResourceKinds({ items: [{ type }] } as never)[0]]);
    }
  });

  it('holds Remix as hydrateBundleRows resolves it', () => {
    expect(kinds).toContain(
      "CASE WHEN p_allow_remix IS TRUE OR items.types && ARRAY['remix_access', 'remix_link'] OR (p_status = 'published' AND p_post_generation_id IS NOT NULL) THEN 'remix' END",
    );
    // What that rule says, against the function the app calls, called as
    // hydrateBundleRows calls it (no templateResult).
    expect(serverSource).toMatch(
      /resolveRecipeAllowRemix\(\{\s+storedAllowRemix: row\.allow_remix,\s+status: row\.status,\s+generationId: post\?\.generationId \?\? null,\s+\}\)/,
    );
    for (const storedAllowRemix of [true, false, null]) {
      for (const status of ['published', 'draft']) {
        for (const generationId of ['generation-1', null]) {
          const sqlRule = storedAllowRemix === true || (status === 'published' && generationId !== null);
          expect([storedAllowRemix, status, generationId, resolveRecipeAllowRemix({ storedAllowRemix, status, generationId })])
            .toEqual([storedAllowRemix, status, generationId, sqlRule]);
        }
      }
    }
    expect(getPostResourceKinds({ items: [{ type: 'prompt' }], allowRemix: true } as never)).toEqual(['prompt', 'remix']);
  });

  it("holds the search document's kind expression, so no document's text changes", () => {
    const previous = previousDefinition('refresh_marketplace_bundle_search_documents');
    const previousWords = between(previous, "nullif(concat_ws( ' ', CASE WHEN 'prompt'", ' )) FROM public.post_resource_bundles AS bundles');
    const previousItems = between(previous, ' CROSS JOIN LATERAL ( SELECT array_agg', ' WHERE p_bundle_ids IS NULL');
    const previousCases = /^nullif\(concat_ws\( ' ', (.*) \), ''\)$/.exec(previousWords)?.[1];
    const renamed = (expression: string) => expression
      .replaceAll('bundles.resource_items', 'p_resource_items')
      .replaceAll('bundles.allow_remix', 'p_allow_remix')
      .replaceAll('bundles.status', 'p_status')
      .replaceAll('posts.generation_id', 'p_post_generation_id');

    expect(previousCases).toMatch(/^CASE WHEN 'prompt'[\s\S]* THEN 'remix' END$/);
    expect(kindsBody).toBe(
      `SELECT array_remove(ARRAY[ ${renamed(previousCases!)} ], NULL) `
        + `FROM ( ${renamed(previousItems.slice(' CROSS JOIN LATERAL ( '.length))}`,
    );
    // The document as it was, with its kinds read from the function.
    expect(comparable(searchDocument)).toBe(previous
      .replace(previousWords, `nullif(array_to_string(${kindsCall}, ' '), '')`)
      .replace(previousItems, ''));
  });

  it('keeps the listing as it was but for its five filter flags, which read the kinds', () => {
    const previous = previousDefinition('refresh_marketplace_bundle_listings');
    const previousFlags = between(previous, "( nullif(btrim(coalesce(bundles.prompt_text, '')), '') IS NOT NULL", ' FROM public.post_resource_bundles bundles');
    const flags = POST_RESOURCE_KIND_ORDER.map((kind) => `'${kind}' = ANY (resource.kinds)`).join(', ');

    expect(previousFlags).toMatch(/prompt_text[\s\S]*workflow_share_url[\s\S]*attachments[\s\S]*notes_markdown[\s\S]*allow_remix = true/);
    expect(comparable(listing)).toBe(previous
      .replace(previousFlags, flags)
      .replace(
        'LEFT JOIN public.profiles profiles ON profiles.id = bundles.owner_user_id WHERE',
        `LEFT JOIN public.profiles profiles ON profiles.id = bundles.owner_user_id CROSS JOIN LATERAL ${kindsCall} AS resource(kinds) WHERE`,
      ));
    // The flags fill the columns of the same names, in the same order.
    expect(comparable(listing)).toContain(
      `has_${POST_RESOURCE_KIND_ORDER.join(', has_')} ) SELECT`,
    );
  });

  it('refreshes a listing row whenever a column it reads changes, and never on a post counter', () => {
    const postTrigger = latestTrigger('posts_refresh_marketplace_listing');
    const recipeTrigger = latestTrigger('post_resource_bundles_refresh_marketplace_listing_update');
    const profileTrigger = latestTrigger('profiles_refresh_marketplace_listing');

    expect(statements).toContain('CREATE OR REPLACE TRIGGER posts_refresh_marketplace_listing\n');
    expect(postTrigger).toMatch(/AFTER UPDATE ON public\.posts\s+FOR EACH ROW/);
    expect(postTrigger).toContain('EXECUTE FUNCTION public.trg_refresh_marketplace_listing_for_post();');
    expect(columnsFollowed(postTrigger)).toEqual(columnsRead(listing, 'posts'));
    expect(columnsFollowed(postTrigger)).toContain('generation_id');
    for (const counter of ['save_count', 'comment_count', 'share_count', 'report_count', 'remix_count']) {
      expect(postTrigger).not.toContain(counter);
    }
    expect(columnsFollowed(recipeTrigger)).toEqual(columnsRead(listing, 'bundles'));
    expect(columnsFollowed(profileTrigger)).toEqual(columnsRead(listing, 'profiles'));
  });

  it('runs the projections as their owner and lets only the service role call the three functions', () => {
    for (const definition of [listing, searchDocument]) {
      expect(definition).toMatch(/RETURNS void\s+LANGUAGE sql\s+SECURITY DEFINER\s+SET search_path/);
    }
    for (const signature of [
      'public.post_resource_bundle_kinds(jsonb, boolean, text, uuid)',
      'public.refresh_marketplace_bundle_search_documents(uuid[])',
      'public.refresh_marketplace_bundle_listings(uuid[])',
    ]) {
      expect(statements).toContain(`REVOKE ALL ON FUNCTION ${signature}\n  FROM PUBLIC, anon, authenticated;`);
      expect(statements).toContain(`GRANT EXECUTE ON FUNCTION ${signature}\n  TO service_role;`);
    }
  });

  it('runs as one transaction that gives up on a busy table, and re-projects every row last', () => {
    // The CLI applies a file's statements outside a transaction block, where
    // SET LOCAL does nothing and LOCK TABLE is refused.
    expect(statements.trim()).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '5s';/);
    // posts before its recipes, the order the publish and edit routes lock in.
    expect(statements).toMatch(
      /LOCK TABLE public\.posts IN SHARE ROW EXCLUSIVE MODE;\s+LOCK TABLE public\.post_resource_bundles IN SHARE ROW EXCLUSIVE MODE;\s+CREATE OR REPLACE FUNCTION/,
    );
    // DROP TRIGGER takes ACCESS EXCLUSIVE, which would stop every read of posts.
    expect(statements).not.toMatch(/DROP (?:TRIGGER|FUNCTION)/i);
    expect(statements.trim()).toMatch(
      /SELECT public\.refresh_marketplace_bundle_search_documents\(NULL\);\s+SELECT public\.refresh_marketplace_bundle_listings\(NULL\);\s+COMMIT;$/,
    );
  });
});
