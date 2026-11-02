import { useEffect, useRef, type RefObject } from 'react';

/**
 * Focuses a composer's field each time the screen's request count goes up while the composer is
 * mounted. The screen counts its requests from its own mount (a blocked prompt's "Edit prompt" adds
 * one), so a composer mounted later by a tool switch starts from the count it is handed: the
 * requests before it were for another tool's field. Read on mount, the count put every later
 * composer's cursor in its prompt and opened the keyboard unasked (2026-11-02).
 */
export function useFocusRequest(request: number, fieldRef: RefObject<{ focus: () => void } | null>) {
  const answeredRef = useRef(request);
  useEffect(() => {
    if (request === answeredRef.current) return;
    answeredRef.current = request;
    fieldRef.current?.focus();
  }, [request, fieldRef]);
}
