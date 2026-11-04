import fs from 'node:fs';
import path from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  confirmOrphanRemovals,
  formatOrphanList,
  isObjectNamed,
  listStorageOrphans,
  NameCorpus,
  ORPHAN_SCANNED_TABLES,
  ORPHAN_SKIPPED_TABLES,
  parseOrphanList,
} from '@/lib/storage-orphans';

type Row = Record<string, unknown>;

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const OLD = '2026-10-01T00:00:00.000Z';
const RECENT = '2026-11-02T00:00:00.000Z';
const USER = '11111111-1111-4111-8111-111111111111';
const GENERATION = '22222222-2222-4222-8222-222222222222';

/** Every table a migration creates, under the name the database gives it. */
function tablesCreatedByMigrations(): Set<string> {
  const directory = path.resolve(process.cwd(), 'supabase/migrations');
  const tables = new Set<string>();
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(directory, file), 'utf8');
    for (const match of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-z_0-9]+)"?\s*(?:\(|partition|as\b)/gi)) {
      tables.add(match[1].toLowerCase());
    }
    for (const match of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:"?public"?\.)?"?([a-z_0-9]+)"?/gi)) {
      tables.delete(match[1].toLowerCase());
    }
  }
  return tables;
}

/**
 * A small in-memory Supabase: tables answer select/order/gt/is/in/limit/range as
 * PostgREST does, Storage lists (list-v2), describes and removes objects.
 */
function createClient({
  tables = {},
  buckets = {},
  failingTable = null,
}: {
  tables?: Record<string, Row[]>;
  buckets?: Record<string, Array<{ path: string; id?: string; created_at?: string; updated_at?: string; size?: number }>>;
  failingTable?: string | null;
}) {
  const removals: Array<{ bucket: string; paths: string[] }> = [];
  const reads: string[] = [];
  const from = (table: string) => {
    reads.push(table);
    const filters: Array<(row: Row) => boolean> = [];
    let orderColumns: string[] = [];
    let limit: number | null = null;
    let range: [number, number] | null = null;
    const builder = {
      select: () => builder,
      order: (column: string) => {
        orderColumns = [...orderColumns, column];
        return builder;
      },
      gt: (column: string, value: unknown) => {
        filters.push((row) => String(row[column]) > String(value));
        return builder;
      },
      is: (column: string, value: unknown) => {
        filters.push((row) => (row[column] ?? null) === value);
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]));
        return builder;
      },
      limit: (count: number) => {
        limit = count;
        return builder;
      },
      range: (start: number, end: number) => {
        range = [start, end];
        return builder;
      },
      then: (resolve: (value: { data: Row[] | null; error: { message: string } | null }) => unknown) => {
        if (failingTable === table) return Promise.resolve({ data: null, error: { message: `${table} unavailable` } }).then(resolve);
        let rows = (tables[table] ?? []).filter((row) => filters.every((filter) => filter(row)));
        rows = [...rows].sort((a, b) => {
          for (const column of orderColumns) {
            const left = String(a[column]);
            const right = String(b[column]);
            if (left !== right) return left < right ? -1 : 1;
          }
          return 0;
        });
        if (range) rows = rows.slice(range[0], range[1] + 1);
        if (limit !== null) rows = rows.slice(0, limit);
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return builder;
  };

  const storage = {
    from: (bucket: string) => ({
      listV2: async () => ({
        data: {
          hasNext: false,
          folders: [],
          objects: (buckets[bucket] ?? []).map((object, index) => ({
            id: object.id ?? `${bucket}-${index}`,
            key: object.path,
            name: object.path,
            created_at: object.created_at ?? OLD,
            updated_at: object.updated_at ?? object.created_at ?? OLD,
            metadata: { size: object.size ?? 100 },
          })),
        },
        error: null,
      }),
      info: async (objectPath: string) => {
        const objects = buckets[bucket] ?? [];
        const index = objects.findIndex((object) => object.path === objectPath);
        if (index < 0) return { data: null, error: { message: 'Object not found', statusCode: '404' } };
        const object = objects[index];
        return {
          data: {
            id: object.id ?? `${bucket}-${index}`,
            createdAt: object.created_at ?? OLD,
            lastModified: object.updated_at ?? object.created_at ?? OLD,
            size: object.size ?? 100,
          },
          error: null,
        };
      },
      remove: async (paths: string[]) => {
        removals.push({ bucket, paths });
        buckets[bucket] = (buckets[bucket] ?? []).filter((object) => !paths.includes(object.path));
        return { data: paths.map((name) => ({ name })), error: null };
      },
    }),
  };

  return { client: { from, storage } as unknown as SupabaseClient, removals, reads, tables, buckets };
}

