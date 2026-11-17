import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/account-identity', () => ({ resolveLinkedAccountIds: async () => ['owner'] }));
vi.mock('@/lib/owned-media-url-batch', () => ({
  resolveOwnedStoredMediaUrlMap: async ({ outputUrls }: { outputUrls: Iterable<string> }) => new Map(
    Array.from(outputUrls, (stored) => [stored, `https://storage.example/${stored}?token=signed`]),
  ),
}));

import { getCreationMediaKindFilter } from '@/lib/creation-workspace';
import { listOwnerGenerationsForRoute, type OwnerGenerationsRouteClient } from '@/lib/owner-generations-route-service';

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
const migration = read('supabase/migrations/20261117192621_owner_profile_counts_kinds_and_visibility.sql');
const previous = read('supabase/migrations/20261031231029_owner_profile_counts_creation_scopes.sql');
const ownerList = read('src/lib/owner-generations-route-service.ts');

/** The body of the `count(*) FILTER (WHERE …)` that names one column, whitespace folded. */
function countFilter(sql: string, column: string) {
  // The body may not run on into the next count, which a lazy match from the first one would.
  const match = sql.match(new RegExp(
    `count\\(\\*\\) FILTER \\(((?:(?!count\\(\\*\\))[\\s\\S])*?)\\)::integer AS ${column}\\b`,
  ));
  if (!match) throw new Error(`no ${column} count`);
  return match[1].replace(/\s+/g, ' ').trim();
}

/** The text between two markers of a definition, both included. */
function between(sql: string, start: string, end: string) {
  const from = sql.indexOf(start);
  const to = sql.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`no text from ${start} to ${end}`);
  return sql.slice(from, to + end.length);
}

const ACTIVE_RULE = "WHERE generations.archived_at IS NULL AND generations.status = 'succeeded' "
  + 'AND ( generations.source_unavailable_at IS NOT NULL OR generations.output_url IS NOT NULL )';

describe('owner profile counts: kinds and visibility migration', () => {
  it('replaces the function in place, keeping how it runs', () => {
    // Same signature and return type, so /api/profile keeps calling it as it is.
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.owner_profile_counts(p_user_id uuid)\nRETURNS jsonb');
    expect(migration).toMatch(/LANGUAGE sql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = ''/);
    expect(migration).not.toMatch(/DROP FUNCTION/i);
    // A replaced function only: no table, index or policy.
    expect(migration).not.toMatch(/\b(CREATE|ALTER|DROP) (TABLE|INDEX|POLICY)\b/i);
  });

  it('keeps every count of the definition it replaces, word for word', () => {
    expect(migration).toContain(between(previous, 'WITH owner_ids AS (', 'blocked_creators AS ('));
    expect(migration).toContain(between(previous, 'blocked_creators AS (', 'WHERE blocks.blocked_user_id = p_user_id\n  ),'));
    expect(migration).toContain(between(previous, '  saved AS (', '    END AS total\n  )'));
    for (const column of ['active', 'archived', 'failed']) {
      expect(countFilter(migration, column)).toBe(countFilter(previous, column));
    }
    expect(migration).toContain('count(*) FILTER (WHERE posts.archived_at IS NULL)::integer AS active');
    expect(migration).toContain('count(*) FILTER (WHERE posts.archived_at IS NOT NULL)::integer AS archived');
    for (const key of [
      "'creations', (SELECT creations.active FROM creations)",
      "'failedCreations', (SELECT creations.failed FROM creations)",
      "'archivedCreations', (SELECT creations.archived FROM creations)",
      "'posts', (SELECT posts.active FROM posts)",
      "'archivedPosts', (SELECT posts.archived FROM posts)",
      "'saved', (SELECT saved.total FROM saved)",
    ]) {
      expect(previous).toContain(key);
      expect(migration).toContain(key);
    }
  });

  it("counts each of Studio's media filters among the Active creations alone", () => {
    expect(countFilter(migration, 'active')).toBe(ACTIVE_RULE);
    for (const kind of ['image', 'video', 'audio'] as const) {
      const filter = getCreationMediaKindFilter(kind);
      expect(countFilter(migration, `active_${filter}`)).toBe(`${ACTIVE_RULE} AND media.studio_filter = '${filter}'`);
    }
    // Within the owner set (merged guests included) and the studio rule of the totals.
    expect(migration).toContain('WHERE generations.user_id IN (SELECT owner_ids.id FROM owner_ids)');
    expect(migration).toContain(
      '(generations.template_run_id IS NULL AND generations.template_run_step_id IS NULL)\n        OR generations.studio_visible',
    );
  });

  // The owner list reads a creation's kind from its file first (inferVisualContentType), and the
  // count reads it the same way: a change to either reading fails here until both agree.
  it("reads a creation's file by the patterns and folders the owner list reads it by", () => {
    const reading = between(ownerList, 'function inferVisualContentType(', '\n}');
    const branches = [...reading.matchAll(
      /if \(\/(.+?)\/i\.test\(value\) \|\| value\.startsWith\('([^']+)'\)\) return '(video|image|audio)\/unknown';/g,
    )].map(([, pattern, folder, kind]) => ({ pattern, folder, kind }));
    expect(branches.map((branch) => branch.kind)).toEqual(['video', 'image', 'audio']);
    const sqlBranches = branches.map(({ pattern, folder, kind }) => (
      `WHEN generations.output_url ~* '${pattern}'\n          OR starts_with(generations.output_url, '${folder}') THEN '${kind}'`
    ));
    let at = -1;
    for (const branch of sqlBranches) {
      const found = migration.indexOf(branch, at + 1);
      expect(found, branch).toBeGreaterThan(at);
      at = found;
    }
  });

  it('files a sound first, then a video, and a picture for anything else, as classifyVisualMedia does', () => {
    expect(migration).toContain(
      "WHEN generations.category = 'audio' OR output_file.file_kind = 'audio' THEN 'audio'\n"
      + "        WHEN generations.category = 'video' OR output_file.file_kind = 'video' THEN 'videos'\n"
      + "        ELSE 'images'",
    );
  });

  it('counts the live posts by their stored visibility', () => {
    for (const visibility of ['public', 'unlisted', 'private']) {
      expect(countFilter(migration, `active_${visibility}`))
        .toBe(`WHERE posts.archived_at IS NULL AND posts.visibility = '${visibility}'`);
    }
  });

  it('returns each split under the keys of the filters it counts, beside the total it splits', () => {
    expect(migration).toContain(
      "'creationsByKind', (\n      SELECT jsonb_build_object(\n"
      + "        'images', creations.active_images,\n"
      + "        'videos', creations.active_videos,\n"
      + "        'audio', creations.active_audio\n"
      + '      )\n      FROM creations\n    ),',
    );
    expect(migration).toContain(
      "'postsByVisibility', (\n      SELECT jsonb_build_object(\n"
      + "        'public', posts.active_public,\n"
      + "        'unlisted', posts.active_unlisted,\n"
      + "        'private', posts.active_private\n"
      + '      )\n      FROM posts\n    ),',
    );
  });

  it("stays the service role's alone, and says what it counts", () => {
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.owner_profile_counts(uuid) FROM PUBLIC;');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.owner_profile_counts(uuid) FROM anon, authenticated;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.owner_profile_counts(uuid) TO service_role;');
    expect(migration).toMatch(/COMMENT ON FUNCTION public\.owner_profile_counts\(uuid\) IS\n\s+'[^\n]*creationsByKind[^\n]*postsByVisibility/);
  });
});

