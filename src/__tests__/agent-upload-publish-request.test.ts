import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import fixture from '../../contracts/post-resource-bundle-authoring-v1.json';
import { uuidOrNull } from '@/lib/agent-tool-calls';
import {
  AGENT_MADE_WITH_APP_REFUSAL,
  AGENT_RESOURCE_CARDS_MAX,
  AGENT_RESOURCE_CARD_TEXT_MAX_LENGTH,
  AGENT_RESOURCE_CARD_TITLE_MAX_LENGTH,
  agentMadeWithSelections,
  agentResourceAccess,
  agentTextPostId,
  agentUploadPostId,
  buildAgentComposedPostFormData,
  buildAgentResourceBundle,
  namesMagicbooklet,
  refuseAgentMadeWith,
  refuseAgentResourcePrice,
  refuseAgentResources,
  type AgentResourceCard,
} from '@/lib/agent-upload-publish-request';
import {
  buildResourceCardBundleInput,
  createPostComposerResourceCard,
  type PostComposerResourceCardDraft,
} from '@/lib/post-composer-resource-cards';
import { preparePostCreationSubmission } from '@/lib/post-creation-submission-service';
import {
  POST_RESOURCE_CARD_DESCRIPTION_MAX_LENGTH,
  POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS,
  POST_RESOURCE_PRICE_INCREMENT_USD_CENTS,
  getPostResourceBundleLengthError,
  validatePostResourceBundleInput,
  type PostResourceBundleInput,
} from '@/lib/post-resource-bundles';
import { FALLBACK_SOURCE_TOOLS } from '@/lib/source-tools';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '99999999-9999-4999-8999-999999999999';
const UPLOAD_A = '55555555-5555-4555-8555-555555555555';
const UPLOAD_B = '66666666-6666-4666-8666-666666666666';
const PICTURE = `uploads/${USER_ID}/${UPLOAD_A}-paper-fox.png`;
const CLIP = `uploads/${USER_ID}/${UPLOAD_B}-fox-run.mp4`;

const ARGS = {
  title: 'Paper-cut fox in a snowy forest',
  visibility: 'public' as const,
  madeWith: [{ tool: 'Midjourney', model: 'v7' }],
  uploads: [{ storagePath: PICTURE, contentType: 'image/png' }],
};

/** The form's fields as plain values, the JSON ones parsed. */
function fields(formData: FormData): Record<string, unknown> {
  const json = new Set(['sourceTools', 'resourceBundle', 'mediaItems']);
  return Object.fromEntries([...formData.entries()].map(([key, value]) => [key, json.has(key) ? JSON.parse(String(value)) : value]));
}

describe('the id of a post made from uploads', () => {
  it('is one UUID for one creator and one ordered set of staged files, and another for anything else', () => {
    const id = agentUploadPostId(USER_ID, [PICTURE, CLIP]);
    // A repeat of the same publish names the same post: that is what makes a retry safe.
    expect(agentUploadPostId(USER_ID, [PICTURE, CLIP])).toBe(id);
    expect(agentUploadPostId(USER_ID.toUpperCase(), [PICTURE, CLIP])).toBe(id);
    // A UUID wherever one is checked: the tools' schema, the audit row's columns, the posts table.
    expect(z.uuid().safeParse(id).success).toBe(true);
    expect(uuidOrNull(id)).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);

    const others = [
      agentUploadPostId(OTHER_USER_ID, [PICTURE, CLIP]),
      agentUploadPostId(USER_ID, [CLIP, PICTURE]),
      agentUploadPostId(USER_ID, [PICTURE]),
      agentUploadPostId(USER_ID, [PICTURE, `${CLIP}x`]),
    ];
    expect(new Set([id, ...others]).size).toBe(5);
    // The paths are hashed as a list, so no two lists read as the same string.
    expect(agentUploadPostId(USER_ID, ['a', 'b,c'])).not.toBe(agentUploadPostId(USER_ID, ['a,b', 'c']));
    expect(agentUploadPostId(USER_ID, ['a', 'b'])).not.toBe(agentUploadPostId(USER_ID, ['a","b']));
  });
});