describe('the tables an orphan listing reads', () => {
  it('classifies every table the migrations create, each once', () => {
    const created = tablesCreatedByMigrations();
    const scanned = ORPHAN_SCANNED_TABLES.map(({ table }) => table);
    const skipped = Object.keys(ORPHAN_SKIPPED_TABLES);

    expect(new Set(scanned).size).toBe(scanned.length);
    expect(scanned.filter((table) => skipped.includes(table))).toEqual([]);
    expect([...created].filter((table) => !scanned.includes(table) && !skipped.includes(table))).toEqual([]);
    expect([...scanned, ...skipped].filter((table) => !created.has(table))).toEqual([]);
  });

  it('reads every table that holds a purchase, an unlock or a retained copy', () => {
    const scanned = ORPHAN_SCANNED_TABLES.map(({ table }) => table);
    for (const table of [
      'post_resource_purchase_media',
      'post_resource_bundle_revision_files',
      'post_resource_bundle_revisions',
      'post_resource_bundle_revision_supplements',
      'post_resource_bundle_orders',
      'post_resource_bundle_purchases',
      'post_resource_bundles',
      'uploaded_media_private_copies',
      'account_deletion_jobs',
    ]) {
      expect(scanned).toContain(table);
    }
  });
});

describe('isObjectNamed', () => {
  function corpusOf(...rows: Row[]) {
    const corpus = new NameCorpus(NOW);
    rows.forEach((row) => corpus.addRow(row));
    return corpus;
  }

  it('finds a name stored plain, with its bucket, or inside an encoded link', () => {
    expect(isObjectNamed(corpusOf({ storage_path: `showcase/${GENERATION}/cover.abc.png` }), 'showcase_media', `showcase/${GENERATION}/cover.abc.png`)).toBe(true);
    expect(isObjectNamed(corpusOf({ output_url: `generated_images/${USER}/generated_p1.png` }), 'generated_images', `${USER}/generated_p1.png`)).toBe(true);
    expect(isObjectNamed(
      corpusOf({ avatar_url: `https://x.supabase.co/storage/v1/object/public/profiles/${USER}/my%20photo.webp` }),
      'profiles',
      `${USER}/my photo.webp`,
    )).toBe(true);
    expect(isObjectNamed(corpusOf({ workflow_settings: { references: [{ storagePath: `generated_images/${USER}/x.png` }] } }), 'generated_images', `${USER}/x.png`)).toBe(true);
    expect(isObjectNamed(corpusOf({ output_url: `generated_images/${USER}/other.png` }), 'generated_images', `${USER}/generated_p1.png`)).toBe(false);
  });

  it('keeps a derived file whose base is named, and lists one whose base is not', () => {
    const corpus = corpusOf({ output_url: `generated_images/${USER}/generated_p1.png` });

    for (const derived of [
      `${USER}/generated_p1.preview.0123456789abcdef.webp`,
      `${USER}/generated_p1.display.0123456789abcdef.webp`,
    ]) {
      expect(isObjectNamed(corpus, 'generated_images', derived)).toBe(true);
    }
    expect(isObjectNamed(corpus, 'generated_images', `${USER}/generated_p2.display.0123456789abcdef.webp`)).toBe(false);
    expect(isObjectNamed(
      corpusOf({ storage_path: `showcase/${GENERATION}/clip.abc.mp4` }),
      'showcase_media',
      `showcase/${GENERATION}/clip.abc.feed.0123abcd.mp4`,
    )).toBe(true);
    expect(isObjectNamed(
      corpusOf({ avatar_url: `https://x/storage/v1/object/public/profiles/${USER}/avatar-1-a.png` }),
      'profiles',
      `${USER}/avatar-1-a.normalized.0123456789abcdef.webp`,
    )).toBe(true);
  });

  it('keeps a playback rendition while its creation is named, and lists it after', () => {
    const playback = `${USER}/playback/${GENERATION}/0123456789abcdef.mp4`;
    expect(isObjectNamed(corpusOf({ id: GENERATION }), 'generated_videos', playback)).toBe(true);
    expect(isObjectNamed(corpusOf({ id: '33333333-3333-4333-8333-333333333333' }), 'generated_videos', playback)).toBe(false);
  });
});

