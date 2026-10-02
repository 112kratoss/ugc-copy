/** Real cross-process admission; logical reservations use no large disk fixtures. */
import assert from 'node:assert/strict';
import cp, { type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStagingWorkspace, reclaimAbandonedStagingWorkspaces, STAGING_ROOT_NAME, StagingCapacityError } from '../../src/lib/staging-workspace';
const script = fileURLToPath(import.meta.url);
const execArgv = script.endsWith('.cjs') ? [] : ['--import', 'tsx'];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 30_000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Admission fixture timed out'); await sleep(10); }
}
function alive(pid: number) {
  try { return !readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z'); }
  catch { return false; }
}
async function worker() {
  const kind = process.argv[3];
  if (kind === 'reader') { process.send?.({ ready: true }); setInterval(() => {}, 1000); return; }
  const start = once(process, 'message'); process.send?.({ ready: true }); await start;
  try {
    const workspace = await createStagingWorkspace(Number(process.env.AUDIT_RESERVATION_BYTES));
    await fs.writeFile(path.join(workspace.directory, 'media'), Buffer.alloc(4096, 65));
    if (kind === 'orphan') {
      const child = cp.fork(script, ['--worker', 'reader'], { execArgv, stdio: ['ignore', 'ignore', 'inherit', workspace.readerLeaseFd, 'ipc'] });
      await once(child, 'message');
      process.send?.({ admitted: true, reader: child.pid, directory: workspace.directory });
      setInterval(() => {}, 1000); return;
    }
    const finish = once(process, 'message');
    process.send?.({ admitted: true, directory: workspace.directory }); await finish;
    await workspace.cleanup(); process.disconnect?.();
  } catch (error) { process.send?.({ admitted: false, code: (error as { code?: string }).code }); process.disconnect?.(); }
}
async function audit() {
  assert.equal(process.platform, 'linux', 'The orphan check uses /proc.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-admission-'));
  const oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const children: ChildProcess[] = [];
  let reader: number | undefined;
  const workspaces: Awaited<ReturnType<typeof createStagingWorkspace>>[] = [];
  try {
    const info = await fs.statfs(root);
    const budget = Math.floor(info.bavail * info.bsize * 0.7 / 4096) * 4096;
    assert.ok(budget > 128 * 1024 * 1024, 'Admission proof needs free test filesystem headroom.');
    async function start(kind: string) {
      const child = cp.fork(script, ['--worker', kind], {
        execArgv, env: { ...process.env, TMPDIR: root, TSX_DISABLE_CACHE: '1', AUDIT_RESERVATION_BYTES: String(budget), TSX_TSCONFIG_PATH: path.resolve('tsconfig.scripts.json') },
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      children.push(child); await once(child, 'message'); return child;
    }
    const contenders = await Promise.all([start('contend'), start('contend')]);
    const replies = contenders.map(child => once(child, 'message'));
    contenders.forEach(child => child.send('go'));
    const outcomes = (await Promise.all(replies)).map(x => x[0]);
    assert.equal(outcomes.filter(x => x.admitted).length, 1, 'Exactly one competing writer must be admitted.');
    assert.equal(outcomes.find(x => !x.admitted).code, 'STAGING_CAPACITY');
    assert.equal((await fs.readdir(path.join(root, STAGING_ROOT_NAME))).length, 1, 'Rejected admission must not allocate a workspace.');
    const winner = contenders[outcomes.findIndex(x => x.admitted)];
    const exit = once(winner, 'exit'); winner.send('cleanup'); await exit;
    assert.deepEqual(await fs.readdir(path.join(root, STAGING_ROOT_NAME)), []);

    const source = await createStagingWorkspace(budget); workspaces.push(source);
    const sourceFile = path.join(source.directory, 'media');
    await fs.writeFile(sourceFile, Buffer.alloc(4096, 66));
    await assert.rejects(createStagingWorkspace(budget), StagingCapacityError);
    await fs.writeFile(path.join(source.directory, 'sealed'), 'comp');
    await assert.rejects(createStagingWorkspace(budget), StagingCapacityError);
    await fs.unlink(path.join(source.directory, 'sealed'));
    await source.seal();
    const output = await createStagingWorkspace(budget); workspaces.push(output);
    assert.equal((await fs.readFile(sourceFile)).equals(Buffer.alloc(4096, 66)), true);
    await output.cleanup(); await source.cleanup();

    const owner = await start('orphan');
    const claim = once(owner, 'message'); owner.send('go');
    const [inherited] = await claim; assert.equal(inherited.admitted, true);
    reader = inherited.reader;
    assert.ok(reader);
    const death = once(owner, 'exit'); owner.kill('SIGKILL'); await death;
    assert.equal(alive(reader), true);
    assert.equal(await reclaimAbandonedStagingWorkspaces(), 0);
    await assert.rejects(createStagingWorkspace(budget), StagingCapacityError);
    assert.equal(existsSync(path.join(inherited.directory, 'media')), true);
    process.kill(reader, 'SIGKILL'); await until(() => !alive(reader!)); reader = undefined;
    // Process exit observation can precede release of its last file description.
    // Reclamation must use the actual lease, never /proc state as authority.
    let reclaimed = 0;
    await until(async () => { reclaimed += await reclaimAbandonedStagingWorkspaces(); return reclaimed > 0; });
    assert.equal(reclaimed, 1);
    const resumed = await createStagingWorkspace(budget); await resumed.cleanup();
    assert.deepEqual(await fs.readdir(path.join(root, STAGING_ROOT_NAME)), []);
    console.log(JSON.stringify({ node: process.version, concurrentAdmitted: 1, concurrentRejectedBeforeAllocation: 1, completedSourceReleasesGrowth: true, inheritedClaimSurvivesOwnerDeath: true, reclaimAfterChildExit: true, cleanupEmpty: true }));
  } finally {
    if (reader && alive(reader)) { process.kill(reader, 'SIGKILL'); await until(() => !alive(reader!)); }
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
    for (const workspace of workspaces) await workspace.cleanup().catch(() => {});
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    await fs.rm(root, { recursive: true, force: true });
  }
}
(process.argv[2] === '--worker' ? worker() : audit()).catch(error => { console.error(error); process.exitCode = 1; });
