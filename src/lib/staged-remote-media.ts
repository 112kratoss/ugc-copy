import 'server-only';

import { createWriteStream } from 'node:fs';
import { createStagingWorkspace } from '@/lib/staging-workspace';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import {
  openAllowlistedRemoteMedia,
  type RemoteMediaKind,
} from '@/lib/remote-media-security';

export type StagedRemoteMedia = {
  cleanup: () => Promise<void>;
  contentLength: number | null;
  contentType: string;
  filePath: string;
  readerLeaseFd: number;
  sourceName: string;
};

export async function stageAllowlistedRemoteMedia(params: {
  url: string;
  kind: RemoteMediaKind;
}): Promise<StagedRemoteMedia> {
  const media = await openAllowlistedRemoteMedia(params);
  let workspace: Awaited<ReturnType<typeof createStagingWorkspace>>;
  try {
    workspace = await createStagingWorkspace();
  } catch (error) {
    // The response is already open, but no pipeline owns its body yet. Release
    // that source if disk allocation fails, retaining the allocation error.
    await media.body.cancel().catch(() => {});
    throw error;
  }
  const filePath = path.join(workspace.directory, 'media');

  try {
    await pipeline(
      Readable.fromWeb(media.body as NodeReadableStream<Uint8Array>),
      createWriteStream(filePath, { flags: 'wx' }),
    );
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }

  return {
    contentLength: media.contentLength,
    contentType: media.contentType,
    filePath,
    readerLeaseFd: workspace.readerLeaseFd,
    sourceName: media.sourceName,
    cleanup: workspace.cleanup,
  };
}
