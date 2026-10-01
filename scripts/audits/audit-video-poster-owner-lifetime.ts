/**
 * Local-only process lifetime audit. No database, network, or provider calls.
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/audits/audit-video-poster-owner-lifetime.ts
 * Requires POSIX mkfifo/ps and the installed ffmpeg-static binary; takes ~35s.
 * Add --verify-reader-lease to require inherited protection and release.
 * Default exit 1 reports a surviving orphan; exit 2 means inconclusive/error.
 * A FIFO injects blocked input into the real runner. Production staging creates
 * regular files: this does not establish a remotely triggerable hung decoder.
 */
import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { flockSync } from 'fs-ext';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runVideoPosterFfmpeg, VIDEO_POSTER_TIMEOUT_MS } from '../../src/lib/video-poster';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Observation = {
  pid?: number;
  banner: string;
  result?: { ok: boolean; error?: string; elapsedMs: number };
};
type Message =
  | { type: 'spawn'; pid: number }
  | { type: 'stderr'; text: string }
  | { type: 'result'; result: NonNullable<Observation['result']> };

async function worker() {
  // Observe real process creation; preserve the command, options and child.
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
    const child = Reflect.apply(originalSpawn, childProcess, args) as ChildProcess;
    child.once('spawn', () => process.send?.({ type: 'spawn', pid: child.pid }));
    child.stderr?.on('data', (chunk: Buffer) => {
      process.send?.({ type: 'stderr', text: chunk.toString('utf8') });
    });
    return child;
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  const leaseFd = process.argv[5] === '--lease' ? openSync(process.argv[3] + '.lease', 'wx+', 0o600) : undefined;
  if (leaseFd !== undefined) flockSync(leaseFd, 'exnb');
  const started = Date.now();
  try {
    await runVideoPosterFfmpeg(process.argv[3], process.argv[4], '00:00:00.000', leaseFd);
    process.send?.({ type: 'result', result: { ok: true, elapsedMs: Date.now() - started } });
  } catch (error) {
    process.send?.({ type: 'result', result: {
      ok: false, error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - started,
    } });
  } finally {
    if (leaseFd !== undefined) closeSync(leaseFd);
    process.disconnect?.();
  }
}

function inspectReader(pid: number, fixture: string) {
  if (process.platform === 'linux') {
    try {
      const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
      const owned = command.includes(fixture);
      return { owned, running: owned && state !== 'Z', state };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { owned: false, running: false, state: '' };
      throw error;
    }
  }
  const result = childProcess.spawnSync('ps', ['-o', 'stat=,command=', '-p', String(pid)], {
    encoding: 'utf8', timeout: 3000,
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error('Unable to inspect the fixture reader.');
  }
  const output = result.stdout.trim();
  // A reused PID is never permission to signal an unrelated process.
  const owned = output.includes(fixture);
  const state = output.split(/\s+/)[0] ?? '';
  return { owned, running: owned && !state.includes('Z'), state };
}

async function waitFor(predicate: () => boolean, timeout: number, reason: string) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(reason);
    await sleep(40);
  }
}

