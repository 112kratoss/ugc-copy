import { describe, expect, it } from 'vitest';

import {
  buildGenerationRecipeResourceItems,
  buildGenerationPaywallNotes,
  buildGenerationPaywallPrefill,
  hasRecoverableGenerationRemixInputs,
} from '@/lib/generation-paywall';

describe('generation paywall helpers', () => {
  it('builds prompt, notes, and remix access for recoverable image generations', () => {
    const prefill = buildGenerationPaywallPrefill({
      category: 'image',
      model: 'nano-banana-2',
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

    expect(prefill).toMatchObject({
      promptText: 'A polished creator product image with warm natural light.',
      allowRemix: true,
      resourceKinds: ['prompt', 'notes', 'remix'],
      referenceCount: 0,
      referenceKindCounts: {},
    });
    expect(prefill?.notesMarkdown).toContain('Saved generation setup');
    expect(prefill?.notesMarkdown).toContain('Model: Nano Banana 2.0');
    expect(prefill?.notesMarkdown).toContain('Aspect ratio: 4:5');
    expect(prefill?.notesMarkdown).toContain('Inputs: 1 saved reference');
  });

  it('summarizes saved video settings without exposing raw workflow JSON', () => {
    const notes = buildGenerationPaywallNotes({
      category: 'video',
      model: 'bytedance/seedance-2-fast',
      prompt: 'Match the motion and timing references.',
      workflowSettings: {
        model: 'seedance-2-fast',
        aspectRatio: '16:9',
        duration: 12,
        resolution: '480p',
        sound: true,
        referenceMode: 'elements',
        elements: [
          {
            id: 'element-1',
            displayName: 'Hero',
            handle: '@hero',
            storagePath: 'uploads/user-1/hero.png',
          },
        ],
        referenceVideoUrls: ['asset-video-1'],
        referenceAudioUrls: ['asset-audio-1'],
      },
    });

    expect(notes).toContain('Model: Seedance 2 Fast');
    expect(notes).toContain('Duration: 12s');
    expect(notes).toContain('Reference mode: Named references');
    expect(notes).toContain('Inputs: 1 named reference, 1 video reference, 1 audio reference');
    expect(notes).not.toContain('"referenceVideoUrls"');
  });

  it('maps provider model ids to public catalog labels in saved generation notes', () => {
    const notes = buildGenerationPaywallNotes({
      category: 'video',
      model: 'bytedance/seedance-2-fast',
      prompt: 'Recreate this video setup.',
      workflowSettings: {
        aspectRatio: '16:9',
        duration: 8,
      },
    });

    expect(notes).toContain('Model: Seedance 2 Fast');
    expect(notes).not.toContain('bytedance/seedance-2-fast');
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
        model: 'kling-3.0/motion-control',
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
        model: 'kling-3.0/motion-control',
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

  it('returns null when a generation has no usable prompt, notes, or remix inputs', () => {
    expect(
      buildGenerationPaywallPrefill({
        category: null,
        model: null,
        prompt: '   ',
        workflowSettings: null,
      })
    ).toBeNull();
  });

  it('adds safe saved reference metadata from durable input media', () => {
    const prefill = buildGenerationPaywallPrefill({
      category: 'image',
      model: 'nano-banana-2',
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
      resourceKinds: ['prompt', 'notes', 'files'],
      referenceCount: 2,
      referenceKindCounts: {
        image: 1,
        video: 1,
      },
    });
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
});
