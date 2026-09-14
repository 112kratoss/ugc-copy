import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../contracts/model-catalog-transport-v1.json';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ rpc }),
}));
import {
  clearModelCatalogReadCache,
  readModelCatalogCurrent,
  readModelCatalogDetails,
  readModelCatalogPage,
} from '@/lib/model-catalog-read-service';
import { buildGenerationModelCatalog } from '@/lib/generation-model-catalog';
beforeEach(() => {
  clearModelCatalogReadCache();
  vi.stubEnv('GENERATION_MODEL_CATALOG_SOURCE', 'database');
  rpc.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe('bounded public catalog reads', () => {
  it('deduplicates current reads and expires the origin revision at 30 seconds', async () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    rpc.mockResolvedValue({ data: fixture.current, error: null });
    await Promise.all([
      readModelCatalogCurrent('web'),
      readModelCatalogCurrent('web'),
    ]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenLastCalledWith('read_model_catalog_v1_current', {
      p_platform: 'web',
    });
    now += 29999;
    await readModelCatalogCurrent('web');
    expect(rpc).toHaveBeenCalledTimes(1);
    now += 1;
    await readModelCatalogCurrent('web');
    expect(rpc).toHaveBeenCalledTimes(2);
    // Each platform has its own revision projection, so its own cache entry.
    await readModelCatalogCurrent('mobile');
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc).toHaveBeenLastCalledWith('read_model_catalog_v1_current', {
      p_platform: 'mobile',
    });
  });
  it('uses only the bounded summary RPC in shadow mode, without reading a shadow release', async () => {
    vi.stubEnv('GENERATION_MODEL_CATALOG_SOURCE', 'shadow');
    rpc.mockResolvedValue({ data: fixture.page.models, error: null });
    await readModelCatalogPage({
      platform: 'mobile',
      revision: fixture.current.revision,
      kind: 'image',
      after: { id: 'previous', sortOrder: 2 },
      limit: 32,
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('read_model_catalog_v1_page', {
      p_revision: fixture.current.revision,
      p_platform: 'mobile',
      p_kind: 'image',
      p_after_id: 'previous',
      p_after_sort: 2,
      p_limit: 33,
    });
  });
  it('projects requested descriptors through the public allowlist and does not cache unpublished revisions', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(
      readModelCatalogDetails('shadow-test', ['model'], 'web'),
    ).rejects.toMatchObject({ status: 404 });
    const model = buildGenerationModelCatalog({
      platform: 'web',
      schemaVersion: 3,
    }).models[0];
    rpc.mockResolvedValueOnce({
      data: [
        {
          modelId: model.id,
          releaseSchemaVersion: 2,
          webEnabled: true,
          mobileEnabled: false,
          descriptor: {
            ...model,
            providerModelMap: { private: 'private-config' },
            pricingConfig: { secret: 5 },
          },
        },
      ],
      error: null,
    });
    const result = await readModelCatalogDetails('shadow-test', [model.id], 'web');
    expect(JSON.stringify(result)).not.toMatch(
      /private-config|pricingConfig|providerModelMap/,
    );
    expect(result[0].availability).toEqual({ web: true, mobile: false });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith('read_model_catalog_v1_details', {
      p_revision: 'shadow-test',
      p_ids: [model.id],
      p_platform: 'web',
    });
  });
  it('evicts old request entries when the bounded server cache fills', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const page = (revision: string) =>
      readModelCatalogPage({
        platform: 'web',
        revision,
        kind: null,
        after: null,
        limit: 32,
      });
    await page('revision-first');
    for (let i = 0; i < 128; i++) await page(`revision-${i}`);
    await page('revision-first');
    expect(rpc).toHaveBeenCalledTimes(130);
  });
});
