/**
 * The generation-model catalog a release chain publishes, against the code build.
 *
 * Releases clone the active one and carry only the models they change, and each release's
 * manifest test pins only the ids it carries. A model no release re-emits keeps the entry it
 * last had, so the code build can move on while production serves an older shape unseen: on
 * 2026-11-01 twelve entries differed (releases kling-3-motion-inputs-20261101 and
 * image-models-reemit-20261101 moved them back). Two guards share this module:
 * `src/__tests__/generation-model-catalog-drift.test.ts` holds each model's newest committed
 * entry to the code build, and the CLI's `drift` command holds the active release to it.
 */
import { isDeepStrictEqual } from 'node:util';

import { buildGenerationModelCatalog } from '../../src/lib/generation-model-catalog';
import { emitManifest } from './emit-generation-model-catalog-entries';
import {
  buildCatalogDiff,
  materializeCatalogManifest,
  validateCatalogManifest,
  type ActiveCatalogSnapshot,
  type CatalogManifestEntry,
} from './generation-model-catalog';

type CatalogDriftException = {
  /** Where production offers the model; the code build's entry must match in every other field. */
  offered: { web: boolean; mobile: boolean };
  reason: string;
};

const IMAGEN_OFF = 'Off in production on purpose: release imagen-family-disable-20260824 turned the Imagen 4 '
  + 'family off after Google sunset the upstream Imagen API (Kie runs failed with provider 500s). The code build '
  + 'still offers it until the family joins RETIRED_MODEL_IDS (src/lib/generation-model-catalog.ts).';

/** Models production holds apart from the code build on purpose, each with its reason. */
export const CATALOG_DRIFT_EXCEPTIONS: Readonly<Record<string, CatalogDriftException>> = {
  'imagen-4': { offered: { web: false, mobile: false }, reason: IMAGEN_OFF },
  'imagen-4-fast': { offered: { web: false, mobile: false }, reason: IMAGEN_OFF },
  'imagen-4-ultra': { offered: { web: false, mobile: false }, reason: IMAGEN_OFF },
};

/** The entry production should hold for a model: the code build's, offered where an exception says. */
export function expectedProductionEntry(entry: CatalogManifestEntry): CatalogManifestEntry {
  const exception = CATALOG_DRIFT_EXCEPTIONS[entry.modelId];
  if (!exception) return entry;
  return {
    ...entry,
    publicDescriptor: { ...entry.publicDescriptor, availability: { ...exception.offered } },
    webEnabled: exception.offered.web,
    mobileEnabled: exception.offered.mobile,
  };
}

const PARTS = ['publicDescriptor', 'availability', 'adapter', 'pricing', 'validation'] as const;

export type CatalogDriftPart = typeof PARTS[number];

export type CatalogDrift = {
  status: 'clean' | 'drift';
  activeRevision: string;
  models: number;
  /** Models whose active entry differs from the code build outside the exceptions, and the parts that differ. */
  changed: Array<{ modelId: string; parts: CatalogDriftPart[] }>;
  /** Models the active release carries that the code build does not. */
  notInCode: string[];
  /** Models the code build has that the active release does not carry. */
  notInRelease: string[];
  defaultsDiffer: boolean;
  /** Exceptions the active release holds, as the table describes them. */
  excepted: Array<{ modelId: string; parts: CatalogDriftPart[]; reason: string }>;
  /** Exceptions the active release no longer needs: it holds the code build's entry. */
  staleExceptions: string[];
};

function partsOf(change: Record<CatalogDriftPart, boolean>): CatalogDriftPart[] {
  return PARTS.filter((part) => change[part]);
}

/**
 * A full code emit materialized on the active release, compared with it twice: as the code
 * build has it, and as the exceptions say production should hold it. Ids and part names only:
 * nothing here carries a price, a provider mapping or adapter configuration.
 */
export function buildCatalogDrift(active: ActiveCatalogSnapshot): CatalogDrift {
  const codeIds = new Set(buildGenerationModelCatalog({
    platform: 'web',
    schemaVersion: 2,
    includeUnavailable: true,
  }).models.map((model) => model.id));
  const activeIds = active.entries.map((entry) => entry.modelId).sort();
  const manifest = validateCatalogManifest(emitManifest({
    models: activeIds.filter((modelId) => codeIds.has(modelId)),
    revision: 'code-build-drift-check',
    basedOn: active.revision,
    changeNote: 'Read-only comparison of the code build with the active release.',
    expectedModelIds: activeIds,
  }));
  const asCode = buildCatalogDiff(active, materializeCatalogManifest(manifest, active));
  const asExcepted = buildCatalogDiff(active, materializeCatalogManifest(
    { ...manifest, entries: manifest.entries.map(expectedProductionEntry) },
    active,
  ));
  const differsFromCode = new Set(asCode.changed.map((change) => change.modelId));
  const differsFromExcepted = new Set(asExcepted.changed.map((change) => change.modelId));
  // An excepted model may hold the entry its exception describes, or the code build's (then the
  // exception is stale); anything else is drift, told against the entry the exception describes.
  const changed = asExcepted.changed
    .filter((change) => differsFromCode.has(change.modelId))
    .map((change) => ({ modelId: change.modelId, parts: partsOf(change) }));
  const notInCode = activeIds.filter((modelId) => !codeIds.has(modelId));
  const notInRelease = [...codeIds].filter((modelId) => !activeIds.includes(modelId)).sort();
  const defaultsDiffer = !isDeepStrictEqual(active.defaults, manifest.defaults);
  const exceptionIds = Object.keys(CATALOG_DRIFT_EXCEPTIONS).filter((modelId) => activeIds.includes(modelId));
  return {
    status: changed.length || notInCode.length || notInRelease.length || defaultsDiffer ? 'drift' : 'clean',
    activeRevision: active.revision,
    models: activeIds.length,
    changed,
    notInCode,
    notInRelease,
    defaultsDiffer,
    excepted: asCode.changed
      .filter((change) => exceptionIds.includes(change.modelId) && !differsFromExcepted.has(change.modelId))
      .map((change) => ({
        modelId: change.modelId,
        parts: partsOf(change),
        reason: CATALOG_DRIFT_EXCEPTIONS[change.modelId].reason,
      })),
    staleExceptions: exceptionIds.filter((modelId) => !differsFromCode.has(modelId)),
  };
}
