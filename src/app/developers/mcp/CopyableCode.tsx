'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { IconButton, Text } from '@/components/DesignSystem';

type CopyState = 'idle' | 'copied' | 'failed';

/** How long the button shows that the copy worked, as the prompt copy in media details does. */
const COPIED_RESET_MS = 2000;

/**
 * A command, URL or config file the setup page asks a creator to paste somewhere, with a copy
 * button. The text stays selectable, so a browser without the async clipboard (an insecure
 * origin, a denied permission) still lets the person copy it by hand, and the failure says so.
 */
export default function CopyableCode({ code, label }: { code: string; label: string }) {
  const [state, setState] = useState<CopyState>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  async function copy() {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    let next: CopyState = 'failed';
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
        next = 'copied';
      }
    } catch {
      next = 'failed';
    }
    setState(next);
    resetTimer.current = setTimeout(() => setState('idle'), COPIED_RESET_MS);
  }

  return (
    <div>
      <div className="flex items-start gap-2 rounded-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] py-1 pl-4 pr-1">
        <pre className="min-w-0 flex-1 overflow-x-auto py-3">
          <Text as="code" variant="code">{code}</Text>
        </pre>
        <IconButton
          label={state === 'copied' ? `Copied ${label}` : `Copy ${label}`}
          icon={state === 'copied' ? Check : Copy}
          onClick={copy}
          className="shrink-0"
        />
      </div>
      <p role="status" aria-live="polite" className={state === 'failed' ? 'mt-2' : 'sr-only'}>
        {state === 'failed' ? (
          <Text as="span" variant="caption">Copying is blocked here. Select the text and copy it yourself.</Text>
        ) : state === 'copied' ? `Copied ${label} to your clipboard.` : ''}
      </p>
    </div>
  );
}
