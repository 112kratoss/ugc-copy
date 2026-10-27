import { describe, expect, it } from 'vitest';

import {
  applyCreationPromptResource,
  buildCreatePostFormData,
  buildPublishGenerationPostPayload,
  buildSuggestedRecipePreview,
  buildUpdatePostPayload,
  countCreationReferenceFiles,
  createPostComposerResourceCard,
  describeRecipeBuyers,
  followSuggestedRecipePreview,
  foldRecipeSummaryIntoPreview,
  getDefaultPostComposerDraft,
  getPostComposerPackageStatus,
  getPostComposerResourceCardErrors,
  getPostComposerResourceCardSaveHint,
  getRecipeMoneyLine,
  getRecipeRemovalConfirmation,
  getVisiblePostComposerResourceCardErrors,
  POST_COMPOSER_MORE_RESOURCE_CARD_TYPES,
  POST_COMPOSER_PRIMARY_RESOURCE_CARD_TYPES,
  POST_COMPOSER_RESOURCE_CARD_OPTIONS,
  validatePostComposerDraft,
  type PostComposerDraft,
  type PostComposerResourceCardType,
} from '../lib/post-new-view-model';
import type { GenerationListItem } from '../lib/types';

/**
 * The app composer's recipe form after the recipe audit (2026-10-27,
 * archive/recipe-audit-2026-10-27): one Recipe preview suggested from the
 * items, the price told in credits and money, Remix that comes with the recipe,
 * a confirmed removal, and an item editor that speaks only once touched.
 */

