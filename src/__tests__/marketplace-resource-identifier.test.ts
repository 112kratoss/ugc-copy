import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  fromCalls: [] as string[],
  orFilters: [] as string[],
  eqCalls: [] as Array<{ column: string; value: unknown }>,
  bundleResult: { data: null as Record<string, unknown> | null, error: null as unknown },
  legacyResult: { data: null as Record<string, unknown> | null, error: null as unknown },
};

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({
    from(table: string) {
      state.fromCalls.push(table);
      const result = table === 'post_resource_bundles' ? state.bundleResult : state.legacyResult;
      const query = {
        select() {
          return query;
        },
        or(filter: string) {
          state.orFilters.push(filter);
          return query;
        },
        eq(column: string, value: unknown) {
          state.eqCalls.push({ column, value });
          return query;
        },
        async maybeSingle() {
          return result;
        },
      };
      return query;
    },
  }),
}));

const BUNDLE_ID = '11111111-2222-4333-8444-555555555555';
const POST_ID = '99999999-8888-4777-8666-555555555555';

describe('marketplace resource identifier resolution', () => {
  beforeEach(() => {
    state.fromCalls = [];
    state.orFilters = [];
    state.eqCalls = [];
    state.bundleResult = { data: null, error: null };
    state.legacyResult = { data: null, error: null };
  });

  it('rejects PostgREST filter injection attempts without querying the database', async () => {
    const { resolvePostIdForResourceIdentifier } = await import('@/lib/post-resource-bundles-server');

    const maliciousIdentifiers = [
      'x,and(post_id.eq.00000000-0000-0000-0000-000000000000)',
      `${BUNDLE_ID},owner_user_id.eq.${POST_ID}`,
      'id.eq.x)or(post_id.not.is.null',
      'not-a-uuid',
      '',
    ];

    for (const identifier of maliciousIdentifiers) {
      await expect(resolvePostIdForResourceIdentifier(identifier)).resolves.toBeNull();
    }

    expect(state.fromCalls).toEqual([]);
    expect(state.orFilters).toEqual([]);
  });

  it('resolves a bundle id, normalizing case before building the filter', async () => {
    const { resolvePostIdForResourceIdentifier } = await import('@/lib/post-resource-bundles-server');
    state.bundleResult = { data: { post_id: POST_ID, legacy_asset_id: null }, error: null };

    await expect(resolvePostIdForResourceIdentifier(BUNDLE_ID.toUpperCase())).resolves.toBe(POST_ID);

    expect(state.fromCalls).toEqual(['post_resource_bundles']);
    expect(state.orFilters).toEqual([
      `id.eq.${BUNDLE_ID},legacy_asset_id.eq.${BUNDLE_ID}`,
    ]);
  });

  it('resolves a legacy marketplace asset id through the same guarded filter', async () => {
    const { resolvePostIdForResourceIdentifier } = await import('@/lib/post-resource-bundles-server');
    const legacyAssetId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    state.bundleResult = { data: { post_id: POST_ID, legacy_asset_id: legacyAssetId }, error: null };

    await expect(resolvePostIdForResourceIdentifier(legacyAssetId)).resolves.toBe(POST_ID);
    expect(state.orFilters).toEqual([
      `id.eq.${legacyAssetId},legacy_asset_id.eq.${legacyAssetId}`,
    ]);
  });

  it('falls back to the legacy marketplace table with the validated identifier when the bundle schema is missing', async () => {
    const { resolvePostIdForResourceIdentifier } = await import('@/lib/post-resource-bundles-server');
    state.bundleResult = {
      data: null,
      error: {
        code: 'PGRST205',
        message: "Could not find the table 'public.post_resource_bundles' in the schema cache",
      },
    };
    state.legacyResult = { data: { post_id: POST_ID }, error: null };

    await expect(resolvePostIdForResourceIdentifier(BUNDLE_ID)).resolves.toBe(POST_ID);

    expect(state.fromCalls).toEqual(['post_resource_bundles', 'marketplace_assets']);
    expect(state.eqCalls).toEqual([{ column: 'id', value: BUNDLE_ID }]);
  });

  it('returns null for unknown but well-formed identifiers', async () => {
    const { resolvePostIdForResourceIdentifier } = await import('@/lib/post-resource-bundles-server');

    await expect(resolvePostIdForResourceIdentifier(BUNDLE_ID)).resolves.toBeNull();
    expect(state.fromCalls).toEqual(['post_resource_bundles']);
  });
});
