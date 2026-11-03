import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const logBackendErrorMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/backend-logger', () => ({
  logBackendError: (...args: unknown[]) => logBackendErrorMock(...args),
}));

import {
  PUBLIC_GENERATION_SETUP_COLUMNS,
  buildPublicGenerationSetup,
  loadPublicGenerationSetup,
} from '@/lib/public-generation-setup';
import mobileApiContract from '../../contracts/mobile-api-v1.json';
import { formatGenerationSetupLine } from '../../ugc-mobile/lib/generation-setup/generation-setup';

/**
 * A creation's settings are a standard detail of its post, seen without
 * unlocking anything (owner, 2026-11-03). They are the fields and words the
 * recipe's "Saved generation setup" note carried, less the model, which Made
 * with already names, and the inputs, which a locked recipe's preview counts.
 */
describe('the settings a creation post shows everyone', () => {
  it('shows an image run\'s aspect ratio, resolution and output format', () => {
    const setup = buildPublicGenerationSetup({
      category: 'image',
      model: 'nano-banana-2',
      workflow_settings: {
        model: 'nano-banana-2',
        aspectRatio: '9:16',
        resolution: '1K',
        outputFormat: 'jpg',
        googleSearch: false,
        elements: [{ id: 'element-1', displayName: 'Bottle', handle: '@bottle', storagePath: 'uploads/user-1/bottle.png' }],
      },
    });

    expect(setup).toEqual([
      { label: 'Aspect ratio', value: '9:16' },
      { label: 'Resolution', value: '1K' },
      { label: 'Output format', value: 'JPG' },
    ]);
    expect(formatGenerationSetupLine(setup)).toBe('9:16 · 1K · JPG');
    // Made with names the model; the recipe's preview counts the references.
    expect(JSON.stringify(setup)).not.toMatch(/model|nano|banana|input|reference|@bottle|grounding/i);
  });

  // No image model offers grounding any more, and every run stores `false`: "off"
  // would read on every image post and say nothing. A run that had it on says so.
  it('names Google Search grounding only where it was on', () => {
    const settings = { aspectRatio: '4:5', resolution: '2K', outputFormat: 'png' };
    const grounded = buildPublicGenerationSetup({ category: 'image', model: 'nano-banana-2', workflow_settings: { ...settings, googleSearch: true } });

    expect(grounded).toEqual([
      { label: 'Aspect ratio', value: '4:5' },
      { label: 'Resolution', value: '2K' },
      { label: 'Output format', value: 'PNG' },
      { label: 'Google Search grounding', value: 'On' },
    ]);
    expect(formatGenerationSetupLine(grounded)).toBe('4:5 · 2K · PNG · Search grounding on');
    for (const googleSearch of [false, undefined, 'true', null]) {
      expect(buildPublicGenerationSetup({ category: 'image', model: 'nano-banana-2', workflow_settings: { ...settings, googleSearch } }))
        .toEqual(grounded.slice(0, 3));
    }
  });

  it('shows a video run\'s aspect ratio, resolution, length, sound, camera and shots, and none of its inputs', () => {
    const setup = buildPublicGenerationSetup({
      category: 'video',
      model: 'bytedance/seedance-2-fast',
      workflow_settings: {
        model: 'seedance-2-fast',
        aspectRatio: '16:9',
        duration: 12,
        resolution: '480p',
        sound: true,
        fixedLens: true,
        referenceMode: 'elements',
        multiPrompts: [{ prompt: 'One' }, { prompt: 'Two' }, { prompt: 'Three' }],
        startFrame: { kind: 'image', storagePath: 'uploads/user-1/start.png' },
        elements: [{ id: 'element-1', displayName: 'Hero', handle: '@hero', storagePath: 'uploads/user-1/hero.png' }],
        referenceVideoUrls: ['asset-video-1'],
        referenceAudioUrls: ['asset-audio-1'],
      },
    });

    expect(setup).toEqual([
      { label: 'Aspect ratio', value: '16:9' },
      { label: 'Resolution', value: '480P' },
      { label: 'Duration', value: '12s' },
      { label: 'Sound', value: 'On' },
      { label: 'Camera', value: 'Fixed lens' },
      { label: 'Shots', value: '3' },
    ]);
    expect(formatGenerationSetupLine(setup)).toBe('16:9 · 480P · 12s · Sound on · Fixed lens · 3 shots');
    expect(JSON.stringify(setup)).not.toMatch(/seedance|model|input|reference|frame|prompt|@hero|asset-/i);
  });

  it('names a video model\'s mode as its catalog entry does where the model has no resolutions', () => {
    const setup = buildPublicGenerationSetup({
      category: 'video',
      model: 'kling-3.0-video',
      workflow_settings: { model: 'kling-3.0-video', aspectRatio: '9:16', mode: 'std', duration: 5, sound: false },
    });

    expect(setup).toEqual([
      { label: 'Aspect ratio', value: '9:16' },
      { label: 'Mode', value: 'Standard (720p)' },
      { label: 'Duration', value: '5s' },
      { label: 'Sound', value: 'Off' },
    ]);
    expect(formatGenerationSetupLine(setup)).toBe('9:16 · Standard (720p) · 5s · Sound off');
  });

  it('counts the shots of a catalog run, which records them as `shots`, and leaves a lens that moves unsaid', () => {
    const setup = buildPublicGenerationSetup({
      category: 'video',
      model: 'kling-3.0-video',
      workflow_settings: { aspectRatio: 'Auto', isMultiShot: true, shots: [{ prompt: 'One' }, { prompt: 'Two' }], fixedLens: false },
    });

    expect(setup).toEqual([
      { label: 'Aspect ratio', value: 'Auto' },
      { label: 'Shots', value: '2' },
    ]);
    expect(formatGenerationSetupLine(setup)).toBe('Auto ratio · 2 shots');
  });

  it('shows a motion run\'s length, render mode and character orientation, from either start path', () => {
    const legacy = buildPublicGenerationSetup({
      category: 'video',
      creation_mode: 'motion',
      model: 'kling-2.6',
      workflow_settings: {
        creationMode: 'motion',
        model: 'kling-2.6',
        mode: '720p',
        duration: 8,
        characterOrientation: 'video',
        characterImage: { kind: 'image', storagePath: 'uploads/user-1/character.png' },
        referenceVideo: { kind: 'video', storagePath: 'uploads/user-1/reference.mp4' },
      },
    });
    expect(legacy).toEqual([
      { label: 'Duration', value: '8s' },
      { label: 'Render mode', value: '720P' },
      { label: 'Character orientation', value: 'Follow video' },
    ]);
    expect(formatGenerationSetupLine(legacy)).toBe('8s · 720P · Follow video');
    expect(JSON.stringify(legacy)).not.toMatch(/character image|reference video|uploads|kling/i);

    // A catalog-path motion run is a `video` marked by its creation mode, its render mode a `resolution`.
    const catalog = buildPublicGenerationSetup({
      category: 'video',
      creation_mode: 'motion',
      model: 'kling-3.0',
      workflow_settings: {
        model: 'kling-3.0',
        resolution: '1080p',
        duration: 10,
        characterOrientation: 'image',
        inputs: [{ slot: 'characterImage', kind: 'image', storagePath: 'uploads/user-1/character.png' }],
      },
    });
    expect(catalog).toEqual([
      { label: 'Duration', value: '10s' },
      { label: 'Render mode', value: '1080P' },
      { label: 'Character orientation', value: 'Favor image' },
    ]);
  });

  // A template's settings and model are its author's, as its recipe is: Made
  // with names no model on its post, and the line shows nothing either.
  it.each([
    ['its run', { template_run_id: 'run-1', template_run_step_id: null }],
    ['its step', { template_run_id: null, template_run_step_id: 'step-1' }],
  ])('shows nothing of a template result that records %s', (_label, link) => {
    expect(buildPublicGenerationSetup({
      category: 'image',
      model: 'nano-banana-pro',
      workflow_settings: { aspectRatio: '9:16', resolution: '2K', outputFormat: 'png', googleSearch: true },
      ...link,
    })).toEqual([]);
  });

  it('shows nothing without a creation, or for one of no kind it knows', () => {
    expect(buildPublicGenerationSetup(null)).toEqual([]);
    expect(buildPublicGenerationSetup({ category: 'audio', model: 'eleven-v3', workflow_settings: { duration: 9 } })).toEqual([]);
    expect(buildPublicGenerationSetup({ category: 'image', model: 'nano-banana-2', workflow_settings: null })).toEqual([]);
    // A blank setting is left out rather than drawn as an empty value.
    expect(buildPublicGenerationSetup({ category: 'image', model: 'gpt-image-2', workflow_settings: { aspectRatio: ' ', resolution: '2K' } }))
      .toEqual([{ label: 'Resolution', value: '2K' }]);
  });

  it('builds the setup the shared contract pins for the post read by id', () => {
    const pinned = mobileApiContract.endpoints.getShowcasePost.response.item.generationSetup;
    expect(buildPublicGenerationSetup({
      category: 'image',
      model: 'nano-banana-2',
      workflow_settings: { model: 'nano-banana-2', aspectRatio: '16:9', resolution: '1K', outputFormat: 'jpg', googleSearch: false },
    })).toEqual(pinned);
    expect(mobileApiContract.endpoints.getShowcasePost.responseVariants.templateResult.item.generationSetup).toEqual([]);
  });
});

