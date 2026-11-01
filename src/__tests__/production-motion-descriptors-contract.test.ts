import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import productionMotion from '../../contracts/production-motion-descriptors-v1.json';

/**
 * The motion descriptors both suites test against were read from production at one release. A
 * release that re-emits either model may publish another shape (Kling 3.0's plain reference slots
 * came from the compatibility release, which no release touched until kling-3-motion-inputs-20261101),
 * and nothing else would tell the two suites they now test a shape production no longer sends.
 */

type Manifest = {
  release: { revision: string; basedOnRevision: string };
  entries: Array<{ modelId: string }>;
};

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

  it('was read at a release no later release re-emits either model after', () => {
    const releases = readReleases();
    const byBase = new Map(releases.map((manifest) => [manifest.release.basedOnRevision, manifest]));
    expect(
      releases.some((manifest) => manifest.release.revision === productionMotion.revision),
      `${productionMotion.revision} is a release in config/generation-model-catalog/releases`,
    ).toBe(true);

    const motionIds = new Set(productionMotion.models.map((model) => model.id));
    const reEmitted: string[] = [];
    for (let next = byBase.get(productionMotion.revision); next; next = byBase.get(next.release.revision)) {
      for (const entry of next.entries) {
        if (motionIds.has(entry.modelId)) reEmitted.push(`${next.release.revision}: ${entry.modelId}`);
      }
    }
    expect(
      reEmitted,
      'a later release re-emits a motion model: read its descriptor from production again into '
        + 'contracts/production-motion-descriptors-v1.json (both suites test against it)',
    ).toEqual([]);
  });
});