describe('listStorageOrphans', () => {
  const clock = () => NOW;

  it('lists what nothing names, and leaves out the young, the swept, the retained and what bookkeeping tracks', async () => {
    const { client } = createClient({
      buckets: {
        generated_images: [
          { path: `${USER}/generated_named.png` },
          { path: `${USER}/generated_orphan.png`, size: 4096 },
          { path: `${USER}/generated_young.png`, created_at: RECENT },
          { path: `${USER}/generated_rewritten.png`, updated_at: RECENT },
          { path: `${USER}/.emptyFolderPlaceholder` },
        ],
        post_resource_files: [
          { path: `${USER}/generation-references/${GENERATION}/00-reference.png` },
          { path: `retained/${GENERATION}/abc-file.zip` },
        ],
        uploads: [
          { path: `${USER}/live-upload.png` },
          { path: `${USER}/abandoned-upload.png` },
        ],
      },
      tables: {
        generations: [{ id: GENERATION, output_url: `generated_images/${USER}/generated_named.png` }],
        media_upload_intents: [
          { id: 'a', storage_path: `${USER}/live-upload.png`, created_at: RECENT, storage_cleared_at: null },
          { id: 'b', storage_path: `${USER}/abandoned-upload.png`, created_at: OLD, storage_cleared_at: null },
        ],
      },
    });

    const listing = await listStorageOrphans(client, { clock });

    expect(listing.orphans.map(({ bucket, path: objectPath, reason, sizeBytes }) => ({ bucket, path: objectPath, reason, sizeBytes }))).toEqual([
      { bucket: 'generated_images', path: `${USER}/generated_orphan.png`, reason: 'unnamed', sizeBytes: 4096 },
    ]);
    expect(listing.kept).toEqual({
      named: 1,
      too_young: 2,
      placeholder: 1,
      recipe_copy_sweep: 1,
      retained_buyer_copy: 1,
      staged_upload: 2,
    });
  });

  // MEDIA_UPLOAD_RECLAIM_ABANDONED and the app floor gate deleting staged
  // uploads (media-upload-reclaim-service): an app's remix draft can hold an
  // uploads path no row records, and never expires.
  const reclaimOn = { MEDIA_UPLOAD_RECLAIM_ABANDONED: 'true' };

  it('lists an expired staged upload only when asked with the reclaim interlock on, under its own reason', async () => {
    const { client } = createClient({
      buckets: { uploads: [{ path: `${USER}/abandoned-upload.png` }] },
      tables: {
        media_upload_intents: [{ id: 'b', storage_path: `${USER}/abandoned-upload.png`, created_at: OLD, storage_cleared_at: null }],
      },
    });

    const listing = await listStorageOrphans(client, { clock, includeExpiredUploads: true, environment: reclaimOn });

    expect(listing.orphans.map(({ reason }) => reason)).toEqual(['expired_upload']);
  });

  it('refuses to list expired staged uploads while the reclaim interlock is off', async () => {
    const { client, reads } = createClient({ buckets: { uploads: [{ path: `${USER}/abandoned-upload.png` }] } });

    await expect(listStorageOrphans(client, { clock, includeExpiredUploads: true, environment: {} }))
      .rejects.toThrow('MEDIA_UPLOAD_RECLAIM_ABANDONED');
    expect(reads).toEqual([]);
  });

  it('leaves out a staged upload no intent tracks, as the reclaim interlock does', async () => {
    const buckets = { uploads: [{ path: `${USER}/before-intents.png` }, { path: `${USER}/cleared-intent.png` }] };
    const tables = {
      media_upload_intents: [{ id: 'c', storage_path: `${USER}/cleared-intent.png`, created_at: OLD, storage_cleared_at: OLD }],
    };

    const quiet = await listStorageOrphans(createClient({ buckets, tables }).client, { clock });
    expect(quiet.orphans).toEqual([]);
    expect(quiet.kept).toEqual({ staged_upload: 2 });

    const asked = await listStorageOrphans(createClient({ buckets, tables }).client, {
      clock,
      includeExpiredUploads: true,
      environment: reclaimOn,
    });
    expect(asked.orphans.map(({ path: objectPath, reason }) => [objectPath, reason])).toEqual([
      [`${USER}/before-intents.png`, 'expired_upload'],
      [`${USER}/cleared-intent.png`, 'expired_upload'],
    ]);
  });

  it('reads a table past one page', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => ({
      id: `gen-${String(index).padStart(5, '0')}`,
      output_url: `generated_images/${USER}/generated_${index}.png`,
    }));
    const { client } = createClient({
      buckets: { generated_images: [{ path: `${USER}/generated_1000.png` }] },
      tables: { generations: rows },
    });

    const listing = await listStorageOrphans(client, { clock });

    expect(listing.orphans).toEqual([]);
    expect(listing.kept).toEqual({ named: 1 });
  });

  it('lists nothing when a table cannot be read', async () => {
    const { client } = createClient({
      buckets: { generated_images: [{ path: `${USER}/generated_orphan.png` }] },
      failingTable: 'post_resource_purchase_media',
    });

    await expect(listStorageOrphans(client, { clock })).rejects.toThrow('post_resource_purchase_media');
  });
});