async function audit() {
  if (process.platform === 'win32') throw new Error('This audit requires POSIX mkfifo and ps.');
  const root = await mkdtemp(path.join(tmpdir(), 'audit-poster-owner-'));
  const fixtures: Array<{ worker: ChildProcess; observation: Observation; input: string }> = [];
  const verifyLease = process.argv.includes('--verify-reader-lease');
  let claimant: number | undefined;
  let cleanupVerified = false;
  let report: Record<string, unknown> | undefined;
  try {
    for (const name of ['control', 'orphan']) {
      const input = path.join(root, `${name}.fifo`);
      childProcess.execFileSync('mkfifo', [input], { timeout: 3000 });
      const observation: Observation = { banner: '' };
      const child = childProcess.fork(fileURLToPath(import.meta.url), [
        '--worker', input, path.join(root, `${name}.jpg`), ...(verifyLease ? ['--lease'] : []),
      ], { execArgv: ['--import', 'tsx'], env: { ...process.env, TSX_TSCONFIG_PATH: path.resolve('tsconfig.scripts.json') }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      fixtures.push({ worker: child, observation, input });
      child.on('message', (message: Message) => {
        if (message.type === 'spawn') observation.pid = message.pid;
        if (message.type === 'stderr') observation.banner = (observation.banner + message.text).slice(-16000);
        if (message.type === 'result') observation.result = message.result;
      });
      child.on('error', (error) => {
        observation.result = { ok: false, error: error.message, elapsedMs: 0 };
      });
    }
    const [control, orphan] = fixtures;
    // Wait past startup output: killing the stderr reader during startup can
    // instead terminate ffmpeg with SIGPIPE, which proves no timeout property.
    await waitFor(() => fixtures.every(({ observation }) =>
      observation.pid !== undefined && observation.banner.includes('libavformat')),
    10000, 'FFmpeg startup was not observed; probe inconclusive.');
    await sleep(1000);
    for (const fixture of fixtures) {
      assert.equal(fixture.observation.result, undefined, 'Reader exited before fault injection.');
      assert.equal(inspectReader(fixture.observation.pid!, fixture.input).running, true);
    }
    const exit = new Promise<NodeJS.Signals | null>((resolve) => orphan.worker.once('exit', (_, signal) => resolve(signal)));
    assert.equal(orphan.worker.kill('SIGKILL'), true);
    assert.equal(await exit, 'SIGKILL');
    const killedAt = Date.now();
    if (verifyLease) {
      claimant = openSync(orphan.input + '.lease', 'r+');
      assert.throws(() => flockSync(claimant!, 'exnb'),
        (error: unknown) => ['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? ''),
        'The orphan reader lost its inherited lease after parent death.');
    }
    const immediatelyAlive = inspectReader(orphan.observation.pid!, orphan.input).running;
    await sleep(VIDEO_POSTER_TIMEOUT_MS + 1500);
    await waitFor(() => control.observation.result !== undefined, 3000, 'Control did not settle.');
    assert.match(control.observation.result?.error ?? '', /terminated by SIGKILL/);
    assert.ok(control.observation.result!.elapsedMs >= VIDEO_POSTER_TIMEOUT_MS - 100);
    assert.equal(inspectReader(control.observation.pid!, control.input).running, false);
    const survivor = inspectReader(orphan.observation.pid!, orphan.input);
    report = {
      platform: process.platform, nodeVersion: process.version,
      ffmpegVersion: orphan.observation.banner.split('\n')[0],
      input: 'isolated FIFO blocking input; not a production media fixture',
      configuredTimeoutMs: VIDEO_POSTER_TIMEOUT_MS,
      controlElapsedMs: control.observation.result!.elapsedMs,
      parentKilled: true, childAliveAfterParentDeath: immediatelyAlive,
      observedAfterKillMs: Date.now() - killedAt,
      childAliveBeyondTimeout: survivor.running,
      childState: survivor.state,
      inheritedLeaseVerified: verifyLease,
    };
    // The signal reflects the finding, not whether the harness ran correctly.
    if (verifyLease) assert.equal(survivor.running, true, 'Reader exited before the lease lifetime observation.');
    process.exitCode = verifyLease ? 0 : survivor.running ? 1 : 0;
  } finally {
    for (const fixture of fixtures) {
      if (fixture.worker.exitCode === null && fixture.worker.signalCode === null) fixture.worker.kill('SIGKILL');
      if (fixture.observation.pid && inspectReader(fixture.observation.pid, fixture.input).running) {
        process.kill(fixture.observation.pid, 'SIGKILL');
      }
    }
    await waitFor(() => fixtures.every(({ observation, input }) =>
      !observation.pid || !inspectReader(observation.pid, input).running),
    3000, 'Fixture reader cleanup did not finish.');
    if (claimant !== undefined) {
      await waitFor(() => {
        try { flockSync(claimant!, 'exnb'); return true; }
        catch (error) {
          if (['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
          throw error;
        }
      }, 3000, 'Reader lease was not released after termination.');
      closeSync(claimant);
    }
    await rm(root, { recursive: true, force: true });
    cleanupVerified = true;
    if (report) console.log(JSON.stringify({ ...report, cleanupVerified }, null, 2));
  }
}

(process.argv[2] === '--worker' ? worker() : audit()).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
