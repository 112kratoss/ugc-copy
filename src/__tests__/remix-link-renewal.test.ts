import { describe, expect, it } from 'vitest';

import { renewedRemixLink } from '@/lib/remix-link-renewal';
import type { RemixSourceBundle } from '@/lib/remix-source';
import { SIGNED_LINK_SECONDS, signedStorageLink } from './fixtures/signed-storage-links';

const SIGNED_AT = Date.UTC(2026, 10, 2, 9, 0, 0);
const HOUR_MS = SIGNED_LINK_SECONDS * 1000;
const PUBLIC_RESULT = 'https://project.supabase.co/storage/v1/object/public/showcase_media/showcase/gen-1/result.mp4';

/** A remix's answer as the remix source signs it at `signedAt`. */
function answerSignedAt(signedAt: number): RemixSourceBundle {
  return {
    generation: { id: 'gen-1', title: 'Rooftop', prompt: 'Dance', category: 'video', model: 'kling-2.6' },
    result: { mediaType: 'video', url: signedStorageLink('generated_videos/user-1/result.mp4', signedAt) },
    inputs: {
      motion: {
        characterImage: { kind: 'image', label: 'Character image', storagePath: 'generation_inputs/user-1/gen-1/00.png', url: signedStorageLink('generation_inputs/user-1/gen-1/00.png', signedAt) },
        referenceVideo: { kind: 'video', label: 'Clip', storagePath: 'generation_inputs/user-1/gen-1/01.mp4', url: signedStorageLink('generation_inputs/user-1/gen-1/01.mp4', signedAt) },
      },
    },
    inputMedia: [{
      id: 'row-1', generationId: 'gen-1', mediaType: 'image', role: 'character_image', label: 'Character image',
      url: signedStorageLink('generation_inputs/user-1/gen-1/00.png', signedAt),
      storagePath: 'generation_inputs/user-1/gen-1/00.png', sourceGenerationId: null, sortOrder: 0,
      // What the run read, signed when it ran: never a link to renew with.
      metadata: { sourceUrl: signedStorageLink('uploads/user-1/hero.png', signedAt - 30 * HOUR_MS) },
    }],
    // The links the run read, long lapsed: never a link to renew with.
    workflowSettings: {
      referenceVideoUrls: [signedStorageLink('uploads/user-1/old-clip.mp4', signedAt - 30 * HOUR_MS)],
      klingVideoElements: [{ handle: '@move', url: signedStorageLink('uploads/user-1/old-clip.mp4', signedAt - 30 * HOUR_MS) }],
    },
    restoreIssues: [],
  };
}

describe('a remix link renewed', () => {
  it('finds the file a lapsed link opens by its bucket and path, an upload’s too, and no other', () => {
    // A run kept before its inputs were: its picture comes back as the upload it was made from.
    const legacy = (signedAt: number): RemixSourceBundle => ({
      ...answerSignedAt(signedAt),
      inputs: {
        motion: {
          characterImage: { kind: 'image', label: 'Character image', storagePath: 'uploads/user-1/hero-still.png', url: signedStorageLink('uploads/user-1/hero-still.png', signedAt) },
          referenceVideo: { kind: 'video', label: 'Clip', storagePath: 'generation_inputs/user-1/gen-1/01.mp4', url: signedStorageLink('generation_inputs/user-1/gen-1/01.mp4', signedAt) },
        },
      },
    });
    const lapsed = legacy(SIGNED_AT);
    const fresh = legacy(SIGNED_AT + 2 * HOUR_MS);
    expect(fresh.inputs.motion!.characterImage!.url).not.toBe(lapsed.inputs.motion!.characterImage!.url);

    expect(renewedRemixLink(lapsed.inputs.motion!.characterImage!.url!, fresh)).toBe(fresh.inputs.motion!.characterImage!.url);
    expect(renewedRemixLink(lapsed.inputs.motion!.referenceVideo!.url!, fresh)).toBe(fresh.inputs.motion!.referenceVideo!.url);
    expect(renewedRemixLink(signedStorageLink('generation_inputs/user-1/gen-1/02.mp4', SIGNED_AT), fresh)).toBeNull();
    expect(renewedRemixLink('blob:https://magicbooklet.com/5d1c', fresh)).toBeNull();
  });

  it('takes a lapsed link’s file from a fresh answer, never from what the answer records of the run', () => {
    const lapsed = answerSignedAt(SIGNED_AT);
    const fresh = answerSignedAt(SIGNED_AT + 2 * HOUR_MS);

    expect(renewedRemixLink(lapsed.result!.url!, fresh)).toBe(fresh.result!.url);
    expect(renewedRemixLink(lapsed.inputs.motion!.referenceVideo!.url!, fresh)).toBe(fresh.inputs.motion!.referenceVideo!.url);
    expect(renewedRemixLink(lapsed.inputs.motion!.characterImage!.url!, fresh)).toBe(fresh.inputs.motion!.characterImage!.url);
    // A file the answer hands out under no link of its own: the settings' and the rows' records
    // name it, but only by the links the run read.
    expect(renewedRemixLink(signedStorageLink('uploads/user-1/old-clip.mp4', SIGNED_AT), fresh)).toBeNull();
    expect(renewedRemixLink(signedStorageLink('uploads/user-1/hero.png', SIGNED_AT), fresh)).toBeNull();
  });

  it('takes the answer’s own result for a link to the original, posted since or not', () => {
    const lapsed = answerSignedAt(SIGNED_AT);
    const posted = { ...answerSignedAt(SIGNED_AT + 2 * HOUR_MS), result: { mediaType: 'video' as const, url: PUBLIC_RESULT } };
    // The original as the form holds it: its link from the remix's first read.
    const original = lapsed.result!.url!;

    // Posted since: the result is its post's copy, another file than the one the old link opened.
    expect(renewedRemixLink(lapsed.result!.url!, posted)).toBeNull();
    expect(renewedRemixLink(lapsed.result!.url!, posted, original)).toBe(PUBLIC_RESULT);
    // Any link to the original's file is the original's: a reference tile's, renewed when it was added.
    const tileLink = signedStorageLink('generated_videos/user-1/result.mp4', SIGNED_AT + HOUR_MS / 2);
    expect(renewedRemixLink(tileLink, posted, original)).toBe(PUBLIC_RESULT);
    expect(renewedRemixLink(lapsed.result!.url!, { ...posted, result: null }, original)).toBeNull();
    // Any other file is renewed as itself.
    expect(renewedRemixLink(lapsed.inputs.motion!.referenceVideo!.url!, posted, original)).toBe(posted.inputs.motion!.referenceVideo!.url);
  });
});
