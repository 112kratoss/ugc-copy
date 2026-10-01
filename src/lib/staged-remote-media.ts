import 'server-only';

import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  sourceName: string;
};

export async function stageAllowlistedRemoteMedia(params: {
  url: string;
  kind: RemoteMediaKind;
}): Promise<StagedRemoteMedia> {
  const media = await openAllowlistedRemoteMedia(params);
  let tempDirectory: string;
  try {
    tempDirectory = await mkdtemp(path.join(tmpdir(), 'remote-media-'));
  } catch (error) {
    // The response is already open, but no pipeline owns its body yet. Release
    // that source if disk allocation fails, retaining the allocation error.
    await media.body.cancel().catch(() => {});
    throw error;
  }
  const filePath = path.join(tempDirectory, 'media');

  try {
    await pipeline(
      Readable.fromWeb(media.body as NodeReadableStream<Uint8Array>),
      createWriteStream(filePath, { flags: 'wx' }),
    );
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }

  let cleanupPromise: Promise<void> | undefined;
  return {
    contentLength: media.contentLength,
    contentType: media.contentType,
    filePath,
    sourceName: media.sourceName,
    async cleanup() {
      // Every caller must wait for deletion. Cache successful cleanup, but let
      // a later call retry a failed removal instead of reporting false success.
      cleanupPromise ??= rm(tempDirectory, { recursive: true, force: true }).catch((error) => {
        cleanupPromise = undefined;
        throw error;
      });
      await cleanupPromise;
    },
  };
}
