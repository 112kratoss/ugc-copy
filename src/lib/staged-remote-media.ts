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
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'remote-media-'));
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

  let cleanedUp = false;
  return {
    contentLength: media.contentLength,
    contentType: media.contentType,
    filePath,
    sourceName: media.sourceName,
    async cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      await rm(tempDirectory, { recursive: true, force: true });
    },
  };
}
