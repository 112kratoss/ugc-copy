import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { act, Activity, useEffect, useRef, useState } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { hasCreatorEditedPromptDuringRemix } from '@/lib/remix-source';
import { TYPED_BEFORE_HYDRATION_CAPTURE, typedText } from '@/lib/typed-before-hydration';
import { useTypedBeforeHydration } from '@/lib/use-typed-before-hydration';

/**
 * A prompt box drawn on the server and hydrated after a visitor has typed into it,
 * as a creator page is when the visitor types before the page's script runs.
 */
type BoxProps = {
  drawn?: string;
  /** False for a page that opens on a prompt of its own, and for the fault itself. */
  enabled?: boolean;
  onTyped?: (value: string) => void;
  /** A saved draft read as the page opens, answered a microtask later. */
  savedDraft?: string;
  /** Told once that read has answered. */
  onRestoreAnswered?: () => void;
  /** Mount effects long enough that React's scheduler yields before it draws again. */
  slowMount?: boolean;
  /** Hidden and shown again, which runs every effect again over the same field. */
  activity?: 'visible' | 'hidden';
};

function PromptBox({ drawn = '', enabled = true, onTyped, savedDraft, onRestoreAnswered, slowMount = false }: BoxProps) {
  const [prompt, setPrompt] = useState(drawn);
  const [renders, setRenders] = useState(0);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const promptRef = useRef(prompt);
  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt]);
  const handlePromptChange = (value: string) => {
    onTyped?.(value);
    setPrompt(value);
  };
  useTypedBeforeHydration(fieldRef, { drawn: prompt, enabled, onTyped: handlePromptChange });
  // The creators' draft read: an edit made while it was out wins over what it brings back.
  useEffect(() => {
    if (savedDraft === undefined) return;
    if (slowMount) {
      // Past the scheduler's 5 ms slice, so it hands the thread back before its next render.
      const until = performance.now() + 12;
      while (performance.now() < until);
    }
    const promptWhenRestoreStarted = promptRef.current;
    void Promise.resolve(savedDraft).then((saved) => {
      if (!hasCreatorEditedPromptDuringRemix(promptRef.current, promptWhenRestoreStarted)) setPrompt(saved);
      onRestoreAnswered?.();
    });
  }, [savedDraft, slowMount, onRestoreAnswered]);
  return (
    <div>
      <textarea aria-label="Prompt" ref={fieldRef} value={prompt} onChange={(event) => handlePromptChange(event.target.value)} />
      <span data-testid="count">{prompt.length}</span>
      <button type="button" onClick={() => setRenders((count) => count + 1)}>
        Render {renders}
      </button>
      {/* The page's own change of the prompt, as Enhance makes. */}
      <button type="button" onClick={() => setPrompt((current) => `${current}, enhanced`)}>
        Enhance
      </button>
    </div>
  );
}

function Page({ activity = 'visible', ...props }: BoxProps) {
  return (
    <Activity mode={activity}>
      <PromptBox {...props} />
    </Activity>
  );
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
const recoverableErrors: unknown[] = [];

/** Text typed into the server's HTML: an input event, which the root layout's capture hears. */
function typeInto(field: HTMLTextAreaElement, text: string) {
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * The server's HTML for the box, typed into before any script runs, then hydrated: inside
 * act, or outside it, where React's scheduler orders the work as a browser's does.
 */
async function hydrateAfterTyping(props: BoxProps, type: (field: HTMLTextAreaElement) => void, { withinAct = true } = {}) {
  const container = document.createElement('div');
  container.innerHTML = renderToString(<Page {...props} />);
  document.body.appendChild(container);
  type(container.querySelector('textarea')!);
  const hydrate = () => hydrateRoot(container, <Page {...props} />, { onRecoverableError: (error) => recoverableErrors.push(error) });
  let root!: Root;
  if (withinAct) {
    await act(async () => {
      root = hydrate();
    });
  } else {
    root = hydrate();
  }
  mounted.push({ root, container });
  return { container, root };
}

/** A render of the box after hydration, as the creators get when their catalog comes in. */
async function renderAgain(container: HTMLElement) {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button')!.click();
  });
}

const field = (container: HTMLElement) => container.querySelector('textarea')!;
const count = (container: HTMLElement) => container.querySelector('[data-testid="count"]')!.textContent;
const MOTION_DRAWN = "No distortion, the character's movements are consistent with the video.";

beforeAll(() => {
  // The root layout's capture, as the server's HTML runs it ahead of every field.
  new Function(TYPED_BEFORE_HYDRATION_CAPTURE)();
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  // Every box hydrated: none was drawn again on the client.
  expect(recoverableErrors.splice(0)).toEqual([]);
});

describe('what this React build does to text typed before hydration', () => {
  it('keeps it in an empty box, then writes the state over it at the next render', async () => {
    const { container } = await hydrateAfterTyping({ enabled: false }, (box) => typeInto(box, 'A lighthouse at dusk'));
    expect(field(container).value).toBe('A lighthouse at dusk');
    expect(count(container)).toBe('0');

    await renderAgain(container);

    expect(field(container).value).toBe('');
  });

  it('puts the server’s text back in a box it drew text in, as it hydrates', async () => {
    const { container } = await hydrateAfterTyping({ enabled: false, drawn: MOTION_DRAWN }, (box) => typeInto(box, 'Slow pan'));

    expect(field(container).value).toBe(MOTION_DRAWN);
  });

  it('is still React’s own: Next’s bundled build has no replay of a change made before hydration', () => {
    // React's fix (enableHydrationChangeEvent) queues a change event per changed field as hydration
    // commits; once Next's stable build carries it, the hook and the root layout's capture repeat it
    // and can go.
    const next = path.dirname(createRequire(path.join(process.cwd(), 'package.json')).resolve('next/package.json'));
    for (const build of ['production', 'development']) {
      const source = readFileSync(path.join(next, 'dist/compiled/react-dom/cjs', `react-dom-client.${build}.js`), 'utf8');
      expect(source, build).toContain('function initTextarea(');
      expect(source, build).not.toContain('queuedChangeEventTargets');
    }
  });
});

