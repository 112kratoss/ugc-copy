import { describe, expect, it } from 'vitest';

import { preparePostCreationSubmission } from '@/lib/post-creation-submission-service';
import { TITLE_MAX_LENGTH } from '@/lib/posts-server';
import type { SourceToolOption } from '@/lib/source-tools';

const sourceToolCatalog: SourceToolOption[] = [
  { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image', 'video'] },
  { slug: 'capcut', label: 'CapCut', models: [], supportedMediaKinds: ['image', 'video'] },
];

describe('preparePostCreationSubmission', () => {
  it('normalizes mixed posts from uploaded storage references', async () => {
    const formData = new FormData();
    formData.set('title', 'Studio lighting reference');
    formData.set('postFormat', 'mixed');
    formData.set('body', 'Keep the product benefit visible before the hook resolves.');
    formData.set('category', 'video');
    formData.set('visibility', 'public');
    formData.set('sourceTool', 'CapCut');
    formData.set('mediaStoragePath', 'uploads/user-1/tmp-proof.mp4');
    formData.set('mediaOriginalName', 'proof.mp4');
    formData.set('mediaContentType', 'video/mp4');

    const result = await preparePostCreationSubmission({
      formData,
      userId: 'user-1',
      sourceToolCatalog,
    });

    expect(result).toMatchObject({
      ok: true,
      submission: {
        body: 'Keep the product benefit visible before the hook resolves.',
        postFormat: 'mixed',
        category: 'video',
        visibility: 'public',
        // The author's own title, not one derived from the body: every new post
        // is named explicitly now.
        title: 'Studio lighting reference',
        sourceKind: 'external',
        mediaMimeType: 'video/mp4',
        hasSubmittedMedia: true,
        sourceTools: [
          {
            toolLabel: 'CapCut',
            toolSlug: 'capcut',
          },
        ],
      },
    });
    if (result.ok) {
      expect(result.submission.submittedMediaItems).toEqual([
        {
          source: 'uploaded',
          mediaKey: 'media-1',
          filePath: 'user-1/tmp-proof.mp4',
          temporaryStoragePath: 'user-1/tmp-proof.mp4',
          originalName: 'proof.mp4',
          contentType: 'video/mp4',
        },
      ]);
    }
  });

  it('rejects media metadata outside the authenticated user upload prefix', async () => {
    const formData = new FormData();
    formData.set('title', 'Studio lighting reference');
    formData.set('postFormat', 'media');
    formData.set('mediaItems', JSON.stringify([
      {
        storagePath: 'uploads/other-user/proof.png',
        originalName: 'proof.png',
        contentType: 'image/png',
      },
    ]));

    const result = await preparePostCreationSubmission({
      formData,
      userId: 'user-1',
      sourceToolCatalog,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: {
        error: 'Uploaded media must belong to the authenticated user.',
      },
    });
  });

  it('preserves submitted media keys and validates resource scopes against them', async () => {
    const buildFormData = (scopeKey: string) => {
      const formData = new FormData();
      formData.set('title', 'Studio lighting reference');
      formData.set('postFormat', 'media');
      formData.set('category', 'image');
      formData.set('mediaItems', JSON.stringify([{
        mediaKey: 'proof-a',
        storagePath: 'uploads/user-1/proof.png',
        originalName: 'proof.png',
        contentType: 'image/png',
      }]));
      formData.set('resourceBundle', JSON.stringify({
        accessMode: 'free',
        resources: {
          items: [{
            id: 'prompt-a',
            scope: { kind: 'media', mediaKeys: [scopeKey] },
            type: 'prompt',
            title: 'Proof prompt',
            textContent: 'Describe this proof output.',
          }],
        },
      }));
      return formData;
    };

    const accepted = await preparePostCreationSubmission({
      formData: buildFormData('proof-a'),
      userId: 'user-1',
      sourceToolCatalog,
    });
    expect(accepted).toMatchObject({
      ok: true,
      submission: { submittedMediaItems: [{ mediaKey: 'proof-a' }] },
    });

    const rejected = await preparePostCreationSubmission({
      formData: buildFormData('proof-b'),
      userId: 'user-1',
      sourceToolCatalog,
    });
    expect(rejected).toMatchObject({
      ok: false,
      status: 400,
      body: { error: expect.stringMatching(/not part of this post/i) },
    });
  });

  it('rejects titles longer than the shared limit and accepts one exactly at it', async () => {
    function buildFormData(title: string) {
      const formData = new FormData();
      formData.set('postFormat', 'text');
      formData.set('body', 'A text post that carries its own title.');
      formData.set('visibility', 'public');
      formData.set('title', title);
      return formData;
    }

    const rejected = await preparePostCreationSubmission({
      formData: buildFormData('a'.repeat(TITLE_MAX_LENGTH + 1)),
      userId: 'user-1',
      sourceToolCatalog,
    });
    expect(rejected).toMatchObject({
      ok: false,
      status: 400,
      body: { error: `Titles are limited to ${TITLE_MAX_LENGTH} characters.` },
    });

    const accepted = await preparePostCreationSubmission({
      formData: buildFormData('a'.repeat(TITLE_MAX_LENGTH)),
      userId: 'user-1',
      sourceToolCatalog,
    });
    expect(accepted).toMatchObject({
      ok: true,
      submission: { title: 'a'.repeat(TITLE_MAX_LENGTH) },
    });
  });

  // Text posts used to be handed a title derived from their body, so an author
  // could publish one without ever naming it. Every format is named explicitly
  // now, and the body is no longer a fallback for any of them.
  it.each(['text', 'media', 'mixed'])('rejects a %s post submitted without a title', async (postFormat) => {
    const formData = new FormData();
    formData.set('postFormat', postFormat);
    formData.set('body', 'A body long enough to have been a usable derived title.');
    formData.set('visibility', 'public');
    if (postFormat !== 'text') {
      formData.set('category', 'image');
      formData.set('mediaStoragePath', 'uploads/user-1/proof.png');
      formData.set('mediaOriginalName', 'proof.png');
      formData.set('mediaContentType', 'image/png');
    }

    const result = await preparePostCreationSubmission({
      formData,
      userId: 'user-1',
      sourceToolCatalog,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      body: { error: 'Add a title for your post.', field: 'title' },
    });
  });

  it('rejects a title that is only whitespace', async () => {
    const formData = new FormData();
    formData.set('postFormat', 'text');
    formData.set('title', '   \n  ');
    formData.set('body', 'A text post whose author typed only spaces into the title.');
    formData.set('visibility', 'public');

    const result = await preparePostCreationSubmission({
      formData,
      userId: 'user-1',
      sourceToolCatalog,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      body: { error: 'Add a title for your post.', field: 'title' },
    });
  });
});
