import { describe, expect, it } from 'vitest';

import { getCreationAvailability, isCreationLibraryMember } from '../lib/creation-library';
import {
  getGenerationKind,
  getGenerationLabel,
  getGenerationRenderableMediaKind,
  normalizeGenerationAudioKind,
} from '../lib/generation-media';
import {
  buildImmersiveGenerationItems,
  getImmersiveStatusSlide,
  hasImmersiveAudibleMedia,
  selectActiveImmersiveVideoId,
} from '../lib/immersive-preview-view-model';
import { buildImmersiveSlidePages, getImmersiveSlideHint } from '../lib/immersive-slide-pages';
import { getDetailsBackLabel, getDetailsPrimaryAction } from '../lib/post-details-view-model';
import { getProfileFeedMediaHeight, toProfileFeedCard } from '../lib/profile-feed-card-view-model';
import { generationToProfileMediaCard } from '../lib/profile-view-model';
import type { GenerationListItem } from '../lib/types';
import { getViewerActionSlots, getViewerShareIntent, getViewerStateChip } from '../lib/viewer-actions';
import { initialViewerPosition, slidePageKey } from '../lib/viewer-position';

/**
 * What the owner route sends for a finished voiceover: the row's own `audio`
 * category, a signed address for the file, and no visual descriptor at all,
 * because `classifyVisualMedia` has nothing to say about sound.
 */
function voiceover(overrides: Partial<GenerationListItem> = {}): GenerationListItem {
  return {
    id: 'voiceover-1',
    output_url: 'https://storage.example.test/generated_audio/owner-1/generated_task.mp3?token=signed',
    preview_url: null,
    media: null,
    creationMode: null,
    status: 'succeeded',
    created_at: '2026-10-02T07:00:00.000Z',
    completed_at: '2026-10-02T07:00:20.000Z',
    duration: null,
    cost: 4,
    model: 'elevenlabs/text-to-speech-turbo-2-5',
    category: 'audio',
    audioKind: 'voiceover',
    prompt: 'Welcome to Magicbooklet.',
    ...overrides,
  };
}

const soundEffect = (overrides: Partial<GenerationListItem> = {}) => voiceover({
  id: 'sound-effect-1',
  output_url: 'https://storage.example.test/generated_audio/owner-1/generated_task.wav?token=signed',
  duration: 5,
  model: 'elevenlabs/sound-effect-v2',
  audioKind: 'sound-effect',
  prompt: 'Two rising chime tones',
  ...overrides,
});

const owner = { creatorLabel: '@owner' };
const immersive = (item: GenerationListItem) => buildImmersiveGenerationItems('studio-creations', [item], owner)[0];

describe('an audio creation is audio, not an image', () => {
  it('classifies the audio category on its own', () => {
    expect(getGenerationKind({ category: 'audio', creationMode: null })).toBe('audio');
    expect(getGenerationKind({ category: ' Audio ', creationMode: null })).toBe('audio');
    // The kinds that already existed keep their answers.
    expect(getGenerationKind({ category: 'image', creationMode: null })).toBe('image');
    expect(getGenerationKind({ category: 'video', creationMode: null })).toBe('video');
    expect(getGenerationKind({ category: 'ugc-ad', creationMode: null })).toBe('video');
    expect(getGenerationKind({ category: 'text', creationMode: null })).toBe('text');
    expect(getGenerationKind({ category: null, creationMode: 'motion' })).toBe('motion');
    expect(getGenerationKind({ category: null, creationMode: null })).toBe('image');
  });

  it('has no picture or video to draw', () => {
    expect(getGenerationRenderableMediaKind('audio')).toBeNull();
  });

  it('is named by what the server says it is', () => {
    expect(getGenerationLabel('audio', 'voiceover')).toBe('Voiceover');
    expect(getGenerationLabel('audio', 'sound-effect')).toBe('Sound effect');
    expect(getGenerationLabel('audio', 'audio')).toBe('Audio');
    // A server that predates the field, or names a kind this build has not heard of.
    expect(getGenerationLabel('audio')).toBe('Audio');
    expect(getGenerationLabel('audio', null)).toBe('Audio');
    expect(normalizeGenerationAudioKind('music')).toBe('audio');
    expect(normalizeGenerationAudioKind(undefined)).toBe('audio');
    expect(getGenerationLabel('image')).toBe('Image');
  });

  it('belongs to the library once it has a file, like every other finished creation', () => {
    expect(getCreationAvailability(voiceover())).toBe('available');
    expect(isCreationLibraryMember(voiceover())).toBe(true);
    expect(getCreationAvailability(voiceover({ output_url: null }))).toBe('no-output');
    expect(isCreationLibraryMember(voiceover({ output_url: null }))).toBe(false);
    expect(getCreationAvailability(voiceover({ status: 'failed', output_url: null }))).toBe('failed');
  });
});