/**
 * The owner list's half of the kind rule: the category it sends each creation with, which
 * Studio's grid files under a filter (`getCreationMediaKindFilter`). The cases are the kinds
 * creator's in supabase/tests/database/owner_profile_counts.test.sql, which pins the count's half.
 */
describe("the owner list files each of the count's cases under the same filter", () => {
  function clientFor(row: Record<string, unknown>) {
    return {
      from: (table: string) => ({
        select: (columns: string) => {
          const selected = columns.split(',').map((column) => column.trim());
          const data = table === 'generations'
            ? [Object.fromEntries(Object.entries(row).filter(([key]) => selected.includes(key)))]
            : [];
          const query = {
            in: () => query, or: () => query, is: () => query, eq: () => query,
            order: () => query, range: () => query,
            then: (resolve: (result: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve),
          };
          return query;
        },
      }),
    } as unknown as OwnerGenerationsRouteClient;
  }

  const SOURCE_GONE = '2026-11-17T10:00:00Z';
  it.each([
    ['image', 'generated_images/kinds/1.png', null, 'images'],
    [null, 'https://cdn.example.invalid/kinds/2.WEBP', null, 'images'],
    ['image', null, SOURCE_GONE, 'images'],
    [null, null, SOURCE_GONE, 'images'],
    ['video', 'generated_videos/kinds/5.mp4', null, 'videos'],
    [null, 'https://cdn.example.invalid/kinds/6.MOV?token=abc', null, 'videos'],
    ['image', 'generated_videos/kinds/7', null, 'videos'],
    ['video', 'generated_images/kinds/8.png', null, 'videos'],
    ['video', null, SOURCE_GONE, 'videos'],
    ['audio', 'generated_audio/kinds/10.mp3', null, 'audio'],
    [null, 'https://cdn.example.invalid/kinds/11.wav', null, 'audio'],
    ['video', 'https://cdn.example.invalid/kinds/12.m4a', null, 'audio'],
    ['audio', 'generated_videos/kinds/13.mp4', null, 'audio'],
  ])('category %s with the file %s (source gone: %s) is under %s', async (category, outputUrl, sourceGoneAt, filter) => {
    const client = clientFor({
      id: 'kinds-case', user_id: 'owner', category, model: 'test-model', status: 'succeeded',
      created_at: '2026-11-17T09:00:00Z', completed_at: '2026-11-17T09:00:20Z', prompt: null, title: null,
      description: null, cost: 1, duration: null, archived_at: null, output_url: outputUrl,
      source_unavailable_at: sourceGoneAt, preview_url: null, preview_status: 'failed',
      template_run_id: null, template_run_step_id: null, studio_visible: true,
    });
    const result = await listOwnerGenerationsForRoute({
      userId: 'owner', supabase: client, getAdminSupabase: () => client,
      searchParams: new URLSearchParams('detail=summary'),
    });
    const [generation] = result.generations as Array<{ category: 'image' | 'video' | 'audio' }>;

    expect(getCreationMediaKindFilter(generation.category)).toBe(filter);
  });
});
