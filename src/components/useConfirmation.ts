'use client';

import { useCallback, useEffect, useRef } from 'react';

import { requestConfirmation, type ConfirmationRequest } from './feedback-state';

/**
 * `requestConfirmation` for a component: a question it asked is answered
 * "cancel" and taken down when it goes away (or an `<Activity>` hides it), or
 * when `scope` changes: a question about an editor is moot once the editor
 * has closed another way (a save that finished while it was up).
 */
export function useConfirmation(scope?: unknown) {
  const pendingRef = useRef<AbortController | null>(null);

  useEffect(() => () => pendingRef.current?.abort(), [scope]);

  return useCallback((request: ConfirmationRequest) => {
    const controller = new AbortController();
    pendingRef.current = controller;
    return requestConfirmation(request, { signal: controller.signal });
  }, []);
}
