import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isGeneratedRecipeSetupText, sanitizePublicPostContent } from '@/lib/post-public-content';

const migrationsDirectory = 'supabase/migrations';
const sql = readFileSync(join(migrationsDirectory, '20261101042650_marketplace_list_public_read_rules.sql'), 'utf8');
// The statements alone: the header names what the functions no longer do.
const statements = sql.replace(/--.*$/gm, '');
const serverSource = readFileSync('src/lib/post-resource-bundles-server.ts', 'utf8');
const pgtap = readFileSync('supabase/tests/database/marketplace_list_public_read_rules.test.sql', 'utf8');

function readMigration(name: string) {
  return readFileSync(join(migrationsDirectory, name), 'utf8');
}

/** One function's CREATE [OR REPLACE] statement, through its closing dollar quote. */
function functionDefinition(source: string, name: string) {
  const match = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(`).exec(source);
  expect(match, `${name} is not defined`).not.toBeNull();
  const start = match!.index;
  const tag = /\bAS (\$[a-z_]*\$)/.exec(source.slice(start));
  if (!tag) throw new Error(`${name} has no dollar-quoted body`);
  const bodyStart = start + tag.index + tag[0].length;
  return source.slice(start, source.indexOf(`${tag[1]};`, bodyStart) + tag[1].length + 1);
}

/** One trigger's CREATE [OR REPLACE] statement. */
function triggerDefinition(source: string, name: string) {
  const match = new RegExp(`CREATE (?:OR REPLACE )?TRIGGER ${name}\\b[\\s\\S]*?;`).exec(source);
  expect(match, `${name} is not made`).not.toBeNull();
  return match![0];
}

/** The last statement in any migration that makes the named trigger. */
function latestTrigger(name: string): string {
  const definitions = readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .flatMap((file) => {
      const source = readMigration(file).replace(/--.*$/gm, '');
      return new RegExp(`CREATE (?:OR REPLACE )?TRIGGER ${name}\\b`).test(source) ? [triggerDefinition(source, name)] : [];
    });
  expect(definitions.length, `${name} is never made`).toBeGreaterThan(0);
  return definitions[definitions.length - 1];
}

function columnsRead(source: string, alias: string): string[] {
  const columns = [...source.matchAll(new RegExp(`\\b${alias}\\.([a-z_]+)`, 'g'))].map((match) => match[1]);
  return [...new Set(columns)].filter((column) => column !== 'id').sort();
}

function columnsFollowed(trigger: string): string[] {
  return [...trigger.matchAll(/OLD\.([a-z_]+) IS DISTINCT FROM NEW\.\1/g)].map((match) => match[1]).sort();
}

/** A Postgres E'' string's body as the server reads it (the escapes these files use). */
function decodeEscapeString(source: string): string {
  return source.replace(/\\(u[0-9a-fA-F]{4}|[ntrf\\'])/g, (_escape, code: string) => {
    if (code.startsWith('u')) return String.fromCharCode(parseInt(code.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r', f: '\f', '\\': '\\', "'": "'" }[code] as string;
  });
}

const comparable = (definition: string) => definition.replace(/^CREATE (?:OR REPLACE )?(FUNCTION|TRIGGER)/, 'CREATE $1');
const rule = functionDefinition(statements, 'recipe_post_public_body');

// supabase/tests/database/marketplace_list_public_read_rules.test.sql runs the
// rule, both projections, their triggers and the list; this file holds them to
// the app code they mirror and to the definitions they replace, and pins how
// the file takes its locks.
describe('marketplace list public read rules migration', () => {
  it('reads a recipe’s post body by sanitizePublicPostContent’s rule', () => {
    // Under a paid recipe only, as the feed passes isPaidRecipe.
    expect(rule).toMatch(/WHEN p_access_mode = 'paid'\s+AND lower\(btrim\(split_part\(btrim\(replace\(p_body, E'\\r\\n', E'\\n'\), trim_set\.chars\), E'\\n', 1\), trim_set\.chars\)\)\s+= 'saved generation setup'\s+THEN NULL\s+ELSE p_body\s+END/);
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
    const trimmed = [...new Set(decodeEscapeString(literal!))].map((character) => character.codePointAt(0)!).sort((a, b) => a - b);
    // Every character JavaScript trims lies in the Basic Multilingual Plane.
    const javascript: number[] = [];
    for (let codePoint = 0; codePoint <= 0xffff; codePoint += 1) {
      if (String.fromCharCode(codePoint).trim() === '') javascript.push(codePoint);
    }

    expect(trimmed).toEqual(javascript);
  });

  it('drops the same captions the app drops, as the database test spells them', () => {
    const spellings = [...pgtap.matchAll(/\('(\d\d)', E'((?:[^'\\]|\\.)*)'\)/g)].map((match) => ({
      suffix: match[1],
      body: decodeEscapeString(match[2]),
    }));
    // Each spelling's post and its recipe, which is paid.
    const recipeOf = new Map([...pgtap.matchAll(/\('(\d\d)', '(\d\d)', 'paid', 'Spelling recipe \2'/g)].map((match) => [match[2], match[1]]));
    expect(spellings).toHaveLength(12);

    const outcomes = spellings.map(({ suffix, body }) => {
      const word = /([a-z]+)$/.exec(body)?.[1] ?? '';
      const document = `pg_temp\\.document\\('0000f5e1-0000-4000-9000-0000000000${recipeOf.get(suffix)}'::uuid\\)`;
      const dropped = new RegExp(`select is\\(position\\('${word}' in ${document}\\), 0,`).test(pgtap);
      const kept = new RegExp(`select ok\\(position\\('${word}' in ${document}\\) > 0,`).test(pgtap);
      expect([suffix, word, recipeOf.has(suffix), dropped !== kept]).toEqual([suffix, word, true, true]);
      return [suffix, isGeneratedRecipeSetupText(body), dropped];
    });

    expect(outcomes.map(([suffix, app]) => [suffix, app])).toEqual(outcomes.map(([suffix, , database]) => [suffix, database]));
    expect(new Set(outcomes.map(([, app]) => app))).toEqual(new Set([true, false]));
  });

  it('reads every recipe’s post that way in the app, for the card, search and the quality check', () => {
    expect(serverSource).toMatch(
      /const recipeAccessMode = recipeAccessModes\.get\(row\.id\);\s+const \{ body \} = sanitizePublicPostContent\(\{\s+body: row\.body\?\.trim\(\) \|\| '',\s+description: '',\s+prompt: '',\s+hasRecipe: recipeAccessMode !== undefined,\s+isPaidRecipe: recipeAccessMode === 'paid',\s+\}\);/,
    );
    expect(serverSource).toContain("title: row.title?.trim() || deriveTitleFromBody(body) || (row.post_format === 'text' ? 'Untitled note' : 'Untitled creation'),");
    // hydrateBundleRows, for every scope: each row's post under its recipe's access mode.
    expect(serverSource).toMatch(
      /loadLinkedPostMap\(\s+rows\.map\(\(row\) => row\.post_id\),\s+postScope,\s+includeMediaPreviews,\s+throwOnPostReadError,\s+new Map\(rows\.map\(\(row\) => \[row\.post_id, row\.access_mode\]\)\),\s+\)/,
    );
  });

  it('projects the search document as 20261031100330 did, but for the post’s caption', () => {
    const previous = functionDefinition(readMigration('20261031100330_marketplace_search_indexes_public_text.sql'), 'refresh_marketplace_bundle_search_documents');
    const current = functionDefinition(sql, 'refresh_marketplace_bundle_search_documents');

    expect(comparable(current)).toBe(comparable(previous).replace(
      "nullif(btrim(posts.body), ''),",
      "nullif(btrim(public.recipe_post_public_body(posts.body, bundles.access_mode)), ''),",
    ));
    expect(current).not.toBe(previous);
  });

  it('refreshes a document whenever a column it reads changes', () => {
    const projection = functionDefinition(statements, 'refresh_marketplace_bundle_search_documents');
    const recipeTrigger = latestTrigger('post_resource_bundles_refresh_marketplace_search_update');

    expect(recipeTrigger).toBe(triggerDefinition(statements, 'post_resource_bundles_refresh_marketplace_search_update'));
    expect(columnsFollowed(recipeTrigger)).toContain('access_mode');
    expect(columnsFollowed(recipeTrigger)).toEqual(columnsRead(projection, 'bundles'));
    expect(columnsFollowed(latestTrigger('posts_refresh_marketplace_search'))).toEqual(columnsRead(projection, 'posts'));
    expect(columnsFollowed(latestTrigger('profiles_refresh_marketplace_search'))).toEqual(columnsRead(projection, 'profiles'));
  });

  it('keeps the listing as 20260809210000 made it, but for the NSFW label and the caption its quality gate reads', () => {
    const previous = functionDefinition(readMigration('20260809210000_marketplace_bundle_listings.sql'), 'refresh_marketplace_bundle_listings');
    const current = functionDefinition(sql, 'refresh_marketplace_bundle_listings');
    const gate = "      AND coalesce(posts.review_status, 'visible') <> 'hidden'\n";

    expect(comparable(current)).toBe(comparable(previous)
      .replace(gate, `${gate}      AND posts.is_nsfw = false\n`)
      .replace('        posts.body,\n', '        public.recipe_post_public_body(posts.body, bundles.access_mode),\n'));
    expect(current).not.toBe(previous);
  });

  it('recomputes a listing on every post column it reads, the label among them, and on no hot counter', () => {
    const listing = functionDefinition(statements, 'refresh_marketplace_bundle_listings');
    const previous = triggerDefinition(readMigration('20260809210000_marketplace_bundle_listings.sql'), 'posts_refresh_marketplace_listing');
    const current = triggerDefinition(statements, 'posts_refresh_marketplace_listing');
    const last = '    OR OLD.source_tool IS DISTINCT FROM NEW.source_tool\n';

    expect(comparable(current)).toBe(comparable(previous).replace(last, `${last}    OR OLD.is_nsfw IS DISTINCT FROM NEW.is_nsfw\n`));
    expect(columnsFollowed(latestTrigger('posts_refresh_marketplace_listing'))).toEqual(columnsRead(listing, 'posts'));
    for (const counter of ['save_count', 'comment_count', 'share_count', 'report_count', 'remix_count']) {
      expect(current).not.toContain(counter);
    }
    // A recipe edit already recomputes its listing on its access mode.
    expect(latestTrigger('post_resource_bundles_refresh_marketplace_listing_update')).toContain('OLD.access_mode IS DISTINCT FROM NEW.access_mode');
  });

  it('runs both projections as their owner and the rule as a pure function, each callable by the service role only', () => {
    expect(rule).toMatch(/RETURNS text\s+LANGUAGE sql\s+IMMUTABLE\s+PARALLEL SAFE\s+SET search_path = ''/);
    expect(functionDefinition(statements, 'refresh_marketplace_bundle_search_documents')).toMatch(/RETURNS void\s+LANGUAGE sql\s+SECURITY DEFINER\s+SET search_path = ''/);
    expect(functionDefinition(statements, 'refresh_marketplace_bundle_listings')).toMatch(/RETURNS void\s+LANGUAGE sql\s+SECURITY DEFINER\s+SET search_path TO 'public', 'pg_temp'/);
    for (const signature of [
      'public.recipe_post_public_body(text, text)',
      'public.refresh_marketplace_bundle_search_documents(uuid[])',
      'public.refresh_marketplace_bundle_listings(uuid[])',
    ]) {
      expect(statements).toContain(`REVOKE ALL ON FUNCTION ${signature}\n  FROM PUBLIC, anon, authenticated;`);
      expect(statements).toContain(`GRANT EXECUTE ON FUNCTION ${signature}\n  TO service_role;`);
    }
  });

  it('runs as one transaction that gives up on a busy table, and re-projects every listing and document last', () => {
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
    expect(statements.trim()).toMatch(
      /SELECT public\.refresh_marketplace_bundle_listings\(NULL\);\s+SELECT public\.refresh_marketplace_bundle_search_documents\(NULL\);\s+COMMIT;$/,
    );
  });
});
