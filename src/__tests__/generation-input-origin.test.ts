import { describe, expect, it, vi } from 'vitest';

import { generationInputOrigin, loadSourceGenerationOwners, needsSourceGenerationOwner, storedMediaOwnerId } from '@/lib/generation-input-origin';

const CREATOR = '11111111-1111-4111-8111-111111111111';
const GUEST = '22222222-2222-4222-8222-222222222222';
const ORIGINAL = '33333333-3333-4333-8333-333333333333';

const context = {
  ownerIds: new Set([CREATOR, GUEST]),
  sourceGenerationOwners: new Map<string, string | null>([
    ['gen-original', ORIGINAL],
    ['gen-own', CREATOR],
  ]),
};

// The creators' recipe, shared by default, leaves the creator's own uploads out (owner,
// 2026-10-29), so each input is read for whose it is.
describe('generationInputOrigin', () => {
  // A source generation's owner is read only where nothing else says whose an input is.
  it('needs the source generation’s owner only where no source path names one', () => {
    expect(needsSourceGenerationOwner({
      sourceGenerationId: 'gen-original',
      metadata: { sourceStoragePath: `generation_inputs/${ORIGINAL}/gen-original/00.png` },
    })).toBe(false);
    expect(needsSourceGenerationOwner({ sourceGenerationId: 'gen-original', metadata: {} })).toBe(true);
    expect(needsSourceGenerationOwner({ metadata: {} })).toBe(false);
  });

  it('reads a remix’s reference as the original’s by the original’s storage it was kept from', () => {
    expect(generationInputOrigin({
      storagePath: `generation_inputs/${CREATOR}/gen-remix/00-reference_image.png`,
      metadata: { sourceStoragePath: `generation_inputs/${ORIGINAL}/gen-original/00-reference_image.png`, sourceUrl: null },
    }, context)).toBe('others');
  });

  it('reads the creator’s uploads, and a guest’s linked to them, as their own', () => {
    expect(generationInputOrigin({ metadata: { sourceStoragePath: `uploads/${CREATOR}/draft/face.jpg` } }, context)).toBe('own');
    expect(generationInputOrigin({ metadata: { sourceStoragePath: `uploads/${GUEST}/draft/face.jpg` } }, context)).toBe('own');
  });

  it('reads the source link where no source path was kept', () => {
    expect(generationInputOrigin({
      metadata: { sourceStoragePath: null, sourceUrl: `https://example.supabase.co/storage/v1/object/sign/generation_inputs/${ORIGINAL}/gen-original/01-reference_image.png?token=x` },
    }, context)).toBe('others');
  });

  it('reads another account’s creation used as a reference as the original’s, and the creator’s own as theirs', () => {
    expect(generationInputOrigin({ metadata: {}, sourceGenerationId: 'gen-original' }, context)).toBe('others');
    expect(generationInputOrigin({ metadata: {}, sourceGenerationId: 'gen-own' }, context)).toBe('own');
  });

  it('keeps an input whose source is not on record with the creator', () => {
    expect(generationInputOrigin({ metadata: { sourceUrl: 'https://tempfile.redpandaai.co/clip.mp4' } }, context)).toBe('own');
    expect(generationInputOrigin({ metadata: null, sourceGenerationId: 'gen-unknown' }, context)).toBe('own');
    // A stored row's own path is the creator's copy, whatever it came from.
    expect(generationInputOrigin({ storagePath: `generation_inputs/${CREATOR}/gen/00.png`, metadata: {} }, context)).toBe('own');
  });

  it('reads a legacy reading by the path it names', () => {
    expect(generationInputOrigin({ storagePath: `uploads/${ORIGINAL}/frame.png`, metadata: { legacy: true } }, context)).toBe('others');
    expect(generationInputOrigin({ storagePath: `uploads/${CREATOR}/frame.png`, metadata: { legacy: true } }, context)).toBe('own');
  });
});

describe('storedMediaOwnerId', () => {
  it('is the owner segment of a user-scoped path or storage link, and nothing for anything else', () => {
    expect(storedMediaOwnerId(`uploads/${CREATOR}/a.png`)).toBe(CREATOR);
    expect(storedMediaOwnerId(`https://example.supabase.co/storage/v1/object/public/generation_inputs/${ORIGINAL}/g/0.png`)).toBe(ORIGINAL);
    expect(storedMediaOwnerId('https://tempfile.redpandaai.co/clip.mp4')).toBeNull();
    expect(storedMediaOwnerId('unknown_bucket/someone/a.png')).toBeNull();
    expect(storedMediaOwnerId(null)).toBeNull();
  });
});

describe('loadSourceGenerationOwners', () => {
  function supabaseAnswering(result: { data: unknown; error: unknown }) {
    const inFilter = vi.fn(async () => result);
    return { client: { from: () => ({ select: () => ({ in: inFilter }) }) }, inFilter };
  }

  it('reads each source generation’s owner once', async () => {
    const { client, inFilter } = supabaseAnswering({ data: [{ id: 'gen-original', user_id: ORIGINAL }], error: null });
    const owners = await loadSourceGenerationOwners(client as never, ['gen-original', 'gen-original', null, undefined]);
    expect(inFilter).toHaveBeenCalledWith('id', ['gen-original']);
    expect(owners.get('gen-original')).toBe(ORIGINAL);
  });

  it('reads nothing for none, and leaves them unknown when the read fails', async () => {
    const none = supabaseAnswering({ data: [], error: null });
    expect((await loadSourceGenerationOwners(none.client as never, [])).size).toBe(0);
    expect(none.inFilter).not.toHaveBeenCalled();

    const failing = supabaseAnswering({ data: null, error: { message: 'timeout' } });
    expect((await loadSourceGenerationOwners(failing.client as never, ['gen-original'])).size).toBe(0);
  });
});
