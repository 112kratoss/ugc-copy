import fs, { writeFile, readFile } from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { createStagingWorkspace, reclaimAbandonedStagingWorkspaces } from '../lib/staging-workspace';

async function main() {
  const mode = process.argv[2];
  if (mode === 'sweep') {
    process.send?.({ reclaimed: await reclaimAbandonedStagingWorkspaces() });
    process.disconnect?.(); return;
  }
  if (mode === 'many') {
    const workspaces = [];
    for (let i = 0; i < Number(process.argv[3]); i++) {
      workspaces.push(await createStagingWorkspace(1024));
    }
    process.send?.({ directories: workspaces.map((workspace) => workspace.directory) });
    // Keep the owner descriptors alive until the test kills this process.
    setInterval(() => { if (!workspaces.length) throw new Error('Missing owners'); }, 1000);
    return;
  }
  if (mode === 'allocation' || mode === 'publication') {
    const pause = async (directory: string): Promise<never> => {
      process.send?.({ directory });
      return new Promise(() => setInterval(() => {}, 1000));
    };
    if (mode === 'allocation') {
      const original = fs.mkdtemp;
      fs.mkdtemp = async (...args: unknown[]): Promise<never> => {
        const directory = await Reflect.apply(original, fs, args);
        return pause(String(directory));
      };
    } else {
      const original = fs.open;
      fs.open = (async (...args: Parameters<typeof fs.open>) => {
        if (String(args[0]).endsWith('/ready')) return pause(path.dirname(String(args[0])));
        return Reflect.apply(original, fs, args);
      }) as typeof fs.open;
    }
  }
  if (['lease-open', 'lease-write', 'ready-open', 'ready-write', 'lease-partial', 'ready-partial'].includes(mode)) {
    const original = fs.open;
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      const target = String(args[0]);
      if (String(args[1]).startsWith('w') && target.endsWith('/' + mode.replace(/-(open|write|partial)$/, ''))) {
        const pause = async (): Promise<never> => {
          process.send?.({ directory: path.dirname(target) });
          return new Promise(() => setInterval(() => {}, 1000));
        };
        if (mode.endsWith('-open')) return pause();
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...values: Parameters<typeof handle.writeFile>) => {
          if (mode.endsWith('-partial')) await write(String(values[0]).slice(0, 7));
          else await write(...values);
          return pause();
        };
      }
      return handle;
    }) as typeof fs.open;
  }
  syncBuiltinESMExports();
  if (mode === 'hold-lease') {
    fstatSync(3); process.send?.({ ready: true }); setInterval(() => {}, 1000); return;
  }
  if (process.argv[2] === 'reader') {
    fstatSync(3);
    process.send?.({ ready: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    process.send?.({ bytes: (await readFile(process.argv[3])).toString('utf8') });
  } else {
    const workspace = await createStagingWorkspace(1024);
    const file = path.join(workspace.directory, 'media');
    await writeFile(file, 'worker staged bytes');
    process.send?.({ directory: workspace.directory, file });
  }
  setInterval(() => {}, 1000);
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; process.disconnect?.(); });
