/**
 * Emit a generation-model catalog release manifest from the code catalog.
 *
 * The staged DB release must byte-match the code build (the shadow verifier
 * diffs public projections), so manifests are generated, never hand-written.
 * This is the committed replacement for the throwaway generator the 2026-08-15
 * drop-in release was produced with.
 *
 * Usage:
 *   npm run ops:generation-model-catalog:emit -- \
 *     --models qwen3,qwen3-pro \
 *     --revision image-dropins-20260815 \
 *     --based-on wan-provider-id-fix-20260725 \
 *     --change-note "Add qwen models." \
 *     [--expected-exclude seedance-2-5,kling-o3] \
 *     [--acceptance-quotes path/to/quotes.json] \
 *     [--out config/generation-model-catalog/releases/<name>.json]
 *
 * Without --out the manifest prints to stdout. --expected-exclude removes ids
 * from expectedModelIds for staged rollouts where a later release adds them.
 */
import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { buildGenerationModelCatalog } from '../src/lib/generation-model-catalog';
import { buildCodeGenerationModelOperations } from '../src/lib/generation-model-runtime';
import { validateCatalogManifest } from './generation-model-catalog';

interface CliArgs {
  models: string[];
  revision: string;
  basedOn: string;
  changeNote: string;
  expectedExclude: string[];
  acceptanceQuotesPath: string | null;
  out: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}.`);
    }
    flags.set(arg.slice(2), value);
    index += 1;
  }
  const required = (name: string): string => {
    const value = flags.get(name);
    if (!value) throw new Error(`--${name} is required.`);
    return value;
  };
  const list = (value: string | undefined): string[] => (
    value ? value.split(',').map((item) => item.trim()).filter(Boolean) : []
  );
  return {
    models: list(required('models')),
    revision: required('revision'),
    basedOn: required('based-on'),
    changeNote: required('change-note'),
    expectedExclude: list(flags.get('expected-exclude')),
    acceptanceQuotesPath: flags.get('acceptance-quotes') ?? null,
    out: flags.get('out') ?? null,
  };
}

/**
 * The manifest validator rejects an empty `passthroughSettingKeys` array, but the
 * code build emits exactly that for image models. Absent and empty are treated
 * identically by the runtime, so the key is dropped when empty.
 */
function stripEmptyPassthrough(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).filter(([key, value]) => !(
      key === 'passthroughSettingKeys' && Array.isArray(value) && value.length === 0
    )),
  );
}

// No hardcoded copy: the defaults come from the catalog the entries are built from, so
// changing DEFAULT_MODEL_IDS can never leave releases publishing a stale default.

export interface EmitManifestOptions {
  models: string[];
  revision: string;
  basedOn: string;
  changeNote: string;
  /**
   * The complete model inventory of the release this one is BASED ON — it is a guard
   * asserting "the release I am cloning contains exactly these", not the inventory that
   * results. A release that adds models therefore lists the ids WITHOUT them; getting
   * this backwards fails materialization with "active model inventory does not match".
   */
  expectedModelIds?: string[];
  /** Model ids this release introduces; absent from expectedModelIds by definition. */
  addsModelIds?: string[];
  expectedExclude?: string[];
  acceptanceQuotes?: unknown[] | null;
}

export function emitManifest(options: EmitManifestOptions) {
  const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
  const operations = new Map(
    buildCodeGenerationModelOperations().map((entry) => [entry.modelId, entry]),
  );

  const entries = options.models.map((modelId) => {
    const descriptor = catalog.models.find((model) => model.id === modelId);
    const operation = operations.get(modelId);
    if (!descriptor || !operation) {
      throw new Error(`Model ${modelId} is not in the code catalog.`);
    }
    return {
      modelId,
      kind: operation.kind,
      // Existing releases stamp schemaVersion onto each descriptor; mirror that
      // or the shadow projection diff flags every entry.
      publicDescriptor: { schemaVersion: 2, ...(descriptor as unknown as Record<string, unknown>) },
      webEnabled: true,
      mobileEnabled: true,
      adapterKey: operation.adapterKey,
      adapterConfig: operation.adapterConfig,
      providerModelMap: operation.providerModelMap,
      pricingStrategy: operation.pricingStrategy,
      pricingConfig: operation.pricingConfig,
      validationStrategy: operation.validationStrategy,
      validationConfig: stripEmptyPassthrough(operation.validationConfig as Record<string, unknown>),
      verificationConfig: operation.verificationConfig,
    };
  });

  const expectedExclude = options.expectedExclude ?? [];
  const expectedModelIds = options.expectedModelIds
    ? [...options.expectedModelIds].sort()
    : catalog.models
        .map((model) => model.id)
        .filter((id) => !expectedExclude.includes(id))
        .sort();

  const defaults = { web: { ...catalog.defaults }, mobile: { ...catalog.defaults } };

  const manifest = {
    manifestVersion: 1,
    mode: 'clone-active',
    release: {
      schemaVersion: 2,
      revision: options.revision,
      basedOnRevision: options.basedOn,
      changeNote: options.changeNote,
      createdBy: 'catalog-operations',
    },
    upgrade: { legacyDescriptorsToV2: true },
    expectedModelIds,
    ...(options.addsModelIds?.length ? { addsModelIds: [...options.addsModelIds].sort() } : {}),
    defaults,
    entries,
    ...(options.acceptanceQuotes?.length ? { acceptanceQuotes: options.acceptanceQuotes } : {}),
  };

  // Self-check against the same validator the release CLI runs, so a manifest that would
  // be rejected at stage time fails here instead of sitting in the repo looking fine.
  validateCatalogManifest(manifest);
  return manifest;
}

export function serializeManifest(manifest: ReturnType<typeof emitManifest>): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const acceptanceQuotes = args.acceptanceQuotesPath
    ? JSON.parse(readFileSync(path.resolve(args.acceptanceQuotesPath), 'utf8')) as unknown[]
    : null;
  const manifest = emitManifest({
    models: args.models,
    revision: args.revision,
    basedOn: args.basedOn,
    changeNote: args.changeNote,
    expectedExclude: args.expectedExclude,
    acceptanceQuotes,
  });
  const serialized = serializeManifest(manifest);
  if (args.out) {
    await writeFile(path.resolve(args.out), serialized);
    console.log(`Wrote ${args.out} (${manifest.entries.length} entries, ${manifest.expectedModelIds.length} expected ids).`);
  } else {
    process.stdout.write(serialized);
  }
}

if (process.argv[1]?.includes('emit-generation-model-catalog-entries')) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
