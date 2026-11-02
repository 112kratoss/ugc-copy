import { describe, expect, it } from 'vitest';
import { createDefaultCreationDraft } from '../lib/media-creation-view-model';
import { remixSourceMediaUrl } from '../lib/remix-draft-recovery';
import {
  holdsRemixOriginal,
  remixOriginalMedia,
  remixOriginalOf,
  remixOriginalPlace,
  replacedRemixOriginal,
  storedRemixOriginal,
  withRenewedRemixOriginal,
  type RemixOriginal,
} from '../lib/remix-original-reference';
import type { RemixSourceBundle } from '../lib/types';

const SHOWCASE = 'https://project.supabase.co/storage/v1/object/public/showcase_media/showcase/gen-9/result.mp4';

function bundle(result: RemixSourceBundle['result']): RemixSourceBundle {
  return {
    generation: { id: 'gen-9', title: 'Night ride', prompt: 'A neon ride', category: 'video', model: 'kling-3.0-video' },
    result,
    inputs: {},
    workflowSettings: {},
    restoreIssues: [],
  } as RemixSourceBundle;
}

const clip: RemixOriginal = { generationId: 'gen-9', mediaType: 'video', url: SHOWCASE };
const picture: RemixOriginal = { generationId: 'gen-4', mediaType: 'image', url: 'https://project.supabase.co/storage/v1/object/public/showcase_media/showcase/gen-4/look.webp' };

