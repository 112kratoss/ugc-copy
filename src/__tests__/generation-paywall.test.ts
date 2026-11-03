import { describe, expect, it } from 'vitest';

import {
  buildGenerationRecipeResourceItems,
  buildGenerationPaywallPrefill,
  hasRecoverableGenerationRemixInputs,
} from '@/lib/generation-paywall';

describe('generation paywall helpers', () => {
  it('builds the prompt and remix access for recoverable image generations', () => {
    const prefill = buildGenerationPaywallPrefill({
      category: 'image',
      prompt: 'A polished creator product image with warm natural light.',
      workflowSettings: {
        model: 'nano-banana-2',
        aspectRatio: '4:5',
        resolution: '1K',
        outputFormat: 'jpg',
        googleSearch: true,
        elements: [
          {
            id: 'element-1',
            displayName: 'Bottle',
            handle: '@bottle',
            storagePath: 'uploads/user-1/bottle.png',
          },
        ],
      },
    });

    expect(prefill).toEqual({
      promptText: 'A polished creator product image with warm natural light.',
      allowRemix: true,
      resourceKinds: ['prompt', 'remix'],
      referenceCount: 0,
      referenceKindCounts: {},
    });
  });

  // The setup is public on the post since 2026-11-03 (owner's decision), so the
  // sell link, Studio's Manage and Add recipe, the composer and the creators'
  // publish form, which all start a new recipe from this prefill, no longer put
  // a protected "Saved generation setup" item into it.
  it.each([
    ['an image', { category: 'image', workflowSettings: { model: 'nano-banana-2', aspectRatio: '9:16', resolution: '1K', outputFormat: 'jpg', googleSearch: false } }],
    ['a video', { category: 'video', workflowSettings: { model: 'seedance-2-fast', aspectRatio: '16:9', duration: 12, resolution: '480p', sound: true, fixedLens: true } }],
    ['a motion', { category: 'video', creationMode: 'motion', workflowSettings: { creationMode: 'motion', model: 'kling-2.6', mode: '720p', duration: 8, characterOrientation: 'video' } }],
  ])('leaves %s creation\'s settings out of a new recipe', (_kind, source) => {
    const prefill = buildGenerationPaywallPrefill({ ...source, prompt: 'Keep the light warm.' });

    expect(prefill).toMatchObject({ promptText: 'Keep the light warm.', resourceKinds: ['prompt'] });
    // The field that carried the settings as a note is gone (no installed client read it).
    expect(prefill).not.toHaveProperty('notesMarkdown');
    expect(JSON.stringify(prefill)).not.toMatch(/saved generation setup|aspect ratio|resolution|duration|orientation/i);
    // A creation whose settings were all it had starts no recipe at all.
    expect(buildGenerationPaywallPrefill({ ...source, prompt: '' })).toBeNull();
  });

  it('prefers the named element handle for public recipe reference labels when available', () => {
    const items = buildGenerationRecipeResourceItems({
      promptText: 'Match @alisa in the final frame.',
      notesMarkdown: null,
      allowRemix: true,
      inputMedia: [
        {
          id: 'input-1',
          generationId: 'gen-1',
          mediaType: 'image',
          role: 'reference_image',
          label: 'Element 1',
          url: null,
          storagePath: 'generation_inputs/user-1/gen-1/00-reference-image.png',
          sourceGenerationId: null,
          sortOrder: 0,
          metadata: {
            id: 'element-1',
            displayName: 'Element 1',
            handle: '@alisa',
          },
        },
      ],
    });

    expect(items.find((item) => item.type === 'reference_image')).toMatchObject({
      title: '@alisa',
    });
  });

  it('requires both motion source inputs before auto-enabling remix access', () => {
    expect(
      hasRecoverableGenerationRemixInputs({
        category: 'motion',
        prompt: 'Match the performer energy.',
        workflowSettings: {
          characterImage: {
            kind: 'image',
            label: 'Character image',
            storagePath: 'uploads/user-1/character.png',
          },
        },
      })
    ).toBe(false);

    expect(
      hasRecoverableGenerationRemixInputs({
        category: 'motion',
        prompt: 'Match the performer energy.',
        workflowSettings: {
          characterImage: {
            kind: 'image',
            label: 'Character image',
            storagePath: 'uploads/user-1/character.png',
          },
          referenceVideo: {
            kind: 'video',
            label: 'Reference video',
            storagePath: 'uploads/user-1/reference.mp4',
          },
        },
      })
    ).toBe(true);
  });

  // A motion model onboarded through the catalog is stored as a 'video'
  // generation marked by creation_mode, with its inputs kept as slots. Read only
  // by the legacy keys, it never had remix access switched on or its inputs noted.
  it('recognizes a catalog motion generation by its creation mode and input slots', () => {
    const source = {
      category: 'video',
      creationMode: 'motion',
      prompt: 'Match the performer energy.',
      workflowSettings: {
        model: 'kling-2.6',
        duration: 8,
        inputs: [
          { slot: 'characterImage', kind: 'image', label: 'Character image', storagePath: 'uploads/user-1/character.png' },
          { slot: 'referenceVideo', kind: 'video', label: 'Reference video', storagePath: 'uploads/user-1/reference.mp4' },
        ],
      },
    };

    expect(hasRecoverableGenerationRemixInputs(source)).toBe(true);
    expect(buildGenerationPaywallPrefill(source)).toMatchObject({ allowRemix: true, resourceKinds: ['prompt', 'remix'] });
    expect(hasRecoverableGenerationRemixInputs({ ...source, creationMode: null })).toBe(false);
  });

  // A Kling O3 run keeps the pictures of its named subjects, and its settings
  // say which subjects it used. A recipe made from a run sells remix access when
  // the run has inputs a remix can restore, and a buyer's remix restores them
  // only through such a recipe. Not counted, a subject run's recipe sold none.
  it('counts the named subjects of a Kling O3 run as inputs a remix can restore', () => {
    const source = {
      category: 'video',
      prompt: '@lead lifts @bottle and smiles at the camera.',
      workflowSettings: {
        model: 'kling-o3',
        aspectRatio: '16:9',
        duration: 5,
        resolution: '720p',
        referenceMode: 'elements',
        klingSubjects: [
          {
            handle: '@lead',
            displayName: 'Hero creator',
            images: [{ storagePath: 'uploads/user-1/hero-front.png' }, { storagePath: 'uploads/user-1/hero-side.png' }],
          },
          {
            handle: '@bottle',
            displayName: 'Serum bottle',
            images: [{ storagePath: 'uploads/user-1/bottle-front.png' }, { storagePath: 'uploads/user-1/bottle-side.png' }],
          },
        ] as unknown[] | undefined,
      },
    };

    expect(hasRecoverableGenerationRemixInputs(source)).toBe(true);
    const prefill = buildGenerationPaywallPrefill(source);
    expect(prefill).toMatchObject({ allowRemix: true, resourceKinds: ['prompt', 'remix'] });

    // A subject with no staged picture has nothing a remix could restore.
    expect(hasRecoverableGenerationRemixInputs({
      ...source,
      workflowSettings: {
        ...source.workflowSettings,
        klingSubjects: [{ handle: '@lead', displayName: 'Hero creator', images: [{ storagePath: null }] }],
      },
    })).toBe(false);
    // Nor has a run that recorded no subject, as one made before they were kept.
    const before = { ...source, workflowSettings: { ...source.workflowSettings, klingSubjects: undefined } };
    expect(hasRecoverableGenerationRemixInputs(before)).toBe(false);
    expect(buildGenerationPaywallPrefill(before)).toMatchObject({ allowRemix: false, resourceKinds: ['prompt'] });
  });

  it('returns null when a generation has no usable prompt, notes, or remix inputs', () => {
    expect(
      buildGenerationPaywallPrefill({
        category: null,
        prompt: '   ',
        workflowSettings: null,
      })
    ).toBeNull();
  });

  it('adds safe saved reference metadata from durable input media', () => {
    const prefill = buildGenerationPaywallPrefill({
      category: 'image',
      prompt: 'Use the saved references to rebuild the look.',
      workflowSettings: {
        model: 'nano-banana-2',
      },
      inputMedia: [
        {
          id: 'input-1',
          generationId: 'gen-1',
          mediaType: 'image',
          role: 'reference_image',
          label: 'Hero reference',
          url: '/api/media/input-1',
          storagePath: 'generation_inputs/user-1/gen-1/input-1.png',
          sourceGenerationId: null,
          sortOrder: 0,
          metadata: {},
        },
        {
          id: 'input-2',
          generationId: 'gen-1',
          mediaType: 'video',
          role: 'reference_video',
          label: 'Timing reference',
          url: '/api/media/input-2',
          storagePath: 'generation_inputs/user-1/gen-1/input-2.mp4',
          sourceGenerationId: null,
          sortOrder: 1,
          metadata: {},
        },
      ],
    });

    expect(prefill).toMatchObject({
      resourceKinds: ['prompt', 'files'],
      referenceCount: 2,
      referenceKindCounts: {
        image: 1,
        video: 1,
      },
    });
  });

  // The web creators' recipe leaves the creator's own uploads out unless they add them (owner,
  // 2026-10-29), so the prefill counts them apart from a remix's references from its original.
  it('counts the creator’s own references apart, where they were worked out', () => {
    const input = (id: string, mediaType: 'image' | 'video') => ({
      id,
      generationId: 'gen-1',
      mediaType,
      role: mediaType === 'image' ? 'reference_image' as const : 'reference_video' as const,
      label: id,
      url: `/api/media/${id}`,
      storagePath: `generation_inputs/user-1/gen-1/${id}`,
      sourceGenerationId: null,
      sortOrder: 0,
      metadata: {},
    });
    const source = {
      category: 'video',
      prompt: 'Two cats spar in a dim dojo.',
      workflowSettings: { model: 'seedance-2-mini' },
      inputMedia: [input('original-1', 'image'), input('own-1', 'image'), input('own-2', 'video')],
    };

    expect(buildGenerationPaywallPrefill({ ...source, ownInputIds: new Set(['own-1', 'own-2']) })).toMatchObject({
      referenceCount: 3,
      ownReferenceCount: 2,
      ownReferenceKindCounts: { image: 1, video: 1 },
    });
    // Not worked out: absent, and the creators then count every reference as the creator's own.
    expect(buildGenerationPaywallPrefill(source)).not.toHaveProperty('ownReferenceCount');
  });

  it('builds visible recipe items from prompt, saved references, and notes', () => {
    const items = buildGenerationRecipeResourceItems({
      promptText: 'Create the same portrait lighting.',
      notesMarkdown: 'Saved generation setup\nModel: Nano Banana 2.0',
      allowRemix: false,
      inputMedia: [{
        id: 'input-1',
        generationId: 'gen-1',
        mediaType: 'image',
        role: 'reference_image',
        label: 'Image input',
        url: null,
        storagePath: 'generation_inputs/user-1/gen-1/00-reference-image.png',
        sourceGenerationId: null,
        sortOrder: 0,
        metadata: {},
      }],
    });

    expect(items.map((item) => item.type)).toEqual(['prompt', 'reference_image', 'note']);
    expect(items[0]).toMatchObject({
      title: 'Prompt',
      textContent: 'Create the same portrait lighting.',
    });
    expect(items[1]).toMatchObject({
      title: 'Image input',
      storagePath: 'generation_inputs/user-1/gen-1/00-reference-image.png',
      contentType: 'image/png',
      remixUse: 'reference_only',
    });
    expect(items[2]).toMatchObject({
      title: 'Notes',
      textContent: 'Saved generation setup\nModel: Nano Banana 2.0',
    });
  });

  // A creation's clip came to buyers as a "source file", so the app gave the
  // reference video its prompt names a card of its own, "Source assets", apart
  // from the pictures (recipe reading review, 2026-10-29). The copy a recipe
  // stores at publish already typed it as a reference.
  it('types a creation\'s video and audio inputs as references, like its pictures', () => {
    const input = (id: string, mediaType: 'image' | 'video' | 'audio', storagePath: string) => ({
      id,
      generationId: 'gen-1',
      mediaType,
      role: mediaType === 'image' ? 'reference_image' as const : mediaType === 'video' ? 'reference_video' as const : 'reference_audio' as const,
      label: id,
      url: null,
      storagePath,
      sourceGenerationId: null,
      sortOrder: 0,
      metadata: {},
    });
    const items = buildGenerationRecipeResourceItems({
      promptText: null,
      notesMarkdown: null,
      allowRemix: false,
      inputMedia: [
        input('Ali', 'image', 'generation_inputs/user-1/gen-1/00-reference_image.png'),
        input('Video reference 1', 'video', 'generation_inputs/user-1/gen-1/03-reference_video.mp4'),
        input('Voice', 'audio', 'generation_inputs/user-1/gen-1/04-reference_audio.mp3'),
      ],
    });

    expect(items.map((item) => [item.title, item.type, item.contentType])).toEqual([
      ['Ali', 'reference_image', 'image/png'],
      ['Video reference 1', 'reference_video', 'video/mp4'],
      ['Voice', 'reference_audio', 'audio/mpeg'],
    ]);
  });
});