describe('the id of a text post', () => {
  it('is one UUID for one creator, one title and one text, read as the composer reads them', () => {
    const id = agentTextPostId(USER_ID, 'A prompt for product shots', 'Three lines that work.\nTry them.');
    // A repeat of the same publish names the same post, however the text was typed.
    expect(agentTextPostId(USER_ID, 'A prompt for product shots', 'Three lines that work.\nTry them.')).toBe(id);
    expect(agentTextPostId(USER_ID.toUpperCase(), '  A prompt for product shots ', '\nThree lines that work.\r\nTry them.  ')).toBe(id);
    expect(z.uuid().safeParse(id).success).toBe(true);
    expect(uuidOrNull(id)).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);

    const others = [
      agentTextPostId(OTHER_USER_ID, 'A prompt for product shots', 'Three lines that work.\nTry them.'),
      agentTextPostId(USER_ID, 'A prompt for product shots!', 'Three lines that work.\nTry them.'),
      agentTextPostId(USER_ID, 'A prompt for product shots', 'Three lines that work. Try them.'),
      // The title and the text are hashed apart: moving words between them is another post.
      agentTextPostId(USER_ID, 'A prompt for', 'product shots Three lines that work.\nTry them.'),
      // And a text post is never the post of an upload whose path reads the same.
      agentUploadPostId(USER_ID, ['A prompt for product shots', 'Three lines that work.\nTry them.']),
    ];
    expect(new Set([id, ...others]).size).toBe(6);
  });
});

describe('made_with', () => {
  it('refuses Magicbooklet\'s own name in every spelling the catalog reads as the app', () => {
    for (const name of ['Magic Booklet', 'magicbooklet', 'MagicBooklet', 'magic-booklet', '  Magic   Booklet ', 'MAGIC BOOKLET', 'Emptybooklet']) {
      expect(namesMagicbooklet(name), name).toBe(true);
      expect(refuseAgentMadeWith([{ tool: 'Midjourney' }, { tool: name, model: 'Seedance' }]), name).toBe(AGENT_MADE_WITH_APP_REFUSAL);
    }
    for (const name of ['Midjourney', 'Magic Leap', 'Booklet Maker', 'Photoshop', 'Magic']) {
      expect(namesMagicbooklet(name), name).toBe(false);
    }
    // The refusal says where media made here goes instead.
    expect(AGENT_MADE_WITH_APP_REFUSAL).toContain('Magic Booklet is not a name for made_with');
    expect(AGENT_MADE_WITH_APP_REFUSAL).toContain('generation_id');
  });

  it('refuses what the composer\'s own validator refuses, in its words, and lets a plain name stand', () => {
    expect(refuseAgentMadeWith([{ tool: 'Midjourney', model: 'v7' }, { tool: 'Photoshop' }])).toBeNull();
    expect(refuseAgentMadeWith([{ tool: 'Custom' }])).toBe('The source tool name "Custom" is reserved.');
    expect(refuseAgentMadeWith([{ tool: 'unknown' }])).toBe('The source tool name "unknown" is reserved.');
    expect(refuseAgentMadeWith([{ tool: 'x'.repeat(81) }])).toBe('Source tool names must be 80 characters or fewer.');
    expect(refuseAgentMadeWith([{ tool: 'Midjourney', model: 'm'.repeat(81) }])).toBe('Source model names must be 80 characters or fewer.');
    expect(refuseAgentMadeWith([{ tool: '!!!' }])).toBe('Source tool names must include letters or numbers.');
    expect(refuseAgentMadeWith([{ tool: 'Midjourney', model: '???' }])).toBe('Source model names must include letters or numbers.');
    expect(refuseAgentMadeWith([{ tool: 'Midjourney', model: 'All' }])).toBe('The source model name "All" is reserved.');
    expect(refuseAgentMadeWith([{ tool: '   ' }])).toBe('Source tool names cannot be empty.');
    expect(refuseAgentMadeWith(Array.from({ length: 6 }, (_, index) => ({ tool: `Tool ${index}` })))).toBe('A post can include at most 5 source tools.');
    expect(refuseAgentMadeWith(Array.from({ length: 5 }, (_, index) => ({ tool: `Tool ${index}` })))).toBeNull();
  });

  it('is sent as the composer sends a typed name, and never asks the catalog to grow', () => {
    const selections = agentMadeWithSelections([{ tool: ' Midjourney ', model: ' v7 ' }, { tool: 'My Own Renderer' }]);
    expect(selections).toEqual([
      { toolLabel: 'Midjourney', toolSlug: 'midjourney', modelLabel: 'v7', modelSlug: 'v7' },
      { toolLabel: 'My Own Renderer', toolSlug: 'my-own-renderer', modelLabel: null, modelSlug: null },
    ]);
    // The composer's createTool and createModel add a name to the catalog every composer picks
    // from, ten tools and thirty models a day per account. An agent's names stay on its post.
    for (const selection of selections) {
      expect(selection).not.toHaveProperty('createTool');
      expect(selection).not.toHaveProperty('createModel');
    }
  });
});

