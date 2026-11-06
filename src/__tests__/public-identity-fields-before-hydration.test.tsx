import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import PublicIdentityFields from '@/components/PublicIdentityFields';
import type { PublicIdentityDraft } from '@/lib/public-identity';
import { TYPED_BEFORE_HYDRATION_CAPTURE } from '@/lib/typed-before-hydration';

// The post composer's server render draws the name and handle fields for an account that has
// neither, filled with suggestions. A name or handle typed there before the page's script ran
// reached no React: the next render wrote the suggestions back, and Publish claimed the suggested
// handle (2026-11-06; archive/forms-sweep-2026-11-06 has the probe that showed it on the page, which
// the E2E user, whose server state carries no profile, does not draw).
describe('public identity fields typed in before the page’s script ran', () => {
  const SUGGESTED: PublicIdentityDraft = { displayName: 'Workflow User', username: 'workflow-user' };
  const recoverableErrors: unknown[] = [];

  beforeAll(() => {
    // The root layout's capture, as the server's HTML runs it ahead of every field.
    new Function(TYPED_BEFORE_HYDRATION_CAPTURE)();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    // The fields hydrated: React never drew them again on the client, which would drop the text.
    expect(recoverableErrors.splice(0)).toEqual([]);
  });

  /** The composer's part: the draft it keeps, and every draft the fields hand it. */
  function Composer({ onDraft }: { onDraft: (draft: PublicIdentityDraft) => void }) {
    const [draft, setDraft] = useState(SUGGESTED);
    return (
      <PublicIdentityFields
        idPrefix="composer-identity"
        value={draft}
        errors={{}}
        onChange={(next) => {
          onDraft(next);
          setDraft(next);
        }}
      />
    );
  }

  /** The server's HTML, changed by `fill` before any React runs, then hydrated. */
  function hydrateAfter(onDraft: (draft: PublicIdentityDraft) => void, fill: (name: HTMLInputElement, handle: HTMLInputElement) => void) {
    const container = document.createElement('div');
    container.innerHTML = renderToString(<Composer onDraft={() => {}} />);
    document.body.appendChild(container);
    const name = container.querySelector<HTMLInputElement>('#composer-identity-display-name')!;
    const handle = container.querySelector<HTMLInputElement>('#composer-identity-handle')!;
    fill(name, handle);
    render(<Composer onDraft={onDraft} />, { container, hydrate: true, onRecoverableError: (error) => recoverableErrors.push(error) });
    return { name, handle };
  }

  /** Typing in the server's HTML: an input event no React hears. */
  function typeIn(field: HTMLInputElement, value: string) {
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('hands the composer both the name and the handle typed early, the handle normalised', async () => {
    const onDraft = vi.fn();
    const { name, handle } = hydrateAfter(onDraft, (nameField, handleField) => {
      typeIn(nameField, 'Early Name');
      typeIn(handleField, 'Early-Handle');
    });

    // One commit hands both over, the second on top of the first.
    expect(onDraft).toHaveBeenLastCalledWith({ displayName: 'Early Name', username: 'early-handle' });
    // A render of the fields keeps them.
    await act(async () => {});
    expect(name.value).toBe('Early Name');
    expect(handle.value).toBe('early-handle');
  });

  it('hands over only the field typed in', () => {
    const onDraft = vi.fn();
    hydrateAfter(onDraft, (_name, handleField) => {
      typeIn(handleField, 'chosen-early');
    });

    expect(onDraft).toHaveBeenCalledTimes(1);
    expect(onDraft).toHaveBeenCalledWith({ ...SUGGESTED, username: 'chosen-early' });
  });

  it('takes no text a browser put back without an input event', () => {
    const onDraft = vi.fn();
    hydrateAfter(onDraft, (nameField) => {
      nameField.value = 'Restored From Another Tab';
    });

    expect(onDraft).not.toHaveBeenCalled();
  });
});
