import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { getPostResourceKinds } from '@/lib/post-resource-bundles';

const sql = readFileSync('supabase/migrations/20261031100330_marketplace_search_indexes_public_text.sql', 'utf8');
// The statements alone: the header names fields the document no longer reads.
const statements = sql.replace(/--.*$/gm, '');
const projection = statements.slice(
  statements.indexOf('CREATE OR REPLACE FUNCTION public.refresh_marketplace_bundle_search_documents'),
  statements.indexOf('$function$;'),
);
const serverSource = readFileSync('src/lib/post-resource-bundles-server.ts', 'utf8');
const bundlesSource = readFileSync('src/lib/post-resource-bundles.ts', 'utf8');
// The profiles trigger is still the one 20260810112000 made.
const profilesTrigger = /CREATE TRIGGER profiles_refresh_marketplace_search[\s\S]*?;/.exec(
  readFileSync('supabase/migrations/20260810112000_index_marketplace_search.sql', 'utf8'),
)?.[0] ?? '';

function listItems(source: string): string[] {
  return source.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function quotedItems(source: string): string[] {
  return [...source.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

function columnsRead(alias: string): string[] {
  const columns = [...projection.matchAll(new RegExp(`\\b${alias}\\.([a-z_]+)`, 'g'))].map((match) => match[1]);
  return [...new Set(columns)].filter((column) => column !== 'id').sort();
}

function columnsFollowed(trigger: string): string[] {
  return [...trigger.matchAll(/OLD\.([a-z_]+) IS DISTINCT FROM NEW\.\1/g)].map((match) => match[1]).sort();
}

function triggerStatement(name: string): string {
  return new RegExp(`CREATE OR REPLACE TRIGGER ${name}[\\s\\S]*?;`).exec(statements)?.[0] ?? '';
}

// supabase/tests/database/marketplace_search_public_text.test.sql runs the
// projection and its triggers; this file pins it to the app's search check
// and to how the file takes its locks.
describe('marketplace search indexes public text migration', () => {
  it('projects exactly the fields the app checks a listed recipe on, in its order', () => {
    // [the app's field, the column the document reads], one pair per field.
    const fields = [
      ['item.title', 'bundles.title'],
      ['item.summary', 'bundles.summary'],
      ['item.previewText', 'bundles.preview_text'],
      ['item.seller.username', 'profiles.username'],
      ['item.seller.name', 'profiles.display_name'],
      ['item.post?.title', 'posts.title'],
      ['item.post?.body', 'posts.body'],
      ['item.post?.sourceTool', 'posts.source_tool'],
    ];
    const appFields = /function marketplaceItemMatchesQuery[\s\S]*?const searchableText = \[([\s\S]*?)\]\s*\.filter/.exec(serverSource)?.[1] ?? '';
    const documentFields = /lower\(concat_ws\(\s*' ',([\s\S]*?)nullif\(concat_ws\(/.exec(projection)?.[1] ?? '';

    expect(listItems(appFields)).toEqual([...fields.map(([app]) => app), "item.resourceKinds.join(' ')"]);
    expect(listItems(documentFields)).toEqual(fields.map(([, column]) => column));
  });

  it('ends with the kinds, in the order the recipe card lists them', () => {
    const kindOrder = /const POST_RESOURCE_KIND_ORDER: PostResourceKind\[\] = \[([^\]]*)\]/.exec(bundlesSource)?.[1] ?? '';
    const documentKinds = [...projection.matchAll(/CASE WHEN kinds\.([a-z]+) THEN '([a-z]+)' END/g)];

    expect(documentKinds.map((match) => match[1])).toEqual(documentKinds.map((match) => match[2]));
    expect(documentKinds.map((match) => match[2])).toEqual(quotedItems(kindOrder));
  });

  it('reads no item or card text', () => {
    expect(projection).not.toMatch(/textContent|description|resource_sections|->>'title'/);
  });

  it('gives each item type the kind getPostResourceKinds gives it', () => {
    const itemTypes = /const POST_RESOURCE_ITEM_TYPES: PostResourceItemType\[\] = \[([^\]]*)\]/.exec(bundlesSource)?.[1] ?? '';
    const knownTypes = quotedItems(/WHERE item->>'type' IN \(([^)]*)\)/.exec(projection)?.[1] ?? '');
    const files = quotedItems(/END AS workflow,\s*CASE\s*WHEN items\.types IS NOT NULL THEN items\.types && ARRAY\[([^\]]*)\]/.exec(projection)?.[1] ?? '');
    const notes = quotedItems(/THEN items\.types && ARRAY\[([^\]]*)\]\s*ELSE btrim\(coalesce\(bundles\.notes_markdown/.exec(projection)?.[1] ?? '');
    const remix = quotedItems(/coalesce\(items\.types && ARRAY\[([^\]]*)\], false\)/.exec(projection)?.[1] ?? '');

    expect([...knownTypes].sort()).toEqual(quotedItems(itemTypes).sort());
    expect(projection).toContain("'prompt' = ANY (items.types)");
    expect(projection).toContain("'workflow' = ANY (items.types)");
    for (const type of knownTypes) {
      const documentKind = type === 'prompt' || type === 'workflow'
        ? type
        : files.includes(type) ? 'files' : notes.includes(type) ? 'notes' : remix.includes(type) ? 'remix' : null;
      expect([type, documentKind]).toEqual([type, getPostResourceKinds({ items: [{ type }] } as never)[0]]);
    }
  });

  it('holds Remix as resolveRecipeAllowRemix does', () => {
    expect(projection).toMatch(
      /bundles\.allow_remix IS TRUE\s+OR coalesce\(items\.types && ARRAY\['remix_access', 'remix_link'\], false\)\s+OR \(bundles\.status = 'published' AND posts\.generation_id IS NOT NULL\) AS remix/,
    );
  });

  it('refreshes a document whenever a column it reads changes', () => {
    const bundleTrigger = triggerStatement('post_resource_bundles_refresh_marketplace_search_update');
    const postTrigger = triggerStatement('posts_refresh_marketplace_search');

    expect(bundleTrigger).toMatch(/AFTER UPDATE ON public\.post_resource_bundles\s+FOR EACH ROW/);
    expect(bundleTrigger).toContain('EXECUTE FUNCTION public.trg_refresh_marketplace_search_for_bundle();');
    expect(columnsFollowed(bundleTrigger)).toEqual(columnsRead('bundles'));
    expect(postTrigger).toMatch(/AFTER UPDATE ON public\.posts\s+FOR EACH ROW/);
    expect(postTrigger).toContain('EXECUTE FUNCTION public.trg_refresh_marketplace_search_for_post();');
    expect(columnsFollowed(postTrigger)).toEqual(columnsRead('posts'));
    expect(columnsFollowed(profilesTrigger)).toEqual(columnsRead('profiles'));
  });

  it('runs as its owner and lets only the service role call it', () => {
    expect(projection).toMatch(/RETURNS void\s+LANGUAGE sql\s+SECURITY DEFINER\s+SET search_path = ''/);
    expect(statements).toContain(
      'REVOKE ALL ON FUNCTION public.refresh_marketplace_bundle_search_documents(uuid[])\n  FROM PUBLIC, anon, authenticated;',
    );
    expect(statements).toContain(
      'GRANT EXECUTE ON FUNCTION public.refresh_marketplace_bundle_search_documents(uuid[])\n  TO service_role;',
    );
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
    expect(statements).not.toMatch(/DROP TRIGGER/i);
    expect(statements.trim()).toMatch(/SELECT public\.refresh_marketplace_bundle_search_documents\(NULL\);\s+COMMIT;$/);
  });
});
