import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildGenerationModelCatalog } from '@/lib/generation-model-catalog';
import { emitManifest } from '../../scripts/ops/emit-generation-model-catalog-entries';
import {
  runGenerationModelCatalogCli,
  validateCatalogManifest,
  type ActiveCatalogSnapshot,
  type CatalogManifestEntry,
  type CatalogReleaseManifest,
} from '../../scripts/ops/generation-model-catalog';
import {
  CATALOG_DRIFT_EXCEPTIONS,
  buildCatalogDrift,
  expectedProductionEntry,
} from '../../scripts/ops/generation-model-catalog-drift';

/**
 * Production's catalog is the chain of releases in config/generation-model-catalog/releases/:
 * each release clones the one before it and replaces only the models it carries, so the entry
 * production serves for a model is its newest committed entry. Each release's manifest test pins
 * only the ids that release carries, which is how twelve entries drifted from the code build
 * unseen until 2026-11-01. This holds every model's newest committed entry to the entry the
 * emitter builds from code today: a code change that would publish differently fails here until
 * a release re-emits the model, and a model held apart on purpose needs an exception with its
 * reason (CATALOG_DRIFT_EXCEPTIONS, which the CLI's `drift` command reads too).
 */

const supabase = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...await importOriginal<typeof import('@supabase/supabase-js')>(),
  createClient: () => supabase.client,
}));

type Release = { file: string; manifest: CatalogReleaseManifest };

const RELEASES = path.resolve(process.cwd(), 'config/generation-model-catalog/releases');

const releases: Release[] = fs.readdirSync(RELEASES)
  .filter((file) => file.endsWith('.json'))
  .map((file) => ({
    file,
    manifest: JSON.parse(fs.readFileSync(path.join(RELEASES, file), 'utf8')) as CatalogReleaseManifest,
  }));

/** The release the control-plane migration seeded, which the first committed release is based on. */
const seed = (() => {
  const migration = fs.readFileSync(path.resolve(
    process.cwd(),
    'supabase/migrations/20260719035947_generation_model_catalog_control_plane.sql',
  ), 'utf8');
  const encoded = migration.match(/decode\('([^']+)', 'base64'\)/)?.[1];
  if (!encoded) throw new Error('The catalog seed payload is missing.');
  const value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
    revision: string;
    entries: Array<{ model_id: string }>;
  };
  return { revision: value.revision, modelIds: value.entries.map((entry) => entry.model_id).sort() };
})();

/** The releases in the order they publish: each the one release based on the one before. */
const chain: Release[] = [];
for (let base = seed.revision; chain.length < releases.length;) {
  const next = releases.filter((release) => release.manifest.release.basedOnRevision === base);
  if (next.length !== 1) break;
  chain.push(next[0]);
  base = next[0].manifest.release.revision;
}
const head = chain.at(-1)!.manifest;

/** The models the newest release leaves production with. */
const inventory = [...head.expectedModelIds, ...(head.addsModelIds ?? [])].sort();

const newest = new Map<string, { entry: CatalogManifestEntry; file: string }>();
for (const { file, manifest } of chain) {
  for (const entry of manifest.entries) newest.set(entry.modelId, { entry, file });
}

const code = validateCatalogManifest(emitManifest({
  models: inventory,
  revision: 'code-build-drift-test',
  basedOn: head.release.revision,
  changeNote: 'Test only.',
}));

function codeEntry(modelId: string): CatalogManifestEntry {
  const entry = code.entries.find((candidate) => candidate.modelId === modelId);
  if (!entry) throw new Error(`The code build has no entry for ${modelId}.`);
  return entry;
}

/** The catalog the committed releases leave production with, as `loadActiveCatalog` reads it. */
function committedCatalog(): ActiveCatalogSnapshot {
  return structuredClone({
    releaseId: '00000000-0000-4000-8000-000000000202',
    schemaVersion: 2,
    revision: head.release.revision,
    defaults: head.defaults,
    entries: inventory.map((modelId) => newest.get(modelId)!.entry),
  });
}

