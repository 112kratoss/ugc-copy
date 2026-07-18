import { describe, expect, it } from 'vitest';
import {
  buildCreatePostFormData,
  buildOptimisticOwnerPostListItem,
  buildPostComposerMediaItemsPayload,
  buildPostResourceBundleInput,
  buildPublishGenerationPayload,
  buildPublishGenerationPostPayload,
  buildUpdatePostPayload,
  getPostComposerPublishActions,
  applyCreationPromptResource,
  getDefaultPostComposerDraft,
  getExplicitPublishGeneration,
  getPostComposerPackageStatus,
  getPostComposerPreviewStatusLabel,
  getPostComposerReadiness,
  getPostComposerSectionSummary,
  getPostComposerSubmitLabel,
  getPublishableGenerations,
  isTemplateGeneration,
  getPublishGenerationMediaKind,
  getPublishGenerationSubtitle,
  POST_COMPOSER_SOURCE_OPTIONS,
  validatePostComposerDraft,
} from '../lib/post-new-view-model';
import type { GenerationListItem } from '../lib/types';

function generation(overrides: Partial<GenerationListItem>): GenerationListItem {
  return {
    id: 'gen-1',
    output_url: 'https://cdn.example.com/output.png',
    preview_url: 'https://cdn.example.com/output.preview.webp',
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
  it('ships a useful taxonomized source-tool catalog for offline post attribution', () => {
    const expectedSlugs = [
      'magicbooklet',
      'adobe-firefly',
      'midjourney',
      'runway',
      'google-gemini-flow',
      'openai-chatgpt',
      'kling',
      'higgsfield',
      'freepik',
      'leonardo-ai',
      'black-forest-labs',
      'stability-ai',
      'ideogram',
      'recraft',
      'krea',
      'luma-dream-machine',
      'pika',
      'capcut',
      'canva',
      'adobe-photoshop',
      'adobe-premiere-pro',
      'adobe-after-effects',
      'davinci-resolve',
      'final-cut-pro',
      'blender',
      'figma',
      'comfyui',
      'heygen',
      'elevenlabs',
      'sora',
      'other',
    ];

    expect(POST_COMPOSER_SOURCE_OPTIONS.map((tool) => tool.slug)).toEqual(expect.arrayContaining(expectedSlugs));
    expect(POST_COMPOSER_SOURCE_OPTIONS.every((tool) => (
      Boolean(tool.toolType)
      && Boolean(tool.catalogTier)
      && Boolean(tool.status)
      && Array.isArray(tool.capabilities)
      && Array.isArray(tool.aliases)
    ))).toBe(true);
    expect(POST_COMPOSER_SOURCE_OPTIONS.flatMap((tool) => tool.models).every((model) => (
      Boolean(model.status)
      && Array.isArray(model.capabilities)
      && Array.isArray(model.aliases)
    ))).toBe(true);
    expect(POST_COMPOSER_SOURCE_OPTIONS.find((tool) => tool.slug === 'sora')).toMatchObject({
      catalogTier: 'historical',
      status: 'sunset',
    });
  });

  it('keeps only succeeded unposted generations with output media', () => {
    const items = [
      generation({ id: 'ready' }),
      generation({ id: 'failed', status: 'failed' }),
      generation({ id: 'empty', output_url: null, output_urls: [] }),
      generation({ id: 'already-posted', linked_post_id: 'post-1' }),
    ];

    expect(getPublishableGenerations(items).map((item) => item.id)).toEqual(['ready']);
  });

  it('allows only an explicit canonical template result before its grid preview is ready', () => {
    const templateResult = generation({
      id: 'template-result',
      preview_url: null,
      previewUrl: null,
      media: { gridReady: false } as GenerationListItem['media'],
      origin: 'template',
      template: { runId: 'run-1', templateId: 'template-1', templateTitle: 'Ghost rider' },
    });
    const ordinaryPending = generation({
      id: 'ordinary-pending',
      preview_url: null,
      previewUrl: null,
      media: { gridReady: false } as GenerationListItem['media'],
    });

    expect(getPublishableGenerations([templateResult, ordinaryPending])).toEqual([]);
    expect(getExplicitPublishGeneration([templateResult], templateResult.id)).toBe(templateResult);
    expect(getExplicitPublishGeneration([ordinaryPending], ordinaryPending.id)).toBeNull();
    expect(getExplicitPublishGeneration([{ ...templateResult, linked_post_id: 'post-1' }], templateResult.id)).toBeNull();
    expect(isTemplateGeneration(templateResult)).toBe(true);
  });

  it('forces template-origin publishing to final media only', () => {
    const item = generation({
      id: 'template-result',
      origin: 'template',
      template: { runId: 'run-1', templateId: 'template-1', templateTitle: 'Private recipe' },
      input_media: [{ url: 'https://private.example.com/input.jpg', kind: 'image' }],
    });
    const draft = {
      ...getDefaultPostComposerDraft(),
      mode: 'creation' as const,
      selectedGenerationId: item.id,
      resource: {
        ...getDefaultPostComposerDraft().resource,
        accessMode: 'paid' as const,
        previewText: 'Private recipe',
        priceUsd: '9',
        selectedKinds: {
          ...getDefaultPostComposerDraft().resource.selectedKinds,
          prompt: true,
        },
        promptText: 'Do not publish this prompt',
      },
      creationPackage: {
        attachGenerationReferences: true,
        attachPromptResource: true,
      },
    };

    const payload = buildPublishGenerationPostPayload(item, draft);
    expect(payload.resourceBundle).toEqual({ accessMode: 'none' });
    expect(payload).not.toHaveProperty('includeGenerationReferences');
  });

  it('builds a publish payload from generation metadata', () => {
    expect(buildPublishGenerationPayload(generation({ id: 'gen-42', category: 'motion' }))).toEqual({
      generationId: 'gen-42',
      visibility: 'public',
      title: 'Image result',
      description: 'A polished image',
      prompt: 'Make a glossy product photo',
      category: 'video',
    });
  });

  it('uses readable subtitles for the publish list', () => {
    expect(getPublishGenerationSubtitle(generation({ category: 'video', model: 'seedance' }))).toContain('Video');
    expect(getPublishGenerationSubtitle(generation({ category: 'ugc-ad', model: 'seedance' }))).toContain('Video');
    expect(getPublishGenerationSubtitle(generation({ category: null, model: 'seedream' }))).toContain('Image');
  });

  it('normalizes legacy ugc-ad generation category to video media', () => {
    const item = generation({ id: 'gen-ugc', category: 'ugc-ad', output_url: 'https://cdn.example.com/ad.mp4' });

    expect(buildPublishGenerationPayload(item)).toMatchObject({
      generationId: 'gen-ugc',
      category: 'video',
    });
    expect(getPublishGenerationMediaKind(item)).toBe('video');
  });

  it('validates the ordered text composer fields', () => {
    const draft = {
      ...getDefaultPostComposerDraft(),
      mode: 'text' as const,
      title: 'Prompt teardown',
      proofMode: 'text' as const,
      contentText: 'A reusable breakdown for product hooks.',
      caption: '',
      category: 'text' as const,
    };

    expect(validatePostComposerDraft(draft)).toEqual({ valid: true });
    expect(validatePostComposerDraft({ ...draft, title: ' ' })).toEqual({ valid: true });
    expect(validatePostComposerDraft({ ...draft, contentText: '', caption: '' })).toMatchObject({
      valid: false,
      message: 'Write the text post or add a caption.',
    });
  });

  it('builds FormData for text posts in the public post order', () => {
    const formData = buildCreatePostFormData({
      ...getDefaultPostComposerDraft(),
      mode: 'text',
      proofMode: 'text',
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

  it('serializes ordered multi-media gallery items for upload posts', () => {
    const draft = {
      ...getDefaultPostComposerDraft(),
      mode: 'upload' as const,
      proofMode: 'media' as const,
      title: 'Gallery post',
      caption: 'Five references in order.',
      category: 'image' as const,
      mediaItems: [
        {
          id: 'media-1',
          uri: 'file:///cover.jpg',
          name: 'cover.jpg',
          type: 'image/jpeg',
          mediaKind: 'image' as const,
          storagePath: 'uploads/user-1/cover.jpg',
        },
        {
          id: 'media-2',
          uri: 'file:///clip.mp4',
          name: 'clip.mp4',
          type: 'video/mp4',
          mediaKind: 'video' as const,
          storagePath: 'uploads/user-1/clip.mp4',
        },
      ],
      madeWithRows: [{
        id: 'tool-1',
        toolLabel: 'Runway',
        toolSlug: 'runway',
        modelLabel: 'Gen-4',
        modelSlug: 'gen-4',
        createTool: false,
        createModel: false,
      }],
    };

    expect(buildPostComposerMediaItemsPayload(draft)).toEqual([
      {
        storagePath: 'uploads/user-1/cover.jpg',
        contentType: 'image/jpeg',
        originalName: 'cover.jpg',
      },
      {
        storagePath: 'uploads/user-1/clip.mp4',
        contentType: 'video/mp4',
        originalName: 'clip.mp4',
      },
    ]);

    const formData = buildCreatePostFormData(draft);
    expect(formData.get('mediaItems')).toBe(JSON.stringify([
      {
        storagePath: 'uploads/user-1/cover.jpg',
        contentType: 'image/jpeg',
        originalName: 'cover.jpg',
      },
      {
        storagePath: 'uploads/user-1/clip.mp4',
        contentType: 'video/mp4',
        originalName: 'clip.mp4',
      },
    ]));
    expect(formData.get('sourceTools')).toBe(JSON.stringify([{
      toolLabel: 'Runway',
      toolSlug: 'runway',
      modelLabel: 'Gen-4',
      modelSlug: 'gen-4',
    }]));
  });

  it('builds paid unlock bundle payloads only when unlock content exists', () => {
    expect(buildPostResourceBundleInput({
      ...getDefaultPostComposerDraft().resource,
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
    })).toMatchObject({
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

  it('builds web-style resource bundles with selected types, files, remix, and sections', () => {
    expect(buildPostResourceBundleInput({
      ...getDefaultPostComposerDraft().resource,
      accessMode: 'paid',
      selectedKinds: {
        prompt: true,
        workflow: true,
        files: true,
        notes: true,
        remix: true,
      },
      promptText: 'Exact prompt',
      notesMarkdown: 'Usage notes',
      workflowShareUrl: 'https://workflow.example.com',
      attachments: [{
        id: 'att-1',
        kind: 'file',
        label: 'Preset file',
        storagePath: 'user-1/preset.workflow',
        contentType: 'application/json',
        sizeBytes: 128,
        resourceType: 'source_file',
        role: 'primary',
        remixUse: 'import_source',
      }],
      sections: [{
        id: 'section-1',
        title: 'Scene 1',
        kind: 'scene',
        description: 'Opening setup',
        promptText: 'Scene prompt',
        workflowShareUrl: '',
        notesMarkdown: 'Scene notes',
        allowRemix: true,
        attachments: [],
      }],
      organizeSections: true,
      allowRemix: true,
      summary: '',
      previewText: 'Prompt, files, notes, and sections included.',
      priceUsd: '12',
    })).toEqual({
      accessMode: 'paid',
      summary: 'Prompt, workflow, files, notes, and remix access',
      previewText: 'Prompt, files, notes, and sections included.',
      priceUsdCents: 1200,
      resources: {
        promptText: 'Exact prompt',
        notesMarkdown: 'Usage notes',
        workflowShareUrl: 'https://workflow.example.com',
        attachments: [{
          kind: 'file',
          label: 'Preset file',
          storagePath: 'user-1/preset.workflow',
          contentType: 'application/json',
          sizeBytes: 128,
          resourceType: 'source_file',
          role: 'primary',
          remixUse: 'import_source',
        }],
        allowRemix: true,
        sections: [{
          id: 'section-1',
          title: 'Scene 1',
          kind: 'scene',
          description: 'Opening setup',
          sortOrder: 0,
        }],
        items: expect.arrayContaining([
          expect.objectContaining({ type: 'prompt', title: 'Prompt', textContent: 'Exact prompt', sectionId: null }),
          expect.objectContaining({ type: 'source_file', title: 'Preset file', storagePath: 'user-1/preset.workflow', sectionId: null }),
          expect.objectContaining({ type: 'prompt', title: 'Scene 1 prompt', textContent: 'Scene prompt', sectionId: 'section-1' }),
          expect.objectContaining({ type: 'remix_access', title: 'Scene 1 remix access', sectionId: 'section-1' }),
        ]),
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

    expect(payload).toMatchObject({
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

  it('keeps normal creation posts from auto-attaching saved generation references', () => {
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
      resourceBundle: { accessMode: 'none' },
    });
    expect(payload).not.toHaveProperty('includeGenerationReferences');
    expect(getPostComposerPreviewStatusLabel(draft, item)).toBe('No resource package configured.');
  });

  it('requests generation references only when the explicit creation package toggle is enabled', () => {
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
      creationPackage: {
        ...getDefaultPostComposerDraft().creationPackage,
        attachGenerationReferences: true,
      },
    } as const;
    const payload = buildPublishGenerationPostPayload(item, draft);

    expect(payload).toMatchObject({
      generationId: 'gen-with-inputs',
      visibility: 'public',
      includeGenerationReferences: true,
      resourceBundle: { accessMode: 'none' },
    });
    expect(getPostComposerPackageStatus(draft, item)).toEqual(expect.objectContaining({
      label: 'References attached',
      state: 'ready',
    }));
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
      expect(getPostComposerPreviewStatusLabel(draft, item)).toBe('No resource package configured.');
    }
  });

  it('prefills a free resource package from a creation prompt when enabled', () => {
    const item = generation({
      id: 'gen-prompt-package',
      prompt: 'Exact cinematic product prompt',
    });

    const draft = applyCreationPromptResource({
      ...getDefaultPostComposerDraft(),
      mode: 'creation',
      title: 'Prompt package',
      category: 'image',
      selectedGenerationId: 'gen-prompt-package',
      resource: {
        ...getDefaultPostComposerDraft().resource,
        accessMode: 'none',
        promptText: '',
        previewText: '',
      },
    }, item, true);

    expect(draft.creationPackage.attachPromptResource).toBe(true);
    expect(draft.resource.accessMode).toBe('free');
    expect(draft.resource.promptText).toBe('Exact cinematic product prompt');
    expect(draft.resource.previewText).toBe('Includes the exact reusable prompt.');
    expect(buildPublishGenerationPostPayload(item, draft).resourceBundle).toMatchObject({
      accessMode: 'free',
      summary: 'Prompt',
      previewText: 'Includes the exact reusable prompt.',
      priceUsdCents: 0,
      resources: {
        promptText: 'Exact cinematic product prompt',
        notesMarkdown: null,
        workflowShareUrl: null,
        attachments: [],
        allowRemix: false,
      },
    });
  });

  it('summarizes post sections and creation package state for the Phase 4 composer', () => {
    const item = generation({
      id: 'gen-summary',
      input_media: [{ url: 'https://cdn.example.com/input.jpg', kind: 'image' }],
    });
    const draft = {
      ...getDefaultPostComposerDraft(),
      mode: 'creation' as const,
      title: 'Creator card',
      caption: 'Post caption',
      visibility: 'public' as const,
      category: 'image' as const,
      selectedGenerationId: 'gen-summary',
      sourceTool: 'Magicbooklet',
      sourceToolSlug: 'magicbooklet',
      creationPackage: {
        attachGenerationReferences: true,
        attachPromptResource: false,
      },
    };

    expect(getPostComposerSectionSummary(draft, item)).toEqual({
      publicPost: 'Public · Creation selected',
      postSettings: 'Magicbooklet · Image',
      resourcePackage: 'References attached',
    });
    expect(getPostComposerPackageStatus(draft, item)).toEqual(expect.objectContaining({
      label: 'References attached',
      body: 'Creation input media will be available from the post details.',
      state: 'ready',
    }));
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
    }, item)).toBe('Free resource package will appear in post details.');

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
    }, item)).toBe('Paid resource package will appear in post details.');
  });

  it('summarizes guided composer readiness for public post, unlock, preview, and publish', () => {
    const draft = {
      ...getDefaultPostComposerDraft(),
      mode: 'text' as const,
      title: 'Prompt teardown',
      contentText: 'A reusable breakdown.',
      resource: {
        ...getDefaultPostComposerDraft().resource,
        accessMode: 'paid' as const,
        promptText: 'Exact prompt',
        previewText: 'Prompt, notes, and usage included.',
        priceUsd: '9',
      },
    };

    expect(getPostComposerReadiness(draft)).toEqual([
      expect.objectContaining({
        id: 'public-post',
        label: 'Public post ready',
        state: 'ready',
      }),
      expect.objectContaining({
        id: 'unlock',
        label: 'Resource package ready',
        body: 'Paid resource package will appear in post details.',
        state: 'ready',
      }),
      expect.objectContaining({
        id: 'preview',
        label: 'Preview updates live',
        state: 'ready',
      }),
      expect.objectContaining({
        id: 'publish',
        label: 'Ready to publish',
        state: 'ready',
      }),
    ]);
  });

  it('adds structured source tool metadata for uploaded media posts', () => {
    const formData = buildCreatePostFormData({
      ...getDefaultPostComposerDraft(),
      mode: 'upload',
      proofMode: 'media',
      title: 'Uploaded edit',
      caption: 'Made with a video tool.',
      category: 'video',
      madeWithRows: [{
        id: 'tool-1',
        toolLabel: 'Runway',
        toolSlug: 'runway',
        modelLabel: 'Gen-4',
        modelSlug: 'gen-4',
        createTool: false,
        createModel: false,
      }],
      mediaItems: [{
        id: 'media-1',
        uri: 'file:///tmp/image.jpg',
        name: 'image.jpg',
        type: 'image/jpeg',
        mediaKind: 'image',
        storagePath: 'uploads/user-1/image.jpg',
      }],
    });

    expect(formData.get('sourceTools')).toBe(JSON.stringify([{
      toolLabel: 'Runway',
      toolSlug: 'runway',
      modelLabel: 'Gen-4',
      modelSlug: 'gen-4',
    }]));
  });

  it('returns web-style publish actions with explicit target visibility', () => {
    expect(getPostComposerPublishActions({ selectedVisibility: 'public', isEditMode: false, isPending: false })).toEqual([
      { id: 'private', label: 'Save private', visibility: 'private', variant: 'secondary', disabled: false, loading: false },
      { id: 'public', label: 'Publish public', visibility: 'public', variant: 'primary', disabled: false, loading: false },
    ]);
    expect(getPostComposerPublishActions({ selectedVisibility: 'unlisted', isEditMode: false, isPending: false })).toEqual([
      { id: 'private', label: 'Save private', visibility: 'private', variant: 'secondary', disabled: false, loading: false },
      { id: 'unlisted', label: 'Save unlisted', visibility: 'unlisted', variant: 'secondary', disabled: false, loading: false },
      { id: 'public', label: 'Publish public', visibility: 'public', variant: 'primary', disabled: false, loading: false },
    ]);
    expect(getPostComposerPublishActions({ selectedVisibility: 'public', isEditMode: true, isPending: true, pendingVisibility: 'public' })).toEqual([
      { id: 'private', label: 'Save private', visibility: 'private', variant: 'secondary', disabled: true, loading: false },
      { id: 'public', label: 'Saving', visibility: 'public', variant: 'primary', disabled: true, loading: true },
    ]);
  });

  it('builds an optimistic owner post with the selected upload preview', () => {
    const post = buildOptimisticOwnerPostListItem('post-123', {
      ...getDefaultPostComposerDraft(),
      mode: 'upload',
      proofMode: 'media',
      title: 'Manual upload',
      caption: 'Uploaded from phone',
      visibility: 'public',
      category: 'image',
      mediaItems: [{
        id: 'media-1',
        uri: 'file:///tmp/cover.png',
        previewUrl: 'file:///tmp/cover.png',
        name: 'cover.png',
        type: 'image/png',
        mediaKind: 'image',
        storagePath: 'uploads/user-1/cover.png',
      }],
    }, '2026-06-18T07:30:00.000Z');

    expect(post).toMatchObject({
      id: 'post-123',
      title: 'Manual upload',
      visibility: 'public',
      mediaUrl: 'file:///tmp/cover.png',
      mediaKind: 'image',
      description: 'Uploaded from phone',
      category: 'image',
      postFormat: 'mixed',
      sourceTool: 'Manual',
      sourceToolSlug: 'manual',
      mediaItems: [{
        id: 'media-1',
        url: 'file:///tmp/cover.png',
        previewUrl: 'file:///tmp/cover.png',
        mediaKind: 'image',
        contentType: 'image/png',
        originalName: 'cover.png',
        sortOrder: 0,
      }],
    });
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
      expect(payload).toMatchObject({
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
      expect(payload).toMatchObject({
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