describe('the Creations grid tile of an audio creation', () => {
  it('draws an audio plate instead of asking to view media', () => {
    const card = generationToProfileMediaCard(voiceover());

    expect(card).toMatchObject({
      mediaKind: null,
      previewKind: 'audio',
      previewState: 'audio',
      badge: 'Voiceover',
      detailLabel: 'Voiceover',
      isGridReady: true,
      title: 'Welcome to Magicbooklet.',
    });
    expect(card.previewStatusLabel).toBeUndefined();
    // No image or video component may ever be handed a sound file's address.
    expect(card.mediaUrl).toBeNull();
    expect(card.previewUrl).toBeNull();
  });

  it('names a sound effect, and falls back to Audio for an older server', () => {
    expect(generationToProfileMediaCard(soundEffect()).badge).toBe('Sound effect');
    expect(generationToProfileMediaCard(voiceover({ audioKind: undefined })).badge).toBe('Audio');
  });
});

describe('the card and reel item of an audio creation', () => {
  it('carries the sound as audio and offers nothing the server refuses', () => {
    const item = immersive(voiceover());

    expect(item).toMatchObject({
      mediaKind: null,
      mediaUrl: null,
      mediaItems: [],
      previewKind: 'audio',
      creationKind: 'audio',
      badge: 'Voiceover',
      audio: {
        url: 'https://storage.example.test/generated_audio/owner-1/generated_task.mp3?token=signed',
        kind: 'voiceover',
        durationSeconds: null,
      },
      // Publishing, sharing and remixing an audio creation all answer 400.
      canShare: false,
      availableActions: ['archive', 'view-details'],
    });
    expect(item.details?.categoryLabel).toBe('Voiceover');
    expect(getViewerShareIntent(item, 'https://magicbooklet.com')).toEqual({ kind: 'unavailable' });
    expect(getDetailsPrimaryAction(item, { canAccess: false })).toBeNull();
    expect(getViewerActionSlots(item).map((slot) => slot.id)).toEqual(['details']);
  });

  it('keeps the requested length of a sound effect for the player to show before it loads', () => {
    expect(immersive(soundEffect()).audio).toMatchObject({ kind: 'sound-effect', durationSeconds: 5 });
  });

  it('offers only restore once archived', () => {
    const item = immersive(voiceover({ archived_at: '2026-10-02T08:00:00.000Z' }));
    expect(item.availableActions).toEqual(['restore', 'view-details']);
    expect(getViewerStateChip(item)).toEqual({ label: 'Archived', tone: 'danger' });
  });

  it('does not report a posting state for something that cannot be posted', () => {
    expect(getViewerStateChip(immersive(voiceover()))).toBeNull();
    // An image keeps its chip.
    expect(getViewerStateChip(immersive(voiceover({ category: 'image', audioKind: undefined }))))
      .toEqual({ label: 'Not posted', tone: 'neutral' });
  });

  it('is not a video, and does not ask for the reel mute control', () => {
    const item = immersive(voiceover());
    expect(selectActiveImmersiveVideoId([item], 0)).toBeNull();
    expect(hasImmersiveAudibleMedia(item)).toBe(false);
  });

  it('gets its own page in the reel, with the details page behind it', () => {
    const item = immersive(voiceover());
    const pages = buildImmersiveSlidePages(item);

    expect(pages.map((page) => page.type)).toEqual(['audio', 'details']);
    expect(pages.map(slidePageKey)).toEqual(['audio', 'details']);
    expect(initialViewerPosition(item)).toEqual({ itemId: 'voiceover-1', pageKey: 'audio', mediaPageKey: 'audio' });
    expect(getImmersiveSlideHint({ currentHorizontalIndex: 0, item, pages })).toBe('Swipe left for details');
    expect(getImmersiveSlideHint({ currentHorizontalIndex: 1, item, pages })).toBe('Swipe right for the audio');
    expect(getDetailsBackLabel(item)).toBe('Back to audio');
  });

  it('gives the card feed a player to draw, and no media to open', () => {
    const card = toProfileFeedCard(immersive(voiceover()));

    expect(card).toMatchObject({
      hasMedia: false,
      isTextOnly: false,
      sourceUnavailable: false,
      categoryLabel: 'Voiceover',
      audio: { kind: 'voiceover' },
    });
    // The player sizes itself; it is not media, so no media height is reserved for it.
    expect(getProfileFeedMediaHeight(card, 360)).toBe(0);
    // A picture's card is unchanged.
    expect(toProfileFeedCard(immersive(voiceover({ category: 'image', audioKind: undefined }))).audio).toBeNull();
  });

  it('says why a failed run has nothing to play, without pointing at a tool the app does not have', () => {
    const item = immersive(voiceover({ status: 'failed', output_url: null }));

    expect(item.previewKind).toBeUndefined();
    expect(item.audio).toBeNull();
    expect(item.availableActions).toEqual(['archive', 'view-details']);
    expect(buildImmersiveSlidePages(item).map((page) => page.type)).toEqual(['status', 'details']);
    const slide = getImmersiveStatusSlide(item);
    expect(slide.title).toBe('This render failed');
    expect(slide.body).toContain('No voiceover came back');
    expect(slide.body).not.toContain('Create');
    expect(slide.body).toContain('magicbooklet.com');
  });
});
