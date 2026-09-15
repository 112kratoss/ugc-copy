import { describe, expect, it } from 'vitest';
import { createDefaultCreationDraft, type MotionCreationDraft, type VideoCreationDraft } from '../lib/media-creation-view-model';
import { needsRemixReferenceRecovery, recoverRemixReferences, remixSourceMediaUrl, replaceDraftMediaUrl } from '../lib/remix-draft-recovery';
import type { RemixSourceBundle } from '../lib/types';
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
