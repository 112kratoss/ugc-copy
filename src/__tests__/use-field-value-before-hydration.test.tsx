import { act, render } from '@testing-library/react';
import { StrictMode, useRef, useState } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useFieldValueBeforeHydration } from '@/lib/use-field-value-before-hydration';

/**
 * An email field drawn on the server and hydrated after the browser has put text in it, as
 * /login's is when the visitor types, or the browser fills it in, before the page's script runs.
 */
function EmailField({ drawn = '', onValue }: { drawn?: string; onValue?: (value: string) => void }) {
  const [email, setEmail] = useState(drawn);
  const [renders, setRenders] = useState(0);
  const fieldRef = useRef<HTMLInputElement>(null);
  const handleEmailChange = (value: string) => {
    onValue?.(value);
    setEmail(value);
  };
  useFieldValueBeforeHydration(fieldRef, { drawn: email, onValue: handleEmailChange });
  return (
    <div>
      <input aria-label="Email" type="email" ref={fieldRef} value={email} onChange={(event) => handleEmailChange(event.target.value)} />
      <span data-testid="state">{email}</span>
      <button type="button" onClick={() => setRenders((count) => count + 1)}>
        Render {renders}
      </button>
    </div>
  );
}

/** The same field without the hook: what React does on its own. */
function BareEmailField() {
  const [email, setEmail] = useState('');
  const [renders, setRenders] = useState(0);
  return (
    <div>
      <input aria-label="Email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
      <span data-testid="state">{email}</span>
      <button type="button" onClick={() => setRenders((count) => count + 1)}>
        Render {renders}
      </button>
    </div>
  );
}

const recoverableErrors: unknown[] = [];

/** Text typed into the server's HTML: an input event no React hears. */
function typeInto(field: HTMLInputElement, text: string) {
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * The server's HTML for `element`, given text by the browser before any script runs, then
 * hydrated. Testing Library's cleanup unmounts the root and removes the container.
 */
function hydrateAfter(element: React.ReactElement, fill: (field: HTMLInputElement) => void) {
  const container = document.createElement('div');
  container.innerHTML = renderToString(element);
  document.body.appendChild(container);
  fill(container.querySelector('input')!);
  render(element, { container, hydrate: true, onRecoverableError: (error) => recoverableErrors.push(error) });
  return container;
}

/** A render of the field after hydration, as a sign-in's `setLoading(true)` makes. */
async function renderAgain(container: HTMLElement) {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button')!.click();
  });
}

const field = (container: HTMLElement) => container.querySelector('input')!;
const state = (container: HTMLElement) => container.querySelector('[data-testid="state"]')!.textContent;

afterEach(() => {
  // Every field hydrated: none was drawn again on the client.
  expect(recoverableErrors.splice(0)).toEqual([]);
});

// Vitest's React (19.2); the browser runs the 19.3 canary Next bundles, whose input hydration is
// the same. The check that Next's own build still lacks React's fix is the one in
// use-typed-before-hydration.test.tsx.
describe('what React does to text put in an input before hydration', () => {
  it('leaves it in the field as it hydrates, keeps the state empty, then writes the state over it at the next render', async () => {
    const container = hydrateAfter(<BareEmailField />, (input) => typeInto(input, 'early@example.com'));
    expect(field(container).value).toBe('early@example.com');
    expect(state(container)).toBe('');

    await renderAgain(container);

    expect(field(container).value).toBe('');
  });
});

describe('a value the browser put in the field before the page’s script ran', () => {
  it('is handed to the page’s change handler as the page mounts, and stays', async () => {
    const onValue = vi.fn();
    const container = hydrateAfter(<EmailField onValue={onValue} />, (input) => typeInto(input, 'early@example.com'));

    expect(onValue).toHaveBeenCalledTimes(1);
    expect(onValue).toHaveBeenCalledWith('early@example.com');
    expect(state(container)).toBe('early@example.com');
    await renderAgain(container);
    expect(field(container).value).toBe('early@example.com');
    expect(onValue).toHaveBeenCalledTimes(1);
  });

  it('counts with no input event too: what the field shows is the value', async () => {
    const container = hydrateAfter(<EmailField />, (input) => {
      input.value = 'filled@example.com';
    });
    await renderAgain(container);

    expect(state(container)).toBe('filled@example.com');
    expect(field(container).value).toBe('filled@example.com');
  });

  it('is an emptied field too, where the server drew a value', async () => {
    const container = hydrateAfter(<EmailField drawn="drawn@example.com" />, (input) => typeInto(input, ''));
    await renderAgain(container);

    expect(state(container)).toBe('');
    expect(field(container).value).toBe('');
  });

  it('leaves a field that holds what the server drew to the page', () => {
    const onValue = vi.fn();
    hydrateAfter(<EmailField drawn="drawn@example.com" onValue={onValue} />, () => undefined);

    expect(onValue).not.toHaveBeenCalled();
  });

  it('is handed over once, though Strict Mode runs the effect again before the value has drawn', () => {
    // Next's React runs a hydrated field's layout effects twice in Strict Mode (dev); vitest's
    // runs them twice only for a client mount. So a client mount stands in, its field given text
    // with no event as its ref attaches, which is before the hook first looks.
    const onValue = vi.fn();
    function FilledAsItMounts() {
      const [email, setEmail] = useState('');
      const fieldRef = useRef<HTMLInputElement | null>(null);
      useFieldValueBeforeHydration(fieldRef, {
        drawn: email,
        onValue: (value) => {
          onValue(value);
          setEmail(value);
        },
      });
      return (
        <input
          aria-label="Email"
          ref={(node) => {
            fieldRef.current = node;
            if (node && !node.dataset.filled) {
              node.dataset.filled = 'true';
              node.value = 'early@example.com';
            }
          }}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      );
    }

    render(
      <StrictMode>
        <FilledAsItMounts />
      </StrictMode>,
    );

    expect(onValue).toHaveBeenCalledTimes(1);
    expect(onValue).toHaveBeenCalledWith('early@example.com');
  });
});
