/** Real FFmpeg, regular media, process death and fresh-process reclamation.
 * Linux CI: npx tsx --tsconfig tsconfig.scripts.json scripts/audits/audit-media-scratch-lifetime.ts
 * SIGSTOP injects a scheduling barrier after the real reader/writer opens its
 * files. This proves ownership, not a remotely triggerable decoder hang.
 */
import assert from 'node:assert/strict';
import cp, { type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVideoPosterBuffer, getFfmpegPath } from '../../src/lib/video-poster';
import { createVideoRenditionBuffer, createVideoRenditionFromFile, createVideoTeaserFromFile, withVideoInputFile } from '../../src/lib/video-rendition';
import { reclaimAbandonedStagingWorkspaces, STAGING_ROOT_NAME } from '../../src/lib/staging-workspace';

const script = fileURLToPath(import.meta.url);
const execArgv = script.endsWith('.cjs') ? [] : ['--import', 'tsx'];
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 30_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(label);
    await sleep(10);
  }
}
function inspect(pid: number, root: string) {
  try {
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    return { alive: command.includes(root) && state !== 'Z', state, command };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { alive: false, state: '', command: '' };
    throw error;
  }
}
function payloads(root: string): Record<string, number> {
  const result: Record<string, number> = {};
  function walk(directory: string) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile() && !['ready', 'lease'].includes(name)) result[path.relative(root, file)] = stat.size;
    }
  }
  walk(root);
  return result;
}
type Paused = { pid: number; args: string[] };
async function worker() {
  const [kind, source] = process.argv.slice(3);
  const originalSpawn = cp.spawn;
  let paused = false;
  const controller = new AbortController();
  cp.spawn = ((...args: Parameters<typeof cp.spawn>) => {
    const child = Reflect.apply(originalSpawn, cp, args) as ChildProcess;
    let banner = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      banner += chunk.toString('utf8');
      if (!paused && banner.includes(kind === 'poster' ? 'Input #0' : 'Output #0')) {
        paused = true;
        process.kill(child.pid!, 'SIGSTOP');
        if (kind === 'cancel') controller.abort();
        else process.send?.({ pid: child.pid, args: args[1] });
      }
    });
    return child;
  }) as typeof cp.spawn;
  syncBuiltinESMExports();
  const body = new Blob([fs.readFileSync(source)], { type: 'video/mp4' });
  if (kind === 'cancel') {
    await assert.rejects(withVideoInputFile(body, (input, bytes, lease) =>
      createVideoRenditionFromFile(input, bytes, { signal: controller.signal, sourceLeaseFd: lease })),
    (error: Error) => error.name === 'AbortError');
    assert.deepEqual(fs.readdirSync(path.join(tmpdir(), STAGING_ROOT_NAME)), []);
    process.disconnect?.();
    return;
  }
  if (kind === 'poster') await createVideoPosterBuffer(body);
  else if (kind === 'rendition') await createVideoRenditionBuffer(body);
  else await withVideoInputFile(body, (input, _bytes, lease) => createVideoTeaserFromFile(input, lease));
  throw new Error('Worker completed before the parent injected death.');
}
async function audit() {
  assert.equal(process.platform, 'linux', 'This audit inspects Linux process/file descriptors.');
  const root = await mkdtemp(path.join(tmpdir(), 'audit-media-scratch-'));
  const source = path.join(root, 'source.mp4');
  const report = [];
  try {
    cp.execFileSync(getFfmpegPath(), ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      'testsrc2=size=640x360:rate=30', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', source], { timeout: 30_000 });
    for (const kind of ['poster', 'rendition', 'teaser']) {
      const scratch = path.join(root, kind); await mkdir(scratch);
      const env = { ...process.env, TMPDIR: scratch, TSX_TSCONFIG_PATH: path.resolve('tsconfig.scripts.json') };
      const owner = cp.fork(script, ['--worker', kind, source], { execArgv, env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      let reader: number | undefined;
      try {
        let message: Paused | undefined;
        owner.on('message', value => { message = value as Paused; });
        await until(() => Boolean(message) || owner.exitCode !== null || owner.signalCode !== null, 'No FFmpeg checkpoint.');
        assert.ok(message, 'Owner exited before FFmpeg checkpoint.');
        reader = message.pid;
        await until(() => inspect(reader!, scratch).state === 'T', 'FFmpeg not stopped.');
        assert.ok(inspect(reader, scratch).command.includes('ffmpeg'));
        const descriptors = fs.readdirSync(`/proc/${reader}/fd`).flatMap(fd => {
          try { const target = fs.readlinkSync(`/proc/${reader}/fd/${fd}`); return target.startsWith(scratch) ? [target] : []; }
          catch { return []; }
        });
        assert.ok(descriptors.some(file => file.endsWith('input-video')));
        if (kind !== 'poster') assert.ok(descriptors.some(file => file.endsWith('.mp4')));
        const exit = once(owner, 'exit'); owner.kill('SIGKILL'); await exit;
        assert.equal(inspect(reader, scratch).alive, true);
        const sweep = () => Number(cp.execFileSync(process.execPath, [...execArgv, script, '--sweep'], { env, encoding: 'utf8', timeout: 15_000 }).trim());
        const before = payloads(scratch);
        assert.equal(sweep(), 0, 'A live reader/writer must retain all workspaces.');
        assert.deepEqual(payloads(scratch), before);
        process.kill(reader, 'SIGCONT');
        await until(() => !inspect(reader!, scratch).alive, 'Orphan did not exit.');
        const retained = payloads(scratch);
        assert.ok(Object.values(retained).some(bytes => bytes > 0));
        assert.equal(sweep(), 2, 'Fresh process must reclaim both abandoned source and output.');
        assert.deepEqual(payloads(scratch), {});
        assert.deepEqual(fs.readdirSync(path.join(scratch, STAGING_ROOT_NAME)), []);
        report.push({ kind, descriptors, retained, reclaimed: 2 });
      } finally {
        if (owner.exitCode === null && owner.signalCode === null) { const exit = once(owner, 'exit'); owner.kill('SIGKILL'); await exit; }
        if (reader && inspect(reader, scratch).alive) { process.kill(reader, 'SIGKILL'); await until(() => !inspect(reader!, scratch).alive, 'Reader cleanup failed.'); }
      }
    }
    const cancellation = path.join(root, 'cancellation'); await mkdir(cancellation);
    const cancelled = cp.spawn(process.execPath, [...execArgv, script, '--worker', 'cancel', source], {
      env: { ...process.env, TMPDIR: cancellation, TSX_TSCONFIG_PATH: path.resolve('tsconfig.scripts.json') },
      stdio: 'inherit', timeout: 30_000, killSignal: 'SIGKILL',
    });
    assert.equal((await once(cancelled, 'close'))[0], 0, 'Cancellation must wait for FFmpeg to release both leases.');
    const controls = path.join(root, 'controls'); await mkdir(controls);
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = controls;
    try {
      const body = new Blob([fs.readFileSync(source)], { type: 'video/mp4' });
      assert.ok((await createVideoPosterBuffer(body)).length > 0);
      assert.ok((await createVideoRenditionBuffer(body)).bytes > 0);
      assert.ok((await withVideoInputFile(body, (input, _bytes, lease) => createVideoTeaserFromFile(input, lease))).bytes > 0);
      const invalid = new Blob(['invalid regular-file media']);
      await assert.rejects(createVideoPosterBuffer(invalid));
      await assert.rejects(createVideoRenditionBuffer(invalid));
      await assert.rejects(withVideoInputFile(invalid, (input, _bytes, lease) => createVideoTeaserFromFile(input, lease)));
      assert.deepEqual(fs.readdirSync(path.join(controls, STAGING_ROOT_NAME)), []);
      assert.deepEqual(payloads(controls), {});
    } finally {
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
    }
    console.log(JSON.stringify({ node: process.version, report, normalAndDecodeFailureCleanup: true }, null, 2));
  } finally { await rm(root, { recursive: true, force: true }); }
}
const task = process.argv[2] === '--worker' ? worker()
  : process.argv[2] === '--sweep' ? reclaimAbandonedStagingWorkspaces().then(count => console.log(count)) : audit();
task.catch(error => { console.error(error); process.exitCode = 1; });