// "Use as reference" on a remix, as the web's creators offer it (owner, 2026-11-02).
describe("a remix's original as a reference", () => {
  it('is offered from the result the remix source hands out, and only with a link', () => {
    expect(remixOriginalOf(bundle({ mediaType: 'video', url: SHOWCASE }))).toEqual(clip);
    // With the length its post measured, where it has one.
    expect(remixOriginalOf(bundle({ mediaType: 'video', url: SHOWCASE, durationSeconds: 6.2 }))).toEqual({ ...clip, durationSeconds: 6.2 });
    expect(remixOriginalOf(bundle({ mediaType: 'video', url: SHOWCASE, durationSeconds: 0 }))).toEqual(clip);
    expect(remixOriginalOf(bundle({ mediaType: 'video', url: null }))).toBeNull();
    expect(remixOriginalOf(bundle({ mediaType: 'image', url: '  ' }))).toBeNull();
    expect(remixOriginalOf(bundle(null))).toBeNull();
  });

  it('goes among a picture run’s references, a video run’s clips, or as a motion run’s clip', () => {
    expect(remixOriginalPlace('image', picture)).toBe('references');
    expect(remixOriginalPlace('video', clip)).toBe('referenceVideos');
    expect(remixOriginalPlace('motion', clip)).toBe('motionClip');
    // A picture goes nowhere else, and a clip never among pictures.
    expect(remixOriginalPlace('video', picture)).toBeNull();
    expect(remixOriginalPlace('motion', picture)).toBeNull();
    expect(remixOriginalPlace('image', clip)).toBeNull();
  });

  it('is kept by its link and its creation under one id, never a storage path the app would take for an upload', () => {
    expect(remixOriginalMedia(clip, 7.5)).toMatchObject({
      id: 'remix-result:gen-9',
      kind: 'video',
      url: SHOWCASE,
      storagePath: null,
      fileName: 'original-result.mp4',
      displayName: 'Original result',
      sourceGenerationId: 'gen-9',
      durationSeconds: 7.5,
    });
    // A picture answers to an @mention, as every picked one does.
    expect(remixOriginalMedia(picture)).toMatchObject({ id: 'remix-result:gen-4', kind: 'image', handle: '@original_result', fileName: 'original-result.png' });
    // A clip carries the length it is given, and none without one.
    expect(remixOriginalMedia({ ...clip, durationSeconds: 6.2 }, 6.2).durationSeconds).toBe(6.2);
    expect(remixOriginalMedia(clip).durationSeconds).toBeNull();
  });

  it('is found wherever it went, and only by its own id', () => {
    const image = createDefaultCreationDraft('image');
    const video = createDefaultCreationDraft('video');
    const motion = createDefaultCreationDraft('motion');
    expect(holdsRemixOriginal(image, picture)).toBe(false);
    expect(holdsRemixOriginal({ ...image, references: [remixOriginalMedia(picture)] }, picture)).toBe(true);
    expect(holdsRemixOriginal({ ...video, referenceVideos: [remixOriginalMedia(clip)] }, clip)).toBe(true);
    expect(holdsRemixOriginal({ ...motion, referenceVideo: remixOriginalMedia(clip) }, clip)).toBe(true);
    // Another remix's original is not this one.
    expect(holdsRemixOriginal({ ...motion, referenceVideo: remixOriginalMedia({ ...clip, generationId: 'gen-3' }) }, clip)).toBe(false);
  });

  // Replace keeps a tile's id, name and @handle, and puts the creator's own upload in its place.
  it('is no longer the original once Replace puts the creator’s file under its id, and its link is never renewed onto that file', () => {
    const upload = 'https://project.supabase.co/storage/v1/object/sign/uploads/user-1/mine.mp4?token=t';
    const replaced = { ...remixOriginalMedia(clip), url: upload, storagePath: 'uploads/user-1/mine.mp4', sourceGenerationId: null };
    const motion = { ...createDefaultCreationDraft('motion'), referenceVideo: replaced };
    expect(holdsRemixOriginal(motion, clip)).toBe(false);
    expect(replacedRemixOriginal(motion, clip)).toBe(true);
    expect(withRenewedRemixOriginal(motion, { ...clip, url: 'https://project.supabase.co/fresh.mp4' })).toBe(motion);
    expect(remixSourceMediaUrl(bundle({ mediaType: 'video', url: 'https://project.supabase.co/fresh.mp4' }), replaced)).toBeNull();
    // The original itself is not "replaced".
    expect(replacedRemixOriginal({ ...motion, referenceVideo: remixOriginalMedia(clip) }, clip)).toBe(false);
  });

  // Kept with a remix session so a resume offers it; a session from before says nothing, which is not "none".
  it('is read back from a saved session as kept, none, or not said', () => {
    expect(storedRemixOriginal(clip)).toEqual(clip);
    expect(storedRemixOriginal({ ...clip, durationSeconds: 6.2 })).toEqual({ ...clip, durationSeconds: 6.2 });
    expect(storedRemixOriginal({ ...clip, durationSeconds: 'long' })).toEqual(clip);
    expect(storedRemixOriginal(null)).toBeNull();
    expect(storedRemixOriginal(undefined)).toBeUndefined();
    expect(storedRemixOriginal({ ...clip, mediaType: 'audio' })).toBeUndefined();
    expect(storedRemixOriginal({ generationId: 'gen-9', mediaType: 'video', url: '' })).toBeUndefined();
  });

  // A private output's link lasts an hour, and a saved remix keeps it (audit A6).
  it('takes a fresh link from its source read again', () => {
    const fresh = 'https://project.supabase.co/storage/v1/object/sign/generated_videos/owner/result.mp4?token=fresh';
    const saved = remixOriginalMedia({ ...clip, url: 'https://project.supabase.co/storage/v1/object/sign/generated_videos/owner/result.mp4?token=old' });
    expect(remixSourceMediaUrl(bundle({ mediaType: 'video', url: fresh }), saved)).toBe(fresh);
    expect(remixSourceMediaUrl(bundle(null), saved)).toBeNull();

    const motion = { ...createDefaultCreationDraft('motion'), referenceVideo: saved };
    expect(withRenewedRemixOriginal(motion, { ...clip, url: fresh }).referenceVideo?.url).toBe(fresh);
    expect(withRenewedRemixOriginal(motion, null)).toBe(motion);
    const without = createDefaultCreationDraft('motion');
    expect(withRenewedRemixOriginal(without, { ...clip, url: fresh })).toBe(without);
  });
});
