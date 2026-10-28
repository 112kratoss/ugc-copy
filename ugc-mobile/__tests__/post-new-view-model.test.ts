import { describe, expect, it } from 'vitest';
import publicPostQuality from '../../contracts/public-post-quality-v1.json';
import {
  buildCreatePostFormData,
  buildOptimisticOwnerPostListItem,
  upsertOptimisticOwnerPostInfiniteData,
  buildPostComposerMediaItemsPayload,
  buildPostResourceBundleInput,
  buildPublishGenerationPostPayload,
  buildUpdatePostPayload,
  createMadeWithRow,
  createPostComposerResourceCard,
  applyCreationPromptResource,
  getComposerVisibility,
  getDefaultPostComposerDraft,
  getExplicitPublishGeneration,
  getPostComposerDetailErrors,
  getPublicPostQualityError,
  hasCreationPromptCard,
  TITLE_MAX_LENGTH,
  getPostComposerPackageStatus,
  getPostComposerPriceTokens,
  getPostComposerPreviewStatusLabel,
  getPostComposerResourceCardErrors,
  getPostComposerSubmitLabel,
  hydratePostComposerResourceCards,
  migratePostComposerResourceDraftToCards,
  sanitizePostComposerResourceCardIds,
  isPostComposerResourceCardReady,
  isTemplateGeneration,
  getPublishGenerationMediaKind,
  postComposerReturnPath,
  getPublishGenerationTitlePrefill,
  getCreationPostTitleSuggestion,
  getCreationTitleSuggestionHint,
  followCreationTitleSuggestion,
  POST_COMPOSER_RESOURCE_CARD_OPTIONS,
  POST_COMPOSER_SOURCE_OPTIONS,
  validatePostComposerDraft,
  type PostComposerDraft,
} from '../lib/post-new-view-model';
import { normalizeAuthReturnTo } from '../lib/auth-navigation';
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
  it('offers every agreed resource card type, including protected remix links', () => {
    expect(POST_COMPOSER_RESOURCE_CARD_OPTIONS.map((option) => option.id)).toEqual([
      'prompt',
      'reference_media',
      'settings',
      'workflow',
      'source_assets',
      'guide',
      'external_link',
      'remix_link',
      'other',
    ]);
  });

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

  // The server publishes any succeeded run with output; the preview is a
  // separate job. A named creation whose poster is still running, or failed,
  // used to end the composer on "Could not load this creation".
  it('opens any named finished creation with output, whatever its preview', () => {
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
      media: { gridReady: false, status: 'pending' } as GenerationListItem['media'],
    });
    const posterFailed = generation({
      id: 'poster-failed',
      category: 'video',
      output_url: 'https://cdn.example.com/output.mp4',
      preview_url: null,
      previewUrl: null,
      media: { gridReady: false, status: 'failed' } as GenerationListItem['media'],
    });
    const outputsOnly = generation({ id: 'outputs-only', output_url: null, output_urls: ['https://cdn.example.com/a.png'], preview_url: null });

    expect(getExplicitPublishGeneration([templateResult], templateResult.id)).toBe(templateResult);
    expect(getExplicitPublishGeneration([ordinaryPending], ordinaryPending.id)).toBe(ordinaryPending);
    expect(getExplicitPublishGeneration([posterFailed], posterFailed.id)).toBe(posterFailed);
    expect(getExplicitPublishGeneration([outputsOnly], outputsOnly.id)).toBe(outputsOnly);
    expect(isTemplateGeneration(templateResult)).toBe(true);
  });

  it('still refuses a named creation the server could not publish', () => {
    const ready = generation({ id: 'ready' });

    expect(getExplicitPublishGeneration([{ ...ready, linked_post_id: 'post-1' }], 'ready')).toBeNull();
    expect(getExplicitPublishGeneration([{ ...ready, status: 'processing' }], 'ready')).toBeNull();
    expect(getExplicitPublishGeneration([{ ...ready, status: 'failed' }], 'ready')).toBeNull();
    expect(getExplicitPublishGeneration([{ ...ready, output_url: null, output_urls: [] }], 'ready')).toBeNull();
    expect(getExplicitPublishGeneration([ready], 'another-id')).toBeNull();
    expect(getExplicitPublishGeneration([ready], null)).toBeNull();
  });

  describe('the return path sign-in comes back to', () => {
    it('reopens the composer with every param it was opened with', () => {
      expect(postComposerReturnPath({ generationId: 'gen-1', shareAfterPublish: '1' }))
        .toBe('/post/new?generationId=gen-1&shareAfterPublish=1');
      expect(postComposerReturnPath({ postId: 'post-1', focus: 'resources' }))
        .toBe('/post/new?postId=post-1&focus=resources');
    });

    it('encodes values and leaves out empty ones', () => {
      expect(postComposerReturnPath({ generationId: 'gen 1&x=2', postId: '  ', focus: null }))
        .toBe('/post/new?generationId=gen%201%26x%3D2');
      expect(postComposerReturnPath({})).toBe('/post/new');
    });

    it('is a path the sign-in screen accepts as it is', () => {
      const path = postComposerReturnPath({ generationId: 'gen-1', focus: 'resources', shareAfterPublish: '1' });
      expect(normalizeAuthReturnTo(path)).toBe(path);
    });
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
      },
    };

    const payload = buildPublishGenerationPostPayload(item, draft);
    expect(payload.resourceBundle).toEqual({ accessMode: 'none' });
    expect(payload).not.toHaveProperty('includeGenerationReferences');
  });

  it('normalizes legacy ugc-ad and motion generation categories to video media', () => {
    expect(getPublishGenerationMediaKind(generation({ id: 'gen-ugc', category: 'ugc-ad', output_url: 'https://cdn.example.com/ad.mp4' }))).toBe('video');
    expect(getPublishGenerationMediaKind(generation({ id: 'gen-42', category: 'motion' }))).toBe('video');
    expect(getPublishGenerationMediaKind(generation({ category: null }))).toBe('image');
  });

  // The raw prompt used to be the fallback, so a creator selling that prompt
  // published its opening as the post's public title.
  it('prefills a creation post title from its own title or its template, never its prompt', () => {
    expect(getPublishGenerationTitlePrefill(generation({ title: 'Image result' }))).toBe('Image result');
    expect(getPublishGenerationTitlePrefill(generation({
      title: null,
      origin: 'template',
      template: { runId: 'run-1', templateId: 'template-1', templateTitle: 'Ghost rider' },
    }))).toBe('Ghost rider');
    expect(getPublishGenerationTitlePrefill(generation({ title: null, prompt: 'Make a glossy product photo' }))).toBe('');
    expect(getPublishGenerationTitlePrefill(generation({ title: 't'.repeat(TITLE_MAX_LENGTH + 20) }))).toHaveLength(TITLE_MAX_LENGTH);

    const untitled = generation({ title: null, prompt: 'Exact prompt for sale' });
    expect(buildPublishGenerationPostPayload(untitled, {
      ...getDefaultPostComposerDraft(),
      mode: 'creation',
      selectedGenerationId: untitled.id,
    }).title).toBeUndefined();
  });

  // Most creations have no title, and typing one was where people stopped.
  // The suggestion may use the prompt only while the post has no recipe.
  describe('the title a post of a creation starts with', () => {
    const untitled = generation({
      title: null,
      model: 'seedance-2',
      category: 'video',
      prompt: 'A red fox running through fresh snow at dawn, cinematic, 35mm',
    });
    const creationDraft = (overrides: Partial<PostComposerDraft> = {}): PostComposerDraft => ({
      ...getDefaultPostComposerDraft(),
      mode: 'creation',
      selectedGenerationId: untitled.id,
      title: 'Red fox running through fresh snow at dawn',
      ...overrides,
    });
    const withRecipe = (draft: PostComposerDraft): PostComposerDraft => ({
      ...draft,
      resource: { ...draft.resource, accessMode: 'paid' },
    });

    it('is the creation’s own title, else a suggestion from the prompt, else one naming the creation', () => {
      expect(getCreationPostTitleSuggestion(generation({ title: 'Image result' })))
        .toEqual({ title: 'Image result', source: 'creation' });
      expect(getCreationPostTitleSuggestion(untitled))
        .toEqual({ title: 'Red fox running through fresh snow at dawn', source: 'prompt' });
      expect(getCreationPostTitleSuggestion(untitled, 'paid')).toEqual({ title: 'Video recipe', source: 'kind' });
      expect(getCreationPostTitleSuggestion(generation({ title: null, prompt: null, model: 'kling-2.6/motion-control', category: null })))
        .toEqual({ title: 'Motion transfer', source: 'kind' });
      // A motion prompt says how to move, not what is shown; the creation mode says it is one.
      expect(getCreationPostTitleSuggestion(generation({
        title: null,
        prompt: 'No distortion, the character’s movements are consistent with the video.',
        model: 'kling-3.0/video',
        category: 'video',
        creationMode: 'motion',
      }))).toEqual({ title: 'Motion transfer', source: 'kind' });
    });

    it('swaps an untouched suggestion when a recipe is turned on or off, and never a typed title', () => {
      const suggested = creationDraft();
      expect(followCreationTitleSuggestion(suggested, withRecipe(suggested), untitled).title).toBe('Video recipe');
      const recipeSuggested = withRecipe(creationDraft({ title: 'Video recipe' }));
      expect(followCreationTitleSuggestion(recipeSuggested, { ...recipeSuggested, resource: { ...recipeSuggested.resource, accessMode: 'none' } }, untitled).title)
        .toBe('Red fox running through fresh snow at dawn');

      const typed = creationDraft({ title: 'Dawn fox' });
      expect(followCreationTitleSuggestion(typed, withRecipe(typed), untitled).title).toBe('Dawn fox');
      // Turning the exact-prompt card on also turns a recipe on: a free one, which
      // hands its prompt to anyone, so the prompt's title stays (owner, 2026-10-29).
      const withPromptCard = applyCreationPromptResource(suggested, untitled, true);
      expect(withPromptCard.resource.accessMode).toBe('free');
      expect(followCreationTitleSuggestion(suggested, withPromptCard, untitled).title).toBe('Red fox running through fresh snow at dawn');
      // A creation's own title is the creator's, recipe or not.
      const titled = generation({ title: 'Fox study' });
      const own = creationDraft({ title: 'Fox study' });
      expect(followCreationTitleSuggestion(own, withRecipe(own), titled).title).toBe('Fox study');
      // Unless it is the prompt's opening: a public post saves its title onto the
      // creation, so a suggestion kept once comes back as the creation's own.
      const titledFromPrompt = generation({ ...untitled, title: 'Red fox running through fresh snow at dawn' });
      const kept = creationDraft();
      expect(followCreationTitleSuggestion(kept, withRecipe(kept), titledFromPrompt).title).toBe('Video recipe');
    });

    it('says the title is a suggestion until the creator changes it', () => {
      expect(getCreationTitleSuggestionHint(creationDraft(), untitled)).toBe('Suggested from your prompt. Edit it if you like.');
      expect(getCreationTitleSuggestionHint(withRecipe(creationDraft({ title: 'Video recipe' })), untitled))
        .toBe('Suggested. A paid recipe keeps your prompt off the post.');
      expect(getCreationTitleSuggestionHint(creationDraft({ title: 'Dawn fox' }), untitled)).toBeNull();
      expect(getCreationTitleSuggestionHint(creationDraft({ title: 'Fox study' }), generation({ title: 'Fox study' }))).toBeNull();
      expect(getCreationTitleSuggestionHint({ ...creationDraft(), mode: 'upload' }, untitled)).toBeNull();
    });
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
    // Titles are required, matching the server and the web composer. The body
    // is no longer a fallback source for one.
    expect(validatePostComposerDraft({ ...draft, title: ' ' })).toMatchObject({
      valid: false,
      message: 'Add a title for your post.',
    });
    expect(validatePostComposerDraft({ ...draft, contentText: '', caption: '' })).toMatchObject({
      valid: false,
      message: 'Write the text post before continuing.',
    });
    // A Story kept from the media format is not shown in text mode and is not
    // published, so it cannot stand in for the post text.
    expect(validatePostComposerDraft({ ...draft, contentText: '', caption: 'A hidden story' })).toMatchObject({
      valid: false,
      message: 'Write the text post before continuing.',
    });
    // Both are missing here, and the title is reported first because that is
    // the field the author reaches first in the composer.
    expect(validatePostComposerDraft({ ...draft, title: '', contentText: '', caption: '' })).toMatchObject({
      valid: false,
      message: 'Add a title for your post.',
    });
  });

  // Text posts used to inherit a title derived from their body on the server,
  // so an author could publish one without naming it. Every format is named
  // explicitly now, on both clients and the server.
  it('requires a title on every post format', () => {
    const textDraft = {
      ...getDefaultPostComposerDraft(),
      mode: 'text' as const,
      proofMode: 'text' as const,
      contentText: 'A reusable breakdown for product hooks.',
      category: 'text' as const,
    };

    expect(getPostComposerDetailErrors(textDraft)).toMatchObject({
      title: 'Add a title for your post.',
    });
    expect(validatePostComposerDraft(textDraft).valid).toBe(false);

    // Whitespace is not a title.
    expect(getPostComposerDetailErrors({ ...textDraft, title: '   ' })).toMatchObject({
      title: 'Add a title for your post.',
    });

    expect(getPostComposerDetailErrors({ ...textDraft, title: 'Hook breakdown' }).title).toBeUndefined();
  });

  // Every title input slices to TITLE_MAX_LENGTH, so this branch is a backstop
  // for titles that arrive without passing through the keyboard — an edit
  // prefill of an older post, or a generation title used as the default.
  it('flags a title longer than the shared limit and accepts one exactly at it', () => {
    const draft = {
      ...getDefaultPostComposerDraft(),
      mode: 'text' as const,
      proofMode: 'text' as const,
      contentText: 'A reusable breakdown for product hooks.',
      category: 'text' as const,
    };

    expect(getPostComposerDetailErrors({ ...draft, title: 'a'.repeat(TITLE_MAX_LENGTH) }).title).toBeUndefined();
    expect(getPostComposerDetailErrors({ ...draft, title: 'a'.repeat(TITLE_MAX_LENGTH + 1) })).toMatchObject({
      title: `Titles are limited to ${TITLE_MAX_LENGTH} characters.`,
    });
  });

  it('grandfathers a pre-limit title while it stays unchanged, like the server does', () => {
    // A real title: a run of one letter is a placeholder to the public-post rule.
    const grandfathered = 'Long cinematic lighting breakdown with every camera move '.repeat(2).trim();
    expect(grandfathered.length).toBeGreaterThan(TITLE_MAX_LENGTH);
    const draft = {
      ...getDefaultPostComposerDraft(),
      mode: 'text' as const,
      proofMode: 'text' as const,
      contentText: 'A reusable breakdown for product hooks.',
      category: 'text' as const,
      title: grandfathered,
    };

    expect(getPostComposerDetailErrors(draft, { grandfatheredTitle: grandfathered }).title).toBeUndefined();
    expect(validatePostComposerDraft(draft, { grandfatheredTitle: grandfathered })).toEqual({ valid: true });
    // Changing it to a different over-limit value forfeits the exemption.
    expect(getPostComposerDetailErrors(
      { ...draft, title: `${grandfathered} plus` },
      { grandfatheredTitle: grandfathered },
    )).toMatchObject({
      title: `Titles are limited to ${TITLE_MAX_LENGTH} characters.`,
    });
    // A new post grandfathers nothing.
    expect(getPostComposerDetailErrors(draft)).toMatchObject({
      title: `Titles are limited to ${TITLE_MAX_LENGTH} characters.`,
    });
  });

  // The read APIs substitute "Untitled post" for an empty title, so a legacy
  // post is loaded with rawTitle '' — it may be saved that way again, exactly
  // as the server accepts the unchanged value. Requiring a title here re-broke
  // the post the moment the poisoned fallback hydration was fixed.
  it('grandfathers an absent title the post was loaded with', () => {
    const draft = {
      ...getDefaultPostComposerDraft(),
      mode: 'text' as const,
      proofMode: 'text' as const,
      contentText: 'A reusable breakdown for product hooks.',
      category: 'text' as const,
      title: '',
    };

    expect(getPostComposerDetailErrors(draft, { grandfatheredTitle: '' }).title).toBeUndefined();
    // Typing a title and clearing it again keeps the exemption: the loaded
    // state was titleless, so saving titleless stays legal.
    expect(getPostComposerDetailErrors({ ...draft, title: '  ' }, { grandfatheredTitle: '' }).title).toBeUndefined();
    // New posts (nothing grandfathered) still require one.
    expect(getPostComposerDetailErrors(draft)).toMatchObject({
      title: 'Add a title for your post.',
    });
    expect(getPostComposerDetailErrors(draft, { grandfatheredTitle: null })).toMatchObject({
      title: 'Add a title for your post.',
    });
  });

  // "Include exact prompt" reads its state from the recipe's cards: resetting it
  // to defaults on an edit showed it OFF for a post already sharing its prompt,
  // and flipping it deleted the very card the post was sharing. The card is
  // found by its text, as on the web: matched by the app's own card id, a
  // prompt card made on the web read OFF, and switching it on added a second
  // copy of the prompt.
  describe("the creation's prompt card", () => {
    const item = generation({ prompt: 'venom hero shot' });
    // As the web makes it: the card type's own title and a random id.
    const webCard = createPostComposerResourceCard('prompt', { textContent: 'venom hero shot' });

    it('is recognised by its text, wherever it was made', () => {
      expect(hasCreationPromptCard([webCard], item)).toBe(true);
      expect(hasCreationPromptCard([createPostComposerResourceCard('prompt', {
        id: 'creation-prompt',
        title: 'Exact generation prompt',
        textContent: '  venom hero shot ',
      })], item)).toBe(true);
      // A hand-written prompt, or the prompt's text on a card of another kind, is not it.
      expect(hasCreationPromptCard([createPostComposerResourceCard('prompt', { textContent: 'my own prompt' })], item)).toBe(false);
      expect(hasCreationPromptCard([createPostComposerResourceCard('guide', { textContent: 'venom hero shot' })], item)).toBe(false);
      expect(hasCreationPromptCard([webCard], generation({ prompt: null }))).toBe(false);
      expect(hasCreationPromptCard([], item)).toBe(false);
    });

    it('is not added twice, and switching it off takes the one made elsewhere', () => {
      const draft = {
        ...getDefaultPostComposerDraft(),
        mode: 'creation' as const,
        title: 'Venom hero',
        selectedGenerationId: item.id,
        resource: { ...getDefaultPostComposerDraft().resource, accessMode: 'free' as const, cards: [webCard] },
      };

      expect(applyCreationPromptResource(draft, item, true).resource.cards).toEqual([webCard]);
      expect(applyCreationPromptResource(draft, item, false).resource.cards).toEqual([]);
    });

    // The trash button takes only the card; the state read from the cards goes with it.
    it('reads as gone once its card is removed', () => {
      const guide = createPostComposerResourceCard('guide', { title: 'Lighting notes', textContent: 'Key light at 45 degrees.' });
      const draft = applyCreationPromptResource({
        ...getDefaultPostComposerDraft(),
        mode: 'creation',
        title: 'Venom hero',
        selectedGenerationId: item.id,
        resource: { ...getDefaultPostComposerDraft().resource, accessMode: 'free', cards: [guide] },
      }, item, true);
      expect(getPostComposerPackageStatus(draft, item).label).toBe('Prompt recipe ready');

      const withoutPrompt = { ...draft, resource: { ...draft.resource, cards: [guide] } };
      expect(hasCreationPromptCard(withoutPrompt.resource.cards, item)).toBe(false);
      expect(getPostComposerPackageStatus(withoutPrompt, item).label).toBe('Free recipe ready');
    });
  });

  it('returns every visible detail error for an empty media post', () => {
    const draft = {
      ...getDefaultPostComposerDraft(),
      mode: 'upload' as const,
      proofMode: 'media' as const,
      category: 'image' as const,
      title: '',
      upload: null,
      mediaItems: [],
    };

    expect(getPostComposerDetailErrors(draft)).toEqual({
      title: 'Add a title for your post.',
      media: 'Add at least one image or video to continue.',
    });
  });

  it('requires both a resource title and protected content before Save', () => {
    const card = createPostComposerResourceCard('prompt', {
      title: '',
      textContent: '',
    });
    expect(getPostComposerResourceCardErrors(card)).toEqual({
      title: 'Add an item title.',
      content: 'Add the content, link, or file for this item.',
    });
    expect(isPostComposerResourceCardReady(card)).toBe(false);
    expect(isPostComposerResourceCardReady({ ...card, title: 'Reusable prompt', textContent: 'Exact prompt' })).toBe(true);
  });

  // The caption is a Story kept from the media format, which text mode does not
  // show: it is neither the body nor the description of a text post. A text
  // post names no tool, as on the web, even from a draft an older build gave
  // "Manual".
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
      sourceToolSlug: 'manual',
      visibility: 'public',
    });

    const entries = Array.from((formData as unknown as { entries: () => Iterable<[string, FormDataEntryValue]> }).entries());

    expect(entries).toEqual([
      ['title', 'Text post title'],
      ['body', 'Main text content'],
      ['visibility', 'public'],
      ['isNsfw', 'false'],
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
        mediaKey: 'media-1',
        storagePath: 'uploads/user-1/cover.jpg',
        contentType: 'image/jpeg',
        originalName: 'cover.jpg',
      },
      {
        mediaKey: 'media-2',
        storagePath: 'uploads/user-1/clip.mp4',
        contentType: 'video/mp4',
        originalName: 'clip.mp4',
      },
    ]);

    const formData = buildCreatePostFormData(draft);
    expect(formData.get('mediaItems')).toBe(JSON.stringify([
      {
        mediaKey: 'media-1',
        storagePath: 'uploads/user-1/cover.jpg',
        contentType: 'image/jpeg',
        originalName: 'cover.jpg',
      },
      {
        mediaKey: 'media-2',
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

  // The draft's category is set when media is added and is not touched by a
  // reorder or a removal; the create route refuses one that does not match
  // the cover ("choose a matching category", a control this app does not have).
  it('files a media post under its cover after a video is moved first', () => {
    const image = {
      id: 'media-image',
      uri: 'file:///cover.jpg',
      name: 'cover.jpg',
      type: 'image/jpeg',
      mediaKind: 'image' as const,
      storagePath: 'uploads/user-1/cover.jpg',
    };
    const video = {
      id: 'media-video',
      uri: 'file:///clip.mp4',
      name: 'clip.mp4',
      type: 'video/mp4',
      mediaKind: 'video' as const,
      storagePath: 'uploads/user-1/clip.mp4',
    };
    const reordered = {
      ...getDefaultPostComposerDraft(),
      mode: 'upload' as const,
      proofMode: 'media' as const,
      title: 'Mixed gallery',
      category: 'image' as const,
      mediaItems: [video, image],
    };

    const formData = buildCreatePostFormData(reordered);
    expect(formData.get('category')).toBe('video');
    expect(JSON.parse(String(formData.get('mediaItems')))[0]).toMatchObject({ contentType: 'video/mp4' });
    expect(buildOptimisticOwnerPostListItem('post-1', reordered)?.category).toBe('video');

    expect(buildCreatePostFormData({ ...reordered, category: 'video', mediaItems: [image] }).get('category')).toBe('image');
    // A text post keeps its own category whatever media the draft still holds.
    expect(buildOptimisticOwnerPostListItem('post-2', {
      ...reordered,
      mode: 'text',
      proofMode: 'text',
      category: 'text',
      contentText: 'A useful note',
    })?.category).toBe('text');
  });

  // The app has no description field, and the web post page shows the
  // description above the media and the body below it: sending the Story as
  // both stored and showed it twice.
  it('sends the Story as the body only, and a description only when the draft has one', () => {
    const draft = {
      ...getDefaultPostComposerDraft(),
      mode: 'upload' as const,
      proofMode: 'media' as const,
      title: 'Story post',
      caption: 'How this was made.',
      category: 'image' as const,
      mediaItems: [{
        id: 'media-1',
        uri: 'file:///cover.jpg',
        name: 'cover.jpg',
        type: 'image/jpeg',
        mediaKind: 'image' as const,
        storagePath: 'uploads/user-1/cover.jpg',
      }],
    };

    const formData = buildCreatePostFormData(draft);
    expect(formData.get('description')).toBeNull();
    expect(formData.get('body')).toBe('How this was made.');
    expect(formData.get('postFormat')).toBe('mixed');

    expect(buildCreatePostFormData({ ...draft, description: '  Explore copy  ' }).get('description')).toBe('Explore copy');
    expect(buildCreatePostFormData({ ...draft, description: '   ' }).get('description')).toBeNull();
  });

  it('builds paid unlock bundle payloads only when unlock content exists', () => {
    expect(buildPostResourceBundleInput({
      ...getDefaultPostComposerDraft().resource,
      accessMode: 'paid',
      cardAuthoringMode: 'legacy',
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

  it('serializes grouped resource cards with public labels and stable output scopes', () => {
    const bundle = buildPostResourceBundleInput({
      ...getDefaultPostComposerDraft().resource,
      accessMode: 'free',
      cards: [
        createPostComposerResourceCard('prompt', {
          id: 'prompt-card',
          title: 'Editorial prompt',
          preview: 'The exact prompt and structure.',
          textContent: 'Photograph a coral bottle in morning light.',
        }),
        createPostComposerResourceCard('reference_media', {
          id: 'reference-card',
          title: 'Motion reference',
          attachments: [{
            id: 'reference-video',
            kind: 'file',
            label: 'Camera move.mp4',
            storagePath: 'user-1/camera-move.mp4',
            contentType: 'video/mp4',
          }],
          appliesToAll: false,
          mediaKeys: ['media-2'],
        }),
      ],
    });

    expect(bundle).toMatchObject({
      accessMode: 'free',
      resources: {
        allowRemix: false,
        sections: [
          {
            id: 'prompt-card',
            publicTitle: 'Editorial prompt',
            resourceType: 'prompt',
            scope: { kind: 'all' },
          },
          {
            id: 'reference-card',
            publicTitle: 'Motion reference',
            resourceType: 'reference_video',
            scope: { kind: 'media', mediaKeys: ['media-2'] },
          },
        ],
        items: [
          expect.objectContaining({
            id: 'prompt-card-item-1',
            sectionId: 'prompt-card',
            type: 'prompt',
            scope: { kind: 'all' },
          }),
          expect.objectContaining({
            id: 'reference-card-file-1',
            sectionId: 'reference-card',
            type: 'reference_video',
            scope: { kind: 'media', mediaKeys: ['media-2'] },
          }),
        ],
      },
    });
  });

  it('keeps remix links protected without enabling native remix access', () => {
    const bundle = buildPostResourceBundleInput({
      ...getDefaultPostComposerDraft().resource,
      accessMode: 'paid',
      priceTokens: '120',
      cards: [createPostComposerResourceCard('remix_link', {
        id: 'remix-card',
        title: 'Open in editor',
        preview: 'Editable remix project included.',
        externalUrl: 'https://editor.example.com/remix/private',
      })],
    });

    expect(bundle).toMatchObject({
      accessMode: 'paid',
      priceUsdCents: 120,
      resources: {
        allowRemix: false,
        items: [expect.objectContaining({
          type: 'remix_link',
          externalUrl: 'https://editor.example.com/remix/private',
          remixUse: 'none',
        })],
      },
    });
    expect(hydratePostComposerResourceCards(bundle)).toEqual([
      expect.objectContaining({
        id: 'remix-card',
        type: 'remix_link',
        externalUrl: 'https://editor.example.com/remix/private',
        attachments: [],
      }),
    ]);
  });

  // Server-assigned item ids look like `item-N`, and a section-less card used
  // to take its first item's id while an id-less neighbour took an
  // index-based `item-N` group key. On Review & publish the two cards then
  // shared a React key (`item-2`), which React warns can duplicate or drop
  // children. Section-backed cards must still keep the section id, which is
  // what the save path writes back.
  it('gives section-less hydrated cards ids that cannot collide with each other or with stored items', () => {
    const cards = hydratePostComposerResourceCards({
      accessMode: 'free',
      summary: 'Prompt and notes',
      previewText: 'Preview',
      priceUsdCents: 0,
      resources: {
        promptText: 'Prompt',
        notesMarkdown: 'Notes',
        workflowShareUrl: null,
        attachments: [],
        allowRemix: false,
        sections: [{ id: 'section-1', title: 'Settings', description: '' }],
        items: [
          { id: 'item-1', type: 'prompt', title: 'Prompt', textContent: 'A reusable prompt.' },
          { id: 'item-2', type: 'note', title: 'Notes', textContent: 'Some notes.' },
          { type: 'note', title: 'Loose note', textContent: 'No id on this one.' },
          { id: 'item-4', type: 'settings', title: 'Settings', textContent: 'Seed 42', sectionId: 'section-1' },
        ],
      },
    } as never);

    const ids = cards.map((card) => card.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('item-2');
    expect(ids).toContain('section-1');
  });

  it('round-trips a workflow link once and preserves its media scope', () => {
    const original = buildPostResourceBundleInput({
      ...getDefaultPostComposerDraft().resource,
      accessMode: 'free',
      cards: [createPostComposerResourceCard('workflow', {
        id: 'workflow-card',
        title: 'ComfyUI workflow',
        externalUrl: 'https://workflow.example.com/share/123',
        appliesToAll: false,
        mediaKeys: ['media-1', 'media-3'],
      })],
    });
    const cards = hydratePostComposerResourceCards(original);
    const rebuilt = buildPostResourceBundleInput({
      ...getDefaultPostComposerDraft().resource,
      accessMode: 'free',
      cards,
    });

    expect(cards[0]).toMatchObject({
      externalUrl: 'https://workflow.example.com/share/123',
      attachments: [],
      appliesToAll: false,
      mediaKeys: ['media-1', 'media-3'],
    });
    expect(rebuilt?.resources?.items).toHaveLength(1);
    expect(rebuilt?.resources?.items?.[0]).toMatchObject({
      type: 'workflow',
      externalUrl: 'https://workflow.example.com/share/123',
      scope: { kind: 'media', mediaKeys: ['media-1', 'media-3'] },
    });
  });

  it('preserves a stored attachment external fallback when its visible label changes', () => {
    const resource = {
      ...getDefaultPostComposerDraft().resource,
      accessMode: 'free' as const,
      summary: 'Project files',
      previewText: 'Includes the project archive.',
      cards: [createPostComposerResourceCard('source_assets', {
        id: 'dual-location-card',
        attachments: [{
          id: 'dual-location-file',
          kind: 'file',
          label: 'Project archive',
          storagePath: 'user-1/project.zip',
          contentType: 'application/zip',
          sizeBytes: 42,
        }],
      })],
    };
    const original = buildPostResourceBundleInput(resource);
    const originalItem = original?.resources?.items?.[0];
    expect(originalItem).toBeTruthy();
    originalItem!.externalUrl = 'https://downloads.example.com/project.zip';

    const [hydratedCard] = hydratePostComposerResourceCards(original);
    const rebuilt = buildPostResourceBundleInput({
      ...resource,
      cards: [{
        ...hydratedCard!,
        attachments: hydratedCard!.attachments.map((attachment) => ({
          ...attachment,
          label: 'Renamed project archive',
        })),
      }],
    });

    expect(rebuilt?.resources?.items?.[0]).toMatchObject({
      ...originalItem,
      title: 'Renamed project archive',
      externalUrl: 'https://downloads.example.com/project.zip',
    });
  });

  it('removes only the file fields from a workflow item that also backs a visible URL', () => {
    const resource = {
      ...getDefaultPostComposerDraft().resource,
      accessMode: 'free' as const,
      summary: 'Workflow files',
      previewText: 'Includes the shared workflow and its import file.',
      cards: [createPostComposerResourceCard('workflow', {
        id: 'combined-workflow',
        externalUrl: 'https://workflow.example.com/share/combined',
        attachments: [{
          id: 'combined-workflow-file',
          kind: 'file',
          label: 'workflow.json',
          storagePath: 'user-1/workflow.json',
          contentType: 'application/json',
          sizeBytes: 84,
        }],
      })],
    };
    const original = buildPostResourceBundleInput(resource);
    const [urlItem, fileItem] = original?.resources?.items ?? [];
    expect(urlItem).toBeTruthy();
    expect(fileItem).toBeTruthy();
    original!.resources!.items = [{
      ...urlItem!,
      storagePath: fileItem!.storagePath,
      contentType: fileItem!.contentType,
      sizeBytes: fileItem!.sizeBytes,
    }];
    const [hydratedCard] = hydratePostComposerResourceCards(original);

    const rebuilt = buildPostResourceBundleInput({
      ...resource,
      cards: [{ ...hydratedCard!, attachments: [] }],
    });

    expect(rebuilt?.resources?.items).toHaveLength(1);
    expect(rebuilt?.resources?.items?.[0]).toMatchObject({
      externalUrl: 'https://workflow.example.com/share/combined',
      storagePath: null,
      contentType: null,
      sizeBytes: null,
    });
  });

  it('treats an empty explicit card list as deletion without reviving legacy fields', () => {
    const staleLegacyResource = {
      ...getDefaultPostComposerDraft().resource,
      accessMode: 'free' as const,
      cardAuthoringMode: 'cards' as const,
      selectedKinds: {
        prompt: true,
        workflow: false,
        files: false,
        notes: false,
        remix: false,
      },
      promptText: 'Old protected prompt that the creator removed',
      summary: 'A useful public package summary.',
      previewText: 'Includes the reusable prompt and setup guidance.',
      cards: [],
    };

    expect(buildPostResourceBundleInput(staleLegacyResource)).toBeNull();

    const remixOnly = buildPostResourceBundleInput({
      ...staleLegacyResource,
      allowRemix: true,
    });
    expect(remixOnly).toMatchObject({
      accessMode: 'free',
      resources: {
        promptText: null,
        allowRemix: true,
        items: [],
      },
    });
    expect(JSON.stringify(remixOnly)).not.toContain('Old protected prompt');

    // A recovered pre-card draft has no marker (or an explicit legacy marker),
    // so its flat fields remain readable until the creator enters card mode.
    expect(buildPostResourceBundleInput({
      ...staleLegacyResource,
      cardAuthoringMode: 'legacy',
    })?.resources?.promptText).toBe('Old protected prompt that the creator removed');
  });

  it('migrates a restored legacy draft into visible cards before it can be submitted', () => {
    const legacyDraft = {
      ...getDefaultPostComposerDraft(),
      resource: {
        ...getDefaultPostComposerDraft().resource,
        accessMode: 'free' as const,
        promptText: 'A protected prompt from an older saved draft.',
        summary: 'A reusable prompt package.',
        previewText: 'Includes the reusable prompt.',
        cards: [],
        cardAuthoringMode: undefined,
        selectedKinds: {
          prompt: true,
          workflow: false,
          files: false,
          notes: false,
          remix: false,
        },
      },
    };

    const migrated = migratePostComposerResourceDraftToCards(legacyDraft.resource);
    expect(migrated.cardAuthoringMode).toBe('cards');
    expect(migrated.cards).toHaveLength(1);
    expect(migrated.cards[0]).toMatchObject({ textContent: 'A protected prompt from an older saved draft.' });
    expect(migrated.promptText).toBe('');
    expect(buildPostResourceBundleInput(migrated)?.resources?.items?.[0]).toMatchObject({
      textContent: 'A protected prompt from an older saved draft.',
    });
  });

  it('reassigns duplicate card ids on a restored draft, preserving contents and order', () => {
    // Observed on-device: an old build persisted two cards both reading `item-2`.
    const restoredResource = {
      ...getDefaultPostComposerDraft().resource,
      accessMode: 'free' as const,
      cards: [
        createPostComposerResourceCard('prompt', {
          id: 'item-2',
          title: 'Lighting prompt',
          textContent: 'Use a large softbox at camera left.',
        }),
        createPostComposerResourceCard('reference_media', {
          id: 'item-2',
          title: 'Reference stills',
          attachments: [{ id: 'ref-1', kind: 'file' as const, label: 'still.jpg', storagePath: 'refs/still.jpg' }],
        }),
      ],
    };

    const sanitized = sanitizePostComposerResourceCardIds(restoredResource);

    expect(sanitized.cards.map((card) => card.id)).toEqual(['item-2', 'restored-item-2-2']);
    expect(sanitized.cards[0]).toMatchObject({
      type: 'prompt',
      title: 'Lighting prompt',
      textContent: 'Use a large softbox at camera left.',
    });
    expect(sanitized.cards[1]).toMatchObject({
      type: 'reference_media',
      title: 'Reference stills',
      attachments: [{ id: 'ref-1', label: 'still.jpg' }],
    });
  });

  it('never reassigns onto an id the draft already uses, and leaves clean drafts untouched', () => {
    const cleanResource = {
      ...getDefaultPostComposerDraft().resource,
      cards: [
        createPostComposerResourceCard('prompt', { id: 'item-1' }),
        createPostComposerResourceCard('guide', { id: 'item-2' }),
      ],
    };
    expect(sanitizePostComposerResourceCardIds(cleanResource)).toBe(cleanResource);

    const crowdedResource = {
      ...getDefaultPostComposerDraft().resource,
      cards: [
        createPostComposerResourceCard('prompt', { id: 'item-2' }),
        createPostComposerResourceCard('guide', { id: 'item-2' }),
        createPostComposerResourceCard('guide', { id: 'item-2' }),
        // A later card already holding the first reassignment candidate.
        createPostComposerResourceCard('other', { id: 'restored-item-2-2' }),
      ],
    };

    const ids = sanitizePostComposerResourceCardIds(crowdedResource).cards.map((card) => card.id);
    expect(ids).toEqual(['item-2', 'restored-item-2-3', 'restored-item-2-4', 'restored-item-2-2']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('requires the author-written package preview instead of accepting a generated fallback', () => {
    const draft = {
      ...getDefaultPostComposerDraft(),
      mode: 'upload' as const,
      title: 'External creation',
      visibility: 'public' as const,
      upload: { uri: 'file:///tmp/image.jpg', name: 'image.jpg', type: 'image/jpeg' },
      resource: {
        ...getDefaultPostComposerDraft().resource,
        accessMode: 'free' as const,
        summary: 'A detailed reusable lighting prompt for product photography.',
        previewText: '   ',
        cards: [createPostComposerResourceCard('prompt', {
          title: 'Lighting prompt',
          textContent: 'Use a large softbox at camera left and a negative fill at camera right.',
        })],
      },
    };

    expect(validatePostComposerDraft(draft)).toEqual({
      valid: false,
      message: 'Add a recipe preview.',
    });
  });

  it('enforces token pricing in ten-token increments from a ten-token minimum', () => {
    const baseDraft = {
      ...getDefaultPostComposerDraft(),
      mode: 'upload' as const,
      title: 'External creation',
      upload: { uri: 'file:///tmp/image.jpg', name: 'image.jpg', type: 'image/jpeg' },
      resource: {
        ...getDefaultPostComposerDraft().resource,
        accessMode: 'paid' as const,
        previewText: 'Includes the exact prompt.',
        cards: [createPostComposerResourceCard('prompt', { textContent: 'Exact prompt' })],
      },
    };

    expect(getPostComposerPriceTokens({ ...baseDraft.resource, priceTokens: '10' })).toBe(10);
    expect(validatePostComposerDraft({
      ...baseDraft,
      resource: { ...baseDraft.resource, priceTokens: '5' },
    })).toMatchObject({ valid: false, message: 'Paid recipes start at 10 credits, in steps of 10.' });
    expect(validatePostComposerDraft({
      ...baseDraft,
      resource: { ...baseDraft.resource, priceTokens: '15' },
    })).toMatchObject({ valid: false, message: 'Paid recipes start at 10 credits, in steps of 10.' });
    expect(getPostComposerPackageStatus({
      ...baseDraft,
      resource: { ...baseDraft.resource, priceTokens: '15' },
    })).toMatchObject({
      label: 'Set a valid price',
      body: 'Paid recipes start at 10 credits, in steps of 10.',
      state: 'warning',
    });
    expect(validatePostComposerDraft({
      ...baseDraft,
      resource: { ...baseDraft.resource, priceTokens: '20' },
    })).toEqual({ valid: true });
  });

  it('builds web-style resource bundles with selected types, files, remix, and sections', () => {
    expect(buildPostResourceBundleInput({
      ...getDefaultPostComposerDraft().resource,
      accessMode: 'paid',
      cardAuthoringMode: 'legacy',
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
        cardAuthoringMode: 'legacy',
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
    expect(getPostComposerPreviewStatusLabel(draft, item)).toBe('No recipe added.');
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

    const draft = {
      ...getDefaultPostComposerDraft(),
      mode: 'creation',
      title: 'Private reference post',
      category: 'image',
      visibility: 'private',
      selectedGenerationId: 'gen-private-inputs',
      sourceTool: 'Magicbooklet',
      sourceToolSlug: 'magicbooklet',
    } as const;
    const payload = buildPublishGenerationPostPayload(item, draft);

    expect(payload).not.toHaveProperty('includeGenerationReferences');
    expect(getPostComposerPreviewStatusLabel(draft, item)).toBe('No recipe added.');
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

    expect(hasCreationPromptCard(draft.resource.cards, item)).toBe(true);
    expect(draft.resource.accessMode).toBe('free');
    expect(draft.resource.promptText).toBe('Exact cinematic product prompt');
    // Suggested from the items, as the Recipe preview is for any item (recipe audit S7).
    expect(draft.resource.previewText).toBe('Includes the prompt.');
    expect(buildPublishGenerationPostPayload(item, draft).resourceBundle).toMatchObject({
      accessMode: 'free',
      // With no author-written summary, the author's preview stands in for it.
      // The marketplace quality gate reads whichever is non-empty first, so a
      // short derived summary would otherwise shadow the real preview.
      summary: 'Includes the prompt.',
      previewText: 'Includes the prompt.',
      priceUsdCents: 0,
      resources: {
        promptText: null,
        notesMarkdown: null,
        workflowShareUrl: null,
        attachments: [],
        allowRemix: false,
        items: [expect.objectContaining({
          type: 'prompt',
          textContent: 'Exact cinematic product prompt',
          scope: { kind: 'all' },
        })],
      },
    });
  });

  it('reports attached creation references as the package status', () => {
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
      },
    };

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
    }, item)).toBe('The free recipe will appear in post details.');

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
    }, item)).toBe('The paid recipe will appear in post details.');
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
      body: 'Uploaded from phone',
      category: 'image',
      postFormat: 'mixed',
      // Made with was never opened, so the tile names no tool, as the server stores none.
      sourceTool: null,
      sourceToolSlug: null,
      sourceTools: [],
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
    // Nothing was written as a description, so the tile carries none.
    expect(post?.description).toBeUndefined();
  });

  it('returns submit labels for publish visibility and edit states', () => {
    expect(getPostComposerSubmitLabel({ visibility: 'public', isEditMode: false, isPending: false })).toBe('Publish public');
    expect(getPostComposerSubmitLabel({ visibility: 'private', isEditMode: false, isPending: false })).toBe('Save private');
    expect(getPostComposerSubmitLabel({ visibility: 'public', isEditMode: true, isPending: false })).toBe('Save changes');
    expect(getPostComposerSubmitLabel({ visibility: 'private', isEditMode: false, isPending: true })).toBe('Publishing');
    expect(getPostComposerSubmitLabel({ visibility: 'private', isEditMode: true, isPending: true })).toBe('Saving');
  });

  // A post is public or private (product decisions 2026-10-17, item 12): the
  // server stores a requested unlisted as private, so the composer opens an
  // old unlisted post, or a draft an older build saved as unlisted, as private.
  it('opens an old unlisted post as private and keeps the other two as they are', () => {
    expect(getComposerVisibility('unlisted')).toBe('private');
    expect(getComposerVisibility('private')).toBe('private');
    expect(getComposerVisibility('public')).toBe('public');
    expect(getComposerVisibility(undefined)).toBe('public');
  });

  describe('edit payload builder', () => {
    // A creation post's media, category and source follow the creation; the
    // owner's own words travel. Sending only the visibility is what locked
    // title, story and caption behind "Creation details are fixed".
    it('sends the owner-written fields for a generation-backed post and leaves the creation-derived ones out', () => {
      // As the editor loads a post made from a creation.
      const draft = {
        ...getDefaultPostComposerDraft(),
        mode: 'creation' as const,
        proofMode: 'media' as const,
        title: 'New Title',
        caption: 'New Caption',
        visibility: 'private' as const,
        resource: {
          ...getDefaultPostComposerDraft().resource,
          accessMode: 'free' as const,
          cardAuthoringMode: 'legacy' as const,
          promptText: 'New Prompt',
          previewText: 'New Preview',
        },
      };

      const payload = buildUpdatePostPayload(true, draft);
      expect(payload).not.toHaveProperty('category');
      expect(payload).not.toHaveProperty('sourceTool');
      expect(payload).not.toHaveProperty('sourceTools');
      expect(payload).not.toHaveProperty('mediaItems');
      // The Story is the body. An absent description leaves the stored one alone.
      expect(payload).not.toHaveProperty('description');
      expect(payload).toMatchObject({
        title: 'New Title',
        body: 'New Caption',
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

    // A recipe people have bought is edited like any other (recipe audit S2):
    // there is no sold recipe left out of the save any more.
    it('sends the recipe choice with every edit, No recipe included', () => {
      const draft = {
        ...getDefaultPostComposerDraft(),
        visibility: 'private' as const,
        resource: {
          ...getDefaultPostComposerDraft().resource,
          accessMode: 'none' as const,
        },
      };

      expect(buildUpdatePostPayload(true, draft)).toEqual({
        isNsfw: false,
        title: '',
        body: '',
        visibility: 'private',
        resourceBundle: { accessMode: 'none' },
      });
      expect(buildUpdatePostPayload(false, draft)).toHaveProperty('resourceBundle', { accessMode: 'none' });
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
          cardAuthoringMode: 'legacy' as const,
          promptText: 'New Prompt',
          previewText: 'New Preview',
        },
      };

      const payload = buildUpdatePostPayload(false, draft);
      expect(payload).not.toHaveProperty('description');
      // A text post names no tool, as on the web: the "Manual" an older build
      // gave every unattributed draft is not sent.
      expect(payload).not.toHaveProperty('sourceTool');
      expect(payload).not.toHaveProperty('sourceToolSlug');
      expect(payload).not.toHaveProperty('sourceTools');
      expect(payload).toMatchObject({
        title: 'New Title',
        body: 'New Content',
        visibility: 'private',
        category: 'video',
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
        visibility: 'private' as const,
        category: 'image' as const,
        upload: {
          uri: 'file:///tmp/image.jpg',
          name: 'image.jpg',
          type: 'image/jpeg',
        },
      };

      const payload = buildUpdatePostPayload(false, draft);
      expect(payload).not.toHaveProperty('description');
      expect(payload).toMatchObject({
        title: 'Media Title',
        body: 'Media Caption',
        visibility: 'private',
        category: 'image',
      });
      // An untouched Made with sends no tool, so the stored one stays as it is:
      // this used to stamp "Manual" on a post that had none.
      expect(payload).not.toHaveProperty('sourceTool');
      expect(payload).not.toHaveProperty('sourceToolSlug');
      expect(payload).not.toHaveProperty('sourceTools');
    });

    // A post written on the web can carry an Explore description the app has
    // no field for; the edit loads it and sends it back unchanged.
    it('keeps a description the loaded post already had, on both edit routes', () => {
      const draft = {
        ...getDefaultPostComposerDraft(),
        mode: 'upload' as const,
        title: 'Web post',
        description: 'Written in the web composer',
        caption: 'The story',
        category: 'image' as const,
      };

      expect(buildUpdatePostPayload(false, draft)).toMatchObject({
        description: 'Written in the web composer',
        body: 'The story',
      });
      expect(buildUpdatePostPayload(true, draft)).toMatchObject({
        description: 'Written in the web composer',
        body: 'The story',
      });
    });
  });
});

const COVER_ITEM = {
  id: 'media-1',
  uri: 'file:///cover.jpg',
  name: 'cover.jpg',
  type: 'image/jpeg',
  mediaKind: 'image' as const,
  storagePath: 'uploads/user-1/cover.jpg',
};

function mediaPostDraft(overrides: Partial<PostComposerDraft> = {}): PostComposerDraft {
  return {
    ...getDefaultPostComposerDraft(),
    mode: 'upload',
    proofMode: 'media',
    category: 'image',
    title: 'Neon skyline study',
    mediaItems: [COVER_ITEM],
    ...overrides,
  };
}

function textPostDraft(overrides: Partial<PostComposerDraft> = {}): PostComposerDraft {
  return {
    ...getDefaultPostComposerDraft(),
    mode: 'text',
    proofMode: 'text',
    category: 'text',
    title: 'Prompt teardown',
    contentText: 'Too short body',
    ...overrides,
  };
}

// The server refuses a public post with a placeholder title, or a text post
// without enough useful text, and step 2 used to say "Ready to publish" for it.
describe('the public-post rule, checked before step 2 says Ready to publish', () => {
  const messages = publicPostQuality.messages as Record<string, string>;

  it('answers every case of the shared fixture as the server does', () => {
    for (const testCase of publicPostQuality.cases) {
      expect(getPublicPostQualityError(testCase), JSON.stringify(testCase))
        .toBe(testCase.expected === null ? null : messages[testCase.expected]);
    }
  });

  it('refuses a title made only of placeholder words the server refuses, and takes text from the server’s length', () => {
    for (const token of publicPostQuality.placeholderTokens) {
      expect(getPublicPostQualityError({ title: token, body: '', hasMedia: true }), token)
        .toBe(messages.placeholder_title);
      expect(getPublicPostQualityError({ title: `My ${token} video 2`, body: '', hasMedia: true }), token)
        .toBe(messages.placeholder_title);
      // "Product demo" or "Free sample pack" is a real title that uses the word;
      // "lorem", "ipsum" and "asdf" are stand-ins wherever they appear.
      expect(getPublicPostQualityError({ title: `Studio ${token} reel`, body: '', hasMedia: true }), token)
        .toBe(publicPostQuality.decisivePlaceholderTokens.includes(token) ? messages.placeholder_title : null);
    }
    const sentence = 'Lighting breakdown for a product reel';
    expect(getPublicPostQualityError({
      title: 'Prompt teardown',
      body: sentence.slice(0, publicPostQuality.minTextLength),
      hasMedia: false,
    })).toBeNull();
    expect(getPublicPostQualityError({
      title: 'Prompt teardown',
      body: sentence.slice(0, publicPostQuality.minTextLength - 1),
      hasMedia: false,
    })).toBe(messages.needs_text);
  });

  it('keeps a public post the server would refuse from validating', () => {
    expect(validatePostComposerDraft(mediaPostDraft({ title: 'Demo video' })))
      .toEqual({ valid: false, message: messages.placeholder_title });
    expect(validatePostComposerDraft(mediaPostDraft({ title: 'Product demo with Kling 3.0' }))).toEqual({ valid: true });
    expect(validatePostComposerDraft(textPostDraft())).toEqual({ valid: false, message: messages.needs_text });
    expect(validatePostComposerDraft(textPostDraft({ contentText: 'A useful text breakdown' }))).toEqual({ valid: true });
    expect(validatePostComposerDraft(mediaPostDraft())).toEqual({ valid: true });
  });

  it('leaves a private post alone', () => {
    expect(validatePostComposerDraft(mediaPostDraft({ title: 'Demo video', visibility: 'private' })))
      .toEqual({ valid: true });
    expect(validatePostComposerDraft(textPostDraft({ visibility: 'private' }))).toEqual({ valid: true });
  });

  // With a recipe the server judges the post as a listing instead, whose own
  // text rule takes a long enough title in place of text; a placeholder title
  // fails both.
  it('holds a post with a recipe to the title half of the rule', () => {
    const recipe = {
      ...getDefaultPostComposerDraft().resource,
      accessMode: 'free' as const,
      previewText: 'Includes the reusable lighting prompt.',
      cards: [createPostComposerResourceCard('prompt', {
        title: 'Lighting prompt',
        textContent: 'Use a large softbox at camera left.',
      })],
    };

    expect(validatePostComposerDraft(textPostDraft({ title: 'Sunset prompt pack', resource: recipe }))).toEqual({ valid: true });
    expect(validatePostComposerDraft(textPostDraft({ title: 'Sample pack', resource: recipe }))).toEqual({ valid: true });
    expect(validatePostComposerDraft(textPostDraft({ title: 'Sample video', resource: recipe })))
      .toEqual({ valid: false, message: messages.placeholder_title });
  });
});

// The composer stamped "Manual" on every media post nobody attributed, and on
// any web post it edited, so both post pages said "Made with Manual". The web
// sends no tool when Made with is empty, and none for a text post.
describe('Made with sends only what the creator chose', () => {
  const sourceFields = (formData: FormData) => ({
    sourceTool: formData.get('sourceTool'),
    sourceToolSlug: formData.get('sourceToolSlug'),
    sourceTools: formData.get('sourceTools'),
  });
  const noSourceFields = { sourceTool: null, sourceToolSlug: null, sourceTools: null };

  it('starts a draft with no tool', () => {
    const draft = getDefaultPostComposerDraft();
    expect(draft.sourceTool).toBe('');
    expect(draft.sourceToolSlug).toBe('');
    expect(draft.madeWithRows.map((row) => row.toolLabel)).toEqual(['']);
  });

  it('sends no tool for a post whose Made with was never filled in', () => {
    const draft = mediaPostDraft();
    expect(sourceFields(buildCreatePostFormData(draft))).toEqual(noSourceFields);
    for (const key of ['sourceTool', 'sourceToolSlug', 'sourceTools']) {
      expect(buildUpdatePostPayload(false, draft)).not.toHaveProperty(key);
    }
    expect(buildOptimisticOwnerPostListItem('post-1', draft)).toMatchObject({ sourceTool: null, sourceToolSlug: null, sourceTools: [] });
  });

  it('sends nothing for the Manual placeholder an older build saved in a draft, and only the chosen tool beside it', () => {
    const legacy = mediaPostDraft({
      sourceTool: 'Manual',
      sourceToolSlug: 'manual',
      madeWithRows: [createMadeWithRow({ toolLabel: 'Manual', toolSlug: 'manual' })],
    });
    expect(sourceFields(buildCreatePostFormData(legacy))).toEqual(noSourceFields);
    expect(buildUpdatePostPayload(false, legacy)).not.toHaveProperty('sourceTools');
    expect(buildUpdatePostPayload(false, legacy)).not.toHaveProperty('sourceTool');

    const chosen = { ...legacy, madeWithRows: [...legacy.madeWithRows, createMadeWithRow({ toolLabel: 'Runway', toolSlug: 'runway' })] };
    expect(sourceFields(buildCreatePostFormData(chosen))).toEqual({
      sourceTool: 'Runway',
      sourceToolSlug: 'runway',
      sourceTools: JSON.stringify([{ toolLabel: 'Runway', toolSlug: 'runway' }]),
    });
    expect(buildUpdatePostPayload(false, chosen)).toMatchObject({
      sourceTool: 'Runway',
      sourceToolSlug: 'runway',
      sourceTools: [{ toolLabel: 'Runway', toolSlug: 'runway' }],
    });
  });

  it('sends no tool for a text post, even one a chosen tool was left on', () => {
    const text = textPostDraft({
      contentText: 'A useful text breakdown',
      sourceTool: 'Manual',
      sourceToolSlug: 'manual',
      madeWithRows: [createMadeWithRow({ toolLabel: 'Runway', toolSlug: 'runway' })],
    });
    expect(sourceFields(buildCreatePostFormData(text))).toEqual(noSourceFields);
    for (const key of ['sourceTool', 'sourceToolSlug', 'sourceTools']) {
      expect(buildUpdatePostPayload(false, text)).not.toHaveProperty(key);
    }
  });

  it('does not offer Manual in the bundled tool list, which the server’s catalog has no match for', () => {
    expect(POST_COMPOSER_SOURCE_OPTIONS.map((tool) => tool.slug)).not.toContain('manual');
  });
});

// Product decision 1 (2026-10-17): the recipe noun is "Recipe", everywhere.
describe('recipe words on step 2', () => {
  const card = createPostComposerResourceCard('prompt', { title: 'Lighting prompt', textContent: 'Use a large softbox at camera left.' });
  const withRecipe = (accessMode: 'free' | 'paid', overrides: Partial<PostComposerDraft['resource']> = {}) => mediaPostDraft({
    resource: {
      ...getDefaultPostComposerDraft().resource,
      accessMode,
      previewText: 'Includes the reusable lighting prompt.',
      cards: [card],
      ...overrides,
    },
  });

  it('names the package states in recipe words', () => {
    expect(getPostComposerPackageStatus(mediaPostDraft())).toMatchObject({ label: 'Recipe optional', body: 'No recipe added.' });
    expect(getPostComposerPackageStatus(withRecipe('free'))).toMatchObject({
      label: 'Free recipe ready',
      body: 'The free recipe will appear in post details.',
      state: 'ready',
    });
    expect(getPostComposerPackageStatus(withRecipe('paid'))).toMatchObject({
      label: 'Paid recipe ready',
      body: 'The paid recipe will appear in post details.',
      state: 'ready',
    });
    expect(getPostComposerPackageStatus(withRecipe('free', { cards: [] }))).toMatchObject({
      label: 'Finish the recipe',
      body: 'Add at least one item.',
      state: 'warning',
    });
  });

  it('says recipe in its checks', () => {
    expect(validatePostComposerDraft(withRecipe('free', { cards: [] })))
      .toEqual({ valid: false, message: 'Add at least one item to the recipe.' });
    expect(validatePostComposerDraft(withRecipe('paid', { priceTokens: '5' })))
      .toEqual({ valid: false, message: 'Paid recipes start at 10 credits, in steps of 10.' });
  });
});

describe('optimistic owner post cache updates', () => {
  const post = { id: 'post-new' } as never;

  it('seeds a first page when nothing is cached yet', () => {
    const result = upsertOptimisticOwnerPostInfiniteData(undefined, post);

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].posts.map((item) => item.id)).toEqual(['post-new']);
    expect(result.pageParams).toEqual([0]);
  });

  it('prepends the new post to the first page', () => {
    const result = upsertOptimisticOwnerPostInfiniteData({
      pages: [{ success: true, posts: [{ id: 'existing' }] } as never],
      pageParams: [0],
    }, post);

    expect(result.pages[0].posts.map((item) => item.id)).toEqual(['post-new', 'existing']);
  });

  it('does not leave a duplicate behind when the post already sits on a later page', () => {
    const result = upsertOptimisticOwnerPostInfiniteData({
      pages: [
        { success: true, posts: [{ id: 'a' }] } as never,
        { success: true, posts: [{ id: 'post-new' }, { id: 'b' }] } as never,
      ],
      pageParams: [0, 24],
    }, post);

    expect(result.pages[0].posts.map((item) => item.id)).toEqual(['post-new', 'a']);
    expect(result.pages[1].posts.map((item) => item.id)).toEqual(['b']);
  });
});
