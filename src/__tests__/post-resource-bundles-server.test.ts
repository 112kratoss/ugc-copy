import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recipeCopiesWithheldOver, type CreationMarks } from './fixtures/recipe-copies-withheld';

type BundleRow = {
  id: string;
  post_id: string;
  owner_user_id: string;
  legacy_asset_id: string | null;
  access_mode: 'free' | 'paid';
  status: 'published' | 'draft';
  title: string;
  summary: string;
  preview_text: string;
  prompt_text: string | null;
  notes_markdown: string | null;
  workflow_share_url: string | null;
  workflow_snapshot: null;
  attachments: unknown[];
  allow_remix: boolean;
  resource_sections: unknown[];
  resource_items: unknown[];
  price_usd_cents: number;
  sales_count: number;
  /** Absent on a row read through the pre-resource-items select. */
  free_unlock_count?: number;
  earnings_usd_cents: number;
  created_at: string;
  updated_at: string;
};

let bundleRow: BundleRow | null;
let generationRow: {
  id: string;
  user_id: string | null;
  is_public: boolean | null;
  share_input_media_for_remix: boolean | null;
  model: string | null;
  category: string | null;
  prompt: string | null;
  workflow_settings: Record<string, unknown> | null;
  archived_at?: string | null;
  moderation_removed_at?: string | null;
} | null;
let generationInputRows: Array<{
  id: string;
  generation_id: string;
  user_id: string;
  media_type: 'image' | 'video' | 'audio';
  role: string;
  label: string | null;
  storage_path: string;
  source_generation_id: string | null;
  sort_order: number | null;
  metadata: Record<string, unknown> | null;
}>;
let viewerHasPurchased: boolean;
let bundlePresenceError: unknown;
let postRow: Record<string, unknown> | null;
// Fails every list read of posts (the recipe's own post lookup among them).
let postListReadError: unknown;
// Fails only the reads of posts by id (`.in('id', …)`): a page's linked posts,
// after a read of post ids that worked.
let linkedPostReadError: unknown;
let purchasedRevisionRow: Record<string, unknown> | null;
let purchasedMediaRows: Record<string, unknown>[];
// The seller dashboard's reads: paid orders, deletion audits, buyer profiles,
// and the blocks between the seller and their buyers.
let orderRows: Record<string, unknown>[];
let deletionAuditRows: Record<string, unknown>[];
let buyerProfileRows: Array<{ id: string; username: string | null; display_name: string | null; avatar_url: string | null }>;
let profileReadError: unknown;
let blockRows: Array<{ blocker_user_id: string; blocked_user_id: string }>;
let blockReadError: unknown;
// Guest identities and the account each was linked to, for who-is-linked reads.
let linkedGuestRows: Array<{ id: string; merged_into_user_id: string | null }>;
let linkedGuestReadError: unknown;
// The content revisions the hydrate path reads its `updatedAt` from.
let revisionRows: Array<{ bundle_id: string; revision_number: number; created_at: string }>;
let revisionReadError: unknown;
// Holds the hydrate's revision read open, so a test can see what else has
// started while it waits.
let revisionReadGate: Promise<void> | null;
// Every table the service asked, in order, and what each recipe-table read
// selected: what a read costs is part of what these tests pin.
let tableReads: string[];
let bundleSelects: string[];
// The one read of a recipe with its post, the post's generation and that
// generation's inputs: failing, or never answering until its signal gives up.
let embeddedSourceReadError: unknown;
let embeddedSourceReadHangs: boolean;
// The signal each such read was given: a teaser's gives up, an unlock's waits.
let embeddedSourceSignals: Array<AbortSignal | null>;
// How each such read was filtered: its `eq` columns and any `or` it sent.
let embeddedSourceFilters: Array<{ eq: Record<string, unknown>; or: string[] }>;
// The posts each such read asked about.
let embeddedSourcePostIds: unknown[][];
// Rows the marketplace's list RPC returns after `bundleRow`.
let extraListedBundleRows: BundleRow[];
// Recipes of other posts the read can return beside `bundleRow`, each already
// nested with its post, generation and inputs.
let extraCreationInputSources: Array<Record<string, unknown>>;

/**
 * What PostgREST sends for a row under a select: only the columns it names,
 * and each embed under its alias, itself narrowed by its own list. A column
 * the select leaves out is missing, as it would be from the real response.
 */
function projectSelectedColumns(row: Record<string, unknown>, select: string): Record<string, unknown> {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index <= select.length; index += 1) {
    const character = select[index];
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (index === select.length || (character === ',' && depth === 0)) {
      entries.push(select.slice(start, index).trim());
      start = index + 1;
    }
  }

  const projected: Record<string, unknown> = {};
  for (const entry of entries) {
    const open = entry.indexOf('(');
    if (open === -1) {
      if (entry in row) projected[entry] = row[entry];
      continue;
    }
    const alias = entry.slice(0, open).split(':')[0].split('!')[0];
    const inner = entry.slice(open + 1, -1);
    const value = row[alias];
    projected[alias] = Array.isArray(value)
      ? value.map((nested) => projectSelectedColumns(nested as Record<string, unknown>, inner))
      : value && typeof value === 'object'
        ? projectSelectedColumns(value as Record<string, unknown>, inner)
        : null;
  }
  return projected;
}

// Calls through, so a test can see whether the bundle read asked posts itself.
vi.mock('@/lib/nsfw-content-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nsfw-content-server')>();
  return { ...actual, loadNsfwPostIds: vi.fn(actual.loadNsfwPostIds) };
});

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === 'get_purchased_post_resource_bundle_revision') {
        // The projection is buyer-scoped; returning nothing for anyone else is
        // what the SQL does too.
        const isBuyer = args.p_buyer_user_id === 'buyer-1';
        return { data: isBuyer && purchasedRevisionRow ? [purchasedRevisionRow] : [], error: null };
      }
      // Nobody in these fixtures has revealed an NSFW post.
      if (name === 'has_nsfw_reveal') return { data: false, error: null };
      // Which of a recipe's copies are withheld now (`loadWithheldCopies`): those of the fixture's
      // creation once it is removed or archived.
      if (name === 'recipe_copies_withheld') {
        const creation = generationRow as CreationMarks | null;
        return { data: recipeCopiesWithheldOver(creation?.id ? [creation] : [])(args.p_paths as string[]), error: null };
      }
      // The marketplace lists the published recipes there are, as its SQL
      // matched them: the fake searches nothing.
      if (name === 'list_marketplace_resource_bundles') {
        return {
          data: [...(bundleRow ? [bundleRow] : []), ...extraListedBundleRows].filter((row) => row.status === 'published'),
          error: null,
        };
      }

      throw new Error(`Unexpected rpc: ${name}`);
    },
    storage: {
      from: vi.fn(() => ({
        getPublicUrl: (filePath: string) => ({
          data: { publicUrl: `https://public.example.com/${filePath}` },
        }),
        createSignedUrl: vi.fn(async (filePath: string) => ({
          data: { signedUrl: `https://signed.example.com/${filePath}` },
          error: null,
        })),
        createSignedUrls: vi.fn(async (filePaths: string[]) => ({
          data: filePaths.map((filePath) => ({
            error: null,
            path: filePath,
            signedUrl: `https://signed.example.com/${filePath}`,
          })),
          error: null,
        })),
      })),
    },
    from(table: string) {
      tableReads.push(table);
      if (table === 'post_resource_bundles') {
        let checksPresence = false;
        let readsOwnerBundles = false;
        let selectedColumns = '';
        let postIds: unknown[] = [];
        let signal: AbortSignal | null = null;
        const equalityFilters: Record<string, unknown> = {};
        // Each `or` as PostgREST reads it: `column.eq.value` terms, any of
        // which keeps a row.
        const anyOfFilters: Array<Array<[string, string]>> = [];
        const sentOrFilters: string[] = [];

        // The read of a page's creation inputs: each recipe the filters keep,
        // with its post, the post's generation (none once unlinked) and that
        // generation's saved inputs, as PostgREST nests them.
        const readCreationInputSources = async () => {
          if (embeddedSourceReadHangs) {
            // supabase-js answers a request its signal aborted with an error.
            await new Promise((resolve) => signal?.addEventListener('abort', resolve));
            return { data: null, error: { code: '', message: 'AbortError: This operation was aborted' } };
          }
          if (embeddedSourceReadError) return { data: null, error: embeddedSourceReadError };
          const row = bundleRow as Record<string, unknown> | null;
          const post = row && postRow && postRow.id === row.post_id
            ? {
                ...postRow,
                generation: generationRow && postRow.generation_id === generationRow.id
                  ? {
                      ...generationRow,
                      inputs: generationInputRows.filter((input) => input.generation_id === generationRow?.id),
                    }
                  : null,
              }
            : null;
          const sources = [...(row ? [{ ...row, post }] : []), ...extraCreationInputSources];
          // Postgres compares uuids whatever case they are spelled in, and
          // answers with its own spelling.
          const requested = new Set(postIds.map((postId) => String(postId).toLowerCase()));
          const kept = sources.filter((source) => (
            requested.has(String(source.post_id).toLowerCase())
            && Object.entries(equalityFilters).every(([column, value]) => source[column] === value)
            && anyOfFilters.every((terms) => terms.some(([column, value]) => String(source[column]) === value))
          ));
          return { data: kept.map((source) => projectSelectedColumns(source, selectedColumns)), error: null };
        };

        const query = {
          select(columns?: string) {
            selectedColumns = columns ?? '';
            bundleSelects.push(selectedColumns);
            return query;
          },
          in(column?: string, values?: unknown[]) {
            checksPresence = true;
            if (column === 'post_id') postIds = values ?? [];
            return query;
          },
          eq(column?: string, value?: unknown) {
            if (column === 'owner_user_id') readsOwnerBundles = true;
            if (column) equalityFilters[column] = value;
            return query;
          },
          or(filters: string) {
            sentOrFilters.push(filters);
            anyOfFilters.push(filters.split(',').map((term) => {
              const [column, operator, ...value] = term.split('.');
              if (operator !== 'eq') throw new Error(`Unexpected or filter: ${term}`);
              return [column, value.join('.')] as [string, string];
            }));
            return query;
          },
          order() {
            return query;
          },
          abortSignal(value: AbortSignal) {
            signal = value;
            return query;
          },
          async maybeSingle() {
            return {
              data: bundleRow,
              error: null,
            };
          },
          then(
            resolve: (value: { data: unknown[] | null; error: unknown }) => void,
            reject?: (reason: unknown) => void,
          ) {
            if (selectedColumns.includes('generation:generations')) {
              embeddedSourceSignals.push(signal);
              embeddedSourceFilters.push({ eq: { ...equalityFilters }, or: [...sentOrFilters] });
              embeddedSourcePostIds.push([...postIds]);
              void readCreationInputSources().then(resolve, reject);
              return;
            }
            if (readsOwnerBundles) {
              resolve({ data: bundleRow ? [bundleRow] : [], error: null });
              return;
            }
            resolve({
              data: checksPresence && bundleRow ? [{ post_id: bundleRow.post_id }] : [],
              error: checksPresence ? bundlePresenceError : null,
            });
          },
        };

        return query;
      }

      if (table === 'post_resource_bundle_purchases') {
        const query = {
          select() {
            return query;
          },
          eq() {
            return query;
          },
          async maybeSingle() {
            return {
              data: viewerHasPurchased
                ? { id: 'purchase-1', bundle_id: 'bundle-1', buyer_user_id: 'viewer-1' }
                : null,
              error: null,
            };
          },
        };

        return query;
      }

      // A listing's media previews: none, so a card falls back to its post.
      if (table === 'post_media') {
        const query = {
          select() { return query; },
          in() { return query; },
          async order() { return { data: [], error: null }; },
        };
        return query;
      }

      if (table === 'post_resource_purchase_media') {
        const query = {
          select() { return query; },
          eq() { return query; },
          async order() { return { data: purchasedMediaRows, error: null }; },
        };
        return query;
      }

      if (table === 'profiles') {
        return {
          select() {
            return {
              async in(_column: string, ids: string[]) {
                if (profileReadError) return { data: null, error: profileReadError };
                return {
                  data: [{
                    id: 'owner-1',
                    username: 'creator',
                    display_name: 'Creator',
                    avatar_url: null,
                  }, ...buyerProfileRows].filter((row) => ids.includes(row.id)),
                  error: null,
                };
              },
              // Honours its filter, as the database would: an account's linked
              // guests are the ones merged into it, not every merged guest.
              async eq(column: string, value: unknown) {
                if (linkedGuestReadError) return { data: null, error: linkedGuestReadError };
                return {
                  data: linkedGuestRows.filter((row) => row[column as keyof typeof row] === value),
                  error: null,
                };
              },
            };
          },
        };
      }

      // Honours the bundle, status and amount filters, the order and the
      // limit, as the database would: the seller page reads its newest sales
      // and free opens apart, of its own recipes, settled.
      if (table === 'post_resource_bundle_orders') {
        const filters: Array<(row: Record<string, unknown>) => boolean> = [];
        let limit = Number.POSITIVE_INFINITY;
        const query = {
          select() { return query; },
          in(column: string, values: unknown[]) {
            filters.push((row) => values.includes(row[column]));
            return query;
          },
          eq(column: string, value: unknown) {
            if (column === 'amount_subunits' || column === 'status') filters.push((row) => row[column] === value);
            return query;
          },
          gt(column: string, value: number) {
            filters.push((row) => Number(row[column]) > value);
            return query;
          },
          limit(count: number) {
            limit = count;
            return query;
          },
          async order(column: string, options?: { ascending?: boolean }) {
            const direction = options?.ascending === false ? -1 : 1;
            const rows = orderRows
              .filter((row) => filters.every((matches) => matches(row)))
              .sort((first, second) => String(first[column]).localeCompare(String(second[column])) * direction)
              .slice(0, limit);
            return { data: rows, error: null };
          },
        };
        return query;
      }

      // Honours `.not(column, 'is', null)`, as the database would.
      if (table === 'post_deletion_audits') {
        const present: string[] = [];
        const query = {
          select() { return query; },
          eq() { return query; },
          not(column: string, operator: string, value: unknown) {
            if (operator === 'is' && value === null) present.push(column);
            return query;
          },
          async order() {
            return { data: deletionAuditRows.filter((row) => present.every((column) => row[column] != null)), error: null };
          },
        };
        return query;
      }

      if (table === 'user_blocks') {
        const equalities: Record<string, unknown> = {};
        const query = {
          select() { return query; },
          eq(column: string, value: unknown) {
            equalities[column] = value;
            return query;
          },
          async in(column: string, values: unknown[]) {
            if (blockReadError) return { data: null, error: blockReadError };
            return {
              data: blockRows.filter((row) => (
                Object.entries(equalities).every(([key, value]) => row[key as keyof typeof row] === value)
                && values.includes(row[column as keyof typeof row])
              )),
              error: null,
            };
          },
        };
        return query;
      }

      if (table === 'posts') {
        let eqId: string | null = null;
        const equalityFilters: Record<string, unknown> = {};
        const nullFilters: string[] = [];
        let readsById = false;

        // The service narrows post visibility per viewer scope; the mock has to
        // honour those filters or an entitlement test proves nothing.
        const matchesFilters = () => {
          if (!postRow) return false;
          if (nullFilters.some((column) => postRow?.[column] != null)) return false;
          return Object.entries(equalityFilters).every(([column, value]) => postRow?.[column] === value);
        };

        const query = {
          select() {
            return query;
          },
          in(column?: string) {
            if (column === 'id') readsById = true;
            return query;
          },
          eq(column?: string, value?: unknown) {
            if (column === 'id' && typeof value === 'string') {
              eqId = value;
            } else if (column) {
              equalityFilters[column] = value;
            }
            return query;
          },
          is(column?: string) {
            if (column) {
              nullFilters.push(column);
            }
            return query;
          },
          neq() {
            return query;
          },
          order() {
            return query;
          },
          limit() {
            return query;
          },
          async maybeSingle() {
            return { data: eqId === 'post-1' && matchesFilters() ? postRow : null, error: null };
          },
          then(resolve: (value: { data: unknown[] | null; error: unknown }) => void) {
            const readError = postListReadError ?? (readsById ? linkedPostReadError : null);
            resolve(readError
              ? { data: null, error: readError }
              : { data: matchesFilters() && postRow ? [postRow] : [], error: null });
          },
        };

        return query;
      }

      if (table === 'generations') {
        return {
          select() {
            return {
              eq() {
                return {
                  async maybeSingle() {
                    return {
                      data: generationRow,
                      error: null,
                    };
                  },
                };
              },
              async in(_column: string, ids: unknown[]) {
                const row = generationRow as { id?: string } | null;
                return { data: row?.id && ids.includes(row.id) ? [row] : [], error: null };
              },
            };
          },
        };
      }

      if (table === 'post_resource_bundle_revisions') {
        let bundleIds: unknown[] = [];
        const query = {
          select() { return query; },
          in(column: string, values: unknown[]) {
            if (column === 'bundle_id') bundleIds = values;
            return query;
          },
          async order(column: string, options?: { ascending?: boolean }) {
            if (revisionReadGate) await revisionReadGate;
            if (revisionReadError) return { data: null, error: revisionReadError };
            const rows = revisionRows
              .filter((row) => bundleIds.includes(row.bundle_id))
              .sort((first, second) => (
                column === 'revision_number' && options?.ascending === false
                  ? second.revision_number - first.revision_number
                  : first.revision_number - second.revision_number
              ));
            return { data: rows, error: null };
          },
        };
        return query;
      }

      if (table === 'generation_input_media') {
        let generationIds: unknown[] = [];

        const query = {
          select() {
            return query;
          },
          in(column: string, values: unknown[]) {
            if (column === 'generation_id') {
              generationIds = values;
            }
            return query;
          },
          async order() {
            return {
              data: generationInputRows.filter((row) => generationIds.includes(row.generation_id)),
              error: null,
            };
          },
        };

        return {
          select: query.select,
          in: query.in,
          order: query.order,
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  }),
}));