describe('the orphan list file', () => {
  const listing = {
    orphans: [{
      bucket: 'generated_images',
      path: `${USER}/generated_orphan.png`,
      id: 'object-1',
      sizeBytes: 4096,
      createdAt: OLD,
      reason: 'unnamed' as const,
    }],
    kept: {},
    scannedObjects: 1,
    scannedTables: 1,
    scannedRows: 0,
  };

  it('reads back what it wrote', () => {
    const text = formatOrphanList(listing, { projectHost: 'abc.supabase.co', listedAt: new Date(NOW) });

    expect(text.split('\n')[0]).toBe('# storage-orphans v1 project=abc.supabase.co listed_at=2026-11-04T12:00:00.000Z');
    expect(parseOrphanList(text)).toEqual({
      projectHost: 'abc.supabase.co',
      listedAt: new Date(NOW),
      entries: [{ bucket: 'generated_images', path: `${USER}/generated_orphan.png`, id: 'object-1', createdAt: OLD }],
    });
  });

  it.each([
    ['no header', (text: string) => text.split('\n').slice(1).join('\n'), 'header'],
    ['an unknown bucket', (text: string) => text.replace('generated_images\t', 'secrets\t'), 'unknown bucket'],
    ['an escaping path', (text: string) => text.replace(`${USER}/generated_orphan.png`, `${USER}/../other/x.png`), 'canonical'],
    ['a repeated object', (text: string) => `${text}${text.split('\n')[3]}\n`, 'repeats'],
  ])('refuses a list with %s', (_label, change, message) => {
    const text = formatOrphanList(listing, { projectHost: 'abc.supabase.co', listedAt: new Date(NOW) });

    expect(() => parseOrphanList(change(text))).toThrow(message);
  });
});