describe('reading a creation\'s settings for its post', () => {
  function clientAnswering(answer: { data: unknown; error: unknown }) {
    const reads: Array<{ table: string; columns: string; id: unknown }> = [];
    const client = {
      from(table: string) {
        let columns = '';
        let id: unknown = null;
        const query = {
          select(selected: string) { columns = selected; return query; },
          eq(column: string, value: unknown) { if (column === 'id') id = value; return query; },
          async maybeSingle() { reads.push({ table, columns, id }); return answer; },
        };
        return query;
      },
    };
    return { client: client as unknown as SupabaseClient, reads };
  }

  it('reads the columns the setup is built from, for the post\'s creation', async () => {
    const { client, reads } = clientAnswering({
      data: { model: 'nano-banana-2', category: 'image', creation_mode: null, workflow_settings: { aspectRatio: '1:1' }, template_run_id: null, template_run_step_id: null },
      error: null,
    });

    await expect(loadPublicGenerationSetup(client, 'gen-1')).resolves.toEqual([{ label: 'Aspect ratio', value: '1:1' }]);
    expect(reads).toEqual([{ table: 'generations', columns: PUBLIC_GENERATION_SETUP_COLUMNS, id: 'gen-1' }]);
  });

  it('reads nothing for a post made from no creation', async () => {
    const { client, reads } = clientAnswering({ data: null, error: null });
    await expect(loadPublicGenerationSetup(client, null)).resolves.toEqual([]);
    expect(reads).toEqual([]);
  });

  it('shows no setup, and says why in the log, when the read fails: the post still serves', async () => {
    logBackendErrorMock.mockClear();
    const { client } = clientAnswering({ data: null, error: { message: 'timeout' } });
    await expect(loadPublicGenerationSetup(client, 'gen-1')).resolves.toEqual([]);
    expect(logBackendErrorMock).toHaveBeenCalledWith('failed_to_fetch_public_generation_setup', { error: { message: 'timeout' } });
  });
});
