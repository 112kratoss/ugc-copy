import { describe, expect, it } from 'vitest';
import { buildGenerationModelCatalog } from '@/lib/generation-model-catalog';
import { getCatalogDescriptorDefaultSettings } from '@/lib/generation-model-client';
import { APP_CREATOR_OPENINGS } from '../../ugc-mobile/lib/app-creator-opening/app-creator-opening';

/**
 * The app's creators draw their opening (ugc-mobile/lib/app-creator-opening) from the first frame,
 * before their catalog arrives, and the catalog then settles a new draft on its default at that
 * model's published settings, the ones the web's first pick takes too (getCatalogDescriptorDefaultSettings).
 * The two have to be one run, or the chips change as the catalog lands: until 2026-10-30 the app opened
 * on a Kling 3.0 stand-in and moved to Seedance 2 Mini half a second later. A change of default here is
 * a change the app needs in its next update (an OTA).
 */
describe("the app creators' opening", () => {
  const catalog = buildGenerationModelCatalog({ platform: 'mobile', schemaVersion: 3 });

  it.each(['image', 'video', 'motion'] as const)('is the %s default, by name, at its published settings', (tool) => {
    const opening = APP_CREATOR_OPENINGS[tool];
    const model = catalog.models.find((entry) => entry.id === catalog.defaults[tool]);

    expect(model?.id).toBe(opening.modelId);
    expect(model?.kind).toBe(tool);
    expect(model?.displayName).toBe(opening.displayName);
    expect(getCatalogDescriptorDefaultSettings(model!)).toEqual(opening.settings);
  });
});