describe('the committed release chain', () => {
  it('is one line of releases from the seeded revision, each based on the one before it', () => {
    const revisions = releases.map((release) => release.manifest.release.revision);
    expect(new Set(revisions).size).toBe(releases.length);
    expect(releases.filter((release) => (
      ![seed.revision, ...revisions].includes(release.manifest.release.basedOnRevision)
    )).map((release) => release.file)).toEqual([]);
    const sharedBases = [...new Set(releases.map((release) => release.manifest.release.basedOnRevision))]
      .map((base) => releases.filter((release) => release.manifest.release.basedOnRevision === base))
      .filter((based) => based.length > 1)
      .map((based) => based.map((release) => release.file));
    expect(sharedBases).toEqual([]);
    expect(releases.filter((release) => !chain.includes(release)).map((release) => release.file)).toEqual([]);
  });

  it('clones in each release exactly the models the release before it left', () => {
    let models = seed.modelIds;
    for (const { file, manifest } of chain) {
      expect([...manifest.expectedModelIds].sort(), file).toEqual(models);
      models = [...models, ...(manifest.addsModelIds ?? [])].sort();
    }
    expect(models).toEqual(inventory);
  });

  it('carries the models the code build has, no more and no fewer', () => {
    expect(buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2, includeUnavailable: true })
      .models.map((model) => model.id).sort()).toEqual(inventory);
  });

  it('has a committed entry for every model production carries', () => {
    // The seed's models were all re-emitted by 2026-09-04, and a release adds a model only
    // with its entry, so no model is left on an entry no manifest records.
    expect(inventory.filter((modelId) => !newest.has(modelId))).toEqual([]);
  });

  it('publishes the code build\'s default models', () => {
    expect(head.defaults).toEqual(code.defaults);
  });

  it.each(inventory)('%s: the newest committed entry is the code build', (modelId) => {
    const { entry, file } = newest.get(modelId)!;
    const committed = entry as unknown as Record<string, unknown>;
    const expected = expectedProductionEntry(codeEntry(modelId)) as unknown as Record<string, unknown>;
    for (const field of new Set([...Object.keys(committed), ...Object.keys(expected)])) {
      expect(committed[field], `${modelId} ${field} (newest in ${file})`).toEqual(expected[field]);
    }
  });

  it.each(Object.entries(CATALOG_DRIFT_EXCEPTIONS))('%s: its exception is still needed', (modelId, exception) => {
    expect(inventory).toContain(modelId);
    expect(exception.reason.length).toBeGreaterThan(40);
    expect(newest.get(modelId)!.entry).not.toEqual(codeEntry(modelId));
  });
});

/** A read-only stand-in for the service-role client over a catalog: selects only. */
function catalogClient(active: ActiveCatalogSnapshot) {
  const tables: string[] = [];
  const client = {
    from(table: string) {
      tables.push(table);
      if (table === 'generation_model_catalog_releases') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: active.releaseId,
                  schema_version: active.schemaVersion,
                  revision: active.revision,
                  defaults: active.defaults,
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table !== 'generation_model_catalog_entries') throw new Error(`drift read ${table}`);
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({
              data: active.entries.map((entry) => ({
                model_id: entry.modelId,
                public_descriptor: entry.publicDescriptor,
                web_enabled: entry.webEnabled,
                mobile_enabled: entry.mobileEnabled,
                adapter_key: entry.adapterKey,
                adapter_config: entry.adapterConfig,
                provider_model_map: entry.providerModelMap,
                pricing_strategy: entry.pricingStrategy,
                pricing_config: entry.pricingConfig,
                validation_strategy: entry.validationStrategy,
                validation_config: entry.validationConfig,
                verification_config: entry.verificationConfig,
                generation_models: { kind: entry.kind },
              })),
              error: null,
            }),
          }),
        }),
      };
    },
    rpc() {
      throw new Error('drift called an RPC');
    },
  };
  return { client, tables };
}

async function drift(active: ActiveCatalogSnapshot) {
  const { client, tables } = catalogClient(active);
  supabase.client = client;
  const messages: string[] = [];
  const run = runGenerationModelCatalogCli(
    ['drift', '--json'],
    { NODE_ENV: 'test', SUPABASE_URL: 'https://catalog.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test' },
    { log: (message) => messages.push(message) },
  );
  const failure = await run.then(() => null, (error: unknown) => error);
  return { failure, report: JSON.parse(messages.join('\n')) as Record<string, unknown>, tables };
}

function withEntry(
  active: ActiveCatalogSnapshot,
  modelId: string,
  change: (entry: CatalogManifestEntry) => CatalogManifestEntry,
): ActiveCatalogSnapshot {
  return {
    ...active,
    entries: active.entries.map((entry) => (entry.modelId === modelId ? change(entry) : entry)),
  };
}

const EXCEPTED = Object.keys(CATALOG_DRIFT_EXCEPTIONS).sort();

