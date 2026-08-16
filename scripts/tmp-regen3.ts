/** Regenerate manifests with base-release expectedModelIds. Delete after running. */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { emitManifest, serializeManifest } from './emit-generation-model-catalog-entries';

const dir = path.resolve('config/generation-model-catalog/releases');
const read = (name: string) => JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as {
  release: { changeNote: string };
  expectedModelIds: string[];
  acceptanceQuotes?: unknown[];
};

// The live inventory: the active release (wan fix) added no models, so its own
// expectedModelIds is also its resulting inventory.
const active = read('2026-07-25-wan-provider-id-fix.json').expectedModelIds;

const IMAGE_ADDS = ['grok-imagine-image-2', 'qwen3', 'qwen3-pro', 'ideogram-character'];
const VIDEO_ADDS = ['seedance-2-5', 'kling-o3', 'minimax-h3'];

const afterImage = [...active, ...IMAGE_ADDS];
const afterVideo = [...afterImage, ...VIDEO_ADDS];

const steps = [
  {
    file: '2026-08-15-image-dropins.json',
    models: IMAGE_ADDS,
    revision: 'image-dropins-20260815',
    basedOn: 'wan-provider-id-fix-20260725',
    expected: active,
  },
  {
    file: '2026-08-15-video-dropins.json',
    models: VIDEO_ADDS,
    revision: 'video-dropins-20260815',
    basedOn: 'image-dropins-20260815',
    expected: afterImage,
  },
  {
    file: '2026-08-16-kie-task-image-adapters.json',
    models: [
      'nano-banana-2-lite', 'nano-banana-2', 'nano-banana-pro', 'gpt-image-2',
      'flux-2-pro', 'z-image', 'imagen-4-fast', 'imagen-4', 'imagen-4-ultra',
    ],
    revision: 'kie-task-image-adapters-20260816',
    basedOn: 'video-dropins-20260815',
    expected: afterVideo,
  },
  {
    file: '2026-08-16-capability-reachability.json',
    models: [
      'kling-3.0-video', 'seedance-2', 'seedance-2-fast', 'seedance-2-mini',
      'kling-3.0-turbo', 'seedance-1.5-pro', 'wan-2.7', 'happyhorse-1.1',
      'gemini-omni-video', 'hailuo-2.3', 'veo-3.1', 'grok-imagine-video',
    ],
    revision: 'capability-reachability-20260816',
    basedOn: 'kie-task-image-adapters-20260816',
    expected: afterVideo,
  },
];

for (const step of steps) {
  const committed = read(step.file);
  writeFileSync(path.join(dir, step.file), serializeManifest(emitManifest({
    models: step.models,
    revision: step.revision,
    basedOn: step.basedOn,
    changeNote: committed.release.changeNote,
    expectedModelIds: step.expected,
    acceptanceQuotes: committed.acceptanceQuotes ?? [],
  })));
  console.log(`${step.file}: expectedModelIds=${step.expected.length}, entries=${step.models.length}`);
}
