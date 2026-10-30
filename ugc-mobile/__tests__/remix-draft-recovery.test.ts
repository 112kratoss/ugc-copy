import { describe, expect, it } from 'vitest';
import { applyCatalogModelDefaults } from '../lib/generation-model-draft';
import { createDefaultCreationDraft, type MediaDraft, type MotionCreationDraft, type VideoCreationDraft } from '../lib/media-creation-view-model';
import { countDraftMedia, needsRemixReferenceRecovery, recoverRemixReferences, remixSourceMediaUrl, replaceDraftMediaUrl } from '../lib/remix-draft-recovery';
import type { RemixSourceBundle } from '../lib/types';
import { klingVideoModel } from './generation-model-catalog-v2-fixtures';
const reference = { id: 'girl', kind: 'image' as const, url: 'https://example.com/girl.jpg', fileName: 'girl.jpg', displayName: 'Girl', handle: '@girl' };
function draft(overrides: Partial<VideoCreationDraft> = {}): VideoCreationDraft {
  return { ...createDefaultCreationDraft('video'), model: 'seedance-2', prompt: 'My edited scene with @girl', ...overrides };
}
describe('saved remix reference recovery', () => {
  it('adds only source images still mentioned while preserving every other saved field', () => {
    const current = draft({ aspectRatio: '9:16', duration: 8 });
    const restored = draft({ aspectRatio: '16:9', duration: 4, references: [reference, { ...reference, id: 'other', handle: '@other' }] });
    expect(needsRemixReferenceRecovery(current)).toBe(true);
    expect(recoverRemixReferences(current, restored)).toEqual({ ...current, references: [reference] });
  });
  it('does not undo removal, replacement inputs, or a model change during loading', () => {
    const restored = draft({ references: [reference] });
    for (const current of [draft({ prompt: 'My edited scene' }), draft({ references: [{ ...reference, handle: '@replacement' }] }), draft({ startFrame: reference }), draft({ model: 'different-model' })]) {
      expect(recoverRemixReferences(current, restored)).toBe(current);
    }
  });
  it('does not invent references for an unrelated unknown mention or an unavailable source', () => {
    const current = draft({ prompt: '@new_subject' });
    expect(recoverRemixReferences(current, draft({ references: [reference] }))).toBe(current);
    expect(recoverRemixReferences(draft(), draft())).toEqual(draft());
  });
});

// Audit A6. Source media come back as signed links that last an hour, and a
// saved remix keeps them. A rail that still had its references was never
// re-read, so once the links ran out they showed as missing for good.
describe('saved remix references whose links have run out', () => {
  const STORAGE = 'https://project.supabase.co';
  const NOW = Date.parse('2026-09-16T10:00:00.000Z');
  const signed = (path: string, expiresAtMs: number) => (
    `${STORAGE}/storage/v1/object/sign/${path}?token=head.${Buffer.from(JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) })).toString('base64url')}.signature`
  );
  const clock = { now: NOW, storageBaseUrl: STORAGE };
  const girlPath = 'uploads/owner/girl.png';
  const girl = { ...reference, storagePath: girlPath, url: signed(girlPath, NOW - 60_000) };

  // Diagnostic counterexample 6: a nonempty persisted reference list containing
  // an expired signed URL did not trigger source recovery.
  it('asks for the source again when a saved reference link has expired', () => {
    expect(needsRemixReferenceRecovery(draft({ references: [girl] }), clock)).toBe(true);
    // A frame counts as much as a reference; the prompt's mention is already covered.
    expect(needsRemixReferenceRecovery(draft({ startFrame: { ...girl, id: 'start' } }), clock)).toBe(true);
    const motion: MotionCreationDraft = { ...createDefaultCreationDraft('motion'), characterImage: { ...girl, id: 'hero' } };
    expect(needsRemixReferenceRecovery(motion, clock)).toBe(true);
  });

  it('leaves links alone that are still good, or that it cannot date', () => {
    expect(needsRemixReferenceRecovery(draft({ references: [{ ...girl, url: signed(girlPath, NOW + 3_600_000) }] }), clock)).toBe(false);
    expect(needsRemixReferenceRecovery(draft({ references: [reference] }), clock)).toBe(false);
    expect(needsRemixReferenceRecovery(draft({ references: [{ ...girl, url: girl.url.replace(STORAGE, 'https://elsewhere.example') }] }), clock)).toBe(false);
    // Without a clock only the empty-rail case is checked, as before.
    expect(needsRemixReferenceRecovery(draft({ references: [girl] }))).toBe(false);
  });

  it('renews only the links of media still in the draft, keeping every edit', () => {
    const freshGirl = signed(girlPath, NOW + 3_600_000);
    const otherPath = 'uploads/owner/other.png';
    // Renamed while saved, the other reference removed, the framing changed.
    const current = draft({ aspectRatio: '9:16', references: [{ ...girl, displayName: 'My girl' }] });
    const restored = draft({
      aspectRatio: '16:9',
      references: [
        { ...girl, url: freshGirl },
        { ...reference, id: 'other', handle: '@other', storagePath: otherPath, url: signed(otherPath, NOW + 3_600_000) },
      ],
    });

    expect(recoverRemixReferences(current, restored)).toEqual({
      ...current,
      references: [{ ...current.references[0], url: freshGirl }],
    });
  });

  it('matches renewed media by where it is stored, since restored frames get new ids', () => {
    const framePath = 'uploads/owner/start.png';
    const freshFrame = signed(framePath, NOW + 3_600_000);
    const current = draft({ prompt: 'A slow push in', startFrame: { ...girl, id: 'image-start-1', handle: undefined, storagePath: framePath, url: signed(framePath, NOW - 1) } });
    const restored = draft({ prompt: 'Source prompt', startFrame: { ...girl, id: 'image-start-2', handle: undefined, storagePath: framePath, url: freshFrame } });

    expect(recoverRemixReferences(current, restored)).toEqual({ ...current, startFrame: { ...current.startFrame!, url: freshFrame } });
  });

  it('renews a motion draft’s inputs too', () => {
    const heroPath = 'uploads/owner/hero.png';
    const freshHero = signed(heroPath, NOW + 3_600_000);
    const current: MotionCreationDraft = { ...createDefaultCreationDraft('motion'), prompt: 'Dance', characterImage: { ...girl, id: 'hero-1', storagePath: heroPath, url: signed(heroPath, NOW - 1) } };
    const restored: MotionCreationDraft = { ...current, prompt: 'Source prompt', characterImage: { ...current.characterImage!, id: 'hero-2', url: freshHero } };

    expect(recoverRemixReferences(current, restored)).toEqual({ ...current, characterImage: { ...current.characterImage!, url: freshHero } });
  });
});

