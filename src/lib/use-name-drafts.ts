'use client';

import { useCallback, useRef, useState } from 'react';

type NameDrafts = Record<string, string>;

/**
 * The names being typed into the name fields of one kind of card, by the id of
 * what each field names. A draft becomes the name when its field is left or
 * Enter is pressed. Escape drops it.
 *
 * The drafts are held twice. The state draws the fields, and the ref is what
 * the handlers read. Escape drops a draft and leaves the field in one event,
 * and leaving the field takes the draft before React has drawn again. Read
 * from that render's state, the draft was still there, and Escape renamed the
 * card to what had been typed (2026-10-03).
 */
export function useNameDrafts() {
  const [drafts, setDrafts] = useState<NameDrafts>({});
  const draftsRef = useRef<NameDrafts>({});

  const setDraft = useCallback((id: string, value: string) => {
    const nextDrafts = { ...draftsRef.current, [id]: value };
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
  }, []);

  /** Takes the draft for `id` away and returns it. Undefined when there is none. */
  const takeDraft = useCallback((id: string): string | undefined => {
    const { [id]: draft, ...nextDrafts } = draftsRef.current;
    if (draft === undefined) {
      return undefined;
    }

    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
    return draft;
  }, []);

  /** Forgets the draft for `id`, as Escape does, and as removing the card does. */
  const dropDraft = useCallback((id: string) => {
    takeDraft(id);
  }, [takeDraft]);

  return { drafts, setDraft, takeDraft, dropDraft };
}
