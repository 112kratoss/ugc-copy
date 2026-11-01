import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getPostResourceKinds,
  POST_RESOURCE_ITEM_TYPES,
  POST_RESOURCE_KIND_ORDER,
  resolveRecipeAllowRemix,
} from '@/lib/post-resource-bundles';
import { getCreatorDisplayName } from '@/lib/profile';

const migrationsDirectory = 'supabase/migrations';
const sql = readFileSync(join(migrationsDirectory, '20261031100330_marketplace_search_indexes_public_text.sql'), 'utf8');
// The statements alone: the header names fields the document no longer reads.
const statements = sql.replace(/--.*$/gm, '');
const projection = statements.slice(
  statements.indexOf('CREATE OR REPLACE FUNCTION public.refresh_marketplace_bundle_search_documents'),
  statements.indexOf('$function$;'),
);
const serverSource = readFileSync('src/lib/post-resource-bundles-server.ts', 'utf8');

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

/** The text inside the parentheses that open at `open`. */
function parenthesized(source: string, open: number) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    if (source[index] === ')') depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  throw new Error('unbalanced parentheses');
}

/** Arguments separated by commas outside parentheses and quotes, whitespace collapsed. */
function topLevelArguments(source: string) {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const character of source) {
    if (character === "'") quoted = !quoted;
    if (!quoted && character === '(') depth += 1;
    if (!quoted && character === ')') depth -= 1;
    if (!quoted && depth === 0 && character === ',') {
      parts.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  return [...parts, current].map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function quotedItems(source: string): string[] {
  return [...source.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

function columnsRead(alias: string, source = projection): string[] {
  const columns = [...source.matchAll(new RegExp(`\\b${alias}\\.([a-z_]+)`, 'g'))].map((match) => match[1]);
  return [...new Set(columns)].filter((column) => column !== 'id').sort();
}

/** The last definition in any migration of the named function, comments left out. */
function latestFunction(name: string): string {
  const definitions = readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .flatMap((file) => {
      const source = readMigration(file).replace(/--.*$/gm, '');
      return new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(`).test(source)
        ? [functionDefinition(source, name)]
        : [];
    });
  expect(definitions.length, `${name} is never made`).toBeGreaterThan(0);
  return definitions[definitions.length - 1];
}

function columnsFollowed(trigger: string): string[] {
  return [...trigger.matchAll(/OLD\.([a-z_]+) IS DISTINCT FROM NEW\.\1/g)].map((match) => match[1]).sort();
}

/** The last statement in any migration that makes the named trigger. */
function latestTrigger(name: string): string {
  const pattern = new RegExp(`CREATE (?:OR REPLACE )?TRIGGER ${name}\\b[\\s\\S]*?;`, 'g');
  const definitions = readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .flatMap((file) => [...readMigration(file).replace(/--.*$/gm, '').matchAll(pattern)].map((match) => match[0]));
  expect(definitions.length, `${name} is never made`).toBeGreaterThan(0);
  return definitions[definitions.length - 1];
}

const documentArguments = topLevelArguments(parenthesized(projection, projection.indexOf('concat_ws(') + 'concat_ws'.length));
const kindWords = documentArguments[documentArguments.length - 1];

// supabase/tests/database/marketplace_search_public_text.test.sql runs the
// projection, its triggers and the list; this file holds them to the app code
// they mirror, and pins how the file takes its locks.
describe('marketplace search indexes public text migration', () => {
  it('projects the text the app checks a listed recipe on, field for field and in its order', () => {
    // [the app's field, the document's expression for it]
    const fields = [
      ['item.title', "CASE WHEN lower(btrim(coalesce(bundles.title, ''))) IN ('', 'attached unlock') THEN 'Recipe' ELSE btrim(bundles.title) END"],
      ['item.summary', "nullif(bundles.summary, '')"],
      ['item.previewText', "nullif(bundles.preview_text, '')"],
      ['item.seller.username', "nullif(profiles.username, '')"],
      ['item.seller.name', "coalesce(nullif(btrim(profiles.display_name), ''), nullif(btrim(profiles.username), ''), 'Creator')"],
      ['item.post?.title', "nullif(btrim(posts.title), '')"],
      ['item.post?.body', "nullif(btrim(posts.body), '')"],
      ['item.post?.sourceTool', "nullif(posts.source_tool, '')"],
      ["item.resourceKinds.join(' ')", kindWords],
    ];
    const appFields = /function marketplaceItemMatchesQuery[\s\S]*?const searchableText = \[([\s\S]*?)\]\s*\.filter\(Boolean\)/.exec(serverSource)?.[1] ?? '';

    expect(appFields.split(',').map((field) => field.trim()).filter(Boolean)).toEqual(fields.map(([app]) => app));
    expect(documentArguments).toEqual(["' '", ...fields.map(([, expression]) => expression)]);
    expect(kindWords).toMatch(/^nullif\(concat_ws\(/);
  });

  it('reads the title and seller name as the card shows them', () => {
    // The card's title: normalizeBundleDisplayTitle, as hydrateBundleRows reads it.
    expect(serverSource).toContain('title: normalizeBundleDisplayTitle(row.title),');
    expect(serverSource).toMatch(
      /function normalizeBundleDisplayTitle\(value: string \| null \| undefined\): string \{\s+const title = value\?\.trim\(\);\s+return !title \|\| \/\^attached unlock\$\/i\.test\(title\) \? 'Recipe' : title;\s+\}/,
    );
    // The seller's name: getCreatorDisplayName with no email, as toSellerSummary calls it.
    expect(serverSource).toMatch(
      /name: getCreatorDisplayName\(\{\s+displayName: profile\?\.display_name \?\? null,\s+username: profile\?\.username \?\? null,\s+\}\)/,
    );
    expect(getCreatorDisplayName({ displayName: '  Maya  ', username: 'maya' })).toBe('Maya');
    expect(getCreatorDisplayName({ displayName: '  ', username: ' maya ' })).toBe('maya');
    expect(getCreatorDisplayName({ displayName: null, username: null })).toBe('Creator');
    // The post's title and caption, trimmed. A post with no title is shown under
    // a fallback the document does not hold (the header says why). Under a paid
    // recipe the card shows the caption as public reads show it since
    // 20261101042650, whose test holds that rule.
    expect(serverSource).toContain("title: row.title?.trim() || deriveTitleFromBody(row.body) || (row.post_format === 'text' ? 'Untitled note' : 'Untitled creation'),");
    expect(serverSource).toContain("body: row.body?.trim() || '',");
  });

  it('reads nothing an unlock gives, nor the legacy columns', () => {
    expect(projection).not.toMatch(/textContent|description|resource_sections|->>'title'/);
    expect(projection).not.toMatch(/prompt_text|notes_markdown|workflow_share_url|workflow_snapshot|attachments/);
  });

  it('ends with the kinds, in the order the app lists them', () => {
    expect([...kindWords.matchAll(/THEN '([a-z]+)'/g)].map((match) => match[1])).toEqual(POST_RESOURCE_KIND_ORDER);
  });

  it('gives each item type the kind getPostResourceKinds gives it', () => {
    const knownTypes = quotedItems(/WHERE btrim\(item->>'type'\) IN \(([^)]*)\)/.exec(projection)?.[1] ?? '');
    const files = quotedItems(/THEN 'workflow' END, CASE WHEN items\.types && ARRAY\[([^\]]*)\] THEN 'files' END/.exec(kindWords)?.[1] ?? '');
    const notes = quotedItems(/CASE WHEN items\.types && ARRAY\[([^\]]*)\] THEN 'notes' END/.exec(kindWords)?.[1] ?? '');
    const remix = quotedItems(/OR items\.types && ARRAY\[([^\]]*)\]/.exec(kindWords)?.[1] ?? '');

    expect([...knownTypes].sort()).toEqual([...POST_RESOURCE_ITEM_TYPES].sort());
    expect(kindWords).toContain("CASE WHEN 'prompt' = ANY (items.types) THEN 'prompt' END");
    expect(kindWords).toContain("CASE WHEN 'workflow' = ANY (items.types) THEN 'workflow' END");
    for (const type of knownTypes) {
      const documentKind = type === 'prompt' || type === 'workflow'
        ? type
        : files.includes(type) ? 'files' : notes.includes(type) ? 'notes' : remix.includes(type) ? 'remix' : null;
      expect([type, documentKind]).toEqual([type, getPostResourceKinds({ items: [{ type }] } as never)[0]]);
    }
  });

  it('holds Remix as hydrateBundleRows resolves it', () => {
    expect(kindWords).toContain(
      "CASE WHEN bundles.allow_remix IS TRUE OR items.types && ARRAY['remix_access', 'remix_link'] OR (bundles.status = 'published' AND posts.generation_id IS NOT NULL) THEN 'remix' END",
    );
    // What that rule says, against the function the app calls, called as
    // hydrateBundleRows calls it (no templateResult).
    expect(serverSource).toMatch(
      /resolveRecipeAllowRemix\(\{\s+storedAllowRemix: row\.allow_remix,\s+status: row\.status,\s+generationId: post\?\.generationId \?\? null,\s+\}\)/,
    );
    for (const storedAllowRemix of [true, false, null]) {
      for (const status of ['published', 'draft']) {
        for (const generationId of ['generation-1', null]) {
          const documentRule = storedAllowRemix === true || (status === 'published' && generationId !== null);
          expect([storedAllowRemix, status, generationId, resolveRecipeAllowRemix({ storedAllowRemix, status, generationId })])
            .toEqual([storedAllowRemix, status, generationId, documentRule]);
        }
      }
    }
    // And the kind it adds to a recipe's items.
    expect(getPostResourceKinds({ items: [{ type: 'prompt' }], allowRemix: true } as never)).toEqual(['prompt', 'remix']);
  });

  it('refreshes a document whenever a column it reads changes', () => {
    // The latest triggers against the latest projection, whichever file made
    // each: a later file that reads another column must follow it too.
    const latestProjection = latestFunction('refresh_marketplace_bundle_search_documents');
    const recipeTrigger = latestTrigger('post_resource_bundles_refresh_marketplace_search_update');
    const postTrigger = latestTrigger('posts_refresh_marketplace_search');
    const profileTrigger = latestTrigger('profiles_refresh_marketplace_search');

    expect(recipeTrigger).toMatch(/AFTER UPDATE ON public\.post_resource_bundles\s+FOR EACH ROW/);
    expect(recipeTrigger).toContain('EXECUTE FUNCTION public.trg_refresh_marketplace_search_for_bundle();');
    expect(columnsFollowed(recipeTrigger)).toEqual(columnsRead('bundles', latestProjection));
    expect(postTrigger).toMatch(/AFTER UPDATE ON public\.posts\s+FOR EACH ROW/);
    expect(postTrigger).toContain('EXECUTE FUNCTION public.trg_refresh_marketplace_search_for_post();');
    expect(columnsFollowed(postTrigger)).toEqual(columnsRead('posts', latestProjection));
    expect(columnsFollowed(profileTrigger)).toEqual(columnsRead('profiles', latestProjection));
  });

  it('keeps the listing as it was but for a literal search pattern', () => {
    const previous = functionDefinition(readMigration('20261017145444_free_unlocks_are_not_sales.sql'), 'list_marketplace_resource_bundles');
    const current = functionDefinition(sql, 'list_marketplace_resource_bundles');
    const comparable = (definition: string) => definition.replace(/^CREATE (?:OR REPLACE )?FUNCTION/, 'CREATE FUNCTION');

    // A replacer function: `$4` in a replacement string is a pattern.
    expect(comparable(current)).toBe(comparable(previous).replace(
      "ILIKE (''%%'' || lower(btrim($4)) || ''%%'')",
      () => "ILIKE (''%%'' || replace(replace(replace(lower(btrim($4)), ''\\'', ''\\\\''), ''%'', ''\\%''), ''_'', ''\\_'') || ''%%'')",
    ));
    expect(current).not.toBe(previous.replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION'));
  });

  it('runs both functions as their owner and lets only the service role call them', () => {
    expect(projection).toMatch(/RETURNS void\s+LANGUAGE sql\s+SECURITY DEFINER\s+SET search_path = ''/);
    for (const signature of [
      'public.refresh_marketplace_bundle_search_documents(uuid[])',
      'public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer)',
    ]) {
      expect(statements).toContain(`REVOKE ALL ON FUNCTION ${signature}\n  FROM PUBLIC, anon, authenticated;`);
      expect(statements).toContain(`GRANT EXECUTE ON FUNCTION ${signature}\n  TO service_role;`);
    }
  });

  it('runs as one transaction that gives up on a busy table, and re-projects every document last', () => {
    // The CLI applies a file's statements outside a transaction block, where
    // SET LOCAL does nothing and LOCK TABLE is refused.
    expect(statements.trim()).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '5s';/);
    // posts before its recipes, the order the publish and edit routes lock in.
    expect(statements).toMatch(
      /LOCK TABLE public\.posts IN SHARE ROW EXCLUSIVE MODE;\s+LOCK TABLE public\.post_resource_bundles IN SHARE ROW EXCLUSIVE MODE;\s+CREATE OR REPLACE FUNCTION/,
    );
    // DROP TRIGGER takes ACCESS EXCLUSIVE, which would stop every read of posts.
    expect(statements).not.toMatch(/DROP (?:TRIGGER|FUNCTION)/i);
    expect(statements.trim()).toMatch(/SELECT public\.refresh_marketplace_bundle_search_documents\(NULL\);\s+COMMIT;$/);
  });
});