describe('a prompt typed before the page’s script ran', () => {
  it('is handed to the page’s change handler as the page mounts, and stays', async () => {
    const onTyped = vi.fn();
    const { container } = await hydrateAfterTyping({ onTyped }, (box) => typeInto(box, 'A lighthouse at dusk'));

    expect(onTyped).toHaveBeenCalledTimes(1);
    expect(onTyped).toHaveBeenCalledWith('A lighthouse at dusk');
    expect(count(container)).toBe('20');
    await renderAgain(container);
    expect(field(container).value).toBe('A lighthouse at dusk');
  });

  it('replaces a prompt the server drew, which the hydration had put back', async () => {
    const { container } = await hydrateAfterTyping({ drawn: MOTION_DRAWN }, (box) => typeInto(box, `${MOTION_DRAWN} Slow pan.`));
    await renderAgain(container);

    expect(field(container).value).toBe(`${MOTION_DRAWN} Slow pan.`);
    expect(count(container)).toBe(String(MOTION_DRAWN.length + 10));
  });

  it('is an emptied box too, where the server drew a prompt', async () => {
    const { container } = await hydrateAfterTyping({ drawn: MOTION_DRAWN }, (box) => typeInto(box, ''));
    await renderAgain(container);

    expect(field(container).value).toBe('');
    expect(count(container)).toBe('0');
  });

  it('leaves a box typed back to what the server drew to the page', async () => {
    const onTyped = vi.fn();
    await hydrateAfterTyping({ drawn: MOTION_DRAWN, onTyped }, (box) => typeInto(box, MOTION_DRAWN));

    expect(onTyped).not.toHaveBeenCalled();
  });

  it('leaves text no input event brought, as a browser restoring a form puts back, to the page', async () => {
    // Another account's prompt or a stale tab's: never taken for the visitor's.
    const onTyped = vi.fn();
    const { container } = await hydrateAfterTyping({ onTyped }, (box) => {
      box.value = 'A prompt from before';
    });
    await renderAgain(container);

    expect(onTyped).not.toHaveBeenCalled();
    expect(field(container).value).toBe('');
  });

  it('leaves the text to a page that opens on a prompt of its own', async () => {
    // A link's prompt or a remix: the page seeds the box itself, and its seed wins.
    const onTyped = vi.fn();
    const { container } = await hydrateAfterTyping({ enabled: false, onTyped }, (box) => typeInto(box, 'A lighthouse at dusk'));
    await renderAgain(container);

    expect(onTyped).not.toHaveBeenCalled();
    expect(field(container).value).toBe('');
  });

  it('wins over a saved draft read back as the page opens', async () => {
    const { container } = await hydrateAfterTyping({ savedDraft: 'An older prompt' }, (box) => typeInto(box, 'A lighthouse at dusk'));
    await renderAgain(container);

    expect(field(container).value).toBe('A lighthouse at dusk');
    expect(count(container)).toBe('20');
  });

  it('still lets a saved draft fill a box nobody typed into', async () => {
    const { container } = await hydrateAfterTyping({ savedDraft: 'An older prompt' }, () => undefined);
    await renderAgain(container);

    expect(field(container).value).toBe('An older prompt');
  });

  it('wins over a saved draft that answers before React draws again, as it can outside act', async () => {
    // Outside act the scheduler hands the thread back once the mount's effects outlast its slice,
    // and a read can answer before its next render: a passive effect's update would land after
    // the read and lose to it. The layout effect's update draws in the same task, first.
    const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT;
    reactGlobal.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      const answered = vi.fn();
      const { container } = await hydrateAfterTyping(
        { savedDraft: 'An older prompt', slowMount: true, onRestoreAnswered: answered },
        (box) => typeInto(box, 'A lighthouse at dusk'),
        { withinAct: false },
      );

      await vi.waitFor(() => expect(answered).toHaveBeenCalled(), { timeout: 5000 });
      // Whatever React still had to draw once the read had answered.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(field(container).value).toBe('A lighthouse at dusk');
      expect(count(container)).toBe('20');
    } finally {
      reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });

  it('is handed over once, though the page’s effects run again over the same field', async () => {
    const onTyped = vi.fn();
    const { container, root } = await hydrateAfterTyping({ onTyped }, (box) => typeInto(box, 'A lighthouse at dusk'));
    // Changed by the page itself since: effects that run again must not put the typed text back.
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>('button')[1].click();
    });
    expect(field(container).value).toBe('A lighthouse at dusk, enhanced');

    await act(async () => {
      root.render(<Page onTyped={onTyped} activity="hidden" />);
    });
    await act(async () => {
      root.render(<Page onTyped={onTyped} activity="visible" />);
    });

    expect(onTyped).toHaveBeenCalledTimes(1);
    expect(field(container).value).toBe('A lighthouse at dusk, enhanced');
  });
});

describe('the capture the root layout runs', () => {
  it('keeps a textarea’s typed text on the field, and nothing for a field never typed into', () => {
    const typed = document.createElement('textarea');
    const untouched = document.createElement('textarea');
    document.body.append(typed, untouched);
    typeInto(typed, 'A lighthouse at dusk');
    // Written over as hydration writes, with no input event.
    typed.value = 'something else';
    untouched.value = 'drawn';

    expect(typedText(typed)).toBe('A lighthouse at dusk');
    expect(typedText(untouched)).toBeUndefined();
    typed.remove();
    untouched.remove();
  });
});
