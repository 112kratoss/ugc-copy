import { parsePublishedModelDescriptor } from './generation-model-descriptor-parser';
import {
  catalogBytes,
  catalogSummary,
  MODEL_CATALOG_BUDGETS,
} from './model-catalog-transport';

type Entry = {
  modelId: string;
  publicDescriptor: Record<string, unknown>;
  webEnabled: boolean;
  mobileEnabled: boolean;
};
export function measureModelCatalogRelease(release: {
  revision: string;
  schemaVersion: number;
  defaults: Record<'web' | 'mobile', Record<string, string | null>>;
  entries: Entry[];
}) {
  const entries = release.entries;
  for (const kind of ['image', 'video', 'motion'])
    if (release.defaults.web[kind] !== release.defaults.mobile[kind])
      throw new Error(
        `Catalog defaults must match on web and mobile (${kind}).`,
      );
  if (entries.some((e) => e.webEnabled !== e.mobileEnabled))
    throw new Error('Model availability must match on web and mobile.');
  const models = entries
    .filter((e) => e.webEnabled)
    .map((e) => {
      const model = parsePublishedModelDescriptor(
        e.publicDescriptor,
        e.modelId,
        release.schemaVersion,
        { web: true, mobile: true },
      );
      if (model.minClientSchemaVersion > 3)
        throw new Error(
          `Deploy compatible clients before publishing ${e.modelId}.`,
        );
      return model;
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
    defaults: release.defaults.web,
    counts: Object.fromEntries(
      ['image', 'video', 'motion'].map((kind) => [
        kind,
        models.filter((m) => m.kind === kind).length,
      ]),
    ),
  };
  const currentBytes = catalogBytes(current);
  if (currentBytes > MODEL_CATALOG_BUDGETS.current)
    throw new Error('Catalog revision response exceeds its byte budget.');
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
    throw new Error('Catalog detail batch exceeds its byte budget.');
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
    throw new Error('Catalog summary page exceeds its byte budget.');
  const legacyBytes = catalogBytes({
    schemaVersion: 3,
    revision: release.revision,
    defaults: release.defaults.web,
    models: wireModels,
  });
  return {
    currentBytes,
    maxDetailBytes,
    maxPageBytes,
    maxBatchBytes,
    legacyBytes,
    legacyBudgetWarning: legacyBytes > 57344,
  };
}