// Until 2026-10-30 a restore gave every clip no handle, though a Kling 3.0 run keeps the one its
// prompt mentions each clip by, and the session was saved so: resumed as saved while its links were
// good, given only fresh links once they ran out, and held for good on "Unknown element mentions".
describe('saved remix clips without the handles their words mention', () => {
  const clip = (place: number, handle?: string): MediaDraft => ({
    id: `video-${place}`,
    kind: 'video',
    url: `https://cdn.example.com/clip-${place}.mp4`,
    storagePath: `generation_inputs/owner/source-generation/0${place}-reference_video.mp4`,
    fileName: `0${place}-reference_video.mp4`,
    displayName: 'Reference Video',
    ...(handle ? { handle } : {}),
  });
  const kling = (overrides: Partial<VideoCreationDraft> = {}) => draft({
    model: 'kling-3.0-video',
    prompt: 'Open on @reference_video_2, then @reference_video_3',
    ...overrides,
  });
  const keptHandles = () => kling({ referenceVideos: [clip(2, '@reference_video_2'), clip(3, '@reference_video_3')] });

  it('reads the source again while a clip has no handle and the words mention one nothing answers to', () => {
    expect(needsRemixReferenceRecovery(kling({ referenceVideos: [clip(2), clip(3)] }))).toBe(true);
    // A story's shots are words too.
    expect(needsRemixReferenceRecovery(kling({
      prompt: '',
      isMultiShot: true,
      multiPrompts: [{ id: 'shot-1', prompt: '@reference_video_3 jumps', duration: 5 }],
      referenceVideos: [clip(3)],
    }))).toBe(true);
    // Not once the clips answer to the mentions, nor while the words mention nothing unknown.
    expect(needsRemixReferenceRecovery(keptHandles())).toBe(false);
    expect(needsRemixReferenceRecovery(kling({ prompt: 'Two moves', referenceVideos: [clip(2), clip(3)] }))).toBe(false);
  });

  it('gives each clip back the handle its source kept, keeping every other edit', () => {
    const saved = kling({ aspectRatio: '9:16', referenceVideos: [clip(2), clip(3)] });

    const recovered = recoverRemixReferences(saved, { ...keptHandles(), aspectRatio: '16:9' });

    expect(recovered).toEqual({ ...saved, referenceVideos: [clip(2, '@reference_video_2'), clip(3, '@reference_video_3')] });
    expect(needsRemixReferenceRecovery(recovered)).toBe(false);
  });

  it('keeps the handle a creator gave a clip, and gives none that another clip already answers to', () => {
    // The first clip renamed while saved, and a clip uploaded since under @reference_video_3.
    const upload = { ...clip(9, '@reference_video_3'), storagePath: 'uploads/user/clip-9.mp4' };
    const saved = kling({ referenceVideos: [clip(2, '@spin'), clip(3), upload] });

    expect((recoverRemixReferences(saved, keptHandles()) as VideoCreationDraft).referenceVideos.map((item) => item.handle))
      .toEqual(['@spin', undefined, '@reference_video_3']);
  });

  it('brings back no pictures the creator replaced while it repairs the clips', () => {
    const mine = { ...reference, id: 'mine', handle: '@mine' };
    const saved = kling({ prompt: 'Open on @reference_video_2 with @mine and @girl', references: [mine], referenceVideos: [clip(2)] });

    const recovered = recoverRemixReferences(saved, { ...keptHandles(), references: [reference] }) as VideoCreationDraft;

    expect(recovered.references).toEqual([mine]);
    expect(recovered.referenceVideos).toEqual([clip(2, '@reference_video_2')]);
  });

  // Kling 3.0 takes a clip only under a handle, so the screen's catalog reconcile names each clip as the
  // saved draft lands on it, before the source is back. The draft as it was read back tells those
  // stand-ins from a handle the creator gave.
  it('gives a clip its source’s handle over the stand-in the catalog named it with', () => {
    const saved = kling({ referenceVideos: [clip(2), clip(3)] });
    const landed = applyCatalogModelDefaults(saved, klingVideoModel()) as VideoCreationDraft;
    // Past the handles the words mention, so the two cannot meet.
    expect(landed.referenceVideos.map((item) => item.handle)).toEqual(['@reference_video', '@reference_video_4']);

    const recovered = recoverRemixReferences(landed, keptHandles(), saved) as VideoCreationDraft;

    expect(recovered.referenceVideos.map((item) => item.handle)).toEqual(['@reference_video_2', '@reference_video_3']);
    expect(needsRemixReferenceRecovery(recovered)).toBe(false);
  });

  it('keeps a stand-in its words never mention, and a handle the clip was saved with', () => {
    // Four clips uploaded, the first taken away: the source kept @reference_video_2 to _4. The second
    // was renamed before the session was saved; the words mention the second's and the third's.
    const saved = kling({ prompt: 'Open on @reference_video_3, then @reference_video_4', referenceVideos: [clip(2), clip(3, '@spin'), clip(4)] });
    const source = kling({ referenceVideos: [clip(2, '@reference_video_2'), clip(3, '@reference_video_3'), clip(4, '@reference_video_4')] });
    const landed = applyCatalogModelDefaults(saved, klingVideoModel()) as VideoCreationDraft;
    expect(landed.referenceVideos.map((item) => item.handle)).toEqual(['@reference_video', '@spin', '@reference_video_2']);

    const recovered = recoverRemixReferences(landed, source, saved) as VideoCreationDraft;

    expect(recovered.referenceVideos.map((item) => item.handle)).toEqual(['@reference_video', '@spin', '@reference_video_4']);
  });
});

