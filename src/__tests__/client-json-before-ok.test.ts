import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The platform answers a timed-out or crashed function with an HTML 502 or 504. A client that read
 * `await response.json()` before checking `response.ok`, or inside its `!response.ok` branch, threw
 * "Unexpected token '<'…" and showed those words to the person in place of its own message, an
 * unlock paid with credits included (audit 2026-11-27, finding 9). Such a read goes through
 * `readJsonResponse` (`src/lib/read-json-response.ts`), which never throws. A read after the
 * `!response.ok` branch has returned or thrown is left alone: its success path is unchanged.
 */

const ROOTS = ['src/app', 'src/components'].map((root) => path.join(process.cwd(), root));
const API_ROOT = path.join(process.cwd(), 'src/app/api');
const JSON_READ = /await\s+([A-Za-z_$][\w$.]*)\.json\(\)(?!\s*\.catch)/g;

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name);
    if (file === API_ROOT) return [];
    if (statSync(file).isDirectory()) return walk(file);
    return /\.(?:ts|tsx)$/.test(name) ? [file] : [];
  });
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The browser's helpers in src/lib that read an API answer (review of the 2026-11-27 change):
// uploads, their finalize, and the catalog's quotes.
const CLIENT_LIB_FILES = [
  'src/lib/profile-media-upload.ts',
  'src/lib/upload-finalize-client.ts',
  'src/lib/temporary-media-upload.ts',
  'src/lib/workflow-asset-upload.ts',
  'src/lib/generation-model-client.ts',
].map((file) => path.join(process.cwd(), file));

/** Each `await x.json()` read before `x.ok` is checked, or inside `if (!x.ok)`, outside a try. */
function findUnguardedReads(): string[] {
  const found: string[] = [];
  for (const file of [...ROOTS.flatMap(walk), ...CLIENT_LIB_FILES]) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(JSON_READ)) {
        const ok = new RegExp(`${escape(match[1])}\\.ok\\b`);
        const before = lines.slice(Math.max(0, index - 8), index).join('\n');
        const after = lines.slice(index + 1, index + 11).join('\n');
        // A read wrapped in its own try (a helper that answers null) cannot throw at its caller.
        const inOwnTry = /\btry\s*\{\s*$/.test(lines[index - 1] ?? '');
        const readFirst = ok.test(after) && !ok.test(before);
        const insideFailure = new RegExp(`if\\s*\\(\\s*!\\s*${escape(match[1])}\\.ok\\s*\\)\\s*\\{\\s*$`)
          .test(lines[index - 1] ?? '');
        if (!inOwnTry && (readFirst || insideFailure)) found.push(`${path.relative(process.cwd(), file)}:${index + 1}`);
      }
    });
  }
  return found;
}

describe('client reads of an API answer', () => {
  it('never parse a body as JSON before checking response.ok (use readJsonResponse)', () => {
    expect(findUnguardedReads()).toEqual([]);
  });
});

// A read whose success path goes on to use the body names the message it says when a 200's body
// cannot be read (`unreadableSuccess`), instead of carrying on with `{}`: no canvas, share, run,
// list or template (review of the 2026-11-27 change). A pure read says it failed; an action that
// may have been done (a create, a copy, a rename, a save, an import, an approval) says its result
// could not be confirmed and to check before trying again. `workflow-library.test.tsx` draws two of
// these; the rest are held here by their words.
const SUCCESS_BODY_READS: Array<[string, string]> = [
  ['src/app/create-workflow/WorkflowCanvasShareActions.tsx', 'Failed to load workflow share preview.'],
  ['src/app/create-workflow/WorkflowCanvasShareActions.tsx', 'We could not confirm the share link was created. Check before trying again.'],
  ['src/app/create-workflow/WorkflowCanvasShareActions.tsx', 'We could not confirm the share was imported. Check your canvases before trying again.'],
  ['src/app/marketplace/MarketplaceBrowser.tsx', 'Could not load more recipes.'],
  ['src/app/create-workflow/useWorkflowCanvasAssistant.ts', 'Workflow assistant request failed.'],
  ['src/app/create-workflow/useWorkflowCanvasAssistant.ts', 'We could not confirm the proposal was applied. Check the canvas before trying again.'],
  ['src/app/create-workflow/useWorkflowRunPolling.ts', 'Failed to refresh workflow run'],
  ['src/app/create-workflow/CreateWorkflowClient.tsx', 'Failed to load template authoring details.'],
  ['src/app/create-workflow/CreateWorkflowClient.tsx', 'We could not confirm the checkpoint was approved. Check the run before trying again.'],
  ['src/app/create-workflow/useWorkflowCanvasCanvases.ts', 'Failed to load workflow canvas'],
  ['src/app/create-workflow/useWorkflowCanvasCanvases.ts', 'We could not confirm the canvas was created. Check your canvases before trying again.'],
  ['src/app/create-workflow/useWorkflowCanvasCanvases.ts', 'Failed to load workflow canvases'],
  ['src/app/create-workflow/WorkflowLibraryClient.tsx', 'Failed to load workflows.'],
  ['src/app/create-workflow/WorkflowLibraryClient.tsx', 'We could not confirm the workflow was created. Check your workflows before trying again.'],
  ['src/app/create-workflow/WorkflowLibraryClient.tsx', 'Failed to load workflow for duplication.'],
  ['src/app/create-workflow/WorkflowLibraryClient.tsx', 'We could not confirm the copy was made. Check your workflows before trying again.'],
  ['src/app/create-workflow/WorkflowLibraryClient.tsx', 'We could not confirm the new name was saved. Check the workflow before trying again.'],
  ['src/app/create-workflow/useWorkflowCanvasPersistence.ts', 'We could not confirm the canvas was saved. Check it before trying again.'],
  ['src/app/profile/OwnerProfileMediaHub.tsx', 'Could not load your posts.'],
  ['src/app/profile/OwnerProfileMediaHub.tsx', 'Could not load saved posts.'],
  ['src/app/create-workflow/WorkflowTemplatePublishDrawer.tsx', 'Template request failed.'],
  ['src/app/post/new/NewPostClient.tsx', 'Failed to load generation.'],
];

describe('client reads that use a success body', () => {
  it.each(SUCCESS_BODY_READS)('%s says "%s" for a 200 it cannot read', (file, message) => {
    const source = readFileSync(path.join(process.cwd(), file), 'utf8');
    // The message may be one arm of a choice (the assistant's paid send says another).
    expect(source).toMatch(new RegExp(`unreadableSuccess:[^\\n]*'${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  });
});
