import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isGeneratedRecipeSetupText, sanitizePublicPostContent } from '@/lib/post-public-content';

const migrationsDirectory = 'supabase/migrations';
const migrationFile = '20261101042650_marketplace_list_public_read_rules.sql';
// Every migration's statements, comments left out: a header may quote SQL.
const statementsOf = (file: string) => readFileSync(join(migrationsDirectory, file), 'utf8').replace(/--.*$/gm, '');
const statements = statementsOf(migrationFile);
const migrationFiles = readdirSync(migrationsDirectory).filter((file) => file.endsWith('.sql')).sort();
const serverSource = readFileSync('src/lib/post-resource-bundles-server.ts', 'utf8');
const pgtap = readFileSync('supabase/tests/database/marketplace_list_public_read_rules.test.sql', 'utf8');

type Kind = 'FUNCTION' | 'TRIGGER';

/** The named function's or trigger's CREATE [OR REPLACE] statement in this source, the last if it has several. */
function definitionIn(source: string, kind: Kind, name: string): string | null {
  if (kind === 'TRIGGER') {
    const matches = [...source.matchAll(new RegExp(`CREATE (?:OR REPLACE )?TRIGGER ${name}\\b[\\s\\S]*?;`, 'g'))];
    return matches.length ? matches[matches.length - 1][0] : null;
  }
  const starts = [...source.matchAll(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(`, 'g'))];
  if (!starts.length) return null;
  const start = starts[starts.length - 1].index!;
  const tag = /\bAS (\$[a-z_]*\$)/.exec(source.slice(start));
  if (!tag) throw new Error(`${name} has no dollar-quoted body`);
  const bodyStart = start + tag.index + tag[0].length;
  return source.slice(start, source.indexOf(`${tag[1]};`, bodyStart) + tag[1].length + 1);
}

/** The named definition in this file. */
function current(kind: Kind, name: string): string {
  const definition = definitionIn(statements, kind, name);
  expect(definition, `${name} is not made here`).not.toBeNull();
  return definition!;
}

/**
 * The named definition as the migrations up to `before` (or all of them) left
 * it, whichever file made it last: each redefinition must carry every
 * earlier one.
 */
function latest(kind: Kind, name: string, before?: string): string {
  const definitions = migrationFiles
    .filter((file) => before === undefined || file < before)
    .flatMap((file) => definitionIn(statementsOf(file), kind, name) ?? []);
  expect(definitions.length, `${name} is never made`).toBeGreaterThan(0);
  return definitions[definitions.length - 1];
}

function columnsRead(alias: string, source: string): string[] {
  const columns = [...source.matchAll(new RegExp(`\\b${alias}\\.([a-z_]+)`, 'g'))].map((match) => match[1]);
  return [...new Set(columns)].filter((column) => column !== 'id').sort();
}

function columnsFollowed(trigger: string): string[] {
  return [...trigger.matchAll(/OLD\.([a-z_]+) IS DISTINCT FROM NEW\.\1/g)].map((match) => match[1]).sort();
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', f: '\f', '\\': '\\', "'": "'" };

/** A Postgres E'' string's body as the server reads it (the escapes these files use). */
function decodeEscapeString(source: string): string {
  return source.replace(/\\(u[0-9a-fA-F]{4}|[ntrf\\'])/g, (_escape, code: string) => (
    code.startsWith('u') ? String.fromCharCode(parseInt(code.slice(1), 16)) : ESCAPES[code]
  ));
}

const comparable = (definition: string) => definition.replace(/^CREATE (?:OR REPLACE )?(FUNCTION|TRIGGER)/, 'CREATE $1');
const rule = current('FUNCTION', 'recipe_post_public_body');

// supabase/tests/database/marketplace_list_public_read_rules.test.sql runs the
// rule, both projections, their triggers and the list; this file holds them to
// the app code they mirror and to the definitions they replace, and pins how
// the file takes its locks.
describe('marketplace list public read rules migration', () => {
  it('reads a recipe’s post body by sanitizePublicPostContent’s rule', () => {
    // Under a paid recipe only, as the feed passes isPaidRecipe.
    expect(rule).toMatch(
      /WHEN p_access_mode = 'paid'\s+AND lower\(btrim\(split_part\(btrim\(replace\(p_body, E'\\r\\n', E'\\n'\), trim_set\.chars\), E'\\n', 1\), trim_set\.chars\) COLLATE pg_catalog\."C"\)\s+= 'saved generation setup'\s+THEN NULL\s+ELSE p_body\s+END/,
    );
    const heading = /= '([^']+)'\s+THEN NULL/.exec(rule)?.[1] ?? '';
    expect(isGeneratedRecipeSetupText(heading)).toBe(true);
    expect(heading).toBe(heading.trim().toLowerCase());
    const caption = `${heading}\nModel: Nano Banana 2`;
    const shown = (isPaidRecipe: boolean) => sanitizePublicPostContent({
      body: caption, description: '', prompt: '', hasRecipe: true, isPaidRecipe,
    }).body;
    expect([shown(true), shown(false)]).toEqual(['', caption]);
  });

  it('trims what String.prototype.trim trims, and nothing else', () => {
    const literal = /SELECT E'((?:[^'\\]|\\.)*)'::text AS chars/.exec(rule)?.[1];
    expect(literal).toBeDefined();
    // Written as escapes: a raw U+2028 reads as a line break to editors.
    expect(literal).toMatch(/^[\x20-\x7e]+$/);
    const trimmed = [...new Set(decodeEscapeString(literal!))].map((character) => character.codePointAt(0)!).sort((a, b) => a - b);
    // Every character JavaScript trims lies in the Basic Multilingual Plane.
    const javascript: number[] = [];
    for (let codePoint = 0; codePoint <= 0xffff; codePoint += 1) {
      if (String.fromCharCode(codePoint).trim() === '') javascript.push(codePoint);
    }

    expect(trimmed).toEqual(javascript);
  });

  it('drops the captions the app drops, spelling by spelling', () => {
    const spellings = [...pgtap.matchAll(/\('(\d\d)', E'((?:[^'\\]|\\.)*)', '([a-z]+)', (true|false),/g)].map((match) => ({
      suffix: match[1],
      body: decodeEscapeString(match[2]),
      word: match[3],
      dropped: match[4] === 'true',
    }));

    expect(spellings).toHaveLength(13);
    for (const { suffix, body, word, dropped } of spellings) {
      expect([suffix, body.endsWith(word), isGeneratedRecipeSetupText(body)]).toEqual([suffix, true, dropped]);
    }
    expect(new Set(spellings.map(({ dropped }) => dropped))).toEqual(new Set([true, false]));
  });

  it('shows a recipe’s post that way in the app, and judges its listing on the post as stored', () => {
    // loadLinkedPostMap reads each post as stored and as a paid recipe's post shows it.
    expect(serverSource).toMatch(
      /const \{ body: bodyUnderPaidRecipe \} = sanitizePublicPostContent\(\{\s+body: post\.body,\s+description: '',\s+prompt: '',\s+hasRecipe: true,\s+isPaidRecipe: true,\s+\}\);/,
    );
    expect(serverSource).toContain("title: row.title?.trim() || deriveTitleFromBody(bodyUnderPaidRecipe) || (row.post_format === 'text' ? 'Untitled note' : 'Untitled creation'),");
    // Shown that way to everyone but the owner, and only under a paid recipe.
    expect(serverSource).toContain("const post = (scope !== 'owner' && row.access_mode === 'paid' ? read?.underPaidRecipe : read?.post) ?? null;");
    expect(serverSource).toContain('return { item, storedPost: read?.post ?? null };');
    // The list and its fallback judge quality on the post as stored, as the
    // database's listing gate does.
    expect(serverSource).toContain('post: hydrated?.storedPost ?? item.post,');
    expect(serverSource).toContain('post: storedPost ?? item.post,');
  });

  it('projects the search document as the migration before it left it, but for the post’s caption', () => {
    const previous = latest('FUNCTION', 'refresh_marketplace_bundle_search_documents', migrationFile);
    const projection = current('FUNCTION', 'refresh_marketplace_bundle_search_documents');

    expect(comparable(projection)).toBe(comparable(previous).replace(
      "nullif(btrim(posts.body), ''),",
      "nullif(btrim(public.recipe_post_public_body(posts.body, bundles.access_mode)), ''),",
    ));
    expect(projection).not.toBe(previous);
  });

  it('refreshes a document when its recipe’s access mode changes', () => {
    const previous = latest('TRIGGER', 'post_resource_bundles_refresh_marketplace_search_update', migrationFile);
    const trigger = current('TRIGGER', 'post_resource_bundles_refresh_marketplace_search_update');
    const after = '    OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id\n';

    expect(comparable(trigger)).toBe(comparable(previous).replace(after, `${after}    OR OLD.access_mode IS DISTINCT FROM NEW.access_mode\n`));
    expect(columnsFollowed(trigger)).toEqual(columnsRead('bundles', current('FUNCTION', 'refresh_marketplace_bundle_search_documents')));
  });

  it('keeps the listing as the migration before it left it, but for the posts public reads do not show', () => {
    const previous = latest('FUNCTION', 'refresh_marketplace_bundle_listings', migrationFile);
    const listing = current('FUNCTION', 'refresh_marketplace_bundle_listings');

    expect(comparable(listing)).toBe(comparable(previous).replace(
      "      AND coalesce(posts.review_status, 'visible') <> 'hidden'\n",
      "      AND coalesce(posts.review_status, 'visible') = 'visible'\n      AND posts.is_nsfw = false\n",
    ));
    expect(listing).not.toBe(previous);
    // The app's marketplace read shows only visible, unarchived public posts.
    expect(serverSource).toContain("query = query.eq('visibility', 'public').is('archived_at', null).eq('review_status', 'visible');");
    expect(statements).toMatch(
      /COMMENT ON COLUMN public\.marketplace_bundle_listings\.listable IS\s+'[^']*post review status ''visible'' \+ not NSFW-labelled \+/,
    );
  });

  it('recomputes a listing on every post column it reads, the label among them, and on no hot counter', () => {
    const previous = latest('TRIGGER', 'posts_refresh_marketplace_listing', migrationFile);
    const trigger = current('TRIGGER', 'posts_refresh_marketplace_listing');
    const last = '    OR OLD.source_tool IS DISTINCT FROM NEW.source_tool\n';

    expect(comparable(trigger)).toBe(comparable(previous).replace(last, `${last}    OR OLD.is_nsfw IS DISTINCT FROM NEW.is_nsfw\n`));
    // Whichever later file re-creates either.
    expect(columnsFollowed(latest('TRIGGER', 'posts_refresh_marketplace_listing')))
      .toEqual(columnsRead('posts', latest('FUNCTION', 'refresh_marketplace_bundle_listings')));
    for (const counter of ['save_count', 'comment_count', 'share_count', 'report_count', 'remix_count']) {
      expect(trigger).not.toContain(counter);
    }
  });

  it('runs both projections as their owner and the rule as a pure function, each callable by the service role only', () => {
    expect(rule).toMatch(/RETURNS text\s+LANGUAGE sql\s+IMMUTABLE\s+PARALLEL SAFE\s+SET search_path = ''/);
    expect(current('FUNCTION', 'refresh_marketplace_bundle_search_documents')).toMatch(/RETURNS void\s+LANGUAGE sql\s+SECURITY DEFINER\s+SET search_path = ''/);
    expect(current('FUNCTION', 'refresh_marketplace_bundle_listings')).toMatch(/RETURNS void\s+LANGUAGE sql\s+SECURITY DEFINER\s+SET search_path TO 'public', 'pg_temp'/);
    for (const signature of [
      'public.recipe_post_public_body(text, text)',
      'public.refresh_marketplace_bundle_search_documents(uuid[])',
      'public.refresh_marketplace_bundle_listings(uuid[])',
    ]) {
      expect(statements).toContain(`REVOKE ALL ON FUNCTION ${signature}\n  FROM PUBLIC, anon, authenticated;`);
      expect(statements).toContain(`GRANT EXECUTE ON FUNCTION ${signature}\n  TO service_role;`);
    }
  });

  it('runs as one transaction that gives up on a busy table, and re-projects the rows the rules can change last', () => {
    // The CLI applies a file's statements outside a transaction block, where
    // SET LOCAL does nothing and LOCK TABLE is refused.
    expect(statements.trim()).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '5s';/);
    // posts before its recipes, the order the publish and edit routes lock in.
    expect(statements).toMatch(
      /LOCK TABLE public\.posts IN SHARE ROW EXCLUSIVE MODE;\s+LOCK TABLE public\.post_resource_bundles IN SHARE ROW EXCLUSIVE MODE;\s+CREATE OR REPLACE FUNCTION public\.recipe_post_public_body/,
    );
    // DROP TRIGGER takes ACCESS EXCLUSIVE, which would stop every read of posts.
    expect(statements).not.toMatch(/DROP (?:TRIGGER|FUNCTION)/i);
    expect(statements.match(/CREATE (?:OR REPLACE )?TRIGGER/g)).toEqual(['CREATE OR REPLACE TRIGGER', 'CREATE OR REPLACE TRIGGER']);
    // The listings of recipes on posts that are NSFW-labelled or not visible,
    // then the documents of paid recipes.
    expect(statements.trim()).toMatch(
      /SELECT public\.refresh_marketplace_bundle_listings\(ARRAY\(\s+SELECT bundles\.id\s+FROM public\.post_resource_bundles AS bundles\s+JOIN public\.posts AS posts ON posts\.id = bundles\.post_id\s+WHERE posts\.is_nsfw OR posts\.review_status IS DISTINCT FROM 'visible'\s+\)\);\s+SELECT public\.refresh_marketplace_bundle_search_documents\(ARRAY\(\s+SELECT bundles\.id\s+FROM public\.post_resource_bundles AS bundles\s+WHERE bundles\.access_mode = 'paid'\s+\)\);\s+COMMIT;$/,
    );
  });
});