describe('the drift command', () => {
  it('reports only the exceptions on the catalog the releases publish, reading and nothing else', async () => {
    const { failure, report, tables } = await drift(committedCatalog());

    expect(failure).toBeNull();
    expect(tables).toEqual(['generation_model_catalog_releases', 'generation_model_catalog_entries']);
    expect(report).toEqual({
      operation: 'drift',
      status: 'clean',
      activeRevision: head.release.revision,
      models: inventory.length,
      changed: [],
      notInCode: [],
      notInRelease: [],
      defaultsDiffer: false,
      excepted: EXCEPTED.map((modelId) => ({
        modelId,
        parts: ['publicDescriptor', 'availability'],
        reason: CATALOG_DRIFT_EXCEPTIONS[modelId].reason,
      })),
      staleExceptions: [],
    });
    expect(buildCatalogDrift(committedCatalog())).toEqual({ ...report, operation: undefined });
  });

  it('fails on a moved price and names the model and part, never the price or the provider', async () => {
    const active = withEntry(committedCatalog(), 'seedance-2-mini', (entry) => ({
      ...entry,
      pricingConfig: { ...entry.pricingConfig, probeRate: 918273 },
    }));
    const { failure, report } = await drift(active);

    expect(failure).toEqual(new Error(
      'The active catalog release differs from the code build outside the drift exceptions.',
    ));
    expect(report.status).toBe('drift');
    expect(report.changed).toEqual([{ modelId: 'seedance-2-mini', parts: ['pricing'] }]);
    const printed = JSON.stringify(report);
    expect(printed).not.toContain('918273');
    expect(printed).not.toContain('service-role-test');
    for (const entry of active.entries) {
      for (const providerModel of Object.values(entry.providerModelMap)) {
        expect(printed).not.toContain(`"${providerModel}"`);
      }
    }
  });

  it('holds an excepted model to its exception in every other field', async () => {
    const { failure, report } = await drift(withEntry(committedCatalog(), 'imagen-4', (entry) => ({
      ...entry,
      validationStrategy: 'image-v1',
    })));

    expect(failure).not.toBeNull();
    expect(report.changed).toEqual([{ modelId: 'imagen-4', parts: ['validation'] }]);
    expect((report.excepted as Array<{ modelId: string }>).map((item) => item.modelId))
      .toEqual(EXCEPTED.filter((modelId) => modelId !== 'imagen-4'));
  });

  // A release that re-emits an excepted model from code puts it back where the code offers it:
  // Imagen offered again, its runs failing at the provider. That is drift, never a stale exception
  // (2026-11-22 review).
  it('fails when a release puts an excepted model back to the code build\'s entry', async () => {
    const { failure, report } = await drift(withEntry(committedCatalog(), 'imagen-4', () => codeEntry('imagen-4')));

    expect(failure).not.toBeNull();
    expect(report).toMatchObject({
      status: 'drift',
      changed: [{ modelId: 'imagen-4', parts: ['publicDescriptor', 'availability'] }],
      staleExceptions: [],
    });
    expect((report.excepted as Array<{ modelId: string }>).map((item) => item.modelId))
      .toEqual(EXCEPTED.filter((modelId) => modelId !== 'imagen-4'));
  });

  it('calls an exception stale once the code build itself holds the entry it describes', async () => {
    // seedance-1.5-pro is retired in code (RETIRED_MODEL_IDS), so the code build offers it nowhere,
    // which is all an exception of { web: false, mobile: false } would say.
    const exceptions = CATALOG_DRIFT_EXCEPTIONS as Record<string, (typeof CATALOG_DRIFT_EXCEPTIONS)[string]>;
    expect(codeEntry('seedance-1.5-pro')).toMatchObject({ webEnabled: false, mobileEnabled: false });
    exceptions['seedance-1.5-pro'] = {
      offered: { web: false, mobile: false },
      reason: 'A stand-in exception for a model the code build already offers nowhere (retired in code).',
    };
    try {
      const { failure, report } = await drift(committedCatalog());

      expect(failure).toBeNull();
      expect(report).toMatchObject({ status: 'clean', changed: [], staleExceptions: ['seedance-1.5-pro'] });
    } finally {
      delete exceptions['seedance-1.5-pro'];
    }
  });

  it('fails on the provider check\'s settings, which the release diff does not compare, naming no value', async () => {
    const { failure, report } = await drift(withEntry(committedCatalog(), 'nano-banana-2', (entry) => ({
      ...entry,
      verificationConfig: { ...entry.verificationConfig, driftProbe: 'value-that-must-not-print' },
    })));

    expect(failure).not.toBeNull();
    expect(report).toMatchObject({ status: 'drift', changed: [{ modelId: 'nano-banana-2', parts: ['verification'] }] });
    expect(JSON.stringify(report)).not.toContain('value-that-must-not-print');
  });

  it('fails on models one side does not carry and on other default models', async () => {
    const committed = committedCatalog();
    const nanoBanana = committed.entries.find((entry) => entry.modelId === 'nano-banana-2')!;
    const { failure, report } = await drift({
      ...committed,
      defaults: { ...committed.defaults, mobile: { ...committed.defaults.mobile, image: 'seedream-5-lite' } },
      entries: [
        ...committed.entries.filter((entry) => entry.modelId !== 'vidu-q4'),
        {
          ...nanoBanana,
          modelId: 'nano-banana-retired',
          publicDescriptor: { ...nanoBanana.publicDescriptor, id: 'nano-banana-retired' },
        },
      ],
    });

    expect(failure).not.toBeNull();
    expect(report).toMatchObject({
      status: 'drift',
      changed: [],
      notInCode: ['nano-banana-retired'],
      notInRelease: ['vidu-q4'],
      defaultsDiffer: true,
    });
  });
});
