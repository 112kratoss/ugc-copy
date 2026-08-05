import { describe, expect, it } from 'vitest';

import uploadQueueContract from '../../contracts/upload-queue-contract-v1.json';
import { runWeightedUploadQueue } from '@/lib/upload-queue';

/**
 * Replays the shared queue-semantics contract against the WEB implementation.
 * The mobile workspace runs the identical scenarios against its own copy in
 * ugc-mobile/__tests__/upload-queue-contract-fixture.test.ts — the fixture is
 * the single source of truth, so the two deliberate copies cannot drift
 * silently on capacity, video isolation, or failure handling.
 */

type ContractScenario = {
  name: string;
  items: Array<'image' | 'video'>;
  releaseOrder: number[];
  failingIndexes?: number[];
  expectedStartWaves: number[][];
  expectedSuccessIndexes: number[];
  expectedFailureIndexes: number[];
};

const scenarios = uploadQueueContract.scenarios as ContractScenario[];

// The queue schedules through promise chains, not timers, so a bounded burst of
// microtask turns settles every cascading start deterministically.
async function flushMicrotasks() {
  for (let turn = 0; turn < 25; turn += 1) {
    await Promise.resolve();
  }
}

async function replayScenario(scenario: ContractScenario) {
  const gates = scenario.items.map(() => {
    let release!: () => void;
    let fail!: (error: Error) => void;
    const promise = new Promise<string>((resolve, reject) => {
      release = () => resolve('done');
      fail = reject;
    });
    return { promise, release, fail };
  });

  const startWaves: number[][] = [[]];
  const queueResult = runWeightedUploadQueue(
    scenario.items.map((kind, index) => ({ item: index, kind })),
    (_item, index) => {
      startWaves[startWaves.length - 1].push(index);
      return gates[index].promise;
    },
  );
  await flushMicrotasks();

  for (const releaseIndex of scenario.releaseOrder) {
    startWaves.push([]);
    if (scenario.failingIndexes?.includes(releaseIndex)) {
      gates[releaseIndex].fail(new Error(`scenario failure ${releaseIndex}`));
    } else {
      gates[releaseIndex].release();
    }
    await flushMicrotasks();
  }

  const result = await queueResult;
  return { startWaves, result };
}

describe('upload queue shared contract (web implementation)', () => {
  it('pins the semantics constants the scenarios were written against', () => {
    expect(uploadQueueContract.semantics).toEqual({ capacity: 2, weights: { image: 1, video: 2 } });
  });

  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const { startWaves, result } = await replayScenario(scenario);

      expect(startWaves).toEqual(scenario.expectedStartWaves);
      expect(result.successes.map((entry) => entry.index).sort((a, b) => a - b))
        .toEqual(scenario.expectedSuccessIndexes);
      expect(result.failures.map((entry) => entry.index).sort((a, b) => a - b))
        .toEqual(scenario.expectedFailureIndexes);
    });
  }
});
