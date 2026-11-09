import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { uuidOrNull } from '@/lib/agent-tool-calls';
import {
  AGENT_MADE_WITH_APP_REFUSAL,
  agentMadeWithSelections,
  agentUploadPostId,
  buildAgentUploadPublishFormData,
  namesMagicbooklet,
  refuseAgentMadeWith,
} from '@/lib/agent-upload-publish-request';
import { preparePostCreationSubmission } from '@/lib/post-creation-submission-service';
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
    expect(fields(buildAgentUploadPublishFormData(ARGS))).toEqual({
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

    const full = fields(buildAgentUploadPublishFormData({
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
    expect(fields(buildAgentUploadPublishFormData({ ...ARGS, category: 'video' })).category).toBe('video');
    // A file the server has no type for goes with none, never a guess from its name.
    expect(fields(buildAgentUploadPublishFormData({ ...ARGS, uploads: [{ storagePath: PICTURE, contentType: null }] })).mediaItems)
      .toEqual([{ storagePath: PICTURE, originalName: 'paper-fox.png', contentType: '' }]);
  });

  it('is a form the composer service takes: an external media post with its Made with, and no recipe', async () => {
    const prepared = await preparePostCreationSubmission({
      formData: buildAgentUploadPublishFormData({
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
        formData: buildAgentUploadPublishFormData({ ...ARGS, ...extra, uploads }),
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
