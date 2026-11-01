import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = 'supabase/migrations';
const migrationFile = '20261101124828_post_search_public_caption.sql';
// Every migration's statements, comments left out: a header may quote SQL.
const statementsOf = (file: string) => readFileSync(join(migrationsDirectory, file), 'utf8').replace(/--.*$/gm, '');
const statements = statementsOf(migrationFile);
const migrationFiles = readdirSync(migrationsDirectory).filter((file) => file.endsWith('.sql')).sort();

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

/** The named definition as the migrations up to `before` (or all of them) left it. */
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

/** `text` with its only occurrence of `from` replaced. */
function replaceOnce(text: string, from: string, to: string): string {
  expect(text.split(from), `text must occur exactly once: ${from}`).toHaveLength(2);
  return text.replace(from, () => to);
}

const comparable = (definition: string) => definition.replace(/^CREATE (?:OR REPLACE )?(FUNCTION|TRIGGER)/, 'CREATE $1');
const shownBody = 'public.recipe_post_public_body(posts.body, bundles.access_mode)';
const shownPrompt = 'CASE WHEN bundles.id IS NULL THEN posts.prompt END';

// supabase/tests/database/post_search_public_caption.test.sql runs the
// projection, the recipe triggers and post search, and
// post_search_recipe_trigger_account_deletion.test.sql the trigger under an
// account deletion; this file holds them to the definitions they replace and
// to the rules public reads apply, and pins how the file takes its locks.
describe('post search public caption migration', () => {
  it('projects the document as the migration before it left it, but for the text as public reads show it', () => {
    const previous = latest('FUNCTION', 'refresh_post_search_documents', migrationFile);
    const projection = current('FUNCTION', 'refresh_post_search_documents');

    let expected = replaceOnce(comparable(previous), '      posts.body,\n', `      ${shownBody},\n`);
    expected = replaceOnce(expected, "coalesce(posts.body, '')", `coalesce(${shownBody}, '')`);
    expected = replaceOnce(expected, '      posts.prompt,\n', `      ${shownPrompt},\n`);
    expected = replaceOnce(expected, "coalesce(posts.prompt, '')", `coalesce(${shownPrompt}, '')`);
    expected = replaceOnce(
      expected,
      '  FROM public.posts AS posts\n',
      '  FROM public.posts AS posts\n'
        + '  LEFT JOIN public.post_resource_bundles AS bundles\n'
        + '    ON bundles.post_id = posts.id\n'
        + "    AND bundles.status = 'published'\n",
    );
    expect(comparable(projection)).toBe(expected);
    // Every read of the body goes through the rule, and every read of the
    // prompt through the recipe check.
    expect(projection.match(/posts\.body\b/g)).toHaveLength(2);
    expect(projection.split(shownBody)).toHaveLength(3);
    expect(projection.match(/posts\.prompt\b/g)).toHaveLength(2);
    expect(projection.split(shownPrompt)).toHaveLength(3);
  });

  it('reuses the caption rule the marketplace document reads', () => {
    // 20261101072014 made it and its migration test holds it to the app's
    // isGeneratedRecipeSetupText; a copy here could drift from it.
    expect(definitionIn(statements, 'FUNCTION', 'recipe_post_public_body')).toBeNull();
  });

  it('reads a post’s text by its published recipe, as public reads do', () => {
    // No prompt under any recipe, and under a paid one no setup caption.
    const publicContent = readFileSync('src/lib/post-public-content.ts', 'utf8');
    expect(publicContent).toContain("prompt: hasRecipe ? '' : prompt,");
    expect(publicContent).toContain("body: isPaidRecipe && isGeneratedRecipeSetupText(body) ? '' : body,");
    // The feed and search's own cards take a post's recipe from these
    // summaries, which answer for a published recipe only.
    expect(latest('FUNCTION', 'get_public_post_resource_bundle_summaries')).toContain(
      "CASE WHEN bundles.status = 'published' THEN bundles.access_mode ELSE NULL END AS access_mode,",
    );
    const showcase = readFileSync('src/lib/showcase.ts', 'utf8');
    expect(showcase).toContain('hasRecipe: Boolean(asset),');
    expect(showcase).toContain("isPaidRecipe: asset?.accessMode === 'paid',");
    // The post page reads the recipe itself, and shows a draft only to its
    // owner and buyers; search answers everyone else's way.
    const postPage = readFileSync('src/lib/public-posts.ts', 'utf8');
    expect(postPage).toContain('hasRecipe: Boolean(resourceBundle),');
    expect(postPage).toContain("isPaidRecipe: resourceBundle?.accessMode === 'paid',");
    const bundles = readFileSync('src/lib/post-resource-bundles-server.ts', 'utf8');
    expect(bundles).toContain("function isBundlePublishedForMarketplace(row: BundleRow): boolean {\n  return row.status === 'published';\n}");
    expect(bundles).toContain('!isBundlePublishedForMarketplace(row)\n    && row.owner_user_id !== viewerUserId\n    && !viewerHasPurchased');
  });

  it('re-projects a post’s document on every recipe column the document reads, and on no other', () => {
    // Whichever later file re-creates either.
    const projection = latest('FUNCTION', 'refresh_post_search_documents');
    const update = latest('TRIGGER', 'post_resource_bundles_refresh_post_search_update');

    expect(columnsRead('bundles', projection)).toEqual(['access_mode', 'post_id', 'status']);
    expect(columnsFollowed(update)).toEqual(columnsRead('bundles', projection));
    // No column list: it would miss a change a BEFORE trigger makes.
    expect(update).toMatch(/AFTER UPDATE ON public\.post_resource_bundles\s+FOR EACH ROW\s+WHEN \(/);
    expect(update).toContain('EXECUTE FUNCTION public.trg_refresh_post_search_document_for_recipe();');
    // A recipe added or deleted can change what its post shows.
    expect(current('TRIGGER', 'post_resource_bundles_refresh_post_search_insert_delete')).toBe(
      'CREATE OR REPLACE TRIGGER post_resource_bundles_refresh_post_search_insert_delete\n'
        + 'AFTER INSERT OR DELETE ON public.post_resource_bundles\n'
        + 'FOR EACH ROW\n'
        + 'EXECUTE FUNCTION public.trg_refresh_post_search_document_for_recipe();',
    );
  });

  it('projects each post the recipe was or is on, after locking them as an edit of the post does', () => {
    const trigger = current('FUNCTION', 'trg_refresh_post_search_document_for_recipe');

    expect(trigger).toMatch(
      /IF TG_OP = 'INSERT' THEN\s+v_post_ids := ARRAY\[NEW\.post_id\];\s+ELSIF TG_OP = 'DELETE' THEN\s+v_post_ids := ARRAY\[OLD\.post_id\];\s+ELSE\s+v_post_ids := ARRAY\[OLD\.post_id, NEW\.post_id\];\s+END IF;/,
    );
    // NO KEY UPDATE is what an edit of a post takes, so the two wait for each
    // other, while a comment's or a save's foreign-key check (KEY SHARE) does
    // not wait. In id order, so two recipes moving between the same posts
    // cannot deadlock.
    expect(trigger).toMatch(
      /PERFORM 1\s+FROM public\.posts\s+WHERE id = ANY \(v_post_ids\)\s+ORDER BY id\s+FOR NO KEY UPDATE;\s+PERFORM public\.refresh_post_search_documents\(v_post_ids\);\s+RETURN NULL;/,
    );
  });

  it('runs the projection and the trigger as their owner, callable by the service role and nobody respectively', () => {
    expect(current('FUNCTION', 'refresh_post_search_documents')).toMatch(
      /RETURNS void\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path TO 'public', 'pg_temp'/,
    );
    expect(statements).toContain('REVOKE ALL ON FUNCTION public.refresh_post_search_documents(uuid[]) FROM PUBLIC, anon, authenticated;');
    expect(statements).toContain('GRANT EXECUTE ON FUNCTION public.refresh_post_search_documents(uuid[]) TO service_role;');
    expect(current('FUNCTION', 'trg_refresh_post_search_document_for_recipe')).toMatch(
      /RETURNS trigger\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = ''/,
    );
    expect(statements).toContain(
      'REVOKE ALL ON FUNCTION public.trg_refresh_post_search_document_for_recipe()\n  FROM PUBLIC, anon, authenticated, service_role;',
    );
  });

  it('leaves post search reading the document as before', () => {
    expect(definitionIn(statements, 'FUNCTION', 'search_public_posts')).toBeNull();
    expect(latest('FUNCTION', 'search_public_posts')).toMatch(
      /documents\.search_vector @@ plainto_tsquery\('simple', v_query\)\s+OR documents\.search_text ILIKE/,
    );
  });

  it('runs as one transaction that gives up on a busy table, and re-projects the documents the rules change last', () => {
    // The CLI applies a file's statements outside a transaction block, where
    // SET LOCAL does nothing and LOCK TABLE is refused.
    expect(statements.trim()).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '5s';/);
    // posts before its recipes, the order the publish and edit routes lock in.
    expect(statements).toMatch(
      /LOCK TABLE public\.posts IN SHARE ROW EXCLUSIVE MODE;\s+LOCK TABLE public\.post_resource_bundles IN SHARE ROW EXCLUSIVE MODE;\s+CREATE OR REPLACE FUNCTION public\.refresh_post_search_documents/,
    );
    // DROP TRIGGER takes ACCESS EXCLUSIVE, which would stop every read of posts.
    expect(statements).not.toMatch(/DROP (?:TRIGGER|FUNCTION)/i);
    expect(statements.match(/CREATE (?:OR REPLACE )?TRIGGER/g)).toEqual(['CREATE OR REPLACE TRIGGER', 'CREATE OR REPLACE TRIGGER']);
    // The posts with a published recipe whose document the rules change.
    expect(statements.trim()).toMatch(
      /SELECT public\.refresh_post_search_documents\(ARRAY\(\s+SELECT posts\.id\s+FROM public\.posts AS posts\s+JOIN public\.post_resource_bundles AS bundles\s+ON bundles\.post_id = posts\.id\s+AND bundles\.status = 'published'\s+WHERE posts\.prompt IS NOT NULL\s+OR public\.recipe_post_public_body\(posts\.body, bundles\.access_mode\) IS DISTINCT FROM posts\.body\s+\)\);\s+COMMIT;$/,
    );
  });
});
