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

/**
 * Models production holds apart from the code build on purpose, each with its reason: where it
 * offers them, while the code build offers them elsewhere. None today. The Imagen 4 family was
 * the first, off in production since release imagen-family-disable-20260824 while the code build
 * still offered it, until it joined RETIRED_MODEL_IDS (2026-11-22); a retired model's entry is
 * offered nowhere, so production and the code build agree on it without one. An exception the
 * code build stops needing is reported stale, and the test asks for it to go.
 */
export const CATALOG_DRIFT_EXCEPTIONS: Readonly<Record<string, CatalogDriftException>> = {};

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

/**
 * The release diff's parts, and the provider check's settings (`verificationConfig`), which the
 * provider verification job reads from production and the release diff does not compare.
 */
export type CatalogDriftPart = typeof PARTS[number] | 'verification';

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
  /**
   * Exceptions the code build no longer needs: its own entry is already the one the exception
   * describes (a model in RETIRED_MODEL_IDS is offered nowhere), so the exception can go.
   */
  staleExceptions: string[];
};

function partsOf(change: Record<typeof PARTS[number], boolean>): CatalogDriftPart[] {
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
  const expected = materializeCatalogManifest(
    { ...manifest, entries: manifest.entries.map(expectedProductionEntry) },
    active,
  );
  const asExpected = buildCatalogDiff(active, expected);
  // The release diff has no part for the provider check's settings; production reads them too.
  const activeById = new Map(active.entries.map((entry) => [entry.modelId, entry]));
  const verificationDiffers = new Set(expected.entries
    .filter((entry) => {
      const held = activeById.get(entry.modelId);
      return held !== undefined && !isDeepStrictEqual(held.verificationConfig, entry.verificationConfig);
    })
    .map((entry) => entry.modelId));
  // Drift is any model production holds apart from the entry it should hold: the code build's,
  // or, for an excepted model, the one its exception describes. A release that put an excepted
  // model back to the code build's entry (Imagen offered again) is drift, not a stale exception.
  const expectedParts = new Map(asExpected.changed.map((change) => [change.modelId, partsOf(change)]));
  const changed = [...new Set([...expectedParts.keys(), ...verificationDiffers])].sort().map((modelId) => ({
    modelId,
    parts: [
      ...(expectedParts.get(modelId) ?? []),
      ...(verificationDiffers.has(modelId) ? ['verification' as const] : []),
    ],
  }));
  const notInCode = activeIds.filter((modelId) => !codeIds.has(modelId));
  const notInRelease = [...codeIds].filter((modelId) => !activeIds.includes(modelId)).sort();
  const defaultsDiffer = !isDeepStrictEqual(active.defaults, manifest.defaults);
  const exceptionIds = Object.keys(CATALOG_DRIFT_EXCEPTIONS).filter((modelId) => activeIds.includes(modelId));
  const codeEntries = new Map(manifest.entries.map((entry) => [entry.modelId, entry]));
  return {
    status: changed.length || notInCode.length || notInRelease.length || defaultsDiffer ? 'drift' : 'clean',
    activeRevision: active.revision,
    models: activeIds.length,
    changed,
    notInCode,
    notInRelease,
    defaultsDiffer,
    excepted: asCode.changed
      .filter((change) => exceptionIds.includes(change.modelId)
        && !expectedParts.has(change.modelId)
        && !verificationDiffers.has(change.modelId))
      .map((change) => ({
        modelId: change.modelId,
        parts: partsOf(change),
        reason: CATALOG_DRIFT_EXCEPTIONS[change.modelId].reason,
      })),
    staleExceptions: exceptionIds.filter((modelId) => {
      const entry = codeEntries.get(modelId);
      return entry !== undefined && isDeepStrictEqual(entry, expectedProductionEntry(entry));
    }),
  };
}
