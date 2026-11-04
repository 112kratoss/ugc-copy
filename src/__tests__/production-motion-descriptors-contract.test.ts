import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { projectGenerationModelDescriptor } from '@/lib/generation-model-catalog';
import { parsePublishedModelDescriptor } from '@/lib/generation-model-descriptor-parser';
import productionMotion from '../../contracts/production-motion-descriptors-v1.json';

/**
 * The motion descriptors both suites test against were read from production at one release. A
 * release that re-emits either model may publish another shape (Kling 3.0's plain reference slots
 * came from the compatibility release, which no release touched until kling-3-motion-inputs-20261101),
 * and nothing else would tell the two suites they now test a shape production no longer sends. A
 * re-emit that serves the same descriptor (kling-3-image-orientation-20261105 moved Kling 3.0's
 * validation rules only) leaves the contract true.
 */

type Manifest = {
  release: { revision: string; basedOnRevision: string };
  entries: Array<{
    modelId: string;
    webEnabled: boolean;
    mobileEnabled: boolean;
    publicDescriptor: Record<string, unknown>;
  }>;
};

/** An entry's descriptor as the server serves it, in the contract's shape (schema 3, no `inputs`). */
function served(entry: Manifest['entries'][number]): Record<string, unknown> {
  const descriptor = projectGenerationModelDescriptor(parsePublishedModelDescriptor(
    entry.publicDescriptor,
    entry.modelId,
    2,
    { web: entry.webEnabled, mobile: entry.mobileEnabled },
  ), 3) as unknown as Record<string, unknown>;
  delete descriptor.inputs;
  return descriptor;
}

const RELEASES = path.resolve(process.cwd(), 'config/generation-model-catalog/releases');

function readReleases(): Manifest[] {
  return fs.readdirSync(RELEASES)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(RELEASES, name), 'utf8')) as Manifest);
}

describe('the production motion descriptors contract', () => {
  it('holds both models in the motion-inputs slots, and Kling 3.0’s plain reference slots for a rollback', () => {
    const slotsOf = (models: typeof productionMotion.models, id: string) => models
      .find((model) => model.id === id)?.inputModes.flatMap((mode) => mode.slots.map((slot) => slot.key));

    expect(productionMotion.models.map((model) => model.id)).toEqual(['kling-2.6', 'kling-3.0']);
    expect(slotsOf(productionMotion.models, 'kling-2.6')).toEqual(['characterImage', 'referenceVideo']);
    expect(slotsOf(productionMotion.models, 'kling-3.0')).toEqual(['characterImage', 'referenceVideo']);
    // What production serves again if the release that re-emitted Kling 3.0 is rolled back.
    expect(productionMotion.rollback.models.map((model) => model.id)).toEqual(['kling-3.0']);
    expect(slotsOf(productionMotion.rollback.models, 'kling-3.0')).toEqual(['imageReferences', 'videoReferences']);
    const releases = readReleases();
    expect(releases.find((manifest) => manifest.release.revision === productionMotion.revision)?.release.basedOnRevision)
      .toBe(productionMotion.rollback.revision);
  });

  it('was read at a release no later release serves either model differently after', () => {
    const releases = readReleases();
    const byBase = new Map(releases.map((manifest) => [manifest.release.basedOnRevision, manifest]));
    expect(
      releases.some((manifest) => manifest.release.revision === productionMotion.revision),
      `${productionMotion.revision} is a release in config/generation-model-catalog/releases`,
    ).toBe(true);

    const contractModels = new Map(productionMotion.models.map((model) => [model.id, model as unknown]));
    const reEmitted: string[] = [];
    let unchanged = 0;
    for (let next = byBase.get(productionMotion.revision); next; next = byBase.get(next.release.revision)) {
      for (const entry of next.entries) {
        if (!contractModels.has(entry.modelId)) continue;
        if (JSON.stringify(served(entry)) === JSON.stringify(contractModels.get(entry.modelId))) unchanged += 1;
        else reEmitted.push(`${next.release.revision}: ${entry.modelId}`);
      }
    }
    // The comparison is live: kling-3-image-orientation-20261105 re-emits Kling 3.0 with the same descriptor.
    expect(unchanged).toBeGreaterThan(0);
    expect(
      reEmitted,
      'a later release re-emits a motion model: read its descriptor from production again into '
        + 'contracts/production-motion-descriptors-v1.json (both suites test against it)',
    ).toEqual([]);
  });
});
