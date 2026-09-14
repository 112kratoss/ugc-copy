import { projectGenerationModelDescriptor } from './generation-model-catalog';
import { parsePublishedModelDescriptor } from './generation-model-descriptor-parser';
import {
  catalogBytes,
  catalogSummary,
  MODEL_CATALOG_BUDGETS,
  type ModelCatalogPlatform,
} from './model-catalog-transport';

type Entry = {
  modelId: string;
  publicDescriptor: Record<string, unknown>;
  webEnabled: boolean;
  mobileEnabled: boolean;
};
type Release = {
  revision: string;
  schemaVersion: number;
  defaults: Record<ModelCatalogPlatform, Record<string, string | null>>;
  entries: Entry[];
};
export type ModelCatalogPlatformMeasurement = {
  modelCount: number;
  currentBytes: number;
  maxDetailBytes: number;
  maxPageBytes: number;
  maxBatchBytes: number;
  legacyBytes: number;
};
const PLATFORMS: ModelCatalogPlatform[] = ['web', 'mobile'];

/**
 * Every transport response is bounded per platform: a platform sees only the
 * entries enabled for it and its own defaults, so web-only or mobile-only
 * availability stays a supported release shape.
 */
export function measureModelCatalogRelease(release: Release) {
  const platforms = Object.fromEntries(
    PLATFORMS.map((platform) => [platform, measurePlatform(release, platform)]),
  ) as Record<ModelCatalogPlatform, ModelCatalogPlatformMeasurement>;
  const max = (key: keyof ModelCatalogPlatformMeasurement) =>
    Math.max(...PLATFORMS.map((platform) => platforms[platform][key]));
  const legacyBytes = max('legacyBytes');
  return {
    currentBytes: max('currentBytes'),
    maxDetailBytes: max('maxDetailBytes'),
    maxPageBytes: max('maxPageBytes'),
    maxBatchBytes: max('maxBatchBytes'),
    legacyBytes,
    legacyBudgetWarning: legacyBytes > 57344,
    platforms,
  };
}

function measurePlatform(
  release: Release,
  platform: ModelCatalogPlatform,
): ModelCatalogPlatformMeasurement {
  const models = release.entries
    .filter((e) => (platform === 'mobile' ? e.mobileEnabled : e.webEnabled))
    .map((e) => {
      const model = parsePublishedModelDescriptor(
        e.publicDescriptor,
        e.modelId,
        release.schemaVersion,
        { web: e.webEnabled, mobile: e.mobileEnabled },
      );
      if (model.minClientSchemaVersion > 3)
        throw new Error(
          `Deploy compatible clients before publishing ${e.modelId}.`,
        );
      // Measure the same projection the read service serves.
      return projectGenerationModelDescriptor(model, 3);
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1));
  const wireModels = models.map((model) => {
    const value = { ...model } as Partial<typeof model>;
    delete value.inputs;
    return value;
  });
  const envelope = {
    transportVersion: 1,
    descriptorSchemaVersion: 3,
    revision: release.revision,
  };
  const current = {
    ...envelope,
    defaults: release.defaults[platform],
    counts: Object.fromEntries(
      ['image', 'video', 'motion'].map((kind) => [
        kind,
        models.filter((m) => m.kind === kind).length,
      ]),
    ),
  };
  const currentBytes = catalogBytes(current);
  if (currentBytes > MODEL_CATALOG_BUDGETS.current)
    throw new Error(
      `Catalog revision response exceeds its byte budget (${platform}).`,
    );
  let maxDetailBytes = 0,
    maxPageBytes = 0;
  for (const model of wireModels) {
    const bytes = catalogBytes({
      ...envelope,
      models: [model],
      missingIds: [],
    });
    maxDetailBytes = Math.max(maxDetailBytes, bytes);
    if (bytes > MODEL_CATALOG_BUDGETS.detail)
      throw new Error(`Model ${model.id} exceeds the detail byte budget.`);
  }
  const largestModels = [...wireModels]
    .sort((a, b) => catalogBytes(b) - catalogBytes(a))
    .slice(0, 8);
  const maxBatchBytes = catalogBytes({
    ...envelope,
    models: largestModels,
    missingIds: [],
  });
  if (maxBatchBytes > MODEL_CATALOG_BUDGETS.details)
    throw new Error(
      `Catalog detail batch exceeds its byte budget (${platform}).`,
    );
  // Every contiguous window is a possible page, not just pages beginning at multiples of 50.
  for (const kind of [null, 'image', 'video', 'motion']) {
    const summaries = models
      .filter((m) => kind === null || m.kind === kind)
      .map(catalogSummary);
    for (let offset = 0; offset < summaries.length; offset++) {
      const page = {
        transportVersion: 1,
        revision: release.revision,
        models: summaries.slice(offset, offset + 50),
        nextCursor: 'x'.repeat(512),
      };
      maxPageBytes = Math.max(maxPageBytes, catalogBytes(page));
    }
  }
  if (maxPageBytes > MODEL_CATALOG_BUDGETS.models)
    throw new Error(
      `Catalog summary page exceeds its byte budget (${platform}).`,
    );
  const legacyBytes = catalogBytes({
    schemaVersion: 3,
    revision: release.revision,
    defaults: release.defaults[platform],
    models: wireModels,
  });
  return {
    modelCount: models.length,
    currentBytes,
    maxDetailBytes,
    maxPageBytes,
    maxBatchBytes,
    legacyBytes,
  };
}