describe('the form the composer service is sent', () => {
  it('fills the composer page\'s own fields for uploaded media', () => {
    expect(fields(buildAgentComposedPostFormData(ARGS))).toEqual({
      title: 'Paper-cut fox in a snowy forest',
      body: '',
      sourceTool: 'Midjourney',
      sourceToolSlug: 'midjourney',
      sourceTools: [{ toolLabel: 'Midjourney', toolSlug: 'midjourney', modelLabel: 'v7', modelSlug: 'v7' }],
      visibility: 'public',
      isNsfw: 'false',
      // Media alone is a media post; no recipe goes with an upload.
      postFormat: 'media',
      resourceBundle: { accessMode: 'none' },
      // The staged name without the upload id the sign step prefixes, and the type the server recorded.
      mediaItems: [{ storagePath: PICTURE, originalName: 'paper-fox.png', contentType: 'image/png' }],
      category: 'image',
    });

    const full = fields(buildAgentComposedPostFormData({
      ...ARGS,
      description: 'Cut from one sheet.',
      body: '  Made over a weekend.  ',
      visibility: 'private',
      isNsfw: true,
      madeWith: [{ tool: 'Blender' }, { tool: 'After Effects' }],
      uploads: [{ storagePath: CLIP, contentType: 'video/mp4' }, { storagePath: PICTURE, contentType: 'image/png' }],
    }));
    expect(full).toMatchObject({
      description: 'Cut from one sheet.',
      body: 'Made over a weekend.',
      // Media with a note is the composer's mixed post.
      postFormat: 'mixed',
      visibility: 'private',
      isNsfw: 'true',
      sourceTool: 'Blender',
      sourceToolSlug: 'blender',
      // The first file's kind files the post when no category is given.
      category: 'video',
    });
    expect(full.mediaItems).toEqual([
      { storagePath: CLIP, originalName: 'fox-run.mp4', contentType: 'video/mp4' },
      { storagePath: PICTURE, originalName: 'paper-fox.png', contentType: 'image/png' },
    ]);
    // A category given is sent as given: the composer service judges whether it fits the media.
    expect(fields(buildAgentComposedPostFormData({ ...ARGS, category: 'video' })).category).toBe('video');
    // A file the server has no type for goes with none, never a guess from its name.
    expect(fields(buildAgentComposedPostFormData({ ...ARGS, uploads: [{ storagePath: PICTURE, contentType: null }] })).mediaItems)
      .toEqual([{ storagePath: PICTURE, originalName: 'paper-fox.png', contentType: '' }]);
  });

  it('is a form the composer service takes: an external media post with its Made with, and no recipe', async () => {
    const prepared = await preparePostCreationSubmission({
      formData: buildAgentComposedPostFormData({
        ...ARGS,
        body: 'Made over a weekend.',
        madeWith: [{ tool: 'midjourney', model: 'v7' }, { tool: 'My Own Renderer' }],
        uploads: [{ storagePath: PICTURE, contentType: 'image/png' }, { storagePath: CLIP, contentType: 'video/mp4' }],
      }),
      userId: USER_ID,
      sourceToolCatalog: FALLBACK_SOURCE_TOOLS,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const { submission } = prepared;
    expect(submission).toMatchObject({
      title: 'Paper-cut fox in a snowy forest',
      body: 'Made over a weekend.',
      postFormat: 'mixed',
      category: 'image',
      visibility: 'public',
      isNsfw: false,
      // Media made outside the app, as every composer upload is filed.
      sourceKind: 'external',
      hasSubmittedMedia: true,
      resourceBundle: { accessMode: 'none' },
    });
    expect(submission.submittedMediaItems).toEqual([
      expect.objectContaining({ source: 'uploaded', filePath: `${USER_ID}/${UPLOAD_A}-paper-fox.png`, originalName: 'paper-fox.png', contentType: 'image/png' }),
      expect.objectContaining({ source: 'uploaded', filePath: `${USER_ID}/${UPLOAD_B}-fox-run.mp4`, originalName: 'fox-run.mp4', contentType: 'video/mp4' }),
    ]);
    // A name the catalog knows is filed under the catalog's spelling; any other stays as given.
    // Neither asks for a catalog row.
    expect(submission.sourceTools).toEqual([
      expect.objectContaining({ toolLabel: 'Midjourney', toolSlug: 'midjourney', createTool: false, createModel: false }),
      { toolLabel: 'My Own Renderer', toolSlug: 'my-own-renderer', modelLabel: null, modelSlug: null, createTool: false, createModel: false },
    ]);
  });

  it('is refused by the composer service\'s own rules: another account\'s file, a file outside staging, a track, a category that does not fit', async () => {
    const prepare = (uploads: Array<{ storagePath: string; contentType: string | null }>, extra: Partial<typeof ARGS & { category: string }> = {}) => (
      preparePostCreationSubmission({
        formData: buildAgentComposedPostFormData({ ...ARGS, ...extra, uploads }),
        userId: USER_ID,
        sourceToolCatalog: FALLBACK_SOURCE_TOOLS,
      })
    );
    // The ownership rule is the service's: a path under another account's folder is not the caller's to post.
    expect(await prepare([{ storagePath: `uploads/${OTHER_USER_ID}/${UPLOAD_A}-theirs.png`, contentType: null }]))
      .toEqual({ ok: false, status: 400, body: { error: 'Uploaded media must belong to the authenticated user.' } });
    expect(await prepare([{ storagePath: PICTURE, contentType: 'image/png' }, { storagePath: `uploads/${OTHER_USER_ID}/${UPLOAD_A}-theirs.png`, contentType: null }]))
      .toMatchObject({ ok: false, body: { error: 'Uploaded media must belong to the authenticated user.' } });
    expect(await prepare([{ storagePath: `post_media/${USER_ID}/x.png`, contentType: null }]))
      .toMatchObject({ ok: false, body: { error: 'Uploaded media must come from the uploads bucket.' } });
    expect(await prepare([{ storagePath: `uploads/${USER_ID}/${UPLOAD_A}-memo.mp3`, contentType: 'audio/mpeg' }]))
      .toMatchObject({ ok: false, body: { error: 'Audio uploads are not supported in Explore yet.' } });
    expect(await prepare([{ storagePath: PICTURE, contentType: 'image/png' }], { category: 'video' }))
      .toMatchObject({ ok: false, body: { error: 'Please upload an image or video and choose a matching category.' } });
    expect(await prepare(Array.from({ length: 6 }, (_, index) => ({ storagePath: `uploads/${USER_ID}/${UPLOAD_A}-${index}.png`, contentType: 'image/png' }))))
      .toMatchObject({ ok: false, body: { error: 'Add up to 5 media items per post.' } });
  });
});

describe('the form of a text post', () => {
  const TEXT_ARGS = {
    title: 'A prompt for product shots',
    body: '  Three lines that work.\nTry them.  ',
    visibility: 'public' as const,
  };

  it('is the composer\'s text post: format and category text, no media, and Made with only where one was given', () => {
    expect(fields(buildAgentComposedPostFormData(TEXT_ARGS))).toEqual({
      title: 'A prompt for product shots',
      body: 'Three lines that work.\nTry them.',
      visibility: 'public',
      isNsfw: 'false',
      resourceBundle: { accessMode: 'none' },
      postFormat: 'text',
      category: 'text',
    });
    // A category given for a text post is not sent: a text post is filed as text.
    expect(fields(buildAgentComposedPostFormData({ ...TEXT_ARGS, category: 'video', uploads: [] })).category).toBe('text');
    expect(fields(buildAgentComposedPostFormData({ ...TEXT_ARGS, description: 'For studio work.', madeWith: [{ tool: 'Midjourney', model: 'v7' }], isNsfw: true, visibility: 'private' }))).toMatchObject({
      description: 'For studio work.',
      sourceTool: 'Midjourney',
      sourceTools: [{ toolLabel: 'Midjourney', toolSlug: 'midjourney', modelLabel: 'v7', modelSlug: 'v7' }],
      isNsfw: 'true',
      visibility: 'private',
      postFormat: 'text',
    });
  });

  it('carries a guide card as the bundle the composer\'s serializer makes, and the composer service takes it', async () => {
    const cards: AgentResourceCard[] = [{ type: 'guide', title: 'Studio-shot skill', description: 'A skill for clean product shots.', text: '# Studio shots\n1. Light from the left.' }];
    const resourceBundle = buildAgentResourceBundle({ cards });
    const formData = buildAgentComposedPostFormData({ ...TEXT_ARGS, resourceBundle });
    expect(fields(formData)).toMatchObject({ postFormat: 'text', category: 'text', resourceBundle });
    expect(fields(formData)).not.toHaveProperty('mediaItems');

    const prepared = await preparePostCreationSubmission({ formData, userId: USER_ID, sourceToolCatalog: FALLBACK_SOURCE_TOOLS });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.submission).toMatchObject({
      title: 'A prompt for product shots',
      body: 'Three lines that work.\nTry them.',
      postFormat: 'text',
      category: 'text',
      // Words written here, as every composer text post is filed.
      sourceKind: 'manual',
      hasSubmittedMedia: false,
      visibility: 'public',
      resourceBundle: { accessMode: 'free', priceUsdCents: 0 },
    });
    expect(prepared.submission.resourceBundle?.resources?.items).toEqual([
      expect.objectContaining({ id: 'agent-resource-1-item-1', type: 'note', title: 'Studio-shot skill', textContent: '# Studio shots\n1. Light from the left.' }),
    ]);
  });

  it('is refused by the composer service\'s own rules: no text, text too long, no title', async () => {
    const prepare = (overrides: Partial<typeof TEXT_ARGS>) => preparePostCreationSubmission({
      formData: buildAgentComposedPostFormData({ ...TEXT_ARGS, ...overrides }),
      userId: USER_ID,
      sourceToolCatalog: FALLBACK_SOURCE_TOOLS,
    });
    expect(await prepare({ body: '   ' })).toMatchObject({ ok: false, status: 400, body: { error: 'Add a note or upload media to publish a post.' } });
    expect(await prepare({ body: 'x'.repeat(2001) })).toMatchObject({ ok: false, status: 400, body: { error: 'Text posts are limited to 2000 characters.' } });
    expect(await prepare({ title: '' })).toMatchObject({ ok: false, status: 400, body: { error: 'Add a title for your post.', field: 'title' } });
  });
});

describe('a resource\'s cards', () => {
  const PROMPT: AgentResourceCard = { type: 'prompt', title: 'Hook prompt', text: 'Cinematic hook, 35mm' };
  const GUIDE: AgentResourceCard = { type: 'guide', title: 'How to reuse', text: 'Step one, step two.' };
  const LINK: AgentResourceCard = { type: 'external_link', title: 'Docs', url: 'https://example.com/docs' };

  it('lets a prompt, a guide and a link stand, each with the one thing it carries', () => {
    expect(refuseAgentResources([PROMPT, GUIDE, LINK])).toBeNull();
    expect(refuseAgentResources([{ ...PROMPT, description: 'd'.repeat(POST_RESOURCE_CARD_DESCRIPTION_MAX_LENGTH) }])).toBeNull();
    expect(refuseAgentResources(Array.from({ length: AGENT_RESOURCE_CARDS_MAX }, () => PROMPT))).toBeNull();
    expect(refuseAgentResources([{ ...GUIDE, text: 'x'.repeat(AGENT_RESOURCE_CARD_TEXT_MAX_LENGTH) }])).toBeNull();
  });

  it('refuses a card without what its type carries, and one that carries the other thing too', () => {
    expect(refuseAgentResources([{ type: 'prompt', title: 'Hook prompt' }])).toBe('resources[0] is a prompt: give its text.');
    expect(refuseAgentResources([PROMPT, { type: 'guide', title: 'How to reuse', text: '   ' }])).toBe('resources[1] is a guide: give its text.');
    expect(refuseAgentResources([{ type: 'external_link', title: 'Docs' }])).toBe('resources[0] is an external_link: give url, an https address.');
    // The composer takes http too; an agent's link is https or it is refused.
    expect(refuseAgentResources([{ ...LINK, url: 'http://example.com/docs' }])).toBe('resources[0] is an external_link: give url, an https address.');
    expect(refuseAgentResources([{ ...LINK, url: 'javascript:alert(1)' }])).toBe('resources[0] is an external_link: give url, an https address.');
    expect(refuseAgentResources([{ ...LINK, url: 'example.com/docs' }])).toBe('resources[0] is an external_link: give url, an https address.');
    // Half of a card is never dropped without a word.
    expect(refuseAgentResources([{ ...LINK, text: 'Read this first.' }])).toContain('it carries a url, not text');
    expect(refuseAgentResources([{ ...GUIDE, url: 'https://example.com' }])).toContain('it carries text, not a url');
    expect(refuseAgentResources([{ type: 'workflow', title: 'Graph', text: 'x' } as unknown as AgentResourceCard])).toBe('resources[0]: type is prompt, guide or external_link.');
  });

  it('holds a card to the validator\'s title and description bounds, and to the tool\'s own on count and text', () => {
    expect(refuseAgentResources([])).toContain('at least one card');
    expect(refuseAgentResources(Array.from({ length: AGENT_RESOURCE_CARDS_MAX + 1 }, () => PROMPT))).toBe(`A resource holds at most ${AGENT_RESOURCE_CARDS_MAX} cards.`);
    expect(refuseAgentResources([{ ...PROMPT, title: '   ' }])).toContain('resources[0] needs a title');
    expect(refuseAgentResources([{ ...PROMPT, title: 't'.repeat(AGENT_RESOURCE_CARD_TITLE_MAX_LENGTH + 1) }])).toBe(`resources[0]: a card's title is at most ${AGENT_RESOURCE_CARD_TITLE_MAX_LENGTH} characters.`);
    expect(refuseAgentResources([{ ...PROMPT, description: 'd'.repeat(POST_RESOURCE_CARD_DESCRIPTION_MAX_LENGTH + 1) }])).toBe(`resources[0]: a card's description is at most ${POST_RESOURCE_CARD_DESCRIPTION_MAX_LENGTH} characters.`);
    expect(refuseAgentResources([{ ...GUIDE, text: 'x'.repeat(AGENT_RESOURCE_CARD_TEXT_MAX_LENGTH + 1) }])).toBe(`resources[0]: a card's text is at most ${AGENT_RESOURCE_CARD_TEXT_MAX_LENGTH} characters.`);
    // The bounds the tool names are the validator's own.
    expect(AGENT_RESOURCE_CARD_TITLE_MAX_LENGTH).toBe(80);
    const tooLongTitle = buildAgentResourceBundle({ cards: [{ ...PROMPT, title: 't'.repeat(81) }] });
    expect(validatePostResourceBundleInput(tooLongTitle, { ownerUserId: USER_ID, mediaKeys: [] })).not.toBeNull();
    const tooLongDescription = buildAgentResourceBundle({ cards: [{ ...PROMPT, description: 'd'.repeat(POST_RESOURCE_CARD_DESCRIPTION_MAX_LENGTH + 1) }] });
    expect(getPostResourceBundleLengthError(tooLongDescription)).toMatchObject({ field: 'resourceCards' });
  });
});

describe('a resource\'s price', () => {
  it('is free when left out or 0, and a paid price is the validator\'s: the minimum or more, in whole steps', () => {
    expect(refuseAgentResourcePrice(undefined, true)).toBeNull();
    expect(refuseAgentResourcePrice(0, true)).toBeNull();
    // No price is no price, with a resource or without one.
    expect(refuseAgentResourcePrice(undefined, false)).toBeNull();
    expect(refuseAgentResourcePrice(0, false)).toBeNull();
    for (const price of [10, 20, 250, 1000, 99_990]) {
      expect(refuseAgentResourcePrice(price, true), String(price)).toBeNull();
    }
    expect(POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS).toBe(10);
    expect(POST_RESOURCE_PRICE_INCREMENT_USD_CENTS).toBe(10);
  });

  it('refuses a price below the minimum, off the step, a fraction, a negative one and one that is not a number', () => {
    for (const price of [1, 5, 9, 15, 255, 10.5, 9.99, 250.000001, -10, -250, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53 * 10]) {
      const refusal = refuseAgentResourcePrice(price, true);
      expect(refusal, String(price)).toContain('resource_price_tokens is a whole number of tokens, 10 or more, in steps of 10');
      expect(refusal, String(price)).toContain('100 tokens = $1.00');
    }
    // A fraction the validator would round to a price it takes is refused here: the person's
    // number is published as given or not at all.
    expect(validatePostResourceBundleInput({ ...buildAgentResourceBundle({ cards: [{ type: 'prompt', title: 'Hook prompt', text: 'x' }], priceTokens: 10 }), priceUsdCents: 10.4 }, { ownerUserId: USER_ID, mediaKeys: [] })).toBeNull();
    expect(refuseAgentResourcePrice(10.4, true)).not.toBeNull();
  });

  it('refuses a price with no resource to carry it', () => {
    expect(refuseAgentResourcePrice(250, false)).toContain('this post carries none');
    // The number is judged first: a bad price is a bad price wherever it is sent.
    expect(refuseAgentResourcePrice(5, false)).toContain('whole number of tokens');
  });
});

describe('the bundle of a resource', () => {
  type SerializationCase = { name: string; resource: { accessMode: string; priceTokens: string; cards: PostComposerResourceCardDraft[] }; expectedBundle: PostResourceBundleInput };
  const cases = fixture.serializationCases as unknown as SerializationCase[];
  const freePrompt = cases.find((entry) => entry.name === 'prompt card, free access');
  const paidCase = cases.find((entry) => entry.resource.accessMode === 'paid');
  const mixedCase = cases.find((entry) => entry.name === 'settings, guide, external link and source assets cards');

  /** A fixture bundle under the ids this module gives its cards. */
  function withAgentIds(bundle: PostResourceBundleInput, ids: Record<string, string>): PostResourceBundleInput {
    let json = JSON.stringify(bundle);
    for (const [from, to] of Object.entries(ids)) json = json.split(from).join(to);
    return JSON.parse(json) as PostResourceBundleInput;
  }

  it('is the contract\'s free prompt bundle, card for card, under the tool\'s own card id', () => {
    expect(freePrompt).toBeDefined();
    if (!freePrompt) return;
    const card = freePrompt.resource.cards[0];
    const bundle = buildAgentResourceBundle({
      cards: [{ type: 'prompt', title: card.title, description: card.preview, text: card.textContent }],
    });
    // The same shape the web and the app composers serialize for the same card.
    expect(bundle).toEqual(withAgentIds(freePrompt.expectedBundle, { [card.id]: 'agent-resource-1' }));
    expect(bundle).toMatchObject({ accessMode: 'free', priceUsdCents: 0, summary: 'Hook prompt', previewText: 'Includes Hook prompt.' });
    expect(validatePostResourceBundleInput(bundle, { ownerUserId: USER_ID, mediaKeys: [] })).toBeNull();
    expect(agentResourceAccess(bundle)).toBe('free');
  });

  it('serializes a guide as a note and a link as a link, as the contract does', () => {
    expect(mixedCase).toBeDefined();
    if (!mixedCase) return;
    const [, guide, link] = mixedCase.resource.cards;
    const bundle = buildAgentResourceBundle({
      cards: [
        { type: 'guide', title: guide.title, text: guide.textContent },
        { type: 'external_link', title: link.title, url: link.externalUrl },
      ],
    });
    const expectedItems = (mixedCase.expectedBundle.resources?.items ?? []).filter((item) => item.type === 'note' || item.type === 'external_link');
    expect(bundle?.resources?.items).toEqual([
      { ...expectedItems[0], id: 'agent-resource-1-item-1', sectionId: 'agent-resource-1', sortOrder: 0, isPrimary: true },
      { ...expectedItems[1], id: 'agent-resource-2-item-2', sectionId: 'agent-resource-2', sortOrder: 1, isPrimary: false },
    ]);
    // The listing lines are the serializer's own derivation, comma and all.
    expect(bundle).toMatchObject({ summary: '2 reusable resources', previewText: 'Includes How to reuse, and Docs.' });
    // Text and links only: nothing of a file, and no live input handed to a remix.
    expect(bundle?.resources).toMatchObject({ attachments: [], allowRemix: false, promptText: null, workflowShareUrl: null });
    expect(validatePostResourceBundleInput(bundle, { ownerUserId: USER_ID, mediaKeys: [] })).toBeNull();
  });

  it('is paid at the person\'s price exactly as the composer\'s serializer makes it paid, the contract\'s paid case its model', () => {
    expect(paidCase).toBeDefined();
    if (!paidCase) return;
    const priceTokens = Number.parseInt(paidCase.resource.priceTokens, 10);
    // The contract: the composer's priceTokens becomes the bundle's priceUsdCents, the same number.
    expect(paidCase.expectedBundle).toMatchObject({ accessMode: 'paid', priceUsdCents: priceTokens });
    expect(priceTokens).toBe(250);

    const cards: AgentResourceCard[] = [
      { type: 'prompt', title: 'Hook prompt', description: 'The exact prompt.', text: 'Cinematic hook, 35mm' },
      { type: 'guide', title: 'How to reuse', text: 'Step one, step two.' },
      { type: 'external_link', title: 'Docs', description: 'The reference.', url: ' https://example.com/docs ' },
    ];
    const composerCards = [
      createPostComposerResourceCard('prompt', { id: 'agent-resource-1', title: 'Hook prompt', preview: 'The exact prompt.', textContent: 'Cinematic hook, 35mm' }),
      createPostComposerResourceCard('guide', { id: 'agent-resource-2', title: 'How to reuse', textContent: 'Step one, step two.' }),
      createPostComposerResourceCard('external_link', { id: 'agent-resource-3', title: 'Docs', preview: 'The reference.', externalUrl: 'https://example.com/docs' }),
    ];
    const paid = buildAgentResourceBundle({ cards, priceTokens });
    expect(paid).toEqual(buildResourceCardBundleInput({ accessMode: 'paid', cards: composerCards, allowRemix: false, summary: '', previewText: '', priceTokens }));
    expect(paid).toMatchObject({ accessMode: 'paid', priceUsdCents: 250 });
    expect(validatePostResourceBundleInput(paid, { ownerUserId: USER_ID, mediaKeys: [] })).toBeNull();
    expect(agentResourceAccess(paid)).toBe('paid');

    // Free is the same cards with no price, and nothing else differs.
    const free = buildAgentResourceBundle({ cards });
    expect(free).toEqual(buildResourceCardBundleInput({ accessMode: 'free', cards: composerCards, allowRemix: false, summary: '', previewText: '', priceTokens: 0 }));
    expect(free).toEqual({ ...paid, accessMode: 'free', priceUsdCents: 0 });
    expect(buildAgentResourceBundle({ cards, priceTokens: 0 })).toEqual(free);
  });

  it('takes the person\'s summary and preview in place of the derived ones', () => {
    const cards: AgentResourceCard[] = [{ type: 'prompt', title: 'Hook prompt', text: 'Cinematic hook, 35mm' }];
    expect(buildAgentResourceBundle({ cards, summary: 'Three hooks for product reels', preview: 'The exact prompt behind the reel, ready to paste.' })).toMatchObject({
      summary: 'Three hooks for product reels',
      previewText: 'The exact prompt behind the reel, ready to paste.',
    });
    expect(buildAgentResourceBundle({ cards })).toMatchObject({ summary: 'Hook prompt', previewText: 'Includes Hook prompt.' });
  });

  it('names what a post carries in three words', () => {
    expect(agentResourceAccess(null)).toBe('none');
    expect(agentResourceAccess(undefined)).toBe('none');
    expect(agentResourceAccess({ accessMode: 'none' })).toBe('none');
    expect(agentResourceAccess({ accessMode: 'free' })).toBe('free');
    expect(agentResourceAccess({ accessMode: 'paid', priceUsdCents: 250 })).toBe('paid');
  });
});
