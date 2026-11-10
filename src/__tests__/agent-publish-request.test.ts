import { describe, expect, it } from 'vitest';

import {
  AGENT_RECIPE_PREVIEW,
  AGENT_RECIPE_SUMMARY,
  agentFreeRecipeBundle,
  agentPublishSendsRecipe,
  agentRecipeBundle,
  buildAgentPublishRequest,
} from '@/lib/agent-publish-request';
import { getMarketplaceQualityError } from '@/lib/marketplace-trust';
import { getPostResourceBundleLengthError, validatePostResourceBundleInput } from '@/lib/post-resource-bundles';

const GENERATION_ID = '22222222-2222-4222-8222-222222222222';

// The request an agent's publish_post sends is the creator page's one-click Publish request
// (usePublishCreation.ts), so an agent's post is the post the web would have made.
describe('the agent publish request', () => {
  it('sends the free recipe with the exact prompt, and the creation\'s shareable inputs, when remixes are allowed', () => {
    const request = buildAgentPublishRequest({
      generationId: GENERATION_ID,
      title: 'Red bicycle at dawn',
      description: 'Film grain.',
      body: 'Made on a Sunday.',
      category: 'image',
      visibility: 'public',
      isNsfw: false,
      allowRemixes: true,
      creationPrompt: '  a red bicycle at dawn  ',
    });
    expect(request).toEqual({
      generationId: GENERATION_ID,
      visibility: 'public',
      shareInputMediaForRemix: false,
      title: 'Red bicycle at dawn',
      description: 'Film grain.',
      body: 'Made on a Sunday.',
      category: 'image',
      allowRemixes: true,
      includeGenerationReferences: true,
      resourceBundle: agentFreeRecipeBundle('a red bicycle at dawn'),
    });
    expect(request.resourceBundle).toEqual({
      accessMode: 'free',
      summary: AGENT_RECIPE_SUMMARY,
      previewText: AGENT_RECIPE_PREVIEW,
      priceUsdCents: 0,
      resources: { promptText: 'a red bicycle at dawn', workflowShareUrl: null, attachments: [], allowRemix: false },
    });
    expect(request).not.toHaveProperty('isNsfw');
  });

  it('writes listing lines the marketplace quality rule takes for a free recipe of the prompt', () => {
    const bundle = agentFreeRecipeBundle('a red bicycle at dawn, film grain');
    expect(getMarketplaceQualityError({
      title: 'Red bicycle at dawn',
      summary: bundle.summary,
      previewText: bundle.previewText,
      accessMode: 'free',
      priceUsdCents: 0,
      resources: bundle.resources,
      post: { title: 'Red bicycle at dawn', body: null, visibility: 'public', archivedAt: null, reviewStatus: 'visible', hasMedia: true },
    })).toBeNull();
  });

  it('posts the media alone, with no recipe and no remix switch, when remixes are off or the creation has no prompt', () => {
    const off = buildAgentPublishRequest({ generationId: GENERATION_ID, title: 'Clip', visibility: 'private', isNsfw: true, allowRemixes: false, creationPrompt: 'a prompt' });
    expect(off).toEqual({
      generationId: GENERATION_ID,
      visibility: 'private',
      shareInputMediaForRemix: false,
      title: 'Clip',
      isNsfw: true,
      resourceBundle: { accessMode: 'none' },
    });
    // The server refuses a composer that sends the switch without a recipe (CREATION_RECIPE_REQUIRED).
    expect(off).not.toHaveProperty('allowRemixes');
    expect(off).not.toHaveProperty('includeGenerationReferences');

    const silent = buildAgentPublishRequest({ generationId: GENERATION_ID, visibility: 'public', allowRemixes: true, creationPrompt: '   ' });
    expect(silent.resourceBundle).toEqual({ accessMode: 'none' });
    expect(silent).not.toHaveProperty('allowRemixes');
    expect(silent).not.toHaveProperty('title');
  });

  it('sends the same recipe paid, at the person\'s price, as the web\'s Publish sends a paid one', () => {
    const request = buildAgentPublishRequest({
      generationId: GENERATION_ID,
      title: 'Red bicycle at dawn',
      visibility: 'public',
      allowRemixes: true,
      creationPrompt: '  a red bicycle at dawn  ',
      recipePriceTokens: 250,
    });
    // usePublishCreation.ts's buildAutoResourceBundle for a paid recipe of the prompt: the access
    // mode, and the token count in priceUsdCents. Nothing else differs from the free request.
    expect(request.resourceBundle).toEqual({
      accessMode: 'paid',
      summary: AGENT_RECIPE_SUMMARY,
      previewText: AGENT_RECIPE_PREVIEW,
      priceUsdCents: 250,
      resources: { promptText: 'a red bicycle at dawn', workflowShareUrl: null, attachments: [], allowRemix: false },
    });
    const free = buildAgentPublishRequest({ generationId: GENERATION_ID, title: 'Red bicycle at dawn', visibility: 'public', allowRemixes: true, creationPrompt: 'a red bicycle at dawn' });
    expect(request).toEqual({ ...free, resourceBundle: { ...free.resourceBundle, accessMode: 'paid', priceUsdCents: 250 } });
    expect(request).toMatchObject({ allowRemixes: true, includeGenerationReferences: true, shareInputMediaForRemix: false });
    // The price is passed, never worked out: the number given is the number sent.
    for (const price of [10, 20, 990, 12_340]) {
      expect(agentRecipeBundle('a prompt', { priceTokens: price })).toMatchObject({ accessMode: 'paid', priceUsdCents: price });
    }
    // The service's validator and its public listing rule take it.
    expect(validatePostResourceBundleInput(request.resourceBundle, { ownerUserId: 'user-1', mediaKeys: ['media-1'] })).toBeNull();
    expect(getMarketplaceQualityError({
      title: 'Red bicycle at dawn',
      summary: request.resourceBundle?.summary,
      previewText: request.resourceBundle?.previewText,
      accessMode: 'paid',
      priceUsdCents: 250,
      resources: request.resourceBundle?.resources,
      post: { title: 'Red bicycle at dawn', body: null, visibility: 'public', archivedAt: null, reviewStatus: 'visible', hasMedia: true },
    })).toBeNull();
  });

  it('is free with no price, a price of 0 or the free builder, and the validator is the one that refuses a bad price', () => {
    const free = agentFreeRecipeBundle('a prompt');
    expect(agentRecipeBundle('a prompt')).toEqual(free);
    expect(agentRecipeBundle('a prompt', { priceTokens: 0 })).toEqual(free);
    expect(free).toMatchObject({ accessMode: 'free', priceUsdCents: 0 });
    // This module does no arithmetic on a price: one the tool let through wrongly is still
    // refused by the service's own rule.
    expect(validatePostResourceBundleInput(agentRecipeBundle('a prompt', { priceTokens: 5 }), { ownerUserId: 'user-1', mediaKeys: ['media-1'] }))
      .toBe('Paid recipes must cost at least 10 credits and use 10-credit increments.');
    expect(validatePostResourceBundleInput(agentRecipeBundle('a prompt', { priceTokens: 255 }), { ownerUserId: 'user-1', mediaKeys: ['media-1'] }))
      .toBe('Paid recipes must cost at least 10 credits and use 10-credit increments.');
  });

  it('takes the person\'s own listing lines for the recipe, else the web\'s', () => {
    const request = buildAgentPublishRequest({
      generationId: GENERATION_ID,
      visibility: 'private',
      allowRemixes: true,
      creationPrompt: 'a red bicycle at dawn',
      recipePriceTokens: 100,
      recipeSummary: '  The dawn bicycle prompt  ',
      recipePreview: 'The exact prompt and the film-grain settings behind this shot.',
    });
    expect(request.resourceBundle).toMatchObject({
      accessMode: 'paid',
      priceUsdCents: 100,
      summary: 'The dawn bicycle prompt',
      previewText: 'The exact prompt and the film-grain settings behind this shot.',
    });
    expect(agentRecipeBundle('a prompt', { summary: '   ', preview: '' })).toMatchObject({ summary: AGENT_RECIPE_SUMMARY, previewText: AGENT_RECIPE_PREVIEW });
    // A summary left out is the preview where one was given, as the composer's serializer has it
    // and as the tool's description says; a summary given stands beside its preview.
    expect(agentRecipeBundle('a prompt', { preview: 'The exact prompt behind this shot.' })).toMatchObject({
      summary: 'The exact prompt behind this shot.',
      previewText: 'The exact prompt behind this shot.',
    });
    expect(agentRecipeBundle('a prompt', { summary: 'The dawn bicycle prompt' })).toMatchObject({ summary: 'The dawn bicycle prompt', previewText: AGENT_RECIPE_PREVIEW });
    // Lines over the listing's limits are the service's to refuse, in its words.
    expect(getPostResourceBundleLengthError(agentRecipeBundle('a prompt', { summary: 's'.repeat(181) }))).toMatchObject({ field: 'resourceSummary' });
    expect(getPostResourceBundleLengthError(agentRecipeBundle('a prompt', { preview: 'p'.repeat(181) }))).toMatchObject({ field: 'resourcePreview' });
  });

  it('carries a recipe only with remixes allowed and a prompt to hold, so a price has something to price', () => {
    expect(agentPublishSendsRecipe({ allowRemixes: true, creationPrompt: 'a prompt' })).toBe(true);
    expect(agentPublishSendsRecipe({ allowRemixes: false, creationPrompt: 'a prompt' })).toBe(false);
    expect(agentPublishSendsRecipe({ allowRemixes: true, creationPrompt: '   ' })).toBe(false);
    expect(agentPublishSendsRecipe({ allowRemixes: true, creationPrompt: null })).toBe(false);
    // A price sent where no recipe goes is dropped by the builder; the tool refuses it first.
    const alone = buildAgentPublishRequest({ generationId: GENERATION_ID, visibility: 'public', allowRemixes: false, creationPrompt: 'a prompt', recipePriceTokens: 250 });
    expect(alone.resourceBundle).toEqual({ accessMode: 'none' });
  });
});
