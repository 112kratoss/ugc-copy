import fs, { writeFile, readFile } from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import path from 'node:path';
import { createStagingWorkspace, reclaimAbandonedStagingWorkspaces } from '../lib/staging-workspace';

async function main() {
  const mode = process.argv[2];
  if (mode === 'sweep') {
    process.send?.({ reclaimed: await reclaimAbandonedStagingWorkspaces() });
    process.disconnect?.(); return;
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
  if (process.argv[2] === 'reader') {
    fstatSync(3);
    process.send?.({ ready: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    process.send?.({ bytes: (await readFile(process.argv[3])).toString('utf8') });
  } else {
    const workspace = await createStagingWorkspace();
    const file = path.join(workspace.directory, 'media');
    await writeFile(file, 'worker staged bytes');
    process.send?.({ directory: workspace.directory, file });
  }
  setInterval(() => {}, 1000);
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; process.disconnect?.(); });
