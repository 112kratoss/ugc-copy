import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(process.cwd(), 'supabase/migrations');
// Version order: every name starts with its UTC stamp.
const migrationNames = readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort();

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260827110000_public_search.sql'),
  'utf8',
);

function readMigration(suffix: string): string {
  const matches = migrationNames.filter((name) => name.endsWith(suffix));
  expect(matches, `${suffix} must exist exactly once`).toHaveLength(1);
  return readFileSync(join(migrationsDirectory, matches[0]), 'utf8');
}

/** The one `CREATE OR REPLACE FUNCTION public.<name>(` statement, through its closing `$function$;`. */
function functionDefinition(sql: string, name: string): string {
  const opener = `CREATE OR REPLACE FUNCTION public.${name}(`;
  expect(sql.split(opener), `${name} must be defined exactly once`).toHaveLength(2);
  const start = sql.indexOf(opener);
  const end = sql.indexOf('\n$function$;', start);
  expect(end, `${name} has no closing $function$;`).toBeGreaterThan(start);
  return sql.slice(start, end + '\n$function$;'.length);
}

/** `text` with its only occurrence of `from` replaced. */
function replaceOnce(text: string, from: string, to: string): string {
  expect(text.split(from), `text must occur exactly once: ${from}`).toHaveLength(2);
  return text.replace(from, () => to);
}

describe('public search migration', () => {
  it('creates backend-owned creator and post documents with GIN indexes', () => {
    expect(migration).toContain('CREATE TABLE public.post_search_documents');
    expect(migration).toContain('CREATE TABLE public.creator_search_documents');
    expect(migration).toContain('USING gin (search_vector)');
    expect(migration).toContain('extensions.gin_trgm_ops');
    expect(migration).toContain('REVOKE ALL ON TABLE public.post_search_documents FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('REVOKE ALL ON TABLE public.creator_search_documents FROM PUBLIC, anon, authenticated');
  });

  it('keeps search eligibility synchronized with safety state', () => {
    expect(migration).toContain("posts.visibility = 'public'");
    expect(migration).toContain('posts.archived_at IS NULL');
    expect(migration).toContain("posts.review_status = 'visible'");
    expect(migration).toContain('posts_refresh_public_search_document');
    expect(migration).toContain('posts_refresh_creator_search_document');
  });

  it('matches LIKE metacharacters literally instead of concatenating raw input', () => {
    expect(migration).toContain(
      String.raw`v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');`,
    );
    expect(migration).not.toContain("LIKE v_query");
    expect(migration).not.toContain("ILIKE ('%' || v_query || '%')");
  });

  it('exposes only backend search RPCs with bounded inputs', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.search_public_creators');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.search_public_posts');
    expect(migration).toContain('Creator search limit must be between 1 and 25');
    expect(migration).toContain('Post search limit must be between 1 and 25');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('TO service_role');
  });
});

describe('post search leaves NSFW-labelled posts out', () => {
  const hideNsfwMigration = readMigration('_search_public_posts_hide_nsfw.sql');
  const searchDefinitionPattern = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.search_public_posts\s*\(/i;

  it('reads the label inside the scored set, before the keyset comparison and the limit, and changes nothing else', () => {
    // Text posts stay searchable: the label is the only new condition.
    expect(functionDefinition(hideNsfwMigration, 'search_public_posts')).toBe(replaceOnce(
      functionDefinition(migration, 'search_public_posts'),
      "    WHERE documents.search_vector @@ plainto_tsquery('simple', v_query)\n"
        + "      OR documents.search_text ILIKE ('%' || v_like || '%')\n"
        + '      OR documents.title_normalized OPERATOR(extensions.%) v_query\n'
        + '      OR documents.tool_normalized OPERATOR(extensions.%) v_query\n',
      '    WHERE posts.is_nsfw = false\n'
        + '      AND (\n'
        + "        documents.search_vector @@ plainto_tsquery('simple', v_query)\n"
        + "        OR documents.search_text ILIKE ('%' || v_like || '%')\n"
        + '        OR documents.title_normalized OPERATOR(extensions.%) v_query\n'
        + '        OR documents.tool_normalized OPERATOR(extensions.%) v_query\n'
        + '      )\n',
    ));
  });

  it('keeps the post search RPC callable only by the service role', () => {
    expect(hideNsfwMigration).toContain(
      'REVOKE ALL ON FUNCTION public.search_public_posts(text, uuid, double precision, uuid, integer)\n'
        + '  FROM PUBLIC, anon, authenticated;',
    );
    expect(hideNsfwMigration).toContain(
      'GRANT EXECUTE ON FUNCTION public.search_public_posts(text, uuid, double precision, uuid, integer)\n'
        + '  TO service_role;',
    );
  });

  it('keeps the label filter in the newest definition of post search', () => {
    // A later CREATE OR REPLACE copied from an older body would quietly bring
    // labelled posts back into search.
    const definers = migrationNames.filter((name) => (
      searchDefinitionPattern.test(readFileSync(join(migrationsDirectory, name), 'utf8'))
    ));
    expect(definers.length).toBeGreaterThanOrEqual(2);
    const newest = readFileSync(join(migrationsDirectory, definers[definers.length - 1]), 'utf8');
    const fromDefinition = newest.slice(newest.search(searchDefinitionPattern));
    const closing = fromDefinition.search(/\n\$(?:function)?\$;/);
    expect(closing, 'the newest definition of search_public_posts must close').toBeGreaterThan(0);
    expect(fromDefinition.slice(0, closing)).toMatch(/\bis_nsfw\s*=\s*false\b|\bNOT\s+\w+\.is_nsfw\b/i);
  });
});
