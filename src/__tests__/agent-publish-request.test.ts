import { describe, expect, it } from 'vitest';

import {
  AGENT_RECIPE_PREVIEW,
  AGENT_RECIPE_SUMMARY,
  agentFreeRecipeBundle,
  buildAgentPublishRequest,
} from '@/lib/agent-publish-request';
import { getMarketplaceQualityError } from '@/lib/marketplace-trust';

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
});
