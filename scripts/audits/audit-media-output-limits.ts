/** Actual rendition scratch must stay within its useful output budget. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { getFfmpegPath } from '../../src/lib/video-poster';
import { createVideoRenditionBuffer, VideoRenditionSkipped } from '../../src/lib/video-rendition';

async function audit() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-output-bound-'));
  const scratch = path.join(root, 'scratch'); await fs.mkdir(scratch);
  const oldTmp = process.env.TMPDIR;
  const originalRm = fs.rm;
  let largestOutput = 0;
  function observe(directory: string) {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name), stat = statSync(file);
      if (stat.isDirectory()) observe(file);
      else if (name === 'rendition.mp4') largestOutput = Math.max(largestOutput, stat.size);
    }
  }
  try {
    const source = path.join(root, 'small.mp4');
    execFileSync(getFfmpegPath(), ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      'color=c=black:s=640x360:r=1', '-t', '12', '-c:v', 'libx264', '-crf', '40', source], { timeout: 30_000 });
    const bytes = await fs.readFile(source);
    process.env.TMPDIR = scratch;
    fs.rm = (async (...args: Parameters<typeof fs.rm>) => {
      observe(scratch);
      return originalRm(...args);
    }) as typeof fs.rm;
    syncBuiltinESMExports();
    await assert.rejects(createVideoRenditionBuffer(new Blob([bytes])),
      (error: unknown) => error instanceof VideoRenditionSkipped && error.reason === 'not-smaller');
    const budget = Math.ceil(bytes.length * 0.85 / 1024) * 1024;
    assert.ok(largestOutput > 0);
    assert.ok(largestOutput <= budget, `Output grew to ${largestOutput}, beyond useful budget ${budget}.`);
    assert.deepEqual(readdirSync(path.join(scratch, 'magicbooklet-staging-v1')), []);
    console.log(JSON.stringify({ platform: process.platform, sourceBytes: bytes.length, budget, largestOutput, cleanup: true }));
  } finally {
    fs.rm = originalRm; syncBuiltinESMExports();
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    await fs.rm(root, { recursive: true, force: true });
  }
}
audit().catch(error => { console.error(error); process.exitCode = 1; });
