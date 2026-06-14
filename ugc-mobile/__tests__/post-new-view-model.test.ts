import { describe, expect, it } from 'vitest';
import {
  buildCreatePostFormData,
  buildPostResourceBundleInput,
  buildPublishGenerationPayload,
  buildPublishGenerationPostPayload,
  buildUpdatePostPayload,
  getDefaultPostComposerDraft,
  getPostComposerPreviewStatusLabel,
  getPostComposerSubmitLabel,
  getPublishableGenerations,
  getPublishGenerationMediaKind,
  getPublishGenerationSubtitle,
  validatePostComposerDraft,
} from '../lib/post-new-view-model';
import type { GenerationListItem } from '../lib/types';

function generation(overrides: Partial<GenerationListItem>): GenerationListItem {
  return {
    id: 'gen-1',
    output_url: 'https://cdn.example.com/output.png',
    status: 'succeeded',
    created_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:01:00.000Z',
    model: 'seedream',
    category: 'image',
    title: 'Image result',
    description: 'A polished image',
    prompt: 'Make a glossy product photo',
    ...overrides,
  };
}

describe('post new view model', () => {
  it('keeps only succeeded unposted generations with output media', () => {
    const items = [
      generation({ id: 'ready' }),
      generation({ id: 'failed', status: 'failed' }),
      generation({ id: 'empty', output_url: null, output_urls: [] }),
      generation({ id: 'already-posted', linked_post_id: 'post-1' }),
    ];

    expect(getPublishableGenerations(items).map((item) => item.id)).toEqual(['ready']);
  });

  it('builds a publish payload from generation metadata', () => {
    expect(buildPublishGenerationPayload(generation({ id: 'gen-42', category: 'motion' }))).toEqual({
      generationId: 'gen-42',
      visibility: 'public',
      title: 'Image result',
      description: 'A polished image',
      prompt: 'Make a glossy product photo',
      category: 'motion',
    });
  });

  it('uses readable subtitles for the publish list', () => {
    expect(getPublishGenerationSubtitle(generation({ category: 'video', model: 'seedance' }))).toContain('Video');
    expect(getPublishGenerationSubtitle(generation({ category: 'ugc-ad', model: 'seedance' }))).toContain('UGC ad');
    expect(getPublishGenerationSubtitle(generation({ category: null, model: 'seedream' }))).toContain('Image');
  });

  it('preserves ugc-ad generation category and treats it as video media', () => {
    const item = generation({ id: 'gen-ugc', category: 'ugc-ad', output_url: 'https://cdn.example.com/ad.mp4' });

    expect(buildPublishGenerationPayload(item)).toMatchObject({
      generationId: 'gen-ugc',
      category: 'ugc-ad',
    });
    expect(getPublishGenerationMediaKind(item)).toBe('video');
  });

  it('validates the ordered text composer fields', () => {
    const draft = {
      ...getDefaultPostComposerDraft(),
      mode: 'text' as const,
      title: 'Prompt teardown',
      contentText: 'A reusable breakdown for product hooks.',
      caption: '',
      category: 'text' as const,
    };

    expect(validatePostComposerDraft(draft)).toEqual({ valid: true });
    expect(validatePostComposerDraft({ ...draft, title: ' ' })).toMatchObject({
      valid: false,
      message: 'Add a title before publishing.',
    });
    expect(validatePostComposerDraft({ ...draft, contentText: '', caption: '' })).toMatchObject({
      valid: false,
      message: 'Write the text post or add a caption.',
    });
  });

  it('builds FormData for text posts in the public post order', () => {
    const formData = buildCreatePostFormData({
      ...getDefaultPostComposerDraft(),
      mode: 'text',
      title: 'Text post title',
      contentText: 'Main text content',
      caption: 'Extra caption',
      category: 'text',
      sourceTool: 'Manual',
      visibility: 'public',
    });

    const entries = Array.from((formData as unknown as { entries: () => Iterable<[string, FormDataEntryValue]> }).entries());

    expect(entries).toEqual([
      ['title', 'Text post title'],
      ['description', 'Extra caption'],
      ['body', 'Main text content\n\nExtra caption'],
      ['sourceTool', 'Manual'],
      ['sourceToolSlug', 'manual'],
      ['visibility', 'public'],
      ['postFormat', 'text'],
      ['resourceBundle', JSON.stringify({ accessMode: 'none' })],
    ]);
  });

  it('builds paid unlock bundle payloads only when unlock content exists', () => {
    expect(buildPostResourceBundleInput({
      accessMode: 'paid',
      promptText: 'Exact prompt',
      notesMarkdown: 'Usage notes',
      workflowShareUrl: 'https://workflow.example.com',
      attachmentUrl: 'https://assets.example.com/preset.zip',
      attachmentLabel: 'Preset',
      allowRemix: true,
      summary: '',
      previewText: 'Exact prompt, workflow, preset, and notes.',
      priceUsd: '9',
    })).toEqual({
      accessMode: 'paid',
      summary: 'Prompt, workflow, files, notes, and remix access',
      previewText: 'Exact prompt, workflow, preset, and notes.',
      priceUsdCents: 900,
      resources: {
        promptText: 'Exact prompt',
        notesMarkdown: 'Usage notes',
        workflowShareUrl: 'https://workflow.example.com',
        attachments: [{ kind: 'link', label: 'Preset', url: 'https://assets.example.com/preset.zip' }],
        allowRemix: true,
      },
    });
  });

  it('builds generation publish payloads from the ordered composer', () => {
    const payload = buildPublishGenerationPostPayload(generation({ id: 'gen-post', category: 'video' }), {
      ...getDefaultPostComposerDraft(),
      mode: 'creation',
      title: 'Sports edit prompt',
      caption: 'Broadcast framing details.',
      sourceTool: 'Magicbooklet',
      sourceToolSlug: 'magicbooklet',
      category: 'video',
      visibility: 'public',
      selectedGenerationId: 'gen-post',
      resource: {
        ...getDefaultPostComposerDraft().resource,
        accessMode: 'free',
        promptText: 'Use a stadium broadcast lens.',
        previewText: 'Prompt included.',
      },
    });

    expect(payload).toEqual({
      generationId: 'gen-post',
      visibility: 'public',
      title: 'Sports edit prompt',
      description: undefined,
      body: 'Broadcast framing details.',
      category: 'video',
      sourceTool: 'Magicbooklet',
      sourceToolSlug: 'magicbooklet',
      sourceTools: [{
        toolLabel: 'Magicbooklet',
        toolSlug: 'magicbooklet',
        modelLabel: 'seedream',
        modelSlug: 'seedream',
      }],
      resourceBundle: {
        accessMode: 'free',
        summary: 'Prompt',
        previewText: 'Prompt included.',
        priceUsdCents: 0,
        resources: {
          promptText: 'Use a stadium broadcast lens.',
          notesMarkdown: null,
          workflowShareUrl: null,
          attachments: [],
          allowRemix: false,
        },
      },
    });
  });

  it('requests generation references for public creation posts with saved inputs', () => {
    const item = generation({
      id: 'gen-with-inputs',
      input_media: [{ url: 'https://cdn.example.com/input.jpg', kind: 'image' }],
    });
    const draft = {
      ...getDefaultPostComposerDraft(),
      mode: 'creation',
      title: 'Reference post',
      category: 'image',
      visibility: 'public',
      selectedGenerationId: 'gen-with-inputs',
      sourceTool: 'Magicbooklet',
      sourceToolSlug: 'magicbooklet',
    } as const;
    const payload = buildPublishGenerationPostPayload(item, draft);

    expect(payload).toMatchObject({
      generationId: 'gen-with-inputs',
      visibility: 'public',
      includeGenerationReferences: true,
      resourceBundle: { accessMode: 'none' },
    });
    expect(getPostComposerPreviewStatusLabel(draft, item)).toBe('Free reference package will appear in post details.');
  });

  it('keeps non-public creation posts without unlocks from auto-attaching generation references', () => {
    const item = generation({
      id: 'gen-private-inputs',
      input_media: [{ url: 'https://cdn.example.com/input.jpg', kind: 'image' }],
    });

    for (const visibility of ['private', 'unlisted'] as const) {
      const draft = {
        ...getDefaultPostComposerDraft(),
        mode: 'creation',
        title: 'Private reference post',
        category: 'image',
        visibility,
        selectedGenerationId: 'gen-private-inputs',
        sourceTool: 'Magicbooklet',
        sourceToolSlug: 'magicbooklet',
      } as const;
      const payload = buildPublishGenerationPostPayload(item, draft);

      expect(payload).not.toHaveProperty('includeGenerationReferences');
      expect(getPostComposerPreviewStatusLabel(draft, item)).toBe('No unlock attached.');
    }
  });

  it('uses explicit unlock preview labels before auto generation reference labels', () => {
    const item = generation({
      id: 'gen-unlock-inputs',
      input_media: [{ url: 'https://cdn.example.com/input.jpg', kind: 'image' }],
    });

    expect(getPostComposerPreviewStatusLabel({
      ...getDefaultPostComposerDraft(),
      mode: 'creation',
      visibility: 'public',
      selectedGenerationId: 'gen-unlock-inputs',
      resource: {
        ...getDefaultPostComposerDraft().resource,
        accessMode: 'free',
        promptText: 'Prompt',
        previewText: 'Prompt included.',
      },
    }, item)).toBe('Free unlock will appear in post details.');

    expect(getPostComposerPreviewStatusLabel({
      ...getDefaultPostComposerDraft(),
      mode: 'creation',
      visibility: 'public',
      selectedGenerationId: 'gen-unlock-inputs',
      resource: {
        ...getDefaultPostComposerDraft().resource,
        accessMode: 'paid',
        promptText: 'Prompt',
        previewText: 'Prompt included.',
      },
    }, item)).toBe('Paid unlock will appear in post details.');
  });

  it('adds structured source tool metadata for uploaded media posts', () => {
    const formData = buildCreatePostFormData({
      ...getDefaultPostComposerDraft(),
      mode: 'upload',
      title: 'Uploaded edit',
      caption: 'Made with a video tool.',
      category: 'video',
      sourceTool: 'Runway',
      sourceToolSlug: 'runway',
      upload: null,
    });

    expect(formData.get('sourceTools')).toBe(JSON.stringify([{
      toolLabel: 'Runway',
      toolSlug: 'runway',
    }]));
  });

  it('returns submit labels for publish visibility and edit states', () => {
    expect(getPostComposerSubmitLabel({ visibility: 'public', isEditMode: false, isPending: false })).toBe('Publish public');
    expect(getPostComposerSubmitLabel({ visibility: 'unlisted', isEditMode: false, isPending: false })).toBe('Save unlisted');
    expect(getPostComposerSubmitLabel({ visibility: 'private', isEditMode: false, isPending: false })).toBe('Save private');
    expect(getPostComposerSubmitLabel({ visibility: 'public', isEditMode: true, isPending: false })).toBe('Save changes');
    expect(getPostComposerSubmitLabel({ visibility: 'private', isEditMode: false, isPending: true })).toBe('Publishing');
    expect(getPostComposerSubmitLabel({ visibility: 'private', isEditMode: true, isPending: true })).toBe('Saving');
  });

  describe('edit payload builder', () => {
    it('preserves existing post fields when generation-backed', () => {
      const draft = {
        ...getDefaultPostComposerDraft(),
        title: 'New Title',
        caption: 'New Caption',
        visibility: 'private' as const,
        resource: {
          ...getDefaultPostComposerDraft().resource,
          accessMode: 'free' as const,
          promptText: 'New Prompt',
          previewText: 'New Preview',
        },
      };

      const payload = buildUpdatePostPayload(true, draft);
      expect(payload).toEqual({
        visibility: 'private',
        resourceBundle: {
          accessMode: 'free',
          summary: 'Prompt',
          previewText: 'New Preview',
          priceUsdCents: 0,
          resources: {
            promptText: 'New Prompt',
            notesMarkdown: null,
            workflowShareUrl: null,
            attachments: [],
            allowRemix: false,
          },
        },
      });
    });

    it('submits text post edits without duplicating the caption into the body', () => {
      const draft = {
        ...getDefaultPostComposerDraft(),
        title: 'New Title',
        caption: 'New Caption',
        contentText: 'New Content',
        visibility: 'private' as const,
        category: 'video' as const,
        sourceTool: 'Manual',
        sourceToolSlug: 'manual',
        resource: {
          ...getDefaultPostComposerDraft().resource,
          accessMode: 'free' as const,
          promptText: 'New Prompt',
          previewText: 'New Preview',
        },
      };

      const payload = buildUpdatePostPayload(false, draft);
      expect(payload).toEqual({
        title: 'New Title',
        description: 'New Caption',
        body: 'New Content',
        visibility: 'private',
        category: 'video',
        sourceTool: 'Manual',
        sourceToolSlug: 'manual',
        resourceBundle: {
          accessMode: 'free',
          summary: 'Prompt',
          previewText: 'New Preview',
          priceUsdCents: 0,
          resources: {
            promptText: 'New Prompt',
            notesMarkdown: null,
            workflowShareUrl: null,
            attachments: [],
            allowRemix: false,
          },
        },
      });
    });

    it('submits uploaded media edits with the caption as the post body', () => {
      const draft = {
        ...getDefaultPostComposerDraft(),
        mode: 'upload' as const,
        title: 'Media Title',
        caption: 'Media Caption',
        contentText: 'Ignored media notes',
        visibility: 'unlisted' as const,
        category: 'image' as const,
        upload: {
          uri: 'file:///tmp/image.jpg',
          name: 'image.jpg',
          type: 'image/jpeg',
        },
      };

      const payload = buildUpdatePostPayload(false, draft);
      expect(payload).toMatchObject({
        title: 'Media Title',
        description: 'Media Caption',
        body: 'Media Caption',
        visibility: 'unlisted',
        category: 'image',
        sourceTools: [{
          toolLabel: 'Manual',
          toolSlug: 'manual',
        }],
      });
    });
  });

  describe('publishable generation selection', () => {
    it('only allows publishable generations', () => {
      const items = [
        generation({ id: 'succeeded-unposted', status: 'succeeded', output_url: 'https://example.com', linked_post_id: null }),
        generation({ id: 'succeeded-posted', status: 'succeeded', output_url: 'https://example.com', linked_post_id: 'post-1' }),
        generation({ id: 'failed-unposted', status: 'failed', output_url: 'https://example.com', linked_post_id: null }),
        generation({ id: 'no-output', status: 'succeeded', output_url: null, output_urls: [], linked_post_id: null }),
      ];

      const publishable = getPublishableGenerations(items);
      expect(publishable.map((p) => p.id)).toEqual(['succeeded-unposted']);
    });
  });
});
