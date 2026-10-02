import 'server-only';

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createMediaScratchWorkspace } from '@/lib/staging-workspace';

// Fixed shell source only. All executable paths and encoder arguments are argv.
// exec preserves the PID, timeout target and inherited workspace descriptors.
const LIMIT_SCRIPT = 'ulimit -c 0 && ulimit -f "$1" || exit 125; shift; exec "$@"';
const SHELL = '/bin/sh';
let shellUnit: Promise<number> | undefined;

/** A per-file bound, not a reservation of aggregate filesystem capacity. */
export class MediaOutputLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Media output reached its ${maxBytes}-byte file limit.`);
    this.name = 'MediaOutputLimitError';
  }
}

async function measureShellUnit() {
  if (!['linux', 'darwin'].includes(process.platform)) {
    throw new Error('Media output limits require a supported POSIX runtime.');
  }
  const workspace = await createMediaScratchWorkspace();
  try {
    const file = path.join(workspace.mediaDirectory, 'limit-probe');
    // Shells differ in units, including macOS sh vs Linux sh. Test the actual
    // kernel boundary before selecting a conversion; never encode unbounded.
    const args = ['-c', LIMIT_SCRIPT, 'media-limit-probe', '1',
      process.execPath, '-e',
      'try { require("node:fs").writeFileSync(process.argv[1], Buffer.alloc(8192)); process.exitCode = 2; } catch (e) { process.exitCode = e.code === "EFBIG" ? 0 : 3; }',
      file];
    const result = await new Promise<{ status: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
      const child = spawn(SHELL, args, {
        stdio: ['ignore', 'ignore', 'ignore', workspace.readerLeaseFd],
        timeout: 10_000,
        killSignal: 'SIGKILL',
      });
      let error: Error | undefined;
      child.on('error', (value) => { error = value; });
      child.on('close', (status, signal) => resolve({ status, signal, error }));
    });
    if (result.error || (result.status !== 0 && result.signal !== 'SIGXFSZ')) {
      throw new Error('Cannot verify the media encoder file-size limit.');
    }
    const { size } = await stat(file);
    if (size !== 512 && size !== 1024) throw new Error('Unsupported media file-limit unit.');
    return size;
  } finally { await workspace.cleanup(); }
}

/** Cached per process; a failed capability check can be retried on later work. */
export async function mediaEncoderCommand(executable: string, args: string[], maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes % 1024 !== 0) {
    throw new Error('Media output budget must be a positive whole number of KiB.');
  }
  shellUnit ??= measureShellUnit().catch((error: unknown) => { shellUnit = undefined; throw error; });
  const unit = await shellUnit;
  return { executable: SHELL, args: ['-c', LIMIT_SCRIPT, 'media-encoder', String(maxBytes / unit), executable, ...args] };
}