// The thumbnail's own retry, after a link fails to load: one piece of media is
// renewed, from the source when it came from one.
describe('renewing one reference link', () => {
  const bundle = {
    generation: { id: 'gen-girl', title: 'Original', prompt: 'The girl from @girl', category: 'video', model: 'seedance-2' },
    result: null,
    inputs: {
      video: {
        referenceMode: 'elements',
        startFrame: { kind: 'image', url: 'https://cdn.example.com/start-fresh.png', storagePath: 'uploads/owner/start.png' },
        endFrame: null,
        elements: [{ id: 'girl', displayName: 'Girl', handle: '@girl', url: 'https://cdn.example.com/girl-fresh.png', storagePath: null }],
        referenceVideos: [{ kind: 'video', url: null, storagePath: 'uploads/owner/gone.mp4' }],
      },
    },
    workflowSettings: {},
    restoreIssues: [],
  } satisfies RemixSourceBundle;

  it('finds the fresh link by storage path, or by id for an element stored nowhere', () => {
    const start = { ...reference, id: 'image-start-9', handle: undefined, storagePath: 'uploads/owner/start.png' };
    expect(remixSourceMediaUrl(bundle, start)).toBe('https://cdn.example.com/start-fresh.png');
    expect(remixSourceMediaUrl(bundle, reference)).toBe('https://cdn.example.com/girl-fresh.png');
    // The source could not sign it, or no longer has it.
    expect(remixSourceMediaUrl(bundle, { ...reference, kind: 'video', id: 'clip', storagePath: 'uploads/owner/gone.mp4' })).toBeNull();
    expect(remixSourceMediaUrl(bundle, { ...reference, id: 'mine', storagePath: 'uploads/me/mine.png' })).toBeNull();
  });

  it('changes that one link and nothing else', () => {
    const other = { ...reference, id: 'other', handle: '@other', url: 'https://cdn.example.com/other.png' };
    const current = draft({ references: [reference, other], startFrame: { ...reference, id: 'start' } });

    expect(replaceDraftMediaUrl(current, 'girl', 'https://cdn.example.com/girl-fresh.png')).toEqual({
      ...current,
      references: [{ ...reference, url: 'https://cdn.example.com/girl-fresh.png' }, other],
    });
    expect(replaceDraftMediaUrl(current, 'start', 'https://cdn.example.com/start-fresh.png').startFrame?.url).toBe('https://cdn.example.com/start-fresh.png');
    expect(replaceDraftMediaUrl(current, 'missing', 'https://cdn.example.com/x.png')).toBe(current);
  });
});

