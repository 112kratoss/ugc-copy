'use client';

import { Check, Copy, Loader2, Share2 } from 'lucide-react';
import { useRef, useState, type DOMAttributes, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';

import { ModalSheet } from '@/components/ModalSheet';
import { SHARE_BUSY_STYLE, useShareAction } from '@/components/useShareAction';
import { sharePublicGeneration } from '@/lib/share-client';
import type { GenerationShareSourceSurface } from '@/lib/share';

interface PublicShareButtonProps {
  generationId: string;
  title: string;
  description?: string | null;
  sourceSurface: GenerationShareSourceSurface;
  accessToken?: string | null;
  className?: string;
  label?: string;
  disabled?: boolean;
  disabledReason?: string;
  onShared?: () => void;
  iconOnly?: boolean;
  /** The creator sharing their own post; the share text then claims the work. */
  viewerIsOwner?: boolean;
}

const COPY_REFUSED = 'Copying is blocked here too. Select the link and copy it yourself.';

const keepInSheet = (event: SyntheticEvent) => event.stopPropagation();

/**
 * Every press, swipe and wheel the sheet takes, kept from what the button sits in: a feed card
 * opens its post on a click and in a new tab on a middle-click (`onAuxClick`), and the reel moves
 * to another post on a swipe or a wheel.
 */
const KEEP_IN_SHEET = {
  onClick: keepInSheet,
  onAuxClick: keepInSheet,
  onDoubleClick: keepInSheet,
  onContextMenu: keepInSheet,
  onPointerDown: keepInSheet,
  onPointerUp: keepInSheet,
  onMouseDown: keepInSheet,
  onMouseUp: keepInSheet,
  onTouchStart: keepInSheet,
  onTouchMove: keepInSheet,
  onTouchEnd: keepInSheet,
  onWheel: keepInSheet,
} satisfies DOMAttributes<HTMLSpanElement>;

function selectWholeLink(field: HTMLInputElement) {
  field.setSelectionRange(0, field.value.length);
}

/**
 * The link of a share the browser refused both ways (`ShareLinkRefusedError`), to copy by hand,
 * for this button and `ProfileShareButton`: selected in a read-only field as the sheet comes up,
 * so a keyboard copies it at once, and Copy link, a press of its own, which the browser may allow
 * where the share's spent click was not. The share is counted once the person has the link, by
 * Copy link or their own copy of the field, and once only. On the app's sheet (`ModalSheet`, drawn
 * in <body> as it expects), because the share buttons sit in action rows, Explore's tiles and the
 * reel's column, with no room for a field.
 *
 * React's events cross a portal, so the span between the button and the portal keeps the sheet's
 * presses, swipes and wheels in it (`KEEP_IN_SHEET`); it draws no box.
 */
export function ShareLinkSheet({ link, onCopy, onCopiedByHand, onClose }: {
  link: string;
  /** True once the link is on the clipboard. */
  onCopy: () => Promise<boolean>;
  /** The person copied the field's link themselves (Cmd or Ctrl+C, the field's menu). */
  onCopiedByHand: () => void;
  onClose: () => void;
}) {
  const fieldRef = useRef<HTMLInputElement>(null);
  const [copyRefused, setCopyRefused] = useState(false);
  // A second press while the clipboard answers the first writes and closes once.
  const copyingRef = useRef(false);

  const copy = async () => {
    if (copyingRef.current) return;
    copyingRef.current = true;
    const copied = await onCopy();
    copyingRef.current = false;
    if (copied) {
      onClose();
      return;
    }
    setCopyRefused(true);
    fieldRef.current?.focus();
    if (fieldRef.current) selectWholeLink(fieldRef.current);
  };

  return (
    <span className="contents" {...KEEP_IN_SHEET}>
      {createPortal(
        <ModalSheet
          title="Copy the link"
          body="Sharing is blocked in this browser. Copy the link, then paste it wherever you want to share it."
          initialFocusRef={fieldRef}
          onClose={onClose}
        >
          <input
            ref={fieldRef}
            type="text"
            readOnly
            value={link}
            aria-label="Link"
            onFocus={(event) => selectWholeLink(event.currentTarget)}
            onClick={(event) => selectWholeLink(event.currentTarget)}
            // Where Copy link is refused too, this is how the link leaves, and it is the share.
            onCopy={onCopiedByHand}
            className="ui-focus-ring mt-5 block min-h-12 w-full rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 text-base text-[var(--ui-text-primary)] sm:text-sm"
          />
          <p role="status" className={copyRefused ? 'mt-3 text-sm leading-6 text-[var(--ui-text-secondary)]' : 'sr-only'}>
            {copyRefused ? COPY_REFUSED : ''}
          </p>
          <div className="ui-confirm-actions">
            <button type="button" onClick={() => void copy()} className="ui-button ui-button-primary ui-focus-ring">
              <Copy aria-hidden className="h-4 w-4" />
              Copy link
            </button>
          </div>
        </ModalSheet>,
        document.body,
      )}
    </span>
  );
}

export default function PublicShareButton({
  generationId,
  title,
  description,
  sourceSurface,
  accessToken,
  className,
  label = 'Share',
  disabled = false,
  disabledReason,
  onShared,
  iconOnly = false,
  viewerIsOwner = false,
}: PublicShareButtonProps) {
  const {
    state,
    isLoading,
    resolvedLabel,
    statusMessage,
    runShareAction,
    refusedLink,
    copyRefusedLink,
    countRefusedLinkCopiedByHand,
    dismissRefusedLink,
  } = useShareAction({
    label,
    disabled,
    onShared,
    onAction: () =>
      sharePublicGeneration({
        generationId,
        title,
        description,
        sourceSurface,
        accessToken,
        viewerIsOwner,
      }),
  });

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          void runShareAction();
        }}
        // Busy while it shares, never disabled, so the focus stays on it (`SHARE_BUSY_STYLE`).
        // A post that cannot be shared at all is disabled.
        disabled={disabled}
        aria-disabled={isLoading || undefined}
        aria-busy={isLoading}
        aria-label={iconOnly ? resolvedLabel : undefined}
        title={disabledReason || (iconOnly ? resolvedLabel : undefined)}
        className={className}
        style={isLoading ? SHARE_BUSY_STYLE : undefined}
      >
        {state === 'loading' ? (
          <Loader2 size={16} className="h-4 w-4 shrink-0 animate-spin" />
        ) : state === 'copied' || state === 'shared' ? (
          <Check size={16} className="h-4 w-4 shrink-0" />
        ) : (
          <Share2 size={16} className="h-4 w-4 shrink-0" />
        )}
        {!iconOnly && <span>{resolvedLabel}</span>}
      </button>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {statusMessage}
      </span>
      {refusedLink ? (
        <ShareLinkSheet
          link={refusedLink}
          onCopy={copyRefusedLink}
          onCopiedByHand={countRefusedLinkCopiedByHand}
          onClose={dismissRefusedLink}
        />
      ) : null}
    </>
  );
}
