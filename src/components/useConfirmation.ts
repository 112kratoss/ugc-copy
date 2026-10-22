'use client';

import { useCallback, useEffect, useRef } from 'react';

import { requestConfirmation, type ConfirmationRequest } from './feedback-state';

/**
 * `requestConfirmation` for a component: a question it asked is answered
 * "cancel" and taken down when it goes away (or an `<Activity>` hides it).
 * Otherwise a Back taken while the question was up would leave the dialog
 * over the next page, and its answer would act for a page that is gone.
 */
export function useConfirmation() {
  const pendingRef = useRef<AbortController | null>(null);

  useEffect(() => () => pendingRef.current?.abort(), []);

  return useCallback((request: ConfirmationRequest) => {
    const controller = new AbortController();
    pendingRef.current = controller;
    return requestConfirmation(request, { signal: controller.signal });
  }, []);
}