describe('post resource bundle server access', () => {
  it('commits post, bundle, and proof media through the combined mutation RPC', async () => {
    const rpc = vi.fn(async () => ({
      data: {
        post_id: 'post-1',
        visibility: 'private',
        bundle_id: 'bundle-1',
        bundle_status: 'draft',
      },
      error: null,
    }));
    const { updatePostWithResourceBundleAtomically } = await import('@/lib/post-resource-bundles-server');

    await updatePostWithResourceBundleAtomically({
      supabase: { rpc } as never,
      postId: 'post-1',
      ownerUserId: 'user-1',
      patch: { title: 'Atomic edit' },
      hasBundlePayload: false,
      bundle: null,
      mediaItems: [{
        mediaKey: 'proof-new',
        storagePath: 'posts/post-1/new.jpg',
        mediaKind: 'image',
        contentType: 'image/jpeg',
        originalName: 'new.jpg',
        sortOrder: 0,
      }],
    });

    expect(rpc).toHaveBeenCalledWith('update_post_with_resource_bundle_and_media', {
      p_post_id: 'post-1',
      p_owner_user_id: 'user-1',
      p_post_patch: { title: 'Atomic edit' },
      p_has_bundle: false,
      p_bundle: null,
      p_media_items: [expect.objectContaining({ mediaKey: 'proof-new' })],
    });
  });

  beforeEach(() => {
    vi.resetModules();
    bundleRow = {
      id: 'bundle-1',
      post_id: 'post-1',
      owner_user_id: 'owner-1',
      legacy_asset_id: null,
      access_mode: 'free',
      status: 'published',
      title: 'Creation recipe',
      summary: 'Public recipe resources.',
      preview_text: 'Prompt, notes, and references.',
      prompt_text: 'Public prompt text',
      notes_markdown: 'Public notes',
      workflow_share_url: null,
      workflow_snapshot: null,
      attachments: [],
      allow_remix: false,
      resource_sections: [],
      resource_items: [
        {
          type: 'prompt',
          title: 'Prompt',
          textContent: 'Public prompt text',
        },
        {
          type: 'reference_image',
          title: 'Reference image',
          storagePath: 'owner-1/generation-references/gen-1/input.png',
          contentType: 'image/png',
        },
      ],
      price_usd_cents: 0,
      sales_count: 0,
      earnings_usd_cents: 0,
      created_at: '2026-06-05T00:00:00.000Z',
      updated_at: '2026-06-05T00:00:00.000Z',
    };
    generationRow = {
      id: 'gen-1',
      user_id: 'owner-1',
      is_public: true,
      share_input_media_for_remix: true,
      model: 'nano-banana-2',
      category: 'image',
      prompt: 'Public generated prompt',
      workflow_settings: {
        model: 'nano-banana-2',
        aspectRatio: '9:16',
      },
    };
    generationInputRows = [{
      id: 'input-1',
      generation_id: 'gen-1',
      user_id: 'owner-1',
      media_type: 'image',
      role: 'reference_image',
      label: 'Image input',
      storage_path: 'generation_inputs/owner-1/gen-1/00-reference-image.png',
      source_generation_id: null,
      sort_order: 0,
      metadata: {},
    }];
    viewerHasPurchased = false;
    bundlePresenceError = null;
    postListReadError = null;
    linkedPostReadError = null;
    postRow = {
      id: 'post-1',
      user_id: 'owner-1',
      generation_id: 'gen-1',
      title: 'Public recipe post',
      body: 'A visible result.',
      prompt: 'Post prompt fallback',
      category: 'image',
      post_format: 'media',
      visibility: 'public',
      archived_at: null,
      tombstoned_at: null,
      review_status: 'visible',
      showcase_asset_path: null,
      output_url: null,
      source_kind: 'magicbooklet',
      source_tool: 'magicbooklet',
      source_tool_slug: 'magicbooklet',
      save_count: 0,
      remix_count: 0,
      share_visit_count: 0,
      created_at: '2026-06-05T00:00:00.000Z',
    };
    purchasedRevisionRow = null;
    purchasedMediaRows = [{
      purchase_id: 'purchase-1',
      source_media_id: 'proof-media-1',
      media_key: 'purchased-output-1',
      storage_path: 'owner-1/posts/original.png',
      external_url: null,
      preview_storage_path: 'owner-1/posts/original-preview.png',
      preview_thumbhash: 'thumbhash-original',
      media_kind: 'image',
      content_type: 'image/png',
      original_name: 'original.png',
      width: 800,
      height: 1000,
      duration_seconds: null,
      sort_order: 0,
    }];
    orderRows = [];
    deletionAuditRows = [];
    buyerProfileRows = [];
    profileReadError = null;
    blockRows = [];
    blockReadError = null;
    linkedGuestRows = [];
    linkedGuestReadError = null;
    revisionRows = [];
    revisionReadError = null;
    revisionReadGate = null;
    tableReads = [];
    bundleSelects = [];
    embeddedSourceReadError = null;
    embeddedSourceReadHangs = false;
    embeddedSourceSignals = [];
    embeddedSourceFilters = [];
    embeddedSourcePostIds = [];
    extraCreationInputSources = [];
    extraListedBundleRows = [];
  });

  it('keeps a published free recipe gated until the viewer adds it', async () => {
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: null,
    });

    expect(detail?.viewerCanAccess).toBe(false);
    expect(detail?.resources).toBeNull();
  });

  // The post page reads "no recipe" from a null detail and then serves the
  // post's stored prompt, so a post lookup that fails must not read as the
  // post being hidden.
  it('fails the public detail when its post cannot be read, rather than answer no recipe', async () => {
    postListReadError = { code: 'XX000', message: 'temporary database failure' };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      await expect(getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null, isNsfw: false }))
        .rejects.toMatchObject({ message: 'temporary database failure' });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('answers its creator and a buyer as before when the post cannot be read', async () => {
    postListReadError = { code: 'XX000', message: 'temporary database failure' };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      const forCreator = await getPostResourceBundleDetailByPostId('post-1', {
        viewerUserId: (bundleRow as BundleRow).owner_user_id,
        isNsfw: false,
      });
      expect(forCreator?.viewerCanAccess).toBe(true);

      // A buyer's library falls back to the purchased version on a null.
      viewerHasPurchased = true;
      await expect(getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'viewer-1', isNsfw: false }))
        .resolves.toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });

  // Decision 6 (2026-10-17): free unlocks are not sales. Both counts are public
  // social proof, so a visitor's detail carries them side by side.
  it('counts paid sales and free unlocks apart in the public detail', async () => {
    bundleRow = { ...(bundleRow as BundleRow), sales_count: 2, free_unlock_count: 5 };
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null });

    expect(detail?.salesCount).toBe(2);
    expect(detail?.freeUnlockCount).toBe(5);
    // Earnings stay owner-only beside them.
    expect(detail).not.toHaveProperty('earningsUsdCents');
  });

  it('reads a bundle row that has no free unlock column as none', async () => {
    const legacyRow = { ...(bundleRow as BundleRow) };
    delete legacyRow.free_unlock_count;
    bundleRow = legacyRow;
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null });

    expect(detail?.freeUnlockCount).toBe(0);
  });

  it('takes the post\'s NSFW flag from a caller that has just read its row', async () => {
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
    const { loadNsfwPostIds } = await import('@/lib/nsfw-content-server');
    // A mocked module outlives resetModules, so the spy still holds earlier tests' calls.
    vi.mocked(loadNsfwPostIds).mockClear();

    await expect(getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null }))
      .resolves.toMatchObject({ id: 'bundle-1' });
    expect(loadNsfwPostIds).toHaveBeenCalledTimes(1);

    vi.mocked(loadNsfwPostIds).mockClear();
    await expect(getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null, isNsfw: false }))
      .resolves.toMatchObject({ id: 'bundle-1' });
    // The post page passes the row it read; it costs no second posts read.
    expect(loadNsfwPostIds).not.toHaveBeenCalled();
  });

  it('keeps an NSFW post\'s recipe from a viewer who has not revealed it, on the caller\'s flag', async () => {
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
    const { loadNsfwPostIds } = await import('@/lib/nsfw-content-server');
    vi.mocked(loadNsfwPostIds).mockClear();

    // The fixture row is not marked NSFW, so only the caller's flag can hide it.
    await expect(getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null, isNsfw: true }))
      .resolves.toBeNull();
    expect(loadNsfwPostIds).not.toHaveBeenCalled();
  });

  // Review of 2026-10-29: the route passes the id as the URL spells it, and the
  // NSFW check looked it up among the database's own (lowercase) spellings, so
  // /api/posts/<ID IN CAPITALS>/resource-bundle opened an NSFW post's recipe
  // without a reveal, and let it be claimed or bought (#454).
  it('keeps an NSFW post\'s recipe from a viewer who has not revealed it, however its id is spelled', async () => {
    postRow = { ...(postRow as Record<string, unknown>), is_nsfw: true };
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    for (const spelling of ['post-1', 'POST-1']) {
      await expect(getPostResourceBundleDetailByPostId(spelling, { viewerUserId: 'viewer-1' })).resolves.toBeNull();
      await expect(getPostResourceBundleDetailByPostId(spelling, { viewerUserId: null })).resolves.toBeNull();
    }
    // Its owner still reads it.
    await expect(getPostResourceBundleDetailByPostId('POST-1', { viewerUserId: 'owner-1' }))
      .resolves.toMatchObject({ id: 'bundle-1', viewerIsOwner: true });
  });

  it('grants access on entitlement alone, never on the shape of the bundle id', async () => {
    // A legacy branch granted access to any published bundle whose id started
    // with 'generation-recipe:'. post_resource_bundles.id is a uuid column, so
    // no such row can exist, and nothing in the app constructs that id any more
    // -- synthetic feed recipes are resolved in showcase-feed, never here. The
    // clause was unreachable, but "grant access if the id looks special" has no
    // business inside an entitlement predicate, so it is gone. This pins that.
    bundleRow = {
      ...(bundleRow as BundleRow),
      id: 'generation-recipe:post-1',
    };
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: null,
    });

    expect(detail?.viewerCanAccess).toBe(false);
    expect(detail?.resources).toBeNull();
  });

  it('keeps published paid recipe resources locked before purchase', async () => {
    bundleRow = {
      ...(bundleRow as BundleRow),
      access_mode: 'paid',
      price_usd_cents: 900,
    };
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: null,
    });

    expect(detail?.viewerCanAccess).toBe(false);
    expect(detail?.resources).toBeNull();
    expect(detail?.lockedPreview.itemCounts).toMatchObject({
      prompt: 1,
      reference_image: 1,
    });
  });

  it('does not expose paid remix inputs before the viewer purchases the bundle', async () => {
    bundleRow = {
      ...(bundleRow as BundleRow),
      access_mode: 'paid',
      price_usd_cents: 900,
      allow_remix: true,
    };
    const { loadGenerationRecipeRemixInputMediaByPostId } = await import(
      '@/lib/post-resource-bundles-server'
    );

    await expect(loadGenerationRecipeRemixInputMediaByPostId({
      postId: 'post-1',
      generationId: 'gen-1',
      viewerUserId: 'viewer-1',
    })).resolves.toEqual([]);
  });

  it('exposes paid remix inputs only after purchase and explicit remix opt-in', async () => {
    bundleRow = {
      ...(bundleRow as BundleRow),
      access_mode: 'paid',
      price_usd_cents: 900,
      allow_remix: true,
    };
    viewerHasPurchased = true;
    const { loadGenerationRecipeRemixInputMediaByPostId } = await import(
      '@/lib/post-resource-bundles-server'
    );

    const media = await loadGenerationRecipeRemixInputMediaByPostId({
      postId: 'post-1',
      generationId: 'gen-1',
      viewerUserId: 'viewer-1',
    });

    expect(media).toEqual([
      expect.objectContaining({
        id: 'input-1',
        storagePath: 'generation_inputs/owner-1/gen-1/00-reference-image.png',
        url: 'https://signed.example.com/owner-1/gen-1/00-reference-image.png',
      }),
    ]);
  });

  // Owner, 2026-11-03: a file of someone else's recipe that this creator's run used through their
  // unlock (a remix of a recipe they bought) is never handed on, whatever this recipe's switches say.
  it('hands a buyer none of the creation’s inputs that were someone else’s recipe files, in the unlock or its remix', async () => {
    bundleRow = {
      ...(bundleRow as BundleRow),
      access_mode: 'paid',
      price_usd_cents: 900,
      allow_remix: true,
    };
    viewerHasPurchased = true;
    const recipeFileRow = (id: string, sortOrder: number, metadata: Record<string, unknown>) => ({
      ...generationInputRows[0],
      id,
      label: `Bought ${id}`,
      storage_path: `generation_inputs/owner-1/gen-1/0${sortOrder}-reference-image.png`,
      sort_order: sortOrder,
      metadata,
    });
    generationInputRows = [
      ...generationInputRows,
      // Marked as it was kept: the run imported the seller's copy through the creator's unlock.
      recipeFileRow('input-bought', 1, {
        sourceKind: 'recipe-file',
        sourceStoragePath: 'post_resource_files/seller-9/generation-references/gen-0/00-reference-image-row-1.png',
      }),
      // Unmarked, and known by its sources alone: the seller's file, and the start's import of it.
      recipeFileRow('input-seller-file', 2, {
        sourceStoragePath: 'post_resource_files/seller-9/generation-references/gen-0/01-reference-image-row-2.png',
      }),
      recipeFileRow('input-imported', 3, {
        sourceUrl: 'https://project.supabase.co/storage/v1/object/sign/generation_inputs/owner-1/recipe-imports/gen-0/02-reference-image-row-3.png?token=x',
      }),
    ];
    const {
      getPostResourceBundleDetailByPostId,
      loadGenerationRecipeRemixInputMediaByPostId,
      loadGenerationRecipeRemixInputsByPostId,
    } = await import('@/lib/post-resource-bundles-server');
    const request = { postId: 'post-1', generationId: 'gen-1', viewerUserId: 'viewer-1' };

    const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'viewer-1' });
    const media = await loadGenerationRecipeRemixInputMediaByPostId(request);
    const inputs = await loadGenerationRecipeRemixInputsByPostId(request);

    const listed = (detail?.resources?.items ?? []).map((item) => item.storagePath).filter(Boolean);
    expect(listed).toContain('generation_inputs/owner-1/gen-1/00-reference-image.png');
    expect(listed.filter((path) => /0[123]-reference-image/.test(String(path)))).toEqual([]);
    expect(media.map((item) => item.id)).toEqual(['input-1']);
    expect(inputs.inputMedia.map((item) => item.id)).toEqual(['input-1']);
    // Held back for a remix's empty slots, with no link to the file.
    expect(inputs.recipeFiles.map((item) => [item.id, item.url])).toEqual([
      ['input-bought', null],
      ['input-seller-file', null],
      ['input-imported', null],
    ]);
  });

  it('does not expose remix inputs to someone who has not unlocked a switch-off recipe', async () => {
    bundleRow = {
      ...(bundleRow as BundleRow),
      access_mode: 'free',
      allow_remix: false,
    };
    const { loadGenerationRecipeRemixInputMediaByPostId } = await import(
      '@/lib/post-resource-bundles-server'
    );

    await expect(loadGenerationRecipeRemixInputMediaByPostId({
      postId: 'post-1',
      generationId: 'gen-1',
      viewerUserId: 'viewer-1',
    })).resolves.toEqual([]);
  });

  it('surfaces saved references in the unlocked bundle after purchase', async () => {
    bundleRow = {
      ...(bundleRow as BundleRow),
      access_mode: 'paid',
      price_usd_cents: 900,
      allow_remix: true,
    };
    viewerHasPurchased = true;
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: 'viewer-1',
    });

    expect(detail?.viewerCanAccess).toBe(true);
    expect(detail?.resources?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'reference_image',
        storagePath: 'generation_inputs/owner-1/gen-1/00-reference-image.png',
      }),
    ]));
  });

  it('shows buyers the references even when remix restoration is not shared', async () => {
    // share_input_media_for_remix gates restoring the files into a remix, not
    // seeing them in an unlock the viewer paid for — no product surface sets
    // the flag today, so gating display on it would hide references from
    // every buyer.
    bundleRow = {
      ...(bundleRow as BundleRow),
      access_mode: 'paid',
      price_usd_cents: 900,
      allow_remix: true,
    };
    generationRow = {
      ...(generationRow as NonNullable<typeof generationRow>),
      share_input_media_for_remix: false,
    };
    viewerHasPurchased = true;
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: 'viewer-1',
    });

    expect(detail?.viewerCanAccess).toBe(true);
    expect(detail?.resources?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'reference_image',
        storagePath: 'generation_inputs/owner-1/gen-1/00-reference-image.png',
      }),
    ]));
  });

  // A live post whose generation is no longer public: an operator's removal,
  // which changes the generation alone, or a creation archived and restored by
  // its creator, which stays unpublished. The buyer's remix reads the inputs
  // through its own loader, which a generation start also asks before it copies
  // another creator's input, so it withholds what the unlock withholds.
  it('withholds live references from non-owners, in the unlock and its remix, once the generation is no longer public', async () => {
    bundleRow = {
      ...(bundleRow as BundleRow),
      access_mode: 'paid',
      price_usd_cents: 900,
      allow_remix: true,
    };
    generationRow = {
      ...(generationRow as NonNullable<typeof generationRow>),
      is_public: false,
    };
    viewerHasPurchased = true;
    const {
      getPostResourceBundleDetailByPostId,
      loadGenerationRecipeRemixInputMediaByPostId,
    } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: 'viewer-1',
    });
    const media = await loadGenerationRecipeRemixInputMediaByPostId({
      postId: 'post-1',
      generationId: 'gen-1',
      viewerUserId: 'viewer-1',
    });

    // Unlocked, with the creator's switch on: only the generation's state holds them back.
    expect(detail?.viewerCanAccess).toBe(true);
    expect(detail?.resources?.allowRemix).toBe(true);
    expect(detail?.resources?.items?.some(
      (item) => item.storagePath === 'generation_inputs/owner-1/gen-1/00-reference-image.png',
    )).toBe(false);
    expect(media).toEqual([]);
  });

  it('still hands the owner their own inputs through the remix loader', async () => {
    bundleRow = { ...(bundleRow as BundleRow), allow_remix: true };
    generationRow = { ...(generationRow as NonNullable<typeof generationRow>), is_public: false };
    const { loadGenerationRecipeRemixInputMediaByPostId } = await import('@/lib/post-resource-bundles-server');

    const media = await loadGenerationRecipeRemixInputMediaByPostId({
      postId: 'post-1',
      generationId: 'gen-1',
      viewerUserId: 'owner-1',
    });

    expect(media).toEqual([expect.objectContaining({
      storagePath: 'generation_inputs/owner-1/gen-1/00-reference-image.png',
    })]);
  });

  it('always shows the owner their own saved references', async () => {
    bundleRow = {
      ...(bundleRow as BundleRow),
      allow_remix: true,
    };
    generationRow = {
      ...(generationRow as NonNullable<typeof generationRow>),
      is_public: false,
      share_input_media_for_remix: false,
    };
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: 'owner-1',
    });

    expect(detail?.viewerIsOwner).toBe(true);
    expect(detail?.resources?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'reference_image',
        storagePath: 'generation_inputs/owner-1/gen-1/00-reference-image.png',
      }),
    ]));
  });

  // Recipe audit H1 (2026-10-27): a creation post's published recipe includes
  // its Remix whatever its stored switch says, so every read reports it as a
  // remix-included recipe and its buyers get what such a recipe always gave.
  describe('a published creation recipe whose stored remix switch is off', () => {
    it('reads as remix-included, with Remix locked, for someone who has not unlocked it', async () => {
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      // allow_remix stays false from the fixture.
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'viewer-1' });

      expect(detail?.viewerCanAccess).toBe(false);
      expect(detail?.allowRemix).toBe(true);
      expect(detail?.remixCapability).toBe('unlock_required');
      expect(detail?.resourceKinds).toContain('remix');
      expect(detail?.lockedPreview.hasRemix).toBe(true);
    });

    // The creation's saved inputs can be personal (a selfie used as a
    // reference), and only the creator's stored switch ever offered them, so
    // the Remix that now comes with every recipe hands them to nobody new
    // (main session, 2026-10-27): what gives access is normalised, what hands
    // over inputs keys on the stored `allow_remix`.
    it('lets whoever unlocked it remix, without handing them the creation’s inputs', async () => {
      viewerHasPurchased = true;
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'viewer-1' });

      expect(detail?.viewerCanAccess).toBe(true);
      expect(detail?.remixCapability).toBe('public');
      expect(detail?.allowRemix).toBe(true);
      // The stored payload says what the creator chose.
      expect(detail?.resources?.allowRemix).toBe(false);
      expect(detail?.resources?.items?.some(
        (item) => item.storagePath === 'generation_inputs/owner-1/gen-1/00-reference-image.png',
      )).toBe(false);
    });

    it('restores none of the creation’s inputs into the remix of whoever unlocked it', async () => {
      viewerHasPurchased = true;
      const { loadGenerationRecipeRemixInputMediaByPostId } = await import('@/lib/post-resource-bundles-server');

      const media = await loadGenerationRecipeRemixInputMediaByPostId({
        postId: 'post-1',
        generationId: 'gen-1',
        viewerUserId: 'viewer-1',
      });

      expect(media).toEqual([]);
    });

    // The editor round-trips `resources`, so it must hold the stored switch:
    // a re-save of an old recipe never turns the creator's inputs on.
    it('hands its owner the stored switch, while reporting the Remix that comes with it', async () => {
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'owner-1' });

      expect(detail?.viewerIsOwner).toBe(true);
      expect(detail?.allowRemix).toBe(true);
      expect(detail?.resourceKinds).toContain('remix');
      expect(detail?.resources?.allowRemix).toBe(false);
      expect(detail?.resources?.items?.some(
        (item) => item.storagePath === 'generation_inputs/owner-1/gen-1/00-reference-image.png',
      )).toBe(false);
    });

    it('reports a recipe that is no longer published as it is stored', async () => {
      bundleRow = { ...(bundleRow as BundleRow), status: 'draft' as BundleRow['status'] };
      viewerHasPurchased = true;
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'viewer-1' });

      expect(detail?.allowRemix).toBe(false);
      expect(detail?.resourceKinds).not.toContain('remix');
    });

    it('leaves an upload post’s recipe as it is stored', async () => {
      postRow = { ...(postRow as Record<string, unknown>), generation_id: null, source_kind: 'external' };
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'viewer-1' });

      expect(detail?.allowRemix).toBe(false);
      expect(detail?.resourceKinds).not.toContain('remix');
    });
  });

  // Recipe audit S-F8: "Include creation references" stores copies of the
  // creation's inputs as `reference-<input id>` items, and a remix-included
  // recipe merged the same inputs again at read time.
  it('does not list a creation reference twice when the recipe stores a copy of it', async () => {
    bundleRow = {
      ...(bundleRow as BundleRow),
      allow_remix: true,
      resource_items: [
        { id: 'prompt-1', type: 'prompt', title: 'Prompt', textContent: 'Public prompt text' },
        {
          id: 'reference-input-1',
          type: 'reference_image',
          title: 'Image input',
          storagePath: 'owner-1/generation-references/gen-1/input.png',
          contentType: 'image/png',
        },
      ],
    };
    viewerHasPurchased = true;
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'viewer-1' });

    const references = (detail?.resources?.items ?? []).filter((item) => item.type === 'reference_image');
    expect(references.map((item) => item.storagePath)).toEqual([
      'owner-1/generation-references/gen-1/input.png',
    ]);
  });

  // Owner, 2026-11-04: the copies of a creation its creator archived or an operator removed are no
  // longer served to the recipe's buyers, from the recipe as it stands or from the version they bought,
  // so no file route signs them; un-archiving serves them again, and the seller's editor keeps them.
  describe('the copies of a creation now off public view', () => {
    const COPY = 'owner-1/generation-references/gen-1/00-reference-image-input-1.png';
    beforeEach(() => {
      bundleRow = {
        ...(bundleRow as BundleRow),
        resource_items: [
          { id: 'prompt-1', type: 'prompt', title: 'Prompt', textContent: 'Public prompt text' },
          { id: 'reference-input-1', type: 'reference_image', title: 'Image input', storagePath: COPY, contentType: 'image/png' },
        ],
      };
      viewerHasPurchased = true;
    });
    const copiesFor = async (viewerUserId: string) => {
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId });
      return (detail?.resources?.items ?? []).filter((item) => item.storagePath === COPY).map((item) => item.storagePath);
    };

    it('withholds them from a buyer once the creation is archived, and serves them again after', async () => {
      expect(await copiesFor('viewer-1')).toEqual([COPY]);
      generationRow = { ...(generationRow as NonNullable<typeof generationRow>), archived_at: '2026-11-04T00:00:00.000Z' };
      expect(await copiesFor('viewer-1')).toEqual([]);
      generationRow = { ...(generationRow as NonNullable<typeof generationRow>), archived_at: null };
      expect(await copiesFor('viewer-1')).toEqual([COPY]);
    });

    it('withholds them once an operator removed the creation', async () => {
      generationRow = { ...(generationRow as NonNullable<typeof generationRow>), moderation_removed_at: '2026-11-04T00:00:00.000Z' };
      expect(await copiesFor('viewer-1')).toEqual([]);
    });

    // 2026-11-04 review: the teaser counted them, so a new buyer could pay for references they would not get.
    it('leaves them out of the teaser a would-be buyer is sold on', async () => {
      viewerHasPurchased = false;
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const teaser = async () => (await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'stranger-1', countLockedReferences: false }))?.lockedPreview;

      const live = await teaser();
      expect(live?.itemCounts.reference_image).toBe(1);
      expect(live?.resourceKinds).toContain('files');
      generationRow = { ...(generationRow as NonNullable<typeof generationRow>), archived_at: '2026-11-04T00:00:00.000Z' };
      const archived = await teaser();
      expect(archived?.itemCounts.reference_image ?? 0).toBe(0);
      expect(archived?.resourceKinds).not.toContain('files');
    });

    it('keeps them in the seller’s own editor', async () => {
      generationRow = { ...(generationRow as NonNullable<typeof generationRow>), archived_at: '2026-11-04T00:00:00.000Z' };
      expect(await copiesFor('owner-1')).toEqual([COPY]);
    });
  });

  // Recipe reading review B3 (2026-10-29): a creation recipe gains the
  // creation's saved inputs only when it is read unlocked, so its teaser said
  // "1 prompt" and the unlock then gave a prompt, three pictures and a clip
  // (post 6487f689).
  describe('a locked creation recipe whose creator shares the creation’s inputs', () => {
    type InputRow = (typeof generationInputRows)[number];
    const inputRow = (overrides: Partial<InputRow> & Pick<InputRow, 'id'>): InputRow => ({
      generation_id: 'gen-1',
      user_id: 'owner-1',
      media_type: 'image',
      role: 'reference_image',
      label: `Private name of ${overrides.id}`,
      storage_path: `generation_inputs/owner-1/gen-1/${overrides.id}.png`,
      source_generation_id: null,
      sort_order: 0,
      metadata: {},
      ...overrides,
    });
    const embeddedSourceReads = () => bundleSelects.filter((columns) => columns.includes('generation:generations'));

    beforeEach(() => {
      bundleRow = {
        ...(bundleRow as BundleRow),
        allow_remix: true,
        resource_items: [{ id: 'prompt-1', type: 'prompt', title: 'Prompt', textContent: 'Public prompt text' }],
      };
      generationInputRows = [
        inputRow({ id: 'image-1', sort_order: 0 }),
        inputRow({ id: 'image-2', sort_order: 1 }),
        inputRow({ id: 'image-3', sort_order: 2 }),
        inputRow({
          id: 'video-1',
          media_type: 'video',
          role: 'reference_video',
          storage_path: 'generation_inputs/owner-1/gen-1/video-1.mp4',
          sort_order: 3,
        }),
      ];
    });

    it('counts the references its unlock adds, in the order the unlocked recipe reads', async () => {
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const { formatPostResourceBundleCountSummary } = await import('@/lib/post-resource-bundles');

      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null });

      expect(detail?.viewerCanAccess).toBe(false);
      expect(detail?.resources).toBeNull();
      expect(detail?.lockedPreview.itemCounts).toEqual({ prompt: 1, reference_image: 3, reference_video: 1 });
      expect(formatPostResourceBundleCountSummary(detail?.lockedPreview))
        .toBe('1 prompt, 3 reference images, 1 reference video');
      // The kind chips name them too, as they name a reference the recipe stores.
      expect(detail?.resourceKinds).toEqual(['prompt', 'files', 'remix']);
      expect(detail?.lockedPreview.resourceKinds).toEqual(['prompt', 'files', 'remix']);
    });

    it('says how many, never which: no name, file or id of an input leaves the server', async () => {
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'viewer-1' });
      const sent = JSON.stringify(detail);

      expect(detail?.viewerCanAccess).toBe(false);
      expect(sent).not.toContain('generation_inputs');
      expect(sent).not.toContain('Private name');
      expect(sent).not.toMatch(/image-[123]|video-1/);
      // The per-item preview stays the creator's stored items alone.
      expect(detail?.lockedPreview.itemPreviews.map((item) => item.type)).toEqual(['prompt']);
    });

    it('counts exactly what the unlock then shows', async () => {
      bundleRow = {
        ...(bundleRow as BundleRow),
        resource_items: [
          { id: 'prompt-1', type: 'prompt', title: 'Prompt', textContent: 'Public prompt text' },
          // "Include creation references" stored a copy of image-1 (S-F8)…
          {
            id: 'reference-image-1',
            type: 'reference_image',
            title: 'Image 1',
            storagePath: 'owner-1/generation-references/gen-1/image-1.png',
            contentType: 'image/png',
          },
          // …and the creator attached image-2's own file.
          {
            id: 'stored-2',
            type: 'reference_image',
            title: 'Image 2',
            storagePath: 'generation_inputs/owner-1/gen-1/image-2.png',
            contentType: 'image/png',
          },
        ],
      };
      generationInputRows = [
        inputRow({ id: 'image-1', sort_order: 0 }),
        inputRow({ id: 'image-2', sort_order: 1 }),
        // Outside its owner's folder: never signed, so never shown.
        inputRow({ id: 'image-3', storage_path: 'generation_inputs/someone-else/gen-1/image-3.png', sort_order: 2 }),
        inputRow({ id: 'video-1', media_type: 'video', role: 'reference_video', storage_path: 'generation_inputs/owner-1/gen-1/video-1.mp4', sort_order: 3 }),
        inputRow({ id: 'audio-1', media_type: 'audio', role: 'reference_audio', storage_path: 'generation_inputs/owner-1/gen-1/audio-1.mp3', sort_order: 4 }),
      ];
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const { getPostResourceItemCounts } = await import('@/lib/post-resource-bundles');

      const locked = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'viewer-1' });
      viewerHasPurchased = true;
      const unlocked = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'viewer-1' });

      expect(locked?.viewerCanAccess).toBe(false);
      expect(unlocked?.viewerCanAccess).toBe(true);
      expect(locked?.lockedPreview.itemCounts).toEqual(getPostResourceItemCounts(unlocked?.resources?.items ?? []));
      // And the recipe names the same contents once unlocked.
      expect(unlocked?.lockedPreview.itemCounts).toEqual(locked?.lockedPreview.itemCounts);
      expect(unlocked?.resourceKinds).toEqual(locked?.resourceKinds);
      expect(locked?.lockedPreview.itemCounts).toEqual({
        prompt: 1,
        reference_image: 2,
        reference_video: 1,
        reference_audio: 1,
      });
    });

    it('counts the references of a creation made before its inputs were kept, as the unlock reads them', async () => {
      generationInputRows = [];
      generationRow = {
        ...(generationRow as NonNullable<typeof generationRow>),
        workflow_settings: {
          model: 'nano-banana-2',
          elements: [{
            id: 'element-1',
            displayName: 'Image input',
            handle: '@alisa',
            storagePath: 'generation_inputs/owner-1/gen-1/legacy-reference.png',
          }],
        },
      };
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const { getPostResourceItemCounts } = await import('@/lib/post-resource-bundles');

      const locked = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'viewer-1' });
      viewerHasPurchased = true;
      const unlocked = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'viewer-1' });

      expect(locked?.lockedPreview.itemCounts).toEqual({ prompt: 1, reference_image: 1 });
      expect(locked?.lockedPreview.itemCounts).toEqual(getPostResourceItemCounts(unlocked?.resources?.items ?? []));
    });

    it('counts none when the creator’s stored switch keeps them, and reads nothing for it', async () => {
      // The Remix still comes with the recipe; the inputs do not (2026-10-27).
      bundleRow = { ...(bundleRow as BundleRow), allow_remix: false };
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null });

      expect(detail?.lockedPreview.itemCounts).toEqual({ prompt: 1 });
      expect(detail?.resourceKinds).toEqual(['prompt', 'remix']);
      expect(embeddedSourceReads()).toEqual([]);
    });

    it('counts none once the generation is no longer public', async () => {
      generationRow = { ...(generationRow as NonNullable<typeof generationRow>), is_public: false };
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null });

      expect(detail?.lockedPreview.itemCounts).toEqual({ prompt: 1 });
      expect(detail?.resourceKinds).toEqual(['prompt', 'remix']);
    });

    it('counts none from a generation the post’s creator does not own', async () => {
      generationRow = { ...(generationRow as NonNullable<typeof generationRow>), user_id: 'someone-else' };
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null });

      expect(detail?.lockedPreview.itemCounts).toEqual({ prompt: 1 });
    });

    // Publish files a creation made as a guest under the account the guest was
    // linked to; the generation and its saved inputs keep the guest's id.
    it('counts those of a creation made as a guest, posted by the account it was linked to', async () => {
      generationRow = { ...(generationRow as NonNullable<typeof generationRow>), user_id: 'guest-1' };
      generationInputRows = generationInputRows.map((row) => ({
        ...row,
        user_id: 'guest-1',
        storage_path: row.storage_path.replace('/owner-1/', '/guest-1/'),
      }));
      linkedGuestRows = [{ id: 'guest-1', merged_into_user_id: 'owner-1' }];
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null });

      expect(detail?.lockedPreview.itemCounts).toEqual({ prompt: 1, reference_image: 3, reference_video: 1 });
    });

    it('counts none on a post that is not a Magicbooklet creation', async () => {
      postRow = { ...(postRow as Record<string, unknown>), source_kind: 'external' };
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null });

      expect(detail?.lockedPreview.itemCounts).toEqual({ prompt: 1 });
    });

    it('keeps the stored counts when the inputs cannot be read', async () => {
      embeddedSourceReadError = { code: '57014', message: 'canceling statement due to statement timeout' };
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null });

      expect(detail?.viewerCanAccess).toBe(false);
      expect(detail?.lockedPreview.itemCounts).toEqual({ prompt: 1 });
    });

    // postgrest-js retries a 503 for seconds; the count is only a teaser.
    it('gives up on a count that runs long and keeps the stored counts', async () => {
      embeddedSourceReadHangs = true;
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      const started = Date.now();
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null });

      expect(detail?.lockedPreview.itemCounts).toEqual({ prompt: 1 });
      expect(Date.now() - started).toBeLessThan(3000);
    });

    // The app's recipe page names the kinds whether or not it is unlocked.
    it('counts what was merged in for a buyer and for the owner, read as the teaser reads it', async () => {
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      viewerHasPurchased = true;
      const bought = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'viewer-1' });
      viewerHasPurchased = false;
      const own = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'owner-1' });

      for (const detail of [bought, own]) {
        expect(detail?.viewerCanAccess).toBe(true);
        expect(detail?.lockedPreview.itemCounts).toEqual({ prompt: 1, reference_image: 3, reference_video: 1 });
        expect(detail?.resourceKinds).toEqual(['prompt', 'files', 'remix']);
      }
      // One read each, the teaser's, in place of the post, the generation and
      // its inputs read one after another.
      expect(embeddedSourceReads()).toHaveLength(2);
      expect(tableReads).not.toContain('generations');
      expect(tableReads).not.toContain('generation_input_media');
    });

    it('reads nothing for a caller that only decides access', async () => {
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      const detail = await getPostResourceBundleDetailByPostId('post-1', {
        viewerUserId: 'viewer-1',
        countLockedReferences: false,
      });

      expect(detail?.viewerCanAccess).toBe(false);
      expect(detail?.lockedPreview.itemCounts).toEqual({ prompt: 1 });
      expect(embeddedSourceReads()).toEqual([]);
    });

    it('starts the count beside the reads the recipe already makes, so it adds no wait', async () => {
      let releaseRevisionRead!: () => void;
      revisionReadGate = new Promise((resolve) => {
        releaseRevisionRead = resolve;
      });
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      const pending = getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null, isNsfw: false });
      // Asked for while the hydrate's own read is still out, not after it.
      await vi.waitFor(() => expect(embeddedSourceReads()).toHaveLength(1));
      releaseRevisionRead();

      await expect(pending).resolves.toMatchObject({
        lockedPreview: { itemCounts: { prompt: 1, reference_image: 3, reference_video: 1 } },
      });
    });

    // The post page and the app's Details read a recipe on every view.
    it('costs one more request on a locked view: the post with its generation and that generation’s inputs', async () => {
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null, isNsfw: false });
      const sharingReads = [...tableReads];
      const sourceSelects = embeddedSourceReads();
      tableReads = [];
      bundleRow = { ...(bundleRow as BundleRow), allow_remix: false };
      await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null, isNsfw: false });

      expect(sharingReads).toHaveLength(tableReads.length + 1);
      expect(sourceSelects).toHaveLength(1);
      expect(sourceSelects[0]).toContain('generation_input_media');
      expect(sharingReads).not.toContain('generations');
      expect(sharingReads).not.toContain('generation_input_media');
    });

    // #582 read a locked recipe's inputs in one request but an unlocked one's
    // in three, one after another, after everything else the recipe reads.
    it('reads a buyer’s references with the teaser’s one read, beside the reads the recipe already makes', async () => {
      let releaseRevisionRead!: () => void;
      revisionReadGate = new Promise((resolve) => {
        releaseRevisionRead = resolve;
      });
      viewerHasPurchased = true;
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const { getPostResourceItemCounts } = await import('@/lib/post-resource-bundles');

      const pending = getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'viewer-1', isNsfw: false });
      await vi.waitFor(() => expect(embeddedSourceReads()).toHaveLength(1));
      releaseRevisionRead();
      const unlocked = await pending;

      expect(getPostResourceItemCounts(unlocked?.resources?.items ?? []))
        .toEqual({ prompt: 1, reference_image: 3, reference_video: 1 });
      // The unlock waits for its references, where a teaser gives up on them.
      expect(embeddedSourceSignals).toEqual([null]);
    });

    it('gives up on the teaser’s read, and only the teaser’s', async () => {
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null, isNsfw: false });

      expect(embeddedSourceSignals).toHaveLength(1);
      expect(embeddedSourceSignals[0]).toBeInstanceOf(AbortSignal);
    });

    // Review of 2026-10-29: the inputs read finds the recipe by the id as the
    // database spells it, and the lookup used the caller's spelling, so an id
    // in capitals unlocked the recipe without its references.
    it('gives the creation’s references, and counts them, however the post id is spelled', async () => {
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const { getPostResourceItemCounts } = await import('@/lib/post-resource-bundles');

      const locked = await getPostResourceBundleDetailByPostId('POST-1', { viewerUserId: 'viewer-1', isNsfw: false });
      viewerHasPurchased = true;
      const unlocked = await getPostResourceBundleDetailByPostId('POST-1', { viewerUserId: 'viewer-1', isNsfw: false });

      expect(locked?.lockedPreview.itemCounts).toEqual({ prompt: 1, reference_image: 3, reference_video: 1 });
      expect(getPostResourceItemCounts(unlocked?.resources?.items ?? []))
        .toEqual({ prompt: 1, reference_image: 3, reference_video: 1 });
    });

    // The marketplace, search, the reel and the owner's lists teased stored
    // items only: 6487f689's tile said "Includes 1 prompt" beside a post page
    // that, after #582, said a prompt, three pictures and a clip.
    describe('on a page that lists recipes', () => {
      type Counts = Record<string, number>;
      const shared: Counts = { prompt: 1, reference_image: 3, reference_video: 1 };
      const storedOnly: Counts = { prompt: 1 };
      // What the creator did, what a buyer's unlock then gives, and what the
      // owner's own unlock gives.
      const gateCases: Array<[string, () => void, Counts, Counts]> = [
        ['shares the creation’s inputs', () => {}, shared, shared],
        ['keeps them with the stored switch', () => {
          bundleRow = { ...(bundleRow as BundleRow), allow_remix: false };
        }, storedOnly, storedOnly],
        ['made the generation private since', () => {
          generationRow = { ...(generationRow as NonNullable<typeof generationRow>), is_public: false };
        }, storedOnly, shared],
        ['linked a generation they do not own', () => {
          generationRow = { ...(generationRow as NonNullable<typeof generationRow>), user_id: 'someone-else' };
        }, storedOnly, storedOnly],
        ['posted it from outside Magicbooklet', () => {
          postRow = { ...(postRow as Record<string, unknown>), source_kind: 'external' };
        }, storedOnly, storedOnly],
        ['already stores two of them', () => {
          bundleRow = {
            ...(bundleRow as BundleRow),
            resource_items: [
              { id: 'prompt-1', type: 'prompt', title: 'Prompt', textContent: 'Public prompt text' },
              // A copy "Include creation references" stored, and the file itself.
              { id: 'reference-image-1', type: 'reference_image', title: 'Image 1', storagePath: 'owner-1/generation-references/gen-1/image-1.png', contentType: 'image/png' },
              { id: 'stored-2', type: 'reference_image', title: 'Image 2', storagePath: 'generation_inputs/owner-1/gen-1/image-2.png', contentType: 'image/png' },
            ],
          };
        }, shared, shared],
        ['kept one outside their own folder', () => {
          generationInputRows = [
            ...generationInputRows,
            inputRow({ id: 'stray-1', storage_path: 'generation_inputs/someone-else/gen-1/stray-1.png', sort_order: 9 }),
          ];
        }, shared, shared],
        ['made it before inputs were kept', () => {
          generationInputRows = [];
          generationRow = {
            ...(generationRow as NonNullable<typeof generationRow>),
            workflow_settings: {
              model: 'nano-banana-2',
              elements: [{ id: 'element-1', displayName: 'Image input', handle: '@alisa', storagePath: 'generation_inputs/owner-1/gen-1/legacy-reference.png' }],
            },
          };
        }, { prompt: 1, reference_image: 1 }, { prompt: 1, reference_image: 1 }],
      ];

      it.each(gateCases)('the marketplace tile counts what a buyer’s unlock gives when the creator %s', async (_case, arrange, buyerCounts) => {
        arrange();
        const { getMarketplaceResourceList, getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
        const { getPostResourceItemCounts } = await import('@/lib/post-resource-bundles');

        const [tile] = (await getMarketplaceResourceList()).items;
        viewerHasPurchased = true;
        const unlocked = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'viewer-1' });

        expect(unlocked?.viewerCanAccess).toBe(true);
        expect(getPostResourceItemCounts(unlocked?.resources?.items ?? [])).toEqual(buyerCounts);
        expect(tile.lockedPreview.itemCounts).toEqual(buyerCounts);
      });

      it.each(gateCases)('the seller page counts what the owner’s unlock gives when the creator %s', async (_case, arrange, _buyerCounts, ownerCounts) => {
        arrange();
        const { getPostResourceBundleDetailByPostId, getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');
        const { getPostResourceItemCounts } = await import('@/lib/post-resource-bundles');

        const [listing] = (await getSellerPostResourceBundleDashboard('owner-1')).bundles;
        const own = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'owner-1' });

        expect(getPostResourceItemCounts(own?.resources?.items ?? [])).toEqual(ownerCounts);
        expect(listing.lockedPreview.itemCounts).toEqual(ownerCounts);
      });

      it('counts a recipe not yet published on its owner’s pages, and for no one else', async () => {
        bundleRow = { ...(bundleRow as BundleRow), status: 'draft' };
        const {
          countGenerationRecipeReferenceItemsByPostId,
          getPostResourceBundleDetailByPostId,
          getSellerPostResourceBundleDashboard,
        } = await import('@/lib/post-resource-bundles-server');
        const { getPostResourceItemCounts } = await import('@/lib/post-resource-bundles');
        const { createServiceClient } = await import('@/lib/server-helpers');
        // The page counted for: an owner's own page, or a public one (null).
        const countFor = async (ownerUserId: string | null) => [...await countGenerationRecipeReferenceItemsByPostId({
          adminSupabase: createServiceClient() as never,
          postIds: ['post-1'],
          ownerUserId,
        })];

        const [listing] = (await getSellerPostResourceBundleDashboard('owner-1')).bundles;
        const own = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'owner-1' });

        expect(listing.lockedPreview.itemCounts).toEqual(getPostResourceItemCounts(own?.resources?.items ?? []));
        expect(listing.lockedPreview.itemCounts).toEqual({ prompt: 1, reference_image: 3, reference_video: 1 });
        // A list never reads a draft's contents for anyone but its owner.
        expect(await countFor(null)).toEqual([]);
        expect(await countFor('viewer-1')).toEqual([]);
        expect(await countFor('owner-1')).toEqual([['post-1', { reference_image: 3, reference_video: 1 }]]);
        // Each page asks with plain filters, never with an id written into an
        // `or` (postgrest-js does not escape its values).
        expect(embeddedSourceFilters).toEqual([
          // The seller page, then the owner's own recipe page, which has
          // settled who may read already.
          { eq: { allow_remix: true, owner_user_id: 'owner-1' }, or: [] },
          { eq: { allow_remix: true }, or: [] },
          { eq: { allow_remix: true, status: 'published' }, or: [] },
          { eq: { allow_remix: true, owner_user_id: 'viewer-1' }, or: [] },
          { eq: { allow_remix: true, owner_user_id: 'owner-1' }, or: [] },
        ]);
      });

      // Review of 2026-10-29: the read sent every recipe's stored text again,
      // which its callers already held and the count never reads.
      it('reads only what the count needs: the post, generation and inputs, and stored files only where a page has no rows', async () => {
        const {
          countGenerationRecipeReferenceItemsByPostId,
          getMarketplaceResourceList,
          getPostResourceBundleDetailByPostId,
        } = await import('@/lib/post-resource-bundles-server');
        const { createServiceClient } = await import('@/lib/server-helpers');
        const topLevelColumns = (select: string) => {
          const columns: string[] = [];
          let depth = 0;
          let start = 0;
          for (let index = 0; index <= select.length; index += 1) {
            if (select[index] === '(') depth += 1;
            if (select[index] === ')') depth -= 1;
            if (index === select.length || (select[index] === ',' && depth === 0)) {
              const column = select.slice(start, index).trim();
              columns.push(column.includes('(') ? column.slice(0, column.indexOf(':')) : column);
              start = index + 1;
            }
          }
          return columns;
        };

        await getMarketplaceResourceList();
        await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null, isNsfw: false });
        const counts = await countGenerationRecipeReferenceItemsByPostId({
          adminSupabase: createServiceClient() as never,
          postIds: ['post-1'],
          ownerUserId: null,
        });

        expect(embeddedSourceReads().map(topLevelColumns)).toEqual([
          ['post_id', 'owner_user_id', 'post'],
          ['post_id', 'owner_user_id', 'post'],
          // Merging keys on a stored copy's id and file path, nothing else.
          ['post_id', 'owner_user_id', 'attachments', 'resource_items', 'post'],
        ]);
        expect([...counts]).toEqual([['post-1', { reference_image: 3, reference_video: 1 }]]);
      });

      it('counts what a stored copy of an input leaves to add on a page that reads its recipes’ files itself', async () => {
        bundleRow = {
          ...(bundleRow as BundleRow),
          resource_items: [
            { id: 'prompt-1', type: 'prompt', title: 'Prompt', textContent: 'Public prompt text' },
            { id: 'reference-image-1', type: 'reference_image', title: 'Image 1', storagePath: 'owner-1/generation-references/gen-1/image-1.png', contentType: 'image/png' },
            { id: 'stored-2', type: 'reference_image', title: 'Image 2', storagePath: 'generation_inputs/owner-1/gen-1/image-2.png', contentType: 'image/png' },
          ],
        };
        const { countGenerationRecipeReferenceItemsByPostId } = await import('@/lib/post-resource-bundles-server');
        const { createServiceClient } = await import('@/lib/server-helpers');

        const counts = await countGenerationRecipeReferenceItemsByPostId({
          adminSupabase: createServiceClient() as never,
          postIds: ['post-1'],
          ownerUserId: null,
        });

        expect([...counts]).toEqual([['post-1', { reference_image: 1, reference_video: 1 }]]);
      });

      // Review of 2026-10-29: one recipe whose inputs could not be read threw
      // away every count on the page.
      it('keeps counting the rest of the page when one recipe’s inputs cannot be read', async () => {
        // No saved inputs, and settings that name its pictures as something
        // other than a list, which the legacy reader throws on.
        extraCreationInputSources = [{
          post_id: 'post-2',
          owner_user_id: 'owner-2',
          status: 'published',
          allow_remix: true,
          attachments: [],
          resource_items: [{ id: 'prompt-1', type: 'prompt', title: 'Prompt', textContent: 'Another prompt' }],
          post: {
            id: 'post-2',
            user_id: 'owner-2',
            generation_id: 'gen-2',
            category: 'video',
            visibility: 'public',
            archived_at: null,
            review_status: 'visible',
            source_kind: 'magicbooklet',
            generation: {
              id: 'gen-2',
              user_id: 'owner-2',
              is_public: true,
              category: 'video',
              workflow_settings: { seedanceAssets: { images: 'not-a-list' } },
              inputs: [],
            },
          },
        }];
        const { countGenerationRecipeReferenceItemsByPostId } = await import('@/lib/post-resource-bundles-server');
        const { createServiceClient } = await import('@/lib/server-helpers');

        const counts = await countGenerationRecipeReferenceItemsByPostId({
          adminSupabase: createServiceClient() as never,
          postIds: ['post-2', 'post-1'],
          ownerUserId: null,
        });

        expect([...counts]).toEqual([['post-1', { reference_image: 3, reference_video: 1 }]]);
      });

      it('counts none on a post moderation hid, for its owner too', async () => {
        postRow = { ...(postRow as Record<string, unknown>), review_status: 'hidden' };
        const { getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');

        const [listing] = (await getSellerPostResourceBundleDashboard('owner-1')).bundles;

        expect(listing.lockedPreview.itemCounts).toEqual({ prompt: 1 });
      });

      it('reads a page of recipes in one request, filtered to those whose creator shares the inputs', async () => {
        const { countGenerationRecipeReferenceItemsByPostId } = await import('@/lib/post-resource-bundles-server');
        const { createServiceClient } = await import('@/lib/server-helpers');

        const counts = await countGenerationRecipeReferenceItemsByPostId({
          adminSupabase: createServiceClient() as never,
          postIds: ['post-1', 'post-2', 'post-1', 'post-3'],
          ownerUserId: null,
        });

        expect([...counts]).toEqual([['post-1', { reference_image: 3, reference_video: 1 }]]);
        expect(embeddedSourceReads()).toHaveLength(1);
        expect(tableReads.filter((table) => table !== 'post_resource_bundles')).toEqual([]);
      });

      it('asks nothing when no recipe on the page shares its inputs', async () => {
        bundleRow = { ...(bundleRow as BundleRow), allow_remix: false };
        const { getMarketplaceResourceList } = await import('@/lib/post-resource-bundles-server');

        await getMarketplaceResourceList();

        expect(embeddedSourceReads()).toEqual([]);
      });

      it('keeps the stored counts when the page’s read fails or runs long', async () => {
        const { getMarketplaceResourceList } = await import('@/lib/post-resource-bundles-server');

        embeddedSourceReadError = { code: '57014', message: 'canceling statement due to statement timeout' };
        const failed = await getMarketplaceResourceList();
        embeddedSourceReadError = null;
        embeddedSourceReadHangs = true;
        const started = Date.now();
        const slow = await getMarketplaceResourceList();

        expect(failed.items[0]?.lockedPreview.itemCounts).toEqual({ prompt: 1 });
        expect(slow.items[0]?.lockedPreview.itemCounts).toEqual({ prompt: 1 });
        expect(Date.now() - started).toBeLessThan(3000);
      });

      // Review of cb35d555: the RPC page counted before its own search check,
      // which reads a tile's kinds, so whether "files" kept a recipe the SQL
      // matched on text the tile does not show hung on the count read; the
      // fallback, which counts after it, always dropped it.
      it('keeps the same recipes for a search whether or not the count read answers, and counts only those it serves', async () => {
        // A recipe the page drops: its post is gone.
        extraListedBundleRows = [{ ...(bundleRow as BundleRow), id: 'bundle-2', post_id: 'post-2' }];
        const { getMarketplaceResourceList } = await import('@/lib/post-resource-bundles-server');

        const answered = await getMarketplaceResourceList({ q: 'files' });
        embeddedSourceReadError = { code: '57014', message: 'canceling statement due to statement timeout' };
        const failed = await getMarketplaceResourceList({ q: 'files' });
        embeddedSourceReadError = null;
        const shown = await getMarketplaceResourceList({ q: 'creation recipe' });

        expect(answered.items).toEqual([]);
        expect(failed.items).toEqual([]);
        expect(shown.items.map((item) => [item.postId, item.lockedPreview.itemCounts])).toEqual([
          ['post-1', { prompt: 1, reference_image: 3, reference_video: 1 }],
        ]);
        // One read, for the one recipe served.
        expect(embeddedSourcePostIds).toEqual([['post-1']]);
      });

      it('the marketplace tile counts what the unlock then gives, and never which', async () => {
        const { getMarketplaceResourceList, getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
        const { getPostResourceItemCounts } = await import('@/lib/post-resource-bundles');

        const page = await getMarketplaceResourceList();
        viewerHasPurchased = true;
        const unlocked = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'viewer-1' });

        expect(page.items).toHaveLength(1);
        const [tile] = page.items;
        expect(tile.lockedPreview.itemCounts).toEqual(getPostResourceItemCounts(unlocked?.resources?.items ?? []));
        expect(tile.lockedPreview.itemCounts).toEqual({ prompt: 1, reference_image: 3, reference_video: 1 });
        expect(tile.resourceKinds).toEqual(['prompt', 'files', 'remix']);
        const sent = JSON.stringify(page);
        expect(sent).not.toContain('generation_inputs');
        expect(sent).not.toContain('Private name');
        expect(sent).not.toMatch(/image-[123]|video-1/);
      });

      it('the seller page counts them as its owner’s own unlock reads them', async () => {
        // The owner keeps reading the inputs of a generation that is no longer
        // public; a buyer, and so the public tile, gets none of them.
        generationRow = { ...(generationRow as NonNullable<typeof generationRow>), is_public: false };
        const {
          getMarketplaceResourceList,
          getPostResourceBundleDetailByPostId,
          getSellerPostResourceBundleDashboard,
        } = await import('@/lib/post-resource-bundles-server');
        const { getPostResourceItemCounts } = await import('@/lib/post-resource-bundles');

        const dashboard = await getSellerPostResourceBundleDashboard('owner-1');
        const own = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'owner-1' });
        const page = await getMarketplaceResourceList();

        const [listing] = dashboard.bundles;
        expect(listing.lockedPreview.itemCounts).toEqual(getPostResourceItemCounts(own?.resources?.items ?? []));
        expect(listing.lockedPreview.itemCounts).toEqual({ prompt: 1, reference_image: 3, reference_video: 1 });
        expect(listing.resourceKinds).toEqual(['prompt', 'files', 'remix']);
        expect(page.items[0]?.lockedPreview.itemCounts).toEqual({ prompt: 1 });
        expect(page.items[0]?.resourceKinds).toEqual(['prompt', 'remix']);
      });
    });
  });

  // Recipe audit B-F4: "Updated <date>" moved with every sale and free open.
  describe('the date a recipe was updated', () => {
    it('is the time of its latest content revision, not of its last sale', async () => {
      bundleRow = { ...(bundleRow as BundleRow), updated_at: '2026-10-27T09:00:00.000Z' };
      revisionRows = [
        { bundle_id: 'bundle-1', revision_number: 1, created_at: '2026-06-05T00:00:00.000Z' },
        { bundle_id: 'bundle-1', revision_number: 2, created_at: '2026-08-01T12:00:00.000Z' },
        { bundle_id: 'other-bundle', revision_number: 7, created_at: '2026-10-26T00:00:00.000Z' },
      ];
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null });

      expect(detail?.updatedAt).toBe('2026-08-01T12:00:00.000Z');
      expect(detail?.lockedPreview.updatedAt).toBe('2026-08-01T12:00:00.000Z');
    });

    it('falls back to the row’s own time when no revision can be read', async () => {
      bundleRow = { ...(bundleRow as BundleRow), updated_at: '2026-10-27T09:00:00.000Z' };
      revisionReadError = { code: '57014', message: 'canceling statement due to statement timeout' };
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null });

      expect(detail?.updatedAt).toBe('2026-10-27T09:00:00.000Z');
    });
  });

  // The feed and the post page show no body of a paid recipe's post that is
  // the saved generation setup it sells (sanitizePublicPostContent). The
  // marketplace drew that body on the card, sent it to search and matched
  // queries on it.
  describe('a paid recipe whose post’s caption is its saved generation setup', () => {
    const SETUP_CAPTION = 'Saved generation setup\nModel: Nano Banana 2\nLight: quillfeather glow over the water';

    beforeEach(() => {
      bundleRow = { ...(bundleRow as BundleRow), access_mode: 'paid', price_usd_cents: 300 };
      postRow = { ...(postRow as Record<string, unknown>), body: SETUP_CAPTION };
    });

    it('is listed without it', async () => {
      const { getMarketplaceResourceList } = await import('@/lib/post-resource-bundles-server');

      const page = await getMarketplaceResourceList();

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.post?.body).toBe('');
      expect(page.items[0]?.post?.title).toBe('Public recipe post');
      expect(JSON.stringify(page)).not.toContain('quillfeather');
    });

    it('is not found by its words, and still by what the card shows', async () => {
      const { getMarketplaceResourceList } = await import('@/lib/post-resource-bundles-server');

      expect((await getMarketplaceResourceList({ q: 'quillfeather glow' })).items).toEqual([]);
      expect((await getMarketplaceResourceList({ q: 'public recipe post' })).items).toHaveLength(1);
    });

    it('does not name an untitled post after its setup', async () => {
      postRow = { ...(postRow as Record<string, unknown>), title: null };
      const { getMarketplaceResourceList } = await import('@/lib/post-resource-bundles-server');

      const [tile] = (await getMarketplaceResourceList()).items;

      expect(tile?.post?.title).toBe('Untitled creation');
      expect((await getMarketplaceResourceList({ q: 'saved generation setup' })).items).toEqual([]);
    });

    // Every quality check judges the post as stored: the database's listing
    // gate, the publish and promotion checks and both seller pages.
    it('is listed on its post as stored when the post shows nothing else, and shown without it', async () => {
      postRow = { ...(postRow as Record<string, unknown>), title: null, post_format: 'text', category: 'text', generation_id: null };
      const { getMarketplaceResourceList, getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');

      const page = await getMarketplaceResourceList();
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.post).toMatchObject({ title: 'Untitled note', body: '' });
      const [listing] = (await getSellerPostResourceBundleDashboard('owner-1')).bundles;
      expect(listing?.post?.body).toBe(SETUP_CAPTION);
      expect(listing?.quality.eligible).toBe(true);
    });

    it('is shown without it on the post’s own recipe read', async () => {
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: null });

      expect(detail?.post?.body).toBe('');
      expect(JSON.stringify(detail)).not.toContain('quillfeather');
    });

    it('keeps it under a free recipe, as the feed does', async () => {
      bundleRow = { ...(bundleRow as BundleRow), access_mode: 'free', price_usd_cents: 0 };
      const { getMarketplaceResourceList } = await import('@/lib/post-resource-bundles-server');

      const page = await getMarketplaceResourceList({ q: 'quillfeather glow' });

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.post?.body).toBe(SETUP_CAPTION);
    });
  });

  it('refuses to attach references from a generation the post creator does not own', async () => {
    bundleRow = {
      ...(bundleRow as BundleRow),
      allow_remix: true,
    };
    generationRow = {
      ...(generationRow as NonNullable<typeof generationRow>),
      user_id: 'someone-else',
    };
    viewerHasPurchased = true;
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: 'viewer-1',
    });

    expect(detail?.resources?.items?.some(
      (item) => item.storagePath === 'generation_inputs/owner-1/gen-1/00-reference-image.png',
    )).toBe(false);
  });

  // Publish files a creation made as a guest under the account the guest was
  // linked to, while the generation and its saved inputs keep the guest's id.
  describe('a creation made as a guest, posted by the account it was linked to', () => {
    const GUEST_INPUT_PATH = 'generation_inputs/guest-1/gen-1/00-reference-image.png';

    beforeEach(() => {
      bundleRow = {
        ...(bundleRow as BundleRow),
        access_mode: 'paid',
        price_usd_cents: 900,
        allow_remix: true,
      };
      generationRow = { ...(generationRow as NonNullable<typeof generationRow>), user_id: 'guest-1' };
      generationInputRows = generationInputRows.map((row) => ({
        ...row,
        user_id: 'guest-1',
        storage_path: GUEST_INPUT_PATH,
      }));
      linkedGuestRows = [{ id: 'guest-1', merged_into_user_id: 'owner-1' }];
      viewerHasPurchased = true;
    });

    it('lists its saved references in the recipe the buyer unlocked', async () => {
      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'viewer-1' });

      expect(detail?.resources?.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'reference_image', storagePath: GUEST_INPUT_PATH }),
      ]));
    });

    it('hands them to the buyer’s remix, signed from the guest’s folder', async () => {
      const { loadGenerationRecipeRemixInputMediaByPostId } = await import('@/lib/post-resource-bundles-server');

      const media = await loadGenerationRecipeRemixInputMediaByPostId({
        postId: 'post-1',
        generationId: 'gen-1',
        viewerUserId: 'viewer-1',
      });

      expect(media).toEqual([expect.objectContaining({
        id: 'input-1',
        storagePath: GUEST_INPUT_PATH,
        url: 'https://signed.example.com/guest-1/gen-1/00-reference-image.png',
      })]);
    });

    it('signs the references named by a creation made before inputs were kept, from the guest’s folder', async () => {
      generationInputRows = [];
      generationRow = {
        ...(generationRow as NonNullable<typeof generationRow>),
        workflow_settings: {
          model: 'nano-banana-2',
          elements: [{
            id: 'element-1',
            displayName: 'Image input',
            handle: '@alisa',
            storagePath: 'generation_inputs/guest-1/gen-1/legacy-reference.png',
          }],
        },
      };
      const { loadGenerationRecipeRemixInputMediaByPostId } = await import('@/lib/post-resource-bundles-server');

      const media = await loadGenerationRecipeRemixInputMediaByPostId({
        postId: 'post-1',
        generationId: 'gen-1',
        viewerUserId: 'viewer-1',
      });

      expect(media).toEqual([expect.objectContaining({
        storagePath: 'generation_inputs/guest-1/gen-1/legacy-reference.png',
        url: 'https://signed.example.com/guest-1/gen-1/legacy-reference.png',
      })]);
    });

    it.each([
      ['the guest was linked to another account', () => {
        linkedGuestRows = [{ id: 'guest-1', merged_into_user_id: 'someone-else' }];
      }],
      ['who is linked to the account cannot be read', () => {
        linkedGuestReadError = { code: '57014', message: 'profiles read timed out' };
      }],
    ])('withholds them when %s', async (_label, arrange) => {
      arrange();
      const {
        getPostResourceBundleDetailByPostId,
        loadGenerationRecipeRemixInputMediaByPostId,
      } = await import('@/lib/post-resource-bundles-server');

      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'viewer-1' });
      const media = await loadGenerationRecipeRemixInputMediaByPostId({
        postId: 'post-1',
        generationId: 'gen-1',
        viewerUserId: 'viewer-1',
      });

      expect(detail?.viewerCanAccess).toBe(true);
      expect(detail?.resources?.items?.some((item) => item.storagePath === GUEST_INPUT_PATH)).toBe(false);
      expect(media).toEqual([]);
    });
  });

  it('does not duplicate a reference the bundle already stores', async () => {
    bundleRow = {
      ...(bundleRow as BundleRow),
      allow_remix: true,
      resource_items: [
        {
          type: 'reference_image',
          title: 'Reference image',
          storagePath: 'generation_inputs/owner-1/gen-1/00-reference-image.png',
          contentType: 'image/png',
        },
      ],
    };
    viewerHasPurchased = true;
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: 'viewer-1',
    });

    const matches = (detail?.resources?.items ?? []).filter(
      (item) => item.storagePath === 'generation_inputs/owner-1/gen-1/00-reference-image.png',
    );
    expect(matches).toHaveLength(1);
  });

  it('does not infer a public recipe when no saved bundle exists', async () => {
    bundleRow = null;
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: null,
    });

    expect(detail).toBeNull();
  });

  it('keeps legacy workflow references private when no recipe was saved', async () => {
    bundleRow = null;
    generationInputRows = [];
    generationRow = {
      ...(generationRow as NonNullable<typeof generationRow>),
      workflow_settings: {
        model: 'nano-banana-2',
        elements: [{
          id: 'element-1',
          displayName: 'Image input',
          handle: '@alisa',
          storagePath: 'generation_inputs/owner-1/gen-1/legacy-reference.png',
        }],
      },
    };
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: null,
    });

    expect(detail).toBeNull();
  });

  it('requires a deliberately claimed profile before any public post publish', async () => {
    const { getMarketplaceQualityErrorForPostBundle } = await import('@/lib/post-resource-bundles-server');
    const profileClient = {
      from() {
        const query = {
          select() { return query; },
          eq() { return query; },
          async maybeSingle() {
            return {
              data: {
                username: 'creator-a1b2c3d4',
                display_name: 'New Creator',
                avatar_url: null,
              },
              error: null,
            };
          },
        };
        return query;
      },
    };

    await expect(getMarketplaceQualityErrorForPostBundle({
      supabase: profileClient as never,
      ownerUserId: 'owner-1',
      post: { visibility: 'public', body: 'A useful public post.' },
      bundle: null,
    })).resolves.toMatch(/custom handle/i);
  });

  it('never requires an avatar to publish, even with an unlock attached', async () => {
    const { getMarketplaceQualityErrorForPostBundle } = await import('@/lib/post-resource-bundles-server');
    const profileClient = {
      from() {
        const query = {
          select() { return query; },
          eq() { return query; },
          async maybeSingle() {
            return {
              data: {
                username: 'launch-maker',
                display_name: 'Launch Maker',
                avatar_url: null,
              },
              error: null,
            };
          },
        };
        return query;
      },
    };

    await expect(getMarketplaceQualityErrorForPostBundle({
      supabase: profileClient as never,
      ownerUserId: 'owner-1',
      post: { visibility: 'public', body: 'A useful public post.' },
      bundle: null,
    })).resolves.toBeNull();

    // An empty bundle still fails the recipe quality bar, but the complaint is
    // about the recipe content — never the missing profile photo.
    const emptyBundleError = await getMarketplaceQualityErrorForPostBundle({
      supabase: profileClient as never,
      ownerUserId: 'owner-1',
      post: { visibility: 'public', body: 'A useful public post.' },
      bundle: { accessMode: 'free' },
    });
    expect(emptyBundleError).toMatch(/preview or summary/i);
    expect(emptyBundleError).not.toMatch(/profile photo/i);

    // A complete free recipe from an avatar-less profile publishes cleanly.
    await expect(getMarketplaceQualityErrorForPostBundle({
      supabase: profileClient as never,
      ownerUserId: 'owner-1',
      post: {
        title: 'Moody portrait recipe',
        visibility: 'public',
        body: 'A useful public post with plenty of helpful detail.',
      },
      bundle: {
        accessMode: 'free',
        previewText: 'Includes the full prompt and my lighting notes.',
        resources: { promptText: 'Create a moody editorial portrait with soft window light.' },
      },
    })).resolves.toBeNull();
  });

  it('distinguishes profile lookup failures from incomplete profiles', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { getMarketplaceQualityErrorForPostBundle } = await import('@/lib/post-resource-bundles-server');
    const profileClient = {
      from() {
        const query = {
          select() { return query; },
          eq() { return query; },
          async maybeSingle() {
            return { data: null, error: new Error('database unavailable') };
          },
        };
        return query;
      },
    };

    await expect(getMarketplaceQualityErrorForPostBundle({
      supabase: profileClient as never,
      ownerUserId: 'owner-1',
      post: { visibility: 'public', body: 'A useful public post.' },
      bundle: null,
    })).resolves.toBe('Could not verify your creator profile right now. Try again.');
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  describe('what a buyer keeps', () => {
    const editedRevision = {
      revision_number: 2,
      is_latest: false,
      content_fingerprint: 'fingerprint-of-what-they-bought',
      title: 'Launch hook recipe',
      summary: 'Original buyer-facing summary',
      preview_text: 'The version you unlocked.',
      access_mode: 'paid',
      price_usd_cents: 500,
      prompt_text: 'THE PROMPT THEY PAID FOR',
      notes_markdown: 'Notes they paid for',
      workflow_share_url: null,
      workflow_snapshot: null,
      attachments: [],
      allow_remix: false,
      resource_sections: [],
      resource_items: [
        { id: 'item-1', type: 'prompt', title: 'Prompt', textContent: 'THE PROMPT THEY PAID FOR', sortOrder: 0 },
      ],
      created_at: '2026-07-01T00:00:00.000Z',
    };

    it('offers the purchased revision once the creator edits a sold bundle', async () => {
      viewerHasPurchased = true;
      purchasedRevisionRow = editedRevision;
      bundleRow = { ...(bundleRow as BundleRow), prompt_text: 'Rewritten to something useless' };

      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'buyer-1' });

      expect(detail?.viewerCanAccess).toBe(true);
      // Current content is still served -- honest edits reach buyers for free.
      expect(detail?.resources?.promptText).toBe('Rewritten to something useless');
      // ...but what they actually paid for stays retrievable.
      expect(detail?.purchasedRevision?.revisionNumber).toBe(2);
      expect(detail?.purchasedRevision).toMatchObject({
        title: 'Launch hook recipe',
        summary: 'Original buyer-facing summary',
        previewText: 'The version you unlocked.',
        accessMode: 'paid',
        priceUsdCents: 500,
      });
      expect(detail?.purchasedRevision?.resources.promptText).toBe('THE PROMPT THEY PAID FOR');
      expect(detail?.purchasedRevision?.mediaItems).toEqual([
        expect.objectContaining({
          mediaKey: 'purchased-output-1',
          url: 'https://public.example.com/owner-1/posts/original.png',
          previewUrl: 'https://public.example.com/owner-1/posts/original-preview.png',
        }),
      ]);
    });

    it('omits the purchased revision while the bundle is unchanged', async () => {
      viewerHasPurchased = true;
      purchasedRevisionRow = { ...editedRevision, is_latest: true };

      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'buyer-1' });

      expect(detail?.purchasedRevision).toBeNull();
    });

    it('never hands a purchased revision to someone who has not bought it', async () => {
      viewerHasPurchased = false;
      purchasedRevisionRow = editedRevision;

      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'stranger-1' });

      expect(detail?.viewerCanAccess).toBe(false);
      expect(detail?.resources).toBeNull();
      expect(detail?.purchasedRevision).toBeNull();
    });

    it('keeps a buyer reading after the creator deletes the post', async () => {
      // Tombstoned: private and archived, so every public surface drops it.
      postRow = {
        ...(postRow as Record<string, unknown>),
        visibility: 'private',
        archived_at: '2026-07-02T00:00:00.000Z',
        tombstoned_at: '2026-07-02T00:00:00.000Z',
      };
      viewerHasPurchased = true;

      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'buyer-1' });

      expect(detail).not.toBeNull();
      expect(detail?.viewerCanAccess).toBe(true);
      expect(detail?.tombstoned).toBe(true);
      expect(detail?.resources?.promptText).toBe('Public prompt text');
    });

    it('opens a retired bundle for its buyer after the creator removes the unlock', async () => {
      // Caught in live verification: the publish gate ran before the purchase
      // lookup, so a retired bundle (status 'draft') 404'd for the very buyers
      // whose entitlement it was supposed to preserve. The library listed the
      // unlock and opening it failed.
      bundleRow = { ...(bundleRow as BundleRow), status: 'draft' as BundleRow['status'] };
      postRow = {
        ...(postRow as Record<string, unknown>),
        visibility: 'private',
        archived_at: '2026-07-02T00:00:00.000Z',
        tombstoned_at: '2026-07-02T00:00:00.000Z',
      };
      viewerHasPurchased = true;

      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'buyer-1' });

      expect(detail).not.toBeNull();
      expect(detail?.viewerCanAccess).toBe(true);
      expect(detail?.tombstoned).toBe(true);
    });

    it('still hides a retired bundle from someone who never bought it', async () => {
      bundleRow = { ...(bundleRow as BundleRow), status: 'draft' as BundleRow['status'] };
      viewerHasPurchased = false;

      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'stranger-1' });

      expect(detail).toBeNull();
    });

    it('keeps reference media for a buyer once the post is tombstoned', async () => {
      // Deleting a post flips its generation to is_public=false, so a gate that
      // reads only that flag silently strips the references a buyer paid for at
      // the exact moment the tombstone promises to retain them.
      bundleRow = { ...(bundleRow as BundleRow), access_mode: 'paid', price_usd_cents: 900, allow_remix: true };
      generationRow = { ...(generationRow as NonNullable<typeof generationRow>), is_public: false };
      postRow = {
        ...(postRow as Record<string, unknown>),
        visibility: 'private',
        archived_at: '2026-07-02T00:00:00.000Z',
        tombstoned_at: '2026-07-02T00:00:00.000Z',
      };
      viewerHasPurchased = true;

      const {
        getPostResourceBundleDetailByPostId,
        loadGenerationRecipeRemixInputMediaByPostId,
      } = await import('@/lib/post-resource-bundles-server');
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'buyer-1' });
      const remixed = await loadGenerationRecipeRemixInputMediaByPostId({
        postId: 'post-1',
        generationId: 'gen-1',
        viewerUserId: 'buyer-1',
      });

      expect(detail?.viewerCanAccess).toBe(true);
      expect(detail?.resources?.items?.some(
        (item) => item.storagePath === 'generation_inputs/owner-1/gen-1/00-reference-image.png',
      )).toBe(true);
      // Entitlement to read is not entitlement to reuse: a remix of a deleted
      // post restores none of them.
      expect(remixed).toEqual([]);
    });

    it('hides a tombstoned post from everyone who did not buy it', async () => {
      postRow = {
        ...(postRow as Record<string, unknown>),
        visibility: 'private',
        archived_at: '2026-07-02T00:00:00.000Z',
        tombstoned_at: '2026-07-02T00:00:00.000Z',
      };
      viewerHasPurchased = false;

      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'stranger-1' });

      expect(detail).toBeNull();
    });

    it('opens an NSFW post\'s bundle to its buyer without a reveal when the buyer library asks', async () => {
      viewerHasPurchased = true;

      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const detail = await getPostResourceBundleDetailByPostId('post-1', {
        viewerUserId: 'buyer-1',
        isNsfw: true,
        entitledPurchase: true,
      });

      expect(detail?.viewerCanAccess).toBe(true);
      expect(detail?.resources?.promptText).toBe('Public prompt text');
      expect(detail?.post?.id).toBe('post-1');
    });

    it('keeps the reveal gate for that buyer everywhere else', async () => {
      viewerHasPurchased = true;

      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      await expect(getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'buyer-1', isNsfw: true }))
        .resolves.toBeNull();
    });

    it('never opens an NSFW bundle on the buyer-library flag alone', async () => {
      viewerHasPurchased = false;

      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

      await expect(getPostResourceBundleDetailByPostId('post-1', {
        viewerUserId: 'stranger-1',
        isNsfw: true,
        entitledPurchase: true,
      })).resolves.toBeNull();
    });

    it('retracts a buyer\'s access when moderation hides the post', async () => {
      // The one case where entitlement does not survive: violating content must
      // stop being served to everyone, buyers included.
      postRow = { ...(postRow as Record<string, unknown>), review_status: 'hidden' };
      viewerHasPurchased = true;

      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'buyer-1' });

      expect(detail).toBeNull();
    });
  });

  describe('the seller dashboard', () => {
    const paidOrder = (id: string, buyerUserId: string) => ({
      id,
      bundle_id: 'bundle-1',
      buyer_user_id: buyerUserId,
      razorpay_order_id: `order_${id}`,
      status: 'paid',
      amount_subunits: 900,
      currency: 'USD',
      created_at: '2026-07-03T00:00:00.000Z',
    });

    // 03-10: the dashboard is serialised into the seller's page, and a buyer
    // with no handle used to be labelled with their raw account id.
    it('labels each buyer by handle or name and never sends a buyer id', async () => {
      const anonymousBuyerId = '6f1c2a4e-1111-4222-8333-444455556666';
      orderRows = [
        paidOrder('order-1', 'buyer-with-handle'),
        paidOrder('order-2', 'buyer-with-name'),
        paidOrder('order-3', anonymousBuyerId),
      ];
      buyerProfileRows = [
        { id: 'buyer-with-handle', username: 'maya', display_name: 'Maya R', avatar_url: null },
        { id: 'buyer-with-name', username: null, display_name: 'Sam Buyer', avatar_url: null },
        { id: anonymousBuyerId, username: null, display_name: '   ', avatar_url: null },
      ];

      const { getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');
      const dashboard = await getSellerPostResourceBundleDashboard('owner-1');

      expect(dashboard.recentUnlocks.map((unlock) => [unlock.buyerLabel, unlock.named])).toEqual([
        ['@maya', true],
        ['Sam Buyer', true],
        ['Someone', false],
      ]);
      for (const unlock of dashboard.recentUnlocks) expect(unlock).not.toHaveProperty('buyerUserId');
      const serialized = JSON.stringify(dashboard);
      for (const buyerId of ['buyer-with-handle', 'buyer-with-name', anonymousBuyerId]) {
        expect(serialized).not.toContain(buyerId);
      }
    });

    it('totals paid sales and free unlocks apart, per listing and overall', async () => {
      bundleRow = { ...(bundleRow as BundleRow), sales_count: 3, free_unlock_count: 7, earnings_usd_cents: 1530 };

      const { getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');
      const dashboard = await getSellerPostResourceBundleDashboard('owner-1');

      expect(dashboard.bundles.map((bundle) => [bundle.salesCount, bundle.freeUnlockCount])).toEqual([[3, 7]]);
      expect(dashboard.totalSalesCount).toBe(3);
      expect(dashboard.totalFreeUnlockCount).toBe(7);
      // Free unlocks earn nothing: the earnings total is the paid one, unchanged.
      expect(dashboard.totalEarningsUsdCents).toBe(1530);
    });

    // Decision 6 (2026-10-17): a free unlock is not a sale. Its order is a
    // "paid" row of 0 subunits: Recent unlocks lists it as opened, not bought.
    it('lists free unlocks beside paid sales under Recent unlocks, saying which were paid', async () => {
      orderRows = [
        paidOrder('order-paid', 'buyer-with-handle'),
        { ...paidOrder('order-free', 'buyer-with-name'), amount_subunits: 0 },
      ];
      buyerProfileRows = [
        { id: 'buyer-with-handle', username: 'maya', display_name: 'Maya R', avatar_url: null },
        { id: 'buyer-with-name', username: null, display_name: 'Sam Buyer', avatar_url: null },
      ];

      const { getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');
      const dashboard = await getSellerPostResourceBundleDashboard('owner-1');

      expect(dashboard.recentUnlocks.map((unlock) => [unlock.id, unlock.paid, unlock.buyerLabel])).toEqual([
        ['order-paid', true, '@maya'],
        ['order-free', false, 'Sam Buyer'],
      ]);
    });

    // Review 3: the newest six orders of any kind let a run of free opens push
    // a sale off the page, where the earlier Recent sales listed every sale.
    it('keeps the newest sales in Recent unlocks however many free opens follow them', async () => {
      orderRows = [
        { ...paidOrder('order-sale', 'buyer-with-handle'), created_at: '2026-07-01T00:00:00.000Z' },
        ...Array.from({ length: 7 }, (_, index) => ({
          ...paidOrder(`order-free-${index}`, 'buyer-with-name'),
          amount_subunits: 0,
          created_at: `2026-07-02T00:0${index}:00.000Z`,
        })),
      ];
      buyerProfileRows = [{ id: 'buyer-with-handle', username: 'maya', display_name: 'Maya R', avatar_url: null }];

      const { getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');
      const dashboard = await getSellerPostResourceBundleDashboard('owner-1');

      // Newest first: the five newest free opens, then the sale.
      expect(dashboard.recentUnlocks.map((unlock) => unlock.id)).toEqual([
        'order-free-6',
        'order-free-5',
        'order-free-4',
        'order-free-3',
        'order-free-2',
        'order-sale',
      ]);
    });

    // Second review: sales first in line kept every free open off the list
    // once there were six sales, and the Unlocks tile's "Latest" with them.
    it('keeps the newest free opens in Recent unlocks however many sales came before them', async () => {
      orderRows = [
        ...Array.from({ length: 6 }, (_, index) => ({
          ...paidOrder(`order-sale-${index}`, 'buyer-with-handle'),
          created_at: `2026-09-0${index + 1}T00:00:00.000Z`,
        })),
        { ...paidOrder('order-free-1', 'buyer-with-name'), amount_subunits: 0, created_at: '2026-10-30T00:00:00.000Z' },
        { ...paidOrder('order-free-2', 'buyer-with-name'), amount_subunits: 0, created_at: '2026-10-31T00:00:00.000Z' },
      ];

      const { getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');
      const dashboard = await getSellerPostResourceBundleDashboard('owner-1');

      // Newest first, the newest of all at the top.
      expect(dashboard.recentUnlocks.map((unlock) => unlock.id)).toEqual([
        'order-free-2',
        'order-free-1',
        'order-sale-5',
        'order-sale-4',
        'order-sale-3',
        'order-sale-2',
      ]);
    });

    // Second review: the fake ignored these filters, so nothing proved the
    // page reads only its own recipes' settled orders.
    it('lists only settled orders of the seller’s own recipes', async () => {
      orderRows = [
        paidOrder('order-own', 'buyer-with-handle'),
        { ...paidOrder('order-other-seller', 'buyer-with-handle'), bundle_id: 'bundle-of-someone-else' },
        { ...paidOrder('order-unpaid', 'buyer-with-handle'), status: 'created' },
        { ...paidOrder('order-failed', 'buyer-with-handle'), status: 'failed' },
      ];

      const { getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');
      const dashboard = await getSellerPostResourceBundleDashboard('owner-1');

      expect(dashboard.recentUnlocks.map((unlock) => unlock.id)).toEqual(['order-own']);
    });

    // Second review: an unlock with credits read as a dollar amount.
    it('says which sales were paid with credits', async () => {
      orderRows = [
        { ...paidOrder('order-credits', 'buyer-with-handle'), razorpay_order_id: 'credits_bundle_bundle-1_buyer-with-handle' },
        paidOrder('order-card', 'buyer-with-name'),
        { ...paidOrder('order-free', 'buyer-with-name'), amount_subunits: 0, razorpay_order_id: 'credits_bundle_bundle-1_buyer-with-name' },
      ];

      const { getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');
      const dashboard = await getSellerPostResourceBundleDashboard('owner-1');

      expect(dashboard.recentUnlocks.map((unlock) => [unlock.id, unlock.paidInCredits])).toEqual([
        ['order-credits', true],
        ['order-card', false],
        ['order-free', false],
      ]);
    });

    // Review 8: a sale alert stops naming its buyer across a block, either way
    // round (20261020053858); Recent unlocks kept naming free openers.
    it('names no free opener across a block, either way round, and keeps a paid buyer’s handle', async () => {
      const freeOrder = (id: string, buyerUserId: string) => ({ ...paidOrder(id, buyerUserId), amount_subunits: 0 });
      orderRows = [
        paidOrder('order-paid-blocked', 'buyer-blocked'),
        freeOrder('order-free-blocked', 'buyer-blocked'),
        freeOrder('order-free-blocker', 'buyer-blocker'),
        freeOrder('order-free-open', 'buyer-open'),
      ];
      buyerProfileRows = [
        { id: 'buyer-blocked', username: 'blocked', display_name: null, avatar_url: null },
        { id: 'buyer-blocker', username: 'blocker', display_name: null, avatar_url: null },
        { id: 'buyer-open', username: 'open', display_name: null, avatar_url: null },
      ];
      blockRows = [
        { blocker_user_id: 'owner-1', blocked_user_id: 'buyer-blocked' },
        { blocker_user_id: 'buyer-blocker', blocked_user_id: 'owner-1' },
        // Between two other people: no bearing on this seller's page.
        { blocker_user_id: 'buyer-open', blocked_user_id: 'someone-else' },
      ];

      const { getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');
      const dashboard = await getSellerPostResourceBundleDashboard('owner-1');

      expect(dashboard.recentUnlocks.map((unlock) => [unlock.id, unlock.buyerLabel, unlock.named])).toEqual([
        ['order-paid-blocked', '@blocked', true],
        ['order-free-blocked', 'Someone', false],
        ['order-free-blocker', 'Someone', false],
        ['order-free-open', '@open', true],
      ]);
      expect(JSON.stringify(dashboard)).not.toContain('@blocker');
    });

    it('names no free opener when the blocks cannot be read', async () => {
      orderRows = [
        paidOrder('order-paid', 'buyer-with-handle'),
        { ...paidOrder('order-free', 'buyer-with-name'), amount_subunits: 0 },
      ];
      buyerProfileRows = [
        { id: 'buyer-with-handle', username: 'maya', display_name: 'Maya R', avatar_url: null },
        { id: 'buyer-with-name', username: null, display_name: 'Sam Buyer', avatar_url: null },
      ];
      blockReadError = new Error('blocks unavailable');
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const { getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');
      const dashboard = await getSellerPostResourceBundleDashboard('owner-1');

      expect(dashboard.recentUnlocks.map((unlock) => unlock.buyerLabel)).toEqual(['@maya', 'Someone']);
      consoleError.mockRestore();
    });

    it('calls every buyer "Someone" when the buyer profiles cannot be read', async () => {
      const anonymousBuyerId = '6f1c2a4e-1111-4222-8333-444455556666';
      orderRows = [paidOrder('order-1', anonymousBuyerId)];
      profileReadError = new Error('profiles unavailable');
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const { getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');
      const dashboard = await getSellerPostResourceBundleDashboard('owner-1');

      expect(dashboard.recentUnlocks.map((unlock) => unlock.buyerLabel)).toEqual(['Someone']);
      expect(JSON.stringify(dashboard)).not.toContain(anonymousBuyerId);
      consoleError.mockRestore();
    });

    // 03-4: deleting a post with buyers tombstones it and its bundle stays,
    // so the same post was listed once as a bundle and again as deleted.
    it('lists a post deleted with buyers once, as its tombstoned bundle', async () => {
      postRow = {
        ...(postRow as Record<string, unknown>),
        visibility: 'private',
        archived_at: '2026-07-02T00:00:00.000Z',
        tombstoned_at: '2026-07-02T00:00:00.000Z',
      };
      const deletionAudit = (id: string, postId: string | null) => ({
        id,
        post_id: postId,
        title: 'Deleted post',
        visibility: 'public',
        source_kind: 'magicbooklet',
        bundle_access_mode: 'paid',
        bundle_status: 'published',
        bundle_price_usd_cents: 900,
        bundle_resource_kinds: ['prompt'],
        sales_count: 2,
        earnings_usd_cents: 1530,
        had_paid_orders: true,
        deleted_at: '2026-07-02T00:00:00.000Z',
      });
      deletionAuditRows = [
        deletionAudit('audit-tombstoned', 'post-1'),
        deletionAudit('audit-removed', 'post-removed'),
        deletionAudit('audit-legacy', null),
      ];

      const { getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');
      const dashboard = await getSellerPostResourceBundleDashboard('owner-1');

      expect(dashboard.bundles.map((bundle) => [bundle.postId, bundle.post?.tombstoned])).toEqual([['post-1', true]]);
      expect(dashboard.deletedSnapshots.map((snapshot) => snapshot.id)).toEqual(['audit-removed', 'audit-legacy']);
    });

    // Review 7: every deleted post leaves an audit, and all of them were listed
    // as "Deleted posts that had recipes".
    it('leaves out a deleted post that never had a recipe', async () => {
      const deletionAudit = (id: string, bundleAccessMode: 'free' | 'paid' | null) => ({
        id,
        post_id: `post-${id}`,
        title: 'Deleted post',
        visibility: 'public',
        source_kind: 'magicbooklet',
        bundle_access_mode: bundleAccessMode,
        bundle_status: bundleAccessMode ? 'published' : null,
        bundle_price_usd_cents: bundleAccessMode === 'paid' ? 900 : null,
        bundle_resource_kinds: bundleAccessMode ? ['prompt'] : [],
        sales_count: 0,
        earnings_usd_cents: 0,
        had_paid_orders: false,
        deleted_at: '2026-07-02T00:00:00.000Z',
      });
      deletionAuditRows = [
        deletionAudit('plain', null),
        deletionAudit('free-recipe', 'free'),
        deletionAudit('paid-recipe', 'paid'),
      ];

      const { getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');
      const dashboard = await getSellerPostResourceBundleDashboard('owner-1');

      expect(dashboard.deletedSnapshots.map((snapshot) => snapshot.id)).toEqual(['free-recipe', 'paid-recipe']);
    });

    // Second review: every recipe read as one whose post is gone, which
    // nobody can buy, when the read of their posts failed.
    it('fails the page when the posts of its recipes cannot be read', async () => {
      linkedPostReadError = new Error('posts unavailable');
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const { getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');
      await expect(getSellerPostResourceBundleDashboard('owner-1')).rejects.toBeTruthy();
      consoleError.mockRestore();
    });

    // Second review: the editor adds a recipe again to a post whose recipe was
    // removed after it was unlocked, but the page never offered that post.
    it('offers a post whose recipe was removed after it was unlocked', async () => {
      bundleRow = { ...(bundleRow as BundleRow), status: 'draft', retired_at: '2026-07-04T00:00:00.000Z' } as BundleRow;

      const { getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');
      const dashboard = await getSellerPostResourceBundleDashboard('owner-1');

      expect(dashboard.recipeCandidates?.map((candidate) => candidate.postId)).toEqual(['post-1']);
    });

    // Review 6: a recipe removed after it sold is a draft with retired_at set,
    // and the page read it as a draft to publish.
    it('says when a recipe was removed after it was unlocked', async () => {
      bundleRow = { ...(bundleRow as BundleRow), status: 'draft', retired_at: '2026-07-04T00:00:00.000Z' } as BundleRow;

      const { getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');
      const dashboard = await getSellerPostResourceBundleDashboard('owner-1');

      expect(dashboard.bundles.map((bundle) => [bundle.status, bundle.retiredAt])).toEqual([
        ['draft', '2026-07-04T00:00:00.000Z'],
      ]);
    });

    // Ready for a recipe, and the Add a recipe picker: the seller's public
    // posts that have no recipe yet.
    it('offers a public post without a recipe, and never a post that has one', async () => {
      const { getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');
      expect((await getSellerPostResourceBundleDashboard('owner-1')).recipeCandidates).toEqual([]);

      bundleRow = null;
      const dashboard = await getSellerPostResourceBundleDashboard('owner-1');

      expect(dashboard.recipeCandidates).toEqual([expect.objectContaining({
        postId: 'post-1',
        title: 'Public recipe post',
        postFormat: 'media',
        saveCount: expect.any(Number),
      })]);
    });

    it('offers only a public, visible post as one a recipe could go on', async () => {
      bundleRow = null;
      postRow = { ...(postRow as Record<string, unknown>), visibility: 'private' };

      const { getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');
      const dashboard = await getSellerPostResourceBundleDashboard('owner-1');

      expect(dashboard.recipeCandidates).toEqual([]);
    });

    // The suggestions are extra: a read of them that fails is null, which the
    // page says, never a page that cannot load.
    it('loads the dashboard without suggestions when the posts read for them fails', async () => {
      bundleRow = null;
      postListReadError = new Error('posts unavailable');
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const { getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');
      const dashboard = await getSellerPostResourceBundleDashboard('owner-1');

      expect(dashboard.recipeCandidates).toBeNull();
      expect(dashboard.bundles).toEqual([]);
      consoleError.mockRestore();
    });

    // Second review: only the read of post ids gave null; one of the posts
    // themselves that failed came back as no posts at all.
    it('loads the dashboard without suggestions when the posts behind them cannot be read', async () => {
      bundleRow = null;
      linkedPostReadError = new Error('posts unavailable');
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const { getSellerPostResourceBundleDashboard } = await import('@/lib/post-resource-bundles-server');
      const dashboard = await getSellerPostResourceBundleDashboard('owner-1');

      expect(dashboard.recipeCandidates).toBeNull();
      consoleError.mockRestore();
    });
  });

});

// 02-4: a creation made as a guest before registering is published as the
// account, but its references keep the guest's id and sit in the guest's
// folder. "Include generation references" packaged none of them.
describe('generation references packaged for a publish', () => {
  type ReferenceRow = {
    id: string;
    generation_id: string;
    user_id: string;
    media_type: 'image' | 'video';
    role: string;
    label: string | null;
    storage_path: string;
    source_generation_id: null;
    sort_order: number;
    metadata: null;
  };

  const reference = (id: string, userId: string, storagePath: string, sortOrder = 0): ReferenceRow => ({
    id,
    generation_id: 'gen-1',
    user_id: userId,
    media_type: 'image',
    role: 'reference',
    label: `Reference ${id}`,
    storage_path: storagePath,
    source_generation_id: null,
    sort_order: sortOrder,
    metadata: null,
  });

  type StorageOutcome = { error: { message: string; statusCode?: string; status?: number } | null };

  /** A service client holding these rows, with `linkedGuestIds` merged into `user-1`. */
  function referenceClient(rows: ReferenceRow[], linkedGuestIds: string[], options: {
    rowsError?: { message: string } | null;
    /** What the storage service says of each source file; absent, it cannot say. */
    info?: (filePath: string) => { size: number; contentType: string } | null;
    copy?: (to: string) => StorageOutcome;
    upload?: (filePath: string) => StorageOutcome;
  } = {}) {
    const linkedLookups: string[] = [];
    const downloads: string[] = [];
    const uploads: Array<{ path: string; upsert: unknown }> = [];
    const copies: string[] = [];
    const removals: string[][] = [];
    const client = {
      from(table: string) {
        if (table === 'profiles') {
          return {
            select: () => ({
              eq: async (column: string, value: string) => {
                linkedLookups.push(`${column}=${value}`);
                return {
                  data: column === 'merged_into_user_id' && value === 'user-1' ? linkedGuestIds.map((id) => ({ id })) : [],
                  error: null,
                };
              },
            }),
          };
        }
        if (table === 'generation_input_media') {
          let generationId: unknown = null;
          const query = {
            select: () => query,
            eq: (column: string, value: unknown) => {
              if (column === 'generation_id') generationId = value;
              return query;
            },
            order: async () => (options.rowsError
              ? { data: null, error: options.rowsError }
              : { data: rows.filter((row) => row.generation_id === generationId), error: null }),
          };
          return query;
        }
        throw new Error(`Unexpected table access: ${table}`);
      },
      storage: {
        from: (bucket: string) => ({
          info: async (filePath: string) => {
            const info = options.info?.(filePath) ?? null;
            return info ? { data: info, error: null } : { data: null, error: { message: 'not described' } };
          },
          copy: async (filePath: string, to: string, copyOptions?: { destinationBucket?: string }) => {
            copies.push(`${bucket}/${filePath} -> ${copyOptions?.destinationBucket}/${to}`);
            const outcome = options.copy?.(to) ?? { error: null };
            return outcome.error ? { data: null, error: outcome.error } : { data: { path: to }, error: null };
          },
          download: async (filePath: string) => {
            downloads.push(`${bucket}/${filePath}`);
            return { data: new Blob(['image'], { type: 'image/png' }), error: null };
          },
          upload: async (filePath: string, _body: unknown, uploadOptions?: { upsert?: unknown }) => {
            uploads.push({ path: `${bucket}/${filePath}`, upsert: uploadOptions?.upsert });
            return options.upload?.(filePath) ?? { error: null };
          },
          remove: async (paths: string[]) => {
            removals.push(paths.map((path) => `${bucket}/${path}`));
            return { data: paths.map((name) => ({ name })), error: null };
          },
        }),
      },
    };
    return { client: client as never, linkedLookups, downloads, uploads, copies, removals };
  }

  it('reads a linked guest’s references from its folder and plans their copies under the account, moving no bytes', async () => {
    const { planGenerationReferenceCopies } = await import('@/lib/post-resource-bundles-server');
    const source = referenceClient(
      [reference('ref-1', 'guest-1', 'generation_inputs/guest-1/gen-1/hero.png')],
      ['guest-1'],
    );

    const plan = await planGenerationReferenceCopies({
      supabase: source.client,
      ownerUserId: 'user-1',
      generationId: 'gen-1',
    });

    expect(source.linkedLookups).toEqual(['merged_into_user_id=user-1']);
    expect(plan.ok && plan.references).toEqual([{
      item: expect.objectContaining({
        id: 'reference-ref-1',
        type: 'reference_image',
        storagePath: 'user-1/generation-references/gen-1/00-reference-ref-1.png',
        contentType: 'image/png',
      }),
      source: { bucket: 'generation_inputs', filePath: 'guest-1/gen-1/hero.png' },
    }]);
    // A plan is no copy: the bytes move only once every check has passed.
    expect(source.downloads).toEqual([]);
    expect(source.uploads).toEqual([]);
    expect(source.copies).toEqual([]);
  });

  it('plans nothing from a folder outside the account and its linked guests', async () => {
    const { planGenerationReferenceCopies } = await import('@/lib/post-resource-bundles-server');
    const source = referenceClient(
      [
        // A row of the linked guest that names someone else's file.
        reference('ref-1', 'guest-1', 'generation_inputs/stranger-1/gen-1/hero.png'),
        // A row of an identity not linked to the account.
        reference('ref-2', 'stranger-1', 'generation_inputs/stranger-1/gen-1/other.png', 1),
      ],
      ['guest-1'],
    );

    const plan = await planGenerationReferenceCopies({
      supabase: source.client,
      ownerUserId: 'user-1',
      generationId: 'gen-1',
    });

    expect(plan).toEqual({ ok: true, references: [] });
  });

  // A recipe that leaves the creator's own uploads out (the web creators' default, owner
  // 2026-10-29) copies only the references a remix brought from its original.
  it('plans only the rows it is given', async () => {
    const { planGenerationReferenceCopies } = await import('@/lib/post-resource-bundles-server');
    const source = referenceClient(
      [
        reference('ref-own', 'user-1', 'generation_inputs/user-1/gen-1/face.png'),
        reference('ref-original', 'user-1', 'generation_inputs/user-1/gen-1/dojo.png', 1),
      ],
      [],
    );

    const plan = await planGenerationReferenceCopies({
      supabase: source.client,
      ownerUserId: 'user-1',
      generationId: 'gen-1',
      onlyRowIds: new Set(['ref-original']),
    });

    expect(plan.ok && plan.references.map((planned) => planned.item.id)).toEqual(['reference-ref-original']);
  });

  // Owner, 2026-11-03: what the publisher bought is theirs to use, never to sell or give on. The
  // web's recipe sends the rows a remix brought from its original, and a recipe file reads as one.
  it('plans none of the rows that were someone else’s recipe files, given them or not', async () => {
    const { planGenerationReferenceCopies } = await import('@/lib/post-resource-bundles-server');
    const bought = (id: string, metadata: Record<string, unknown>, sortOrder: number) => ({
      ...reference(id, 'user-1', `generation_inputs/user-1/gen-1/0${sortOrder}.png`, sortOrder),
      metadata,
    }) as unknown as ReferenceRow;
    const rows = [
      reference('ref-own', 'user-1', 'generation_inputs/user-1/gen-1/00.png'),
      bought('ref-bought', { sourceKind: 'recipe-file', sourceStoragePath: 'post_resource_files/seller-9/generation-references/gen-0/00-reference-image-row.png' }, 1),
      bought('ref-seller-file', { sourceStoragePath: 'post_resource_files/seller-9/generation-references/gen-0/01-reference-image-row.png' }, 2),
      bought('ref-imported', { sourceUrl: 'https://project.supabase.co/storage/v1/object/sign/generation_inputs/user-1/recipe-imports/gen-0/02.png?token=x' }, 3),
      // The publisher's own recipe file is their own upload, and copies as one.
      bought('ref-own-recipe-file', { sourceStoragePath: 'post_resource_files/user-1/resources/guide.png' }, 4),
    ];

    // A run that remixed no recipe: none of them came through one (phase 1b's rule, below).
    const dependencies = { loadRecipePassOnFolder: async () => null };
    const all = await planGenerationReferenceCopies({ supabase: referenceClient(rows, []).client, ownerUserId: 'user-1', generationId: 'gen-1', dependencies });
    const given = await planGenerationReferenceCopies({
      supabase: referenceClient(rows, []).client,
      ownerUserId: 'user-1',
      generationId: 'gen-1',
      onlyRowIds: new Set(['ref-bought', 'ref-seller-file', 'ref-imported']),
      dependencies,
    });

    expect(all.ok && all.references.map((planned) => [planned.item.id, planned.source?.filePath])).toEqual([
      ['reference-ref-own', 'user-1/gen-1/00.png'],
      ['reference-ref-own-recipe-file', 'user-1/gen-1/04.png'],
    ]);
    expect(given).toEqual({ ok: true, references: [] });
  });

  // Remix plan, phase 1b (owner, 2026-11-05: a remix's recipe holds what its run used): the files of
  // the recipe the run remixed go on into the remixer's recipe, matched by that recipe's copies' folder,
  // while the remixer may still read them; a file of any other recipe never does.
  describe('the files of the recipe the run remixed', () => {
    const SELLER = '11111111-1111-4111-8111-111111111111';
    const ORIGINAL = '22222222-2222-4222-8222-222222222222';
    const FOLDER = `post_resource_files/${SELLER}/generation-references/${ORIGINAL}/`;
    const fromRemixed = `${FOLDER}00-reference-image-row-a.png`;
    const fromOtherRecipe = `post_resource_files/${SELLER}/generation-references/33333333-3333-4333-8333-333333333333/00-reference-image-row-b.png`;
    const recipeFile = (id: string, file: string, sortOrder: number) => ({
      ...reference(id, 'user-1', `generation_inputs/user-1/gen-1/0${sortOrder}.png`, sortOrder),
      metadata: { sourceKind: 'recipe-file', recipeFile: file },
    }) as unknown as ReferenceRow;
    const rows = () => [
      reference('ref-own', 'user-1', 'generation_inputs/user-1/gen-1/00.png'),
      recipeFile('ref-remixed', fromRemixed, 1),
      recipeFile('ref-other-recipe', fromOtherRecipe, 2),
    ];

    async function plan(options: {
      folder?: string | null | Error;
      readable?: string[] | Error;
      onlyRowIds?: Set<string>;
    } = {}) {
      const { planGenerationReferenceCopies } = await import('@/lib/post-resource-bundles-server');
      const asked: string[][] = [];
      const loadReadableRecipeFiles = vi.fn(async (_client: unknown, _holder: string, files: Iterable<string>) => {
        asked.push([...files]);
        if (options.readable instanceof Error) throw options.readable;
        const readable = options.readable ?? [fromRemixed, fromOtherRecipe];
        return new Set(asked.at(-1)!.filter((file) => readable.includes(file)));
      });
      const result = await planGenerationReferenceCopies({
        supabase: referenceClient(rows(), []).client,
        ownerUserId: 'user-1',
        generationId: 'gen-1',
        ...(options.onlyRowIds ? { onlyRowIds: options.onlyRowIds } : {}),
        dependencies: {
          loadRecipePassOnFolder: vi.fn(async () => {
            if (options.folder instanceof Error) throw options.folder;
            return options.folder === undefined ? FOLDER : options.folder;
          }),
          loadReadableRecipeFiles: loadReadableRecipeFiles as never,
        },
      });
      return { result, loadReadableRecipeFiles, asked };
    }

    it('plans the file that came through the remixed recipe, with where it came from, and no other recipe’s', async () => {
      const { result, loadReadableRecipeFiles, asked } = await plan();

      expect(result.ok && result.references.map((planned) => [planned.item.id, planned.passOn ?? null])).toEqual([
        ['reference-ref-own', null],
        ['reference-ref-remixed', { sourceFile: fromRemixed, holderUserId: 'user-1' }],
      ]);
      // Under the remixer's own creation, as any input's copy.
      expect(result.ok && result.references[1]?.item.storagePath).toBe('user-1/generation-references/gen-1/01-reference-ref-remixed.png');
      // Asked once for the holder, of the file in the folder alone.
      expect(loadReadableRecipeFiles).toHaveBeenCalledTimes(1);
      expect(asked).toEqual([[fromRemixed]]);
    });

    it('passes on what the web’s recipe sends among the rows that are not the creator’s own', async () => {
      const { result } = await plan({ onlyRowIds: new Set(['ref-remixed', 'ref-other-recipe']) });

      expect(result.ok && result.references.map((planned) => planned.item.id)).toEqual(['reference-ref-remixed']);
    });

    it('passes nothing on once the remixer may no longer read it, or for a run that remixed no recipe', async () => {
      // A refund, a retracted purchase, or the original creation removed or archived.
      const closed = await plan({ readable: [] });
      const noRecipe = await plan({ folder: null });

      for (const { result } of [closed, noRecipe]) {
        expect(result.ok && result.references.map((planned) => planned.item.id)).toEqual(['reference-ref-own']);
      }
      expect(noRecipe.loadReadableRecipeFiles).not.toHaveBeenCalled();
    });

    // Phase 1b's review: a save that silently left out files the composer counted could not be told
    // from one that meant to; refused, it is retried as when the inputs cannot be read.
    it('plans nothing when either read fails, so the save is retried', async () => {
      for (const failing of [{ folder: new Error('statement timeout') }, { readable: new Error('statement timeout') }]) {
        const { result } = await plan(failing);
        expect(result).toEqual({ ok: false });
      }
    });

    it('records where a passed-on copy came from before it is made, and makes none it cannot record', async () => {
      const { copyPlannedGenerationReferences } = await import('@/lib/post-resource-bundles-server');
      const events: string[] = [];
      const client = (recordError: { message: string } | null) => ({
        from: (table: string) => {
          if (table !== 'recipe_copy_sources') throw new Error(`Unexpected table access: ${table}`);
          return {
            upsert: async (row: Record<string, unknown>, upsertOptions: Record<string, unknown>) => {
              events.push(`record ${row.copy_path} <- ${row.source_file} (${row.holder_user_id}) ${JSON.stringify(upsertOptions)}`);
              return { error: recordError };
            },
          };
        },
        storage: {
          from: () => ({
            info: async () => ({ data: { size: 5, contentType: 'image/png' }, error: null }),
            copy: async (_from: string, to: string) => {
              events.push(`copy ${to}`);
              return { data: { path: to }, error: null };
            },
          }),
        },
      }) as never;
      const references = [{
        item: { id: 'reference-ref-remixed', storagePath: 'user-1/generation-references/gen-1/01-reference-ref-remixed.png', contentType: 'image/png' },
        source: { bucket: 'generation_inputs', filePath: 'user-1/gen-1/01.png' },
        passOn: { sourceFile: fromRemixed, holderUserId: 'user-1' },
      }] as never;

      const copied = await copyPlannedGenerationReferences({ supabase: client(null), references });
      expect(events).toEqual([
        `record post_resource_files/user-1/generation-references/gen-1/01-reference-ref-remixed.png <- ${fromRemixed} (user-1) {"onConflict":"copy_path","ignoreDuplicates":true}`,
        'copy user-1/generation-references/gen-1/01-reference-ref-remixed.png',
      ]);
      expect([...copied.failedItemIds]).toEqual([]);

      events.length = 0;
      const refused = await copyPlannedGenerationReferences({ supabase: client({ message: 'permission denied' }), references });
      expect(events.filter((event) => event.startsWith('copy'))).toEqual([]);
      expect([...refused.failedItemIds]).toEqual(['reference-ref-remixed']);
    });
  });

  // The review of #677's merge with #678: the plan judged a recipe file by the publisher alone and
  // the owner's library read by the account and its linked guests, so a guest's own recipe file
  // was offered and never copied.
  it('reads a linked guest’s own recipe file as the account’s, as the library offers it', async () => {
    const { planGenerationReferenceCopies } = await import('@/lib/post-resource-bundles-server');
    const source = referenceClient(
      [{
        ...reference('ref-guest-file', 'user-1', 'generation_inputs/user-1/gen-1/00.png'),
        metadata: { sourceStoragePath: 'post_resource_files/guest-1/resources/guide.png' },
      } as unknown as ReferenceRow],
      ['guest-1'],
    );

    const plan = await planGenerationReferenceCopies({
      supabase: source.client,
      ownerUserId: 'user-1',
      generationId: 'gen-1',
      dependencies: { loadRecipePassOnFolder: async () => null },
    });

    expect(source.linkedLookups).toContain('merged_into_user_id=user-1');
    expect(plan.ok && plan.references.map((planned) => planned.item.id)).toEqual(['reference-ref-guest-file']);
  });

  it('plans the account’s own references without asking who is linked to it', async () => {
    const { planGenerationReferenceCopies } = await import('@/lib/post-resource-bundles-server');
    const source = referenceClient(
      [reference('ref-1', 'user-1', 'generation_inputs/user-1/gen-1/hero.png')],
      ['guest-1'],
    );

    const plan = await planGenerationReferenceCopies({
      supabase: source.client,
      ownerUserId: 'user-1',
      generationId: 'gen-1',
    });

    expect(source.linkedLookups).toEqual([]);
    expect(plan.ok && plan.references).toHaveLength(1);
  });

  it('says so when the saved inputs cannot be read, rather than plan none', async () => {
    const { planGenerationReferenceCopies } = await import('@/lib/post-resource-bundles-server');
    const source = referenceClient([], [], { rowsError: { message: 'read failed' } });

    await expect(planGenerationReferenceCopies({ supabase: source.client, ownerUserId: 'user-1', generationId: 'gen-1' }))
      .resolves.toEqual({ ok: false });
  });

  // #677's review: the editor re-copied every input on every save.
  it('needs no copy of an input the recipe holds already, by its file or by its place', async () => {
    const { planGenerationReferenceCopies } = await import('@/lib/post-resource-bundles-server');
    const source = referenceClient(
      [
        reference('ref-1', 'user-1', 'generation_inputs/user-1/gen-1/hero.png'),
        reference('ref-2', 'user-1', 'generation_inputs/user-1/gen-1/side.png', 1),
        reference('ref-3', 'user-1', 'generation_inputs/user-1/gen-1/back.png', 2),
      ],
      [],
    );

    const plan = await planGenerationReferenceCopies({
      supabase: source.client,
      ownerUserId: 'user-1',
      generationId: 'gen-1',
      heldItems: [
        // Its copy, as an earlier save stored it.
        { id: 'reference-ref-1', storagePath: 'user-1/generation-references/gen-1/00-reference-ref-1.png', contentType: 'image/webp', sizeBytes: 2048 },
        // Its place, under a file the creator chose instead.
        { id: 'reference-ref-2', storagePath: 'user-1/resources/my-own.png', contentType: 'image/png', sizeBytes: 10 },
      ],
    });

    expect(plan.ok && plan.references.map((planned) => [planned.item.id, planned.source === null])).toEqual([
      ['reference-ref-1', true],
      ['reference-ref-2', true],
      ['reference-ref-3', false],
    ]);
    // The held copy keeps the type and size it was stored with.
    expect(plan.ok && plan.references[0].item).toMatchObject({ contentType: 'image/webp', sizeBytes: 2048 });
  });

  it('copies inside storage where the recipe bucket takes the file, and reads its type and size from the source', async () => {
    const { copyPlannedGenerationReferences, planGenerationReferenceCopies } = await import('@/lib/post-resource-bundles-server');
    const source = referenceClient(
      [reference('ref-1', 'user-1', 'generation_inputs/user-1/gen-1/hero.png')],
      [],
      { info: () => ({ size: 4096, contentType: 'image/webp' }) },
    );
    const plan = await planGenerationReferenceCopies({ supabase: source.client, ownerUserId: 'user-1', generationId: 'gen-1' });
    if (!plan.ok) throw new Error('planned nothing');

    const copied = await copyPlannedGenerationReferences({ supabase: source.client, references: plan.references });

    expect(source.copies).toEqual([
      'generation_inputs/user-1/gen-1/hero.png -> post_resource_files/user-1/generation-references/gen-1/00-reference-ref-1.png',
    ]);
    expect(source.downloads).toEqual([]);
    expect(copied.files.get('reference-ref-1')).toEqual({ contentType: 'image/webp', sizeBytes: 4096 });
    expect(copied.failedItemIds.size).toBe(0);
  });

  it('copies no file the recipe bucket would refuse, and reads it not at all', async () => {
    const { copyPlannedGenerationReferences, planGenerationReferenceCopies } = await import('@/lib/post-resource-bundles-server');
    const source = referenceClient(
      [
        reference('ref-big', 'user-1', 'generation_inputs/user-1/gen-1/clip.mp4'),
        reference('ref-avif', 'user-1', 'generation_inputs/user-1/gen-1/still.avif', 1),
      ],
      [],
      { info: (filePath) => (filePath.endsWith('.mp4')
        ? { size: 150 * 1024 * 1024, contentType: 'video/mp4' }
        : { size: 2048, contentType: 'image/avif' }) },
    );
    const plan = await planGenerationReferenceCopies({ supabase: source.client, ownerUserId: 'user-1', generationId: 'gen-1' });
    if (!plan.ok) throw new Error('planned nothing');

    const copied = await copyPlannedGenerationReferences({ supabase: source.client, references: plan.references });

    expect([...copied.failedItemIds]).toEqual(['reference-ref-big', 'reference-ref-avif']);
    expect(source.copies).toEqual([]);
    expect(source.downloads).toEqual([]);
    expect(copied.files.size).toBe(0);
  });

  it('reads and writes a file again where storage cannot copy it, never over one already there', async () => {
    const { copyPlannedGenerationReferences, planGenerationReferenceCopies } = await import('@/lib/post-resource-bundles-server');
    const source = referenceClient(
      [reference('ref-1', 'user-1', 'generation_inputs/user-1/gen-1/hero.png')],
      [],
      { info: () => ({ size: 4096, contentType: 'image/png' }), copy: () => ({ error: { message: 'copy unavailable' } }) },
    );
    const plan = await planGenerationReferenceCopies({ supabase: source.client, ownerUserId: 'user-1', generationId: 'gen-1' });
    if (!plan.ok) throw new Error('planned nothing');

    const copied = await copyPlannedGenerationReferences({ supabase: source.client, references: plan.references });

    expect(source.downloads).toEqual(['generation_inputs/user-1/gen-1/hero.png']);
    expect(source.uploads).toEqual([{ path: 'post_resource_files/user-1/generation-references/gen-1/00-reference-ref-1.png', upsert: false }]);
    // Typed and sized by the bytes it read.
    expect(copied.files.get('reference-ref-1')).toMatchObject({ contentType: 'image/png' });
  });

  // The path is fixed by the input, so a file there is this input's: it is used
  // as it is, and nothing is written over it.
  it('keeps a copy already at the input’s path as it is', async () => {
    const { copyPlannedGenerationReferences, planGenerationReferenceCopies } = await import('@/lib/post-resource-bundles-server');
    const source = referenceClient(
      [reference('ref-1', 'user-1', 'generation_inputs/user-1/gen-1/hero.png')],
      [],
      {
        info: () => ({ size: 4096, contentType: 'image/png' }),
        copy: () => ({ error: { message: 'The resource already exists', statusCode: '409' } }),
      },
    );
    const plan = await planGenerationReferenceCopies({ supabase: source.client, ownerUserId: 'user-1', generationId: 'gen-1' });
    if (!plan.ok) throw new Error('planned nothing');

    const copied = await copyPlannedGenerationReferences({ supabase: source.client, references: plan.references });

    expect(copied.files.get('reference-ref-1')).toEqual({ contentType: 'image/png', sizeBytes: 4096 });
    expect(source.downloads).toEqual([]);
    expect(source.uploads).toEqual([]);
    expect(source.removals).toEqual([]);
  });

  it('takes the inputs that could not be copied out of the recipe, and keeps a first item', async () => {
    const { applyCopiedGenerationReferences } = await import('@/lib/post-resource-bundles-server');
    const bundle = {
      accessMode: 'free' as const,
      resources: {
        items: [
          { id: 'reference-ref-1', type: 'reference_image', storagePath: 'user-1/generation-references/gen-1/00-reference-ref-1.png', isPrimary: true, sortOrder: 0 },
          { id: 'reference-ref-2', type: 'reference_image', storagePath: 'user-1/generation-references/gen-1/01-reference-ref-2.png', isPrimary: false, sortOrder: 1 },
        ],
      },
    } as never;

    const applied = applyCopiedGenerationReferences(bundle, {
      files: new Map([['reference-ref-2', { contentType: 'image/webp', sizeBytes: 12 }]]),
      failedItemIds: new Set(['reference-ref-1']),
    });

    expect(applied?.resources?.items).toEqual([
      expect.objectContaining({ id: 'reference-ref-2', contentType: 'image/webp', sizeBytes: 12, isPrimary: true }),
    ]);
  });

  // Owner, 2026-11-03: every creation's recipe has its exact prompt, and one with
  // a prompt item of its own keeps that one.
  describe('a creation’s exact prompt', () => {
    const recipe = (items: unknown[], extra: Record<string, unknown> = {}) => ({
      accessMode: 'free' as const,
      previewText: 'The lighting notes behind this still.',
      resources: { items, ...extra },
    }) as never;
    const note = { id: 'notes-item-1', type: 'note', role: 'primary', sectionId: null, title: 'Lighting', textContent: 'Key light at 45 degrees.', sortOrder: 0, isPrimary: true, remixUse: 'none' };

    it('is added, titled as the composers lock it, to a recipe with no prompt item', async () => {
      const { withCreationPromptItem } = await import('@/lib/post-resource-bundles-server');
      const { bundle, addedItem } = withCreationPromptItem(recipe([note]), '  Neon fox in rain  ');

      expect(addedItem).toMatchObject({
        id: 'creation-prompt-item',
        type: 'prompt',
        title: 'Exact generation prompt',
        textContent: 'Neon fox in rain',
        remixUse: 'text_template',
        sortOrder: 1,
        isPrimary: false,
      });
      // The client's own item is kept as it was sent.
      expect(bundle?.resources?.items).toEqual([note, addedItem]);
    });

    it('is not added beside a prompt item of the creator’s own, however worded, nor to No recipe, nor without a prompt', async () => {
      const { withCreationPromptItem } = await import('@/lib/post-resource-bundles-server');
      const own = { ...note, id: 'own-prompt', type: 'prompt', title: 'My prompt', textContent: 'My own wording' };
      const sent = recipe([own]);
      expect(withCreationPromptItem(sent, 'Neon fox in rain')).toEqual({ bundle: sent, addedItem: null });
      // An older recipe's prompt is its flat field.
      const legacy = recipe([], { promptText: 'Neon fox in rain, an older wording' });
      expect(withCreationPromptItem(legacy, 'Neon fox in rain').addedItem).toBeNull();
      const none = { accessMode: 'none' as const } as never;
      expect(withCreationPromptItem(none, 'Neon fox in rain')).toEqual({ bundle: none, addedItem: null });
      expect(withCreationPromptItem(recipe([note]), '   ').addedItem).toBeNull();
    });

    it('takes an id no item of the recipe has', async () => {
      const { withCreationPromptItem } = await import('@/lib/post-resource-bundles-server');
      const { addedItem } = withCreationPromptItem(recipe([{ ...note, id: 'creation-prompt-item' }]), 'Neon fox in rain');
      expect(addedItem?.id).toBe('creation-prompt-item-2');
    });
  });

  // #677's review: the edit validated the recipe before the inputs were merged
  // in, so a recipe of the inputs alone was refused with 400.
  describe('the recipe a creation’s post saves', () => {
    const plannedInput = {
      item: {
        id: 'reference-ref-1',
        scope: { kind: 'all' as const },
        type: 'reference_image' as const,
        role: 'style_reference' as const,
        sectionId: null,
        title: 'Product',
        description: null,
        textContent: null,
        externalUrl: null,
        storagePath: 'user-1/generation-references/gen-1/00-reference-ref-1.png',
        contentType: 'image/png',
        sizeBytes: null,
        workflowSnapshot: null,
        sortOrder: 0,
        isPrimary: true,
        remixUse: 'reference_only' as const,
      },
      source: { bucket: 'generation_inputs', filePath: 'user-1/gen-1/hero.png' },
    };
    const referencesOnly = {
      accessMode: 'free' as const,
      previewText: 'The product reference behind this still.',
      resources: { promptText: null, notesMarkdown: null, workflowShareUrl: null, attachments: [], allowRemix: false, sections: [], items: [] },
    };
    const note = {
      id: 'notes',
      scope: { kind: 'all' as const },
      type: 'note' as const,
      role: 'primary' as const,
      sectionId: null,
      title: 'Lighting',
      description: null,
      textContent: 'Key light at 45 degrees.',
      externalUrl: null,
      storagePath: null,
      contentType: null,
      sizeBytes: null,
      workflowSnapshot: null,
      sortOrder: 0,
      isPrimary: true,
      remixUse: 'none' as const,
    };
    const withNote = { ...referencesOnly, resources: { ...referencesOnly.resources, items: [note] } };

    it('validates the recipe with the inputs merged in, so one of the inputs alone is taken', async () => {
      const { prepareCreationRecipeBundle } = await import('@/lib/post-resource-bundles-server');
      const planGenerationReferenceCopies = vi.fn(async () => ({ ok: true as const, references: [plannedInput] }));

      const prepared = await prepareCreationRecipeBundle({
        supabase: {} as never,
        ownerUserId: 'user-1',
        bundle: referencesOnly,
        creation: { id: 'gen-1', prompt: null },
        includeReferences: true,
        mayShareCreation: true,
        addsCreationPrompt: true,
        mediaKeys: ['media-1'],
        dependencies: { planGenerationReferenceCopies },
      });

      expect(prepared).toMatchObject({
        ok: true,
        addedItemIds: ['reference-ref-1'],
        pendingCopies: [plannedInput],
        refusedReferenceCount: 0,
      });
      expect(prepared.ok && prepared.bundle?.resources?.items).toEqual([expect.objectContaining({ id: 'reference-ref-1' })]);
      expect(planGenerationReferenceCopies).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: 'user-1', generationId: 'gen-1' }));
    });

    it('adds the exact prompt and the inputs together', async () => {
      const { prepareCreationRecipeBundle } = await import('@/lib/post-resource-bundles-server');
      const prepared = await prepareCreationRecipeBundle({
        supabase: {} as never,
        ownerUserId: 'user-1',
        bundle: referencesOnly,
        creation: { id: 'gen-1', prompt: 'A product still lit like a window display.' },
        includeReferences: true,
        mayShareCreation: true,
        addsCreationPrompt: true,
        mediaKeys: ['media-1'],
        dependencies: { planGenerationReferenceCopies: vi.fn(async () => ({ ok: true as const, references: [plannedInput] })) },
      });

      expect(prepared).toMatchObject({
        ok: true,
        addedItemIds: ['creation-prompt-item', 'reference-ref-1'],
        pendingCopies: [plannedInput],
        refusedReferenceCount: 0,
      });
    });

    // #677's re-review: the exact prompt still went into the recipe of a
    // creation an operator removed or its creator archived, which Remix
    // withholds (`remix-access.ts`); only the inputs were held back.
    // #677's re-reviews: a composer sent the locked card itself, and the server
    // stored it as it came. It is taken out; a prompt the creator rewrote or
    // titled as their own stays theirs.
    it('adds nothing of a creation off public view, and takes out the locked card a composer sent', async () => {
      const { prepareCreationRecipeBundle } = await import('@/lib/post-resource-bundles-server');
      const lockedCard = {
        ...note,
        id: 'creation-prompt',
        type: 'prompt' as const,
        title: 'Exact generation prompt',
        textContent: 'A product still lit like a window display.',
        sortOrder: 1,
        isPrimary: false,
        remixUse: 'text_template' as const,
      };
      const prepared = await prepareCreationRecipeBundle({
        supabase: {} as never,
        ownerUserId: 'user-1',
        bundle: { ...withNote, resources: { ...withNote.resources, items: [note, lockedCard] } },
        creation: { id: 'gen-1', prompt: 'A product still lit like a window display.' },
        includeReferences: true,
        mayShareCreation: false,
        addsCreationPrompt: true,
        mediaKeys: ['media-1'],
        dependencies: { planGenerationReferenceCopies: vi.fn(async () => ({ ok: true as const, references: [plannedInput] })) },
      });

      expect(prepared).toMatchObject({ ok: true, addedItemIds: [], pendingCopies: [], refusedReferenceCount: 1 });
      expect(prepared.ok && prepared.bundle?.resources?.items).toEqual([note]);
    });

    it('keeps a prompt the creator rewrote or titled as their own, and a first item, when it takes the locked card out', async () => {
      const { withoutLockedCreationPromptItem } = await import('@/lib/post-resource-bundles-server');
      const prompt = 'A product still lit like a window display.';
      const locked = { ...note, id: 'creation-prompt', type: 'prompt' as const, title: 'Exact generation prompt', textContent: prompt, isPrimary: true };
      const rewritten = { ...locked, id: 'rewritten', textContent: 'My own wording', isPrimary: false };
      const ownTitle = { ...locked, id: 'own-title', title: 'My prompt', isPrimary: false };
      const recipe = { ...withNote, resources: { ...withNote.resources, items: [locked, rewritten, ownTitle] } };

      expect(withoutLockedCreationPromptItem(recipe, prompt)?.resources?.items).toEqual([
        { ...rewritten, isPrimary: true },
        ownTitle,
      ]);
      expect(withoutLockedCreationPromptItem(withNote, prompt)).toBe(withNote);
    });

    // #677's re-review (decided there): an edit of a recipe people have never
    // gains the prompt from the server, since an older composer sends the
    // recipe back on every save and the revision would reach them unseen. A
    // composer that shows the locked card sends it itself; the inputs a creator
    // asks for still come.
    it('adds no exact prompt where told the recipe is one people have, and still the inputs asked for', async () => {
      const { prepareCreationRecipeBundle } = await import('@/lib/post-resource-bundles-server');
      const prepared = await prepareCreationRecipeBundle({
        supabase: {} as never,
        ownerUserId: 'user-1',
        bundle: withNote,
        creation: { id: 'gen-1', prompt: 'A product still lit like a window display.' },
        includeReferences: true,
        mayShareCreation: true,
        addsCreationPrompt: false,
        mediaKeys: ['media-1'],
        dependencies: { planGenerationReferenceCopies: vi.fn(async () => ({ ok: true as const, references: [plannedInput] })) },
      });

      expect(prepared).toMatchObject({ ok: true, addedItemIds: ['reference-ref-1'], pendingCopies: [plannedInput] });
      expect(prepared.ok && prepared.bundle?.resources?.items?.map((item) => item.id)).toEqual(['notes', 'reference-ref-1']);
    });

    it('refuses a recipe that is still empty once nothing could be added', async () => {
      const { prepareCreationRecipeBundle } = await import('@/lib/post-resource-bundles-server');
      const prepared = await prepareCreationRecipeBundle({
        supabase: {} as never,
        ownerUserId: 'user-1',
        bundle: referencesOnly,
        creation: { id: 'gen-1', prompt: null },
        includeReferences: true,
        mayShareCreation: true,
        addsCreationPrompt: true,
        mediaKeys: ['media-1'],
        dependencies: { planGenerationReferenceCopies: vi.fn(async () => ({ ok: true as const, references: [] })) },
      });

      expect(prepared).toEqual({ ok: false, status: 400, error: 'Add content for at least one unlock item before publishing.' });
    });

    it('refuses the save when the saved inputs asked for cannot be read', async () => {
      const { prepareCreationRecipeBundle, GENERATION_REFERENCES_UNREADABLE_ERROR } = await import('@/lib/post-resource-bundles-server');
      const prepared = await prepareCreationRecipeBundle({
        supabase: {} as never,
        ownerUserId: 'user-1',
        bundle: referencesOnly,
        creation: { id: 'gen-1', prompt: null },
        includeReferences: true,
        mayShareCreation: true,
        addsCreationPrompt: true,
        mediaKeys: ['media-1'],
        dependencies: { planGenerationReferenceCopies: vi.fn(async () => ({ ok: false as const })) },
      });

      expect(prepared).toEqual({ ok: false, status: 500, error: GENERATION_REFERENCES_UNREADABLE_ERROR });
    });

    // #677's review: a card that kept a copy's id under another file got a
    // second item under that id, and the save failed with 500.
    it('adds no input whose place an item the client sent holds', async () => {
      const { prepareCreationRecipeBundle } = await import('@/lib/post-resource-bundles-server');
      const replaced = { ...plannedInput.item, storagePath: 'user-1/resources/my-own.png', title: 'My own product shot' };
      const prepared = await prepareCreationRecipeBundle({
        supabase: {} as never,
        ownerUserId: 'user-1',
        bundle: { ...referencesOnly, resources: { ...referencesOnly.resources, items: [replaced] } },
        creation: { id: 'gen-1', prompt: null },
        includeReferences: true,
        mayShareCreation: true,
        addsCreationPrompt: true,
        mediaKeys: ['media-1'],
        dependencies: { planGenerationReferenceCopies: vi.fn(async () => ({ ok: true as const, references: [plannedInput] })) },
      });

      expect(prepared).toMatchObject({ ok: true, addedItemIds: [], pendingCopies: [] });
      expect(prepared.ok && prepared.bundle?.resources?.items).toEqual([replaced]);
    });
  });
});
describe('loadGenerationInputOrigins', () => {
  function originsClient({
    rows,
    rowsError = null,
    linkedGuestIds = [],
    linkedError = null,
    sourceOwners = [],
    generationError = null,
  }: {
    rows: Array<{ id: string; metadata: Record<string, unknown> | null; storage_path: string; source_generation_id: string | null }>;
    rowsError?: unknown;
    linkedGuestIds?: string[];
    linkedError?: unknown;
    sourceOwners?: Array<{ id: string; user_id: string | null }>;
    /** The legacy reading's read of the creation itself, made where no rows were kept. */
    generationError?: unknown;
  }) {
    const client = {
      from(table: string) {
        if (table === 'generation_input_media') {
          return { select: () => ({ eq: async () => ({ data: rowsError ? null : rows, error: rowsError }) }) };
        }
        if (table === 'profiles') {
          return {
            select: () => ({
              eq: async (column: string, value: string) => ({
                data: linkedError ? null : column === 'merged_into_user_id' && value === 'user-1' ? linkedGuestIds.map((id) => ({ id })) : [],
                error: linkedError,
              }),
            }),
          };
        }
        if (table === 'generations') {
          return {
            select: () => ({
              in: async () => ({ data: sourceOwners, error: null }),
              eq: () => ({ maybeSingle: async () => ({ data: null, error: generationError }) }),
            }),
          };
        }
        throw new Error(`Unexpected table access: ${table}`);
      },
    };
    return client as never;
  }

  it('reads a remix’s references from its original as the original’s, and the creator’s uploads as their own', async () => {
    const { loadGenerationInputOrigins } = await import('@/lib/post-resource-bundles-server');
    const origins = await loadGenerationInputOrigins({
      supabase: originsClient({
        rows: [
          { id: 'row-original', storage_path: 'generation_inputs/user-1/gen-1/00.png', source_generation_id: null, metadata: { sourceStoragePath: 'generation_inputs/creator-9/gen-0/00.png' } },
          { id: 'row-own', storage_path: 'generation_inputs/user-1/gen-1/01.png', source_generation_id: null, metadata: { sourceStoragePath: 'uploads/user-1/draft/face.png' } },
          { id: 'row-guest', storage_path: 'generation_inputs/user-1/gen-1/02.png', source_generation_id: null, metadata: { sourceStoragePath: 'uploads/guest-1/draft/hand.png' } },
          { id: 'row-result', storage_path: 'generation_inputs/user-1/gen-1/03.png', source_generation_id: 'gen-0', metadata: {} },
        ],
        linkedGuestIds: ['guest-1'],
        sourceOwners: [{ id: 'gen-0', user_id: 'creator-9' }],
      }),
      ownerUserId: 'user-1',
      generationId: 'gen-1',
    });

    expect(Object.fromEntries(origins.byRowId)).toEqual({
      'row-original': 'others',
      'row-own': 'own',
      'row-guest': 'own',
      'row-result': 'others',
    });
    expect(origins.hasOwn).toBe(true);
  });

  // A recipe that leaves the creator's own uploads out copies the rows whose origin is another's:
  // a file of someone else's recipe the run used is neither, and no recipe copies it.
  it('reads a file of someone else’s recipe as a recipe file, which is neither the creator’s nor the original’s', async () => {
    const { loadGenerationInputOrigins } = await import('@/lib/post-resource-bundles-server');
    const origins = await loadGenerationInputOrigins({
      supabase: originsClient({
        rows: [
          { id: 'row-bought', storage_path: 'generation_inputs/user-1/gen-1/00.png', source_generation_id: null, metadata: { sourceKind: 'recipe-file', sourceStoragePath: 'post_resource_files/seller-9/generation-references/gen-0/00-reference-image-row.png' } },
          { id: 'row-seller-file', storage_path: 'generation_inputs/user-1/gen-1/01.png', source_generation_id: null, metadata: { sourceStoragePath: 'post_resource_files/seller-9/generation-references/gen-0/01-reference-image-row.png' } },
          { id: 'row-original', storage_path: 'generation_inputs/user-1/gen-1/02.png', source_generation_id: null, metadata: { sourceStoragePath: 'generation_inputs/creator-9/gen-0/00.png' } },
          { id: 'row-own-recipe-file', storage_path: 'generation_inputs/user-1/gen-1/03.png', source_generation_id: null, metadata: { sourceStoragePath: 'post_resource_files/user-1/resources/guide.png' } },
        ],
      }),
      ownerUserId: 'user-1',
      generationId: 'gen-1',
    });

    expect(Object.fromEntries(origins.byRowId)).toEqual({
      'row-bought': 'recipe',
      'row-seller-file': 'recipe',
      'row-original': 'others',
      'row-own-recipe-file': 'own',
    });
    expect(origins.hasOwn).toBe(true);
  });

  it('counts every input as the creator’s own when the rows cannot be read', async () => {
    const { loadGenerationInputOrigins } = await import('@/lib/post-resource-bundles-server');
    const origins = await loadGenerationInputOrigins({
      supabase: originsClient({ rows: [], rowsError: { message: 'timeout' } }),
      ownerUserId: 'user-1',
      generationId: 'gen-1',
    });

    expect(origins.byRowId.size).toBe(0);
    expect(origins.hasOwn).toBe(true);
  });

  // A guest's uploads sit in the guest's folder: unread, the guest is not known to be the
  // creator, and their uploads would count as the original's and go out with the recipe.
  it('counts no input as another’s when who is linked to the creator cannot be read', async () => {
    const { loadGenerationInputOrigins } = await import('@/lib/post-resource-bundles-server');
    const origins = await loadGenerationInputOrigins({
      supabase: originsClient({
        rows: [
          { id: 'row-guest', storage_path: 'generation_inputs/user-1/gen-1/02.png', source_generation_id: null, metadata: { sourceStoragePath: 'uploads/guest-1/draft/hand.png' } },
        ],
        linkedError: { message: 'timeout' },
      }),
      ownerUserId: 'user-1',
      generationId: 'gen-1',
    });

    expect([...origins.byRowId.values()]).not.toContain('others');
    expect(origins.hasOwn).toBe(true);
  });

  it('counts every input as the creator’s own when a creation without rows cannot be read', async () => {
    const { loadGenerationInputOrigins } = await import('@/lib/post-resource-bundles-server');
    const origins = await loadGenerationInputOrigins({
      supabase: originsClient({ rows: [], generationError: { message: 'timeout' } }),
      ownerUserId: 'user-1',
      generationId: 'gen-1',
    });

    expect(origins.hasOwn).toBe(true);
  });
});

