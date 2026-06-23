import { describe, expect, it } from 'vitest';

import { preparePostCreationSubmission } from '@/lib/post-creation-submission-service';
import type { SourceToolOption } from '@/lib/source-tools';

const sourceToolCatalog: SourceToolOption[] = [
  { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image', 'video'] },
  { slug: 'capcut', label: 'CapCut', models: [], supportedMediaKinds: ['image', 'video'] },
];

describe('preparePostCreationSubmission', () => {
  it('normalizes mixed posts from uploaded storage references', async () => {
    const formData = new FormData();
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
        title: 'Keep the product benefit visible before the hook resolves.',
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
});