describe('confirmOrphanRemovals', () => {
  function listOf(...entries: Array<{ bucket: string; path: string; id: string }>) {
    return {
      projectHost: 'abc.supabase.co',
      listedAt: new Date(NOW - 60 * 60 * 1000),
      entries: entries.map((entry) => ({ ...entry, createdAt: OLD })),
    };
  }

  it('removes each listed object that is still the same, still old and still named by nothing', async () => {
    const mock = createClient({
      buckets: { generated_images: [{ path: `${USER}/generated_orphan.png`, id: 'object-1' }] },
    });
    const onResult = vi.fn();

    const counts = await confirmOrphanRemovals(mock.client, listOf({ bucket: 'generated_images', path: `${USER}/generated_orphan.png`, id: 'object-1' }), {
      projectHost: 'abc.supabase.co',
      clock: () => NOW,
      onResult,
    });

    expect(counts).toMatchObject({ removed: 1 });
    expect(mock.removals).toEqual([{ bucket: 'generated_images', paths: [`${USER}/generated_orphan.png`] }]);
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ path: `${USER}/generated_orphan.png` }), 'removed');
  });

  it('leaves an object that changed, was rewritten, is gone, or that something names again', async () => {
    const mock = createClient({
      buckets: {
        generated_images: [
          { path: `${USER}/replaced.png`, id: 'object-new' },
          { path: `${USER}/rewritten.png`, id: 'object-2', updated_at: RECENT },
          { path: `${USER}/named-by-column.png`, id: 'object-3' },
          { path: `${USER}/named-in-json.png`, id: 'object-4' },
        ],
      },
      tables: {
        generations: [{ id: GENERATION, output_url: `generated_images/${USER}/named-by-column.png` }],
        workflow_canvases: [{ id: 'canvas-1', graph: { nodes: [{ data: { storagePath: `generated_images/${USER}/named-in-json.png` } }] } }],
      },
    });

    const counts = await confirmOrphanRemovals(mock.client, listOf(
      { bucket: 'generated_images', path: `${USER}/replaced.png`, id: 'object-old' },
      { bucket: 'generated_images', path: `${USER}/rewritten.png`, id: 'object-2' },
      { bucket: 'generated_images', path: `${USER}/gone.png`, id: 'object-5' },
      { bucket: 'generated_images', path: `${USER}/named-by-column.png`, id: 'object-3' },
      { bucket: 'generated_images', path: `${USER}/named-in-json.png`, id: 'object-4' },
    ), { projectHost: 'abc.supabase.co', clock: () => NOW });

    expect(counts).toEqual({ removed: 0, gone: 1, changed: 1, too_young: 1, excluded: 0, named: 2, failed: 0 });
    expect(mock.removals).toEqual([]);
  });

  it('never removes a retained buyer copy or a recipe-copy sweep file, whatever the list says', async () => {
    const mock = createClient({
      buckets: {
        post_resource_files: [
          { path: `retained/${GENERATION}/abc-file.zip`, id: 'object-1' },
          { path: `${USER}/generation-references/${GENERATION}/00-reference.png`, id: 'object-2' },
        ],
      },
    });

    const counts = await confirmOrphanRemovals(mock.client, listOf(
      { bucket: 'post_resource_files', path: `retained/${GENERATION}/abc-file.zip`, id: 'object-1' },
      { bucket: 'post_resource_files', path: `${USER}/generation-references/${GENERATION}/00-reference.png`, id: 'object-2' },
    ), { projectHost: 'abc.supabase.co', clock: () => NOW });

    expect(counts).toMatchObject({ excluded: 2, removed: 0 });
    expect(mock.removals).toEqual([]);
  });

  it('never removes a staged upload unless asked with the reclaim interlock on', async () => {
    const entry = { bucket: 'uploads', path: `${USER}/before-intents.png`, id: 'object-1' };
    const quiet = createClient({ buckets: { uploads: [{ path: entry.path, id: 'object-1' }] } });

    await expect(confirmOrphanRemovals(quiet.client, listOf(entry), { projectHost: 'abc.supabase.co', clock: () => NOW }))
      .resolves.toMatchObject({ excluded: 1, removed: 0 });
    await expect(confirmOrphanRemovals(quiet.client, listOf(entry), {
      projectHost: 'abc.supabase.co',
      clock: () => NOW,
      includeExpiredUploads: true,
      environment: {},
    })).rejects.toThrow('MEDIA_UPLOAD_RECLAIM_ABANDONED');
    expect(quiet.removals).toEqual([]);

    const asked = createClient({ buckets: { uploads: [{ path: entry.path, id: 'object-1' }] } });
    await expect(confirmOrphanRemovals(asked.client, listOf(entry), {
      projectHost: 'abc.supabase.co',
      clock: () => NOW,
      includeExpiredUploads: true,
      environment: { MEDIA_UPLOAD_RECLAIM_ABANDONED: 'true' },
    })).resolves.toMatchObject({ removed: 1 });
  });

  it('reads the rows again once its read is a minute old', async () => {
    const mock = createClient({
      buckets: { generated_images: [{ path: `${USER}/a.png`, id: 'a' }, { path: `${USER}/b.png`, id: 'b' }] },
    });
    let now = NOW;
    const readCorpus = vi.fn(async (_client: SupabaseClient, { clock }: { clock?: () => number } = {}) => new NameCorpus(clock?.() ?? now));

    await confirmOrphanRemovals(mock.client, listOf(
      { bucket: 'generated_images', path: `${USER}/a.png`, id: 'a' },
      { bucket: 'generated_images', path: `${USER}/b.png`, id: 'b' },
    ), {
      projectHost: 'abc.supabase.co',
      clock: () => (now += 70_000),
      readCorpus,
    });

    expect(readCorpus).toHaveBeenCalledTimes(2);
  });

  it('refuses a list made for another project, or more than three days ago', async () => {
    const mock = createClient({});

    await expect(confirmOrphanRemovals(mock.client, listOf(), { projectHost: 'other.supabase.co', clock: () => NOW }))
      .rejects.toThrow('not other.supabase.co');
    await expect(confirmOrphanRemovals(mock.client, { ...listOf(), listedAt: new Date(NOW - 4 * 24 * 60 * 60 * 1000) }, {
      projectHost: 'abc.supabase.co',
      clock: () => NOW,
    })).rejects.toThrow('three days');
    expect(mock.removals).toEqual([]);
  });
});
