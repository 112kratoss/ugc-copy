import { describe, expect, it } from 'vitest';

import {
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
});
