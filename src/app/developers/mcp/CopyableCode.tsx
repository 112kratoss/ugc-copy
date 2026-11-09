'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState, type FocusEvent } from 'react';

import { IconButton, Text } from '@/components/DesignSystem';

type CopyState = 'idle' | 'copied' | 'failed';

/** How long the button shows that the copy worked, as the prompt copy in media details does. */
const COPIED_RESET_MS = 2000;

/**
 * A command, URL or config file the setup page asks a creator to paste somewhere, with a copy
 * button. The text stays selectable, so a browser without the async clipboard (an insecure
 * origin, a denied permission) still lets the person copy it by hand, and the failure says so.
 *
 * `label` names what is copied and whose it is ("the Claude Code command"): the button, its
 * confirmation and the scroller all say it, so no two of them read the same.
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
    // Only the confirmation goes by itself. The failure tells the person what to do instead, so it
    // stays until the next press, or until the focus leaves this block (below).
    if (next === 'copied') resetTimer.current = setTimeout(() => setState('idle'), COPIED_RESET_MS);
  }

  // Selecting the text by hand moves the focus to the scroller, inside the block, which keeps the
  // message; moving on to anything else clears it.
  function clearFailureOnLeave(event: FocusEvent<HTMLDivElement>) {
    if (state === 'failed' && !event.currentTarget.contains(event.relatedTarget as Node | null)) setState('idle');
  }

  return (
    <div onBlur={clearFailureOnLeave}>
      <div className="flex items-start gap-2 rounded-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] py-1 pl-4 pr-1">
        {/* A long command scrolls sideways on a phone, so the keyboard can reach and scroll it too. */}
        <pre
          tabIndex={0}
          role="region"
          aria-label={label}
          className="ui-focus-ring min-w-0 flex-1 overflow-x-auto rounded-lg py-3"
        >
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
