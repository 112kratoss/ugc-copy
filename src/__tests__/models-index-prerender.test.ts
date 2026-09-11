import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const catalogStore = vi.hoisted(() => ({
    loadPublishedGenerationModelCatalog: vi.fn(),
    quotePublishedGenerationModel: vi.fn(),
}));

vi.mock('@/lib/generation-model-catalog-store', () => catalogStore);
vi.mock('@/lib/backend-logger', () => ({
    logBackendError: vi.fn(),
    logBackendWarning: vi.fn(),
}));

import { listPublicModelsForPrerender } from '@/lib/model-pages';

/**
 * `/models` is a static route with `revalidate`, so `next build` prerenders it,
 * and CI's build points at a placeholder Supabase URL. An uncaught catalog
 * failure there fails the whole build (it did, on the first CI run of #151).
 * The build may render an empty index; request time must not.
 */
describe('listPublicModelsForPrerender', () => {
    const originalPhase = process.env.NEXT_PHASE;

    afterEach(() => {
        if (originalPhase === undefined) {
            delete process.env.NEXT_PHASE;
        } else {
            process.env.NEXT_PHASE = originalPhase;
        }
        vi.clearAllMocks();
    });

    it('returns the published catalog when it loads', async () => {
        const models = [{ id: 'veo-3.1', kind: 'video' }];
        catalogStore.loadPublishedGenerationModelCatalog.mockResolvedValue({ catalog: { models } });

        await expect(listPublicModelsForPrerender()).resolves.toBe(models);
    });

    it('renders an empty index during the build when the catalog is unreachable', async () => {
        process.env.NEXT_PHASE = 'phase-production-build';
        catalogStore.loadPublishedGenerationModelCatalog.mockRejectedValue(
            new Error('getaddrinfo ENOTFOUND example.supabase.co'),
        );

        await expect(listPublicModelsForPrerender()).resolves.toEqual([]);
    });

    it('rethrows at request time, so ISR keeps the last good page instead of caching an empty one', async () => {
        delete process.env.NEXT_PHASE;
        catalogStore.loadPublishedGenerationModelCatalog.mockRejectedValue(new Error('database offline'));

        await expect(listPublicModelsForPrerender()).rejects.toThrow('database offline');
    });

    it('is what the /models index page loads through', () => {
        const page = fs.readFileSync(path.resolve(process.cwd(), 'src/app/models/page.tsx'), 'utf8');

        expect(page).toContain('await listPublicModelsForPrerender()');
        expect(page).not.toMatch(/await listPublicModels\(\)/);
    });
});