function generation(overrides: Partial<GenerationListItem> = {}): GenerationListItem {
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

function card(type: PostComposerResourceCardType, id: string = type) {
  return createPostComposerResourceCard(type, {
    id,
    textContent: type === 'prompt' || type === 'settings' || type === 'guide' || type === 'other' ? 'Some protected text' : '',
    externalUrl: type === 'external_link' || type === 'remix_link' || type === 'workflow' ? 'https://example.com/thing' : '',
    attachments: type === 'reference_media' || type === 'source_assets'
      ? [{ id: `${id}-file`, kind: 'file', label: 'file.png', storagePath: 'user-1/file.png', contentType: 'image/png' }]
      : [],
  });
}

/** A public upload post with a title, ready apart from its recipe. */
function recipeDraft(resource: Partial<PostComposerDraft['resource']> = {}): PostComposerDraft {
  const base = getDefaultPostComposerDraft();
  return {
    ...base,
    mode: 'upload',
    proofMode: 'media',
    category: 'image',
    title: 'Neon product study',
    visibility: 'public',
    upload: { uri: 'file:///cover.png', name: 'cover.png', type: 'image/png' },
    resource: { ...base.resource, accessMode: 'free', ...resource },
  };
}

function creationDraft(resource: Partial<PostComposerDraft['resource']> = {}, attachGenerationReferences = false): PostComposerDraft {
  const base = getDefaultPostComposerDraft();
  return {
    ...base,
    mode: 'creation',
    proofMode: 'media',
    category: 'image',
    title: 'Neon product study',
    visibility: 'public',
    selectedGenerationId: 'gen-1',
    sourceTool: 'Magicbooklet',
    sourceToolSlug: 'magicbooklet',
    creationPackage: { attachGenerationReferences },
    resource: { ...base.resource, accessMode: 'free', ...resource },
  };
}

describe('the suggested Recipe preview (S7)', () => {
  it('names each kind once, in the order of the items, with the spec’s example', () => {
    expect(buildSuggestedRecipePreview([
      card('prompt'),
      card('reference_media', 'ref-1'),
      card('reference_media', 'ref-2'),
      card('settings'),
    ])).toBe('Includes the prompt, reference media and the model settings.');
  });

  it('counts the kinds that are counted and joins two with "and"', () => {
    expect(buildSuggestedRecipePreview([card('prompt', 'p1'), card('prompt', 'p2')])).toBe('Includes 2 prompts.');
    expect(buildSuggestedRecipePreview([card('workflow')])).toBe('Includes the workflow.');
    expect(buildSuggestedRecipePreview([card('workflow', 'w1'), card('workflow', 'w2'), card('workflow', 'w3')])).toBe('Includes 3 workflows.');
    expect(buildSuggestedRecipePreview([card('guide')])).toBe('Includes a guide.');
    expect(buildSuggestedRecipePreview([card('guide', 'g1'), card('guide', 'g2')])).toBe('Includes 2 guides.');
    expect(buildSuggestedRecipePreview([card('external_link')])).toBe('Includes a link.');
    expect(buildSuggestedRecipePreview([card('external_link', 'l1'), card('external_link', 'l2')])).toBe('Includes 2 links.');
    expect(buildSuggestedRecipePreview([card('remix_link')])).toBe('Includes a remix link.');
    expect(buildSuggestedRecipePreview([card('remix_link', 'r1'), card('remix_link', 'r2')])).toBe('Includes 2 remix links.');
    expect(buildSuggestedRecipePreview([card('other')])).toBe('Includes one more item.');
    expect(buildSuggestedRecipePreview([card('other', 'o1'), card('other', 'o2')])).toBe('Includes 2 more items.');
    expect(buildSuggestedRecipePreview([card('source_assets', 's1'), card('source_assets', 's2')])).toBe('Includes source files.');
    expect(buildSuggestedRecipePreview([card('settings', 's1'), card('settings', 's2')])).toBe('Includes the model settings.');
    expect(buildSuggestedRecipePreview([card('guide'), card('external_link')])).toBe('Includes a guide and a link.');
  });

  it('is empty with no items', () => {
    expect(buildSuggestedRecipePreview([])).toBe('');
  });

  // The server appends a creation's references after the items (A-F9).
  it('counts a creation’s references as reference media after the items', () => {
    expect(buildSuggestedRecipePreview([], { creationReferences: true })).toBe('Includes reference media.');
    expect(buildSuggestedRecipePreview([card('prompt')], { creationReferences: true })).toBe('Includes the prompt and reference media.');
    expect(buildSuggestedRecipePreview([card('reference_media'), card('prompt')], { creationReferences: true }))
      .toBe('Includes reference media and the prompt.');
  });
});

describe('the Recipe preview follows the items until the creator writes it (S6)', () => {
  const item = generation();

  it('is written when the first item is saved', () => {
    const before = recipeDraft();
    const after = recipeDraft({ cards: [card('prompt')] });
    expect(followSuggestedRecipePreview(before, after, null).resource.previewText).toBe('Includes the prompt.');
  });

  it('is refreshed while it still says what was suggested', () => {
    const before = recipeDraft({ cards: [card('prompt')], previewText: 'Includes the prompt.' });
    const after = { ...before, resource: { ...before.resource, cards: [card('prompt'), card('guide')] } };
    expect(followSuggestedRecipePreview(before, after, null).resource.previewText).toBe('Includes the prompt and a guide.');

    // A removal takes its phrase away, down to nothing.
    const removed = { ...before, resource: { ...before.resource, cards: [] } };
    expect(followSuggestedRecipePreview(before, removed, null).resource.previewText).toBe('');
  });

  it('keeps what the creator wrote', () => {
    const before = recipeDraft({ cards: [card('prompt')], previewText: 'My exact neon portrait prompt.' });
    const after = { ...before, resource: { ...before.resource, cards: [card('prompt'), card('guide')] } };
    expect(followSuggestedRecipePreview(before, after, null).resource.previewText).toBe('My exact neon portrait prompt.');
  });

  it('leaves a field the creator emptied alone until the items change', () => {
    const before = recipeDraft({ cards: [card('prompt')], previewText: 'Includes the prompt.' });
    const emptied = { ...before, resource: { ...before.resource, previewText: '' } };
    expect(followSuggestedRecipePreview(before, emptied, null).resource.previewText).toBe('');
  });

  it('follows the creation’s references as they are switched on and off', () => {
    const before = creationDraft({ cards: [card('prompt')], previewText: 'Includes the prompt.' });
    const on = { ...before, creationPackage: { attachGenerationReferences: true } };
    const withReferences = generation({ input_media: [{ url: 'https://cdn.example.com/a.jpg', kind: 'image' }] });
    expect(followSuggestedRecipePreview(before, on, withReferences).resource.previewText).toBe('Includes the prompt and reference media.');
    expect(followSuggestedRecipePreview(before, on, item).resource.previewText).toBe('Includes the prompt.');
  });

  it('is what Include exact prompt writes', () => {
    const draft = applyCreationPromptResource(creationDraft({ accessMode: 'none' }), item, true);
    expect(draft.resource.previewText).toBe('Includes the prompt.');
    expect(draft.resource.cards[0]).toMatchObject({ title: 'Exact generation prompt', textContent: 'Make a glossy product photo' });

    // Switched off again, the suggestion leaves with its item.
    expect(applyCreationPromptResource(draft, item, false).resource.previewText).toBe('');
  });
});

describe('one Recipe preview in place of the summary and the package preview (S6)', () => {
  it('opens an edit on the summary when there is one, else the preview, and keeps no summary', () => {
    expect(foldRecipeSummaryIntoPreview({
      ...recipeDraft().resource,
      summary: 'Prompt pack for neon portraits',
      previewText: 'Includes the prompt.',
    })).toMatchObject({ summary: '', previewText: 'Prompt pack for neon portraits' });
    expect(foldRecipeSummaryIntoPreview({ ...recipeDraft().resource, summary: '  ', previewText: 'Includes the prompt.' }))
      .toMatchObject({ summary: '', previewText: 'Includes the prompt.' });
  });

  it('sends the one text as the preview and as the summary the serializer copies from it', () => {
    const payload = buildUpdatePostPayload(false, recipeDraft({
      cards: [card('prompt')],
      previewText: 'The exact prompt behind the neon portraits.',
    }));
    expect(payload.resourceBundle).toMatchObject({
      summary: 'The exact prompt behind the neon portraits.',
      previewText: 'The exact prompt behind the neon portraits.',
    });
  });
});

describe('what a paid recipe earns (A-F4, A-F5)', () => {
  // Never a cash price beside a recipe in the app (App Review 2.1(b), 0.1.6):
  // buyers pay in credits here; the creator's own earnings are told in money.
  it('says what buyers pay in credits and what the creator earns in dollars', () => {
    expect(getRecipeMoneyLine(900)).toBe('Buyers pay 900 credits · You earn ~$7.65 (85%) · Payouts from $100');
    expect(getRecipeMoneyLine(50)).toBe('Buyers pay 50 credits · You earn ~$0.43 (85%) · Payouts from $100');
    expect(getRecipeMoneyLine(10)).toBe('Buyers pay 10 credits · You earn ~$0.09 (85%) · Payouts from $100');
    expect(getRecipeMoneyLine(0)).toBe('Buyers pay 0 credits · You earn ~$0.00 (85%) · Payouts from $100');
  });
});

describe('what the recipe needs before it can be published', () => {
  it('needs at least one item, whatever remix access the draft carries (S1)', () => {
    expect(validatePostComposerDraft(recipeDraft({ allowRemix: true, previewText: 'Remix this neon portrait post.' })))
      .toEqual({ valid: false, message: 'Add at least one item to the recipe.' });
    expect(getPostComposerPackageStatus(recipeDraft({ allowRemix: true }))).toMatchObject({
      label: 'Finish the recipe',
      body: 'Add at least one item.',
      state: 'warning',
    });
  });

  it('takes a creation’s references as the recipe’s content (A-F9)', () => {
    const item = generation({ input_media: [{ url: 'https://cdn.example.com/a.jpg', kind: 'image' }] });
    const draft = creationDraft({ previewText: 'Includes reference media.' }, true);
    expect(validatePostComposerDraft(draft, { includesCreationReferences: true })).toEqual({ valid: true });
    expect(validatePostComposerDraft(draft)).toEqual({ valid: false, message: 'Add at least one item to the recipe.' });
    expect(getPostComposerPackageStatus(draft, item)).toMatchObject({ state: 'ready' });
    expect(countCreationReferenceFiles(item)).toBe(1);
    expect(countCreationReferenceFiles(generation({ input_media: [] }))).toBe(0);
    expect(countCreationReferenceFiles(null)).toBe(0);
  });

  it('asks for the Recipe preview in its own words', () => {
    expect(validatePostComposerDraft(recipeDraft({ cards: [card('prompt')], previewText: '  ' })))
      .toEqual({ valid: false, message: 'Add a recipe preview.' });
    expect(getPostComposerPackageStatus(recipeDraft({ cards: [card('prompt')], previewText: '' })))
      .toMatchObject({ label: 'Finish the recipe', body: 'Add a recipe preview.' });
    expect(validatePostComposerDraft(recipeDraft({ cards: [card('prompt')], previewText: 'Prompt pack' })))
      .toEqual({ valid: false, message: 'Write a recipe preview of at least 18 characters that says what people get.' });
  });

  it('prices in credits, from 10 in steps of 10', () => {
    const paid = (priceTokens: string) => recipeDraft({
      accessMode: 'paid',
      cards: [card('prompt')],
      previewText: 'Includes the exact prompt.',
      priceTokens,
    });
    expect(validatePostComposerDraft(paid('5'))).toEqual({ valid: false, message: 'Paid recipes start at 10 credits, in steps of 10.' });
    expect(validatePostComposerDraft(paid('15'))).toEqual({ valid: false, message: 'Paid recipes start at 10 credits, in steps of 10.' });
    expect(getPostComposerPackageStatus(paid('15'))).toEqual({
      id: 'unlock',
      label: 'Set a valid price',
      body: 'Paid recipes start at 10 credits, in steps of 10.',
      state: 'warning',
    });
    expect(validatePostComposerDraft(paid('20'))).toEqual({ valid: true });
  });
});

describe('remix comes with the recipe (S1)', () => {
  it('sends no remix flag on a new recipe, whatever an older draft held', () => {
    const item = generation();
    const draft = creationDraft({ cards: [card('prompt')], previewText: 'Includes the prompt.', allowRemix: true });
    expect(buildPublishGenerationPostPayload(item, draft).resourceBundle).toMatchObject({ resources: { allowRemix: false } });

    const upload = recipeDraft({ cards: [card('prompt')], previewText: 'Includes the prompt.', allowRemix: true });
    const bundle = JSON.parse(String(buildCreatePostFormData(upload).get('resourceBundle')));
    expect(bundle.resources.allowRemix).toBe(false);
  });

  it('sends an edit back with the value it was loaded with', () => {
    for (const allowRemix of [true, false]) {
      const payload = buildUpdatePostPayload(true, creationDraft({ cards: [card('prompt')], previewText: 'Includes the prompt.', allowRemix }));
      expect(payload.resourceBundle).toMatchObject({ resources: { allowRemix } });
    }
  });

  it('publishes a recipe of the creation’s references alone, for the server to fill', () => {
    const item = generation({ input_media: [{ url: 'https://cdn.example.com/a.jpg', kind: 'image' }] });
    const payload = buildPublishGenerationPostPayload(item, creationDraft({ previewText: 'Includes reference media.' }, true));
    expect(payload.includeGenerationReferences).toBe(true);
    expect(payload.resourceBundle).toEqual({
      accessMode: 'free',
      summary: 'Includes reference media.',
      previewText: 'Includes reference media.',
      priceUsdCents: 0,
      resources: {
        promptText: null,
        notesMarkdown: null,
        workflowShareUrl: null,
        attachments: [],
        allowRemix: false,
        sections: [],
        items: [],
      },
    });
  });
});

describe('sold recipes can be corrected (S2)', () => {
  it('always sends the recipe with an edit', () => {
    const payload = buildUpdatePostPayload(false, recipeDraft({
      accessMode: 'paid',
      cards: [card('prompt')],
      previewText: 'Includes the exact prompt.',
      priceTokens: '900',
    }));
    expect(payload.resourceBundle).toMatchObject({ accessMode: 'paid', priceUsdCents: 900 });
  });

  it('tells the creator who has the recipe and what they keep', () => {
    expect(describeRecipeBuyers(0)).toBeNull();
    expect(describeRecipeBuyers(undefined)).toBeNull();
    expect(describeRecipeBuyers(1)).toBe('1 person has this recipe. They keep the version they got and see your changes.');
    expect(describeRecipeBuyers(3)).toBe('3 people have this recipe. They keep the version they got and see your changes.');
  });
});

describe('removing a recipe is confirmed (A-F2)', () => {
  it('asks only when an edit takes away a recipe the post had', () => {
    expect(getRecipeRemovalConfirmation({ loadedAccessMode: 'free', loadedItemCount: 4, buyerCount: 0, nextAccessMode: 'free' })).toBeNull();
    expect(getRecipeRemovalConfirmation({ loadedAccessMode: 'none', loadedItemCount: 0, buyerCount: 0, nextAccessMode: 'none' })).toBeNull();
    expect(getRecipeRemovalConfirmation({ loadedAccessMode: null, loadedItemCount: 0, buyerCount: 0, nextAccessMode: 'none' })).toBeNull();
    expect(getRecipeRemovalConfirmation({ loadedAccessMode: 'paid', loadedItemCount: 4, buyerCount: 0, nextAccessMode: 'none' })).toEqual({
      title: 'Remove this recipe?',
      message: 'Its 4 items and files will be deleted.',
      confirmLabel: 'Remove recipe',
      cancelLabel: 'Keep recipe',
      destructive: true,
    });
  });

  it('says that the people who have it keep their copy', () => {
    expect(getRecipeRemovalConfirmation({ loadedAccessMode: 'free', loadedItemCount: 1, buyerCount: 3, nextAccessMode: 'none' })?.message)
      .toBe('Its 1 item and files will be deleted. The 3 people who have it keep their copy; it comes off sale.');
    expect(getRecipeRemovalConfirmation({ loadedAccessMode: 'paid', loadedItemCount: 2, buyerCount: 1, nextAccessMode: 'none' })?.message)
      .toBe('Its 2 items and files will be deleted. The 1 person who has it keeps their copy; it comes off sale.');
  });
});

describe('the item picker (S8)', () => {
  it('shows four kinds first and the other five under More types, each kind once', () => {
    expect(POST_COMPOSER_PRIMARY_RESOURCE_CARD_TYPES).toEqual(['prompt', 'reference_media', 'settings', 'guide']);
    expect(POST_COMPOSER_MORE_RESOURCE_CARD_TYPES).toEqual(['workflow', 'source_assets', 'external_link', 'remix_link', 'other']);
    expect([...POST_COMPOSER_PRIMARY_RESOURCE_CARD_TYPES, ...POST_COMPOSER_MORE_RESOURCE_CARD_TYPES].sort())
      .toEqual(POST_COMPOSER_RESOURCE_CARD_OPTIONS.map((option) => option.id).sort());
  });
});

describe('the item editor speaks once a field is touched (A-F14)', () => {
  it('names what is missing in item words, as the web composer does', () => {
    expect(getPostComposerResourceCardErrors(createPostComposerResourceCard('prompt', { title: '' }))).toEqual({
      title: 'Add an item title.',
      content: 'Add the content, link, or file for this item.',
    });
    expect(getPostComposerResourceCardErrors(createPostComposerResourceCard('external_link', { externalUrl: 'example.com' })).content)
      .toBe('Add a valid http:// or https:// link.');
  });

  it('shows no error on a new item until its field is touched, and a neutral hint meanwhile', () => {
    const fresh = createPostComposerResourceCard('reference_media');
    expect(getVisiblePostComposerResourceCardErrors(fresh, {})).toEqual({});
    expect(getPostComposerResourceCardSaveHint(fresh, {})).toBe('Add a file to save this item.');

    expect(getVisiblePostComposerResourceCardErrors(fresh, { content: true })).toEqual({ content: 'Add the content, link, or file for this item.' });
    expect(getPostComposerResourceCardSaveHint(fresh, { content: true })).toBeNull();

    const untitled = createPostComposerResourceCard('prompt', { title: '', textContent: 'Exact prompt' });
    expect(getVisiblePostComposerResourceCardErrors(untitled, {})).toEqual({});
    expect(getPostComposerResourceCardSaveHint(untitled, {})).toBe('Add an item title to save this item.');
    expect(getVisiblePostComposerResourceCardErrors(untitled, { title: true })).toEqual({ title: 'Add an item title.' });
  });

  it('asks each kind for what it holds', () => {
    const hint = (type: PostComposerResourceCardType) => getPostComposerResourceCardSaveHint(createPostComposerResourceCard(type), {});
    expect(hint('prompt')).toBe('Add the prompt to save this item.');
    expect(hint('settings')).toBe('Add the settings to save this item.');
    expect(hint('guide')).toBe('Add the guide or notes to save this item.');
    expect(hint('workflow')).toBe('Add a link or a file to save this item.');
    expect(hint('source_assets')).toBe('Add a file to save this item.');
    expect(hint('external_link')).toBe('Add a link to save this item.');
    expect(hint('remix_link')).toBe('Add a link to save this item.');
    expect(hint('other')).toBe('Add text or a file to save this item.');
  });

  it('always shows a link that cannot be opened, which only typing makes', () => {
    const typed = createPostComposerResourceCard('external_link', { externalUrl: 'example.com' });
    expect(getVisiblePostComposerResourceCardErrors(typed, {})).toEqual({ content: 'Add a valid http:// or https:// link.' });
    expect(getPostComposerResourceCardSaveHint(typed, {})).toBeNull();
  });

  it('says nothing about a ready item', () => {
    const ready = card('prompt');
    expect(getVisiblePostComposerResourceCardErrors(ready, { title: true, content: true })).toEqual({});
    expect(getPostComposerResourceCardSaveHint(ready, { title: true, content: true })).toBeNull();
  });
});