// A named subject's pictures go with a subjects run (Kling O3's) as much as a reference does, and a
// remix restores them with links that last an hour. The walks over a draft's media left them out:
// their links were never renewed, and a swept one was never found.
describe('the pictures of named subjects', () => {
  const STORAGE = 'https://project.supabase.co';
  const NOW = Date.parse('2026-09-16T10:00:00.000Z');
  const signed = (path: string, expiresAtMs: number) => (
    `${STORAGE}/storage/v1/object/sign/${path}?token=head.${Buffer.from(JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) })).toString('base64url')}.signature`
  );
  const clock = { now: NOW, storageBaseUrl: STORAGE };
  const picture = (id: string, url: string) => ({
    id, kind: 'image' as const, url, storagePath: `uploads/owner/${id}.png`, fileName: `${id}.png`, displayName: id, handle: '@hero',
  });
  const withHero = (images: ReturnType<typeof picture>[]) => draft({
    model: 'kling-o3',
    prompt: '@hero walks in',
    subjects: [{ id: 'subject-hero', displayName: 'Hero', handle: '@hero', images }],
  });
  const fresh = signed('uploads/owner/side.png', NOW + 3_600_000);
  const current = withHero([picture('front', signed('uploads/owner/front.png', NOW + 3_600_000)), picture('side', signed('uploads/owner/side.png', NOW - 60_000))]);

  it('counts them, and reads the source again when one of their links has run out', () => {
    expect(countDraftMedia(current)).toBe(2);
    expect(needsRemixReferenceRecovery(current, clock)).toBe(true);
    // A subject is an input the draft holds, as a frame or a clip is: a prompt naming it has its reference.
    expect(needsRemixReferenceRecovery(withHero([picture('front', 'https://example.com/front.png')]))).toBe(false);
  });

  it('renews them from the source read again, matched by where each is stored', () => {
    const restored = withHero([
      { ...picture('front-restored', signed('uploads/owner/front.png', NOW + 3_600_000)), storagePath: 'uploads/owner/front.png' },
      { ...picture('side-restored', fresh), storagePath: 'uploads/owner/side.png' },
    ]);
    const recovered = recoverRemixReferences(current, restored);

    expect(recovered.tool === 'video' && recovered.subjects?.[0].images.map((image) => [image.id, image.url])).toEqual([
      ['front', current.subjects![0].images[0].url],
      ['side', fresh],
    ]);
  });

  it('renews one picture’s link, from the source’s subjects or by signing it again', () => {
    const bundle = {
      generation: { id: 'gen-hero', title: 'Original', prompt: '@hero walks in', category: 'video', model: 'kling-o3' },
      result: null,
      inputs: {
        video: {
          referenceMode: 'elements',
          startFrame: null,
          endFrame: null,
          elements: [],
          subjects: [{ handle: '@hero', displayName: 'Hero', images: [{ kind: 'image', url: fresh, storagePath: 'uploads/owner/side.png' }] }],
        },
      },
      workflowSettings: {},
      restoreIssues: [],
    } satisfies RemixSourceBundle;
    const side = current.subjects![0].images[1];

    expect(remixSourceMediaUrl(bundle, side)).toBe(fresh);
    const renewed = replaceDraftMediaUrl(current, 'side', 'https://example.com/renewed.png');
    expect(renewed.subjects?.[0].images.map((image) => image.url)).toEqual([current.subjects![0].images[0].url, 'https://example.com/renewed.png']);
    expect(replaceDraftMediaUrl(current, 'missing', 'https://example.com/x.png')).toBe(current);
  });
});
