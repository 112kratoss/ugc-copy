'use client';

import { useId, useRef, useState } from 'react';
import clsx from 'clsx';
import { AlertCircle, Check, Loader2 } from 'lucide-react';

import { saveTypedInviteCode } from '@/lib/typed-invite-code';

import { TYPED_INVITE_CODE_HELD } from '../../../ugc-mobile/lib/invite-share-link/invite-typed-code';

type Feedback = { tone: 'saved' | 'error'; message: string } | null;

/**
 * "Have an invite code?" under Apple and Google (owner, 2026-11-11: a code a
 * friend can type instead of opening a link). Closed until asked for, so the
 * page stays the two buttons for everyone else. A saved code is recorded as
 * the browser's invite before the account is made, which is what the sign-up's
 * claim needs; the page the sign-up lands on then says "Invite applied"
 * (`describeReferralClaim`).
 */
export default function InviteCodeEntry({ disabled, inviteHeld }: {
  /** A sign-in is under way: nothing else starts. */
  disabled: boolean;
  /** This browser already keeps an invite (its visit cookie), read by the server. */
  inviteHeld: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  const messageId = useId();

  const openField = () => {
    setOpen(true);
    setFeedback(null);
    // The field draws in this click's render; focus it once it is there.
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || disabled) return;
    setSaving(true);
    setFeedback(null);
    const result = await saveTypedInviteCode(value);
    setSaving(false);
    if (result.ok) {
      setFeedback({ tone: 'saved', message: result.message });
      setOpen(false);
      setValue('');
    } else {
      setFeedback({ tone: 'error', message: result.message });
      inputRef.current?.focus();
    }
  };

  const saved = feedback?.tone === 'saved' ? (
    <p role="status" className="mx-auto flex max-w-[360px] items-start gap-2 rounded-2xl bg-black/60 px-3.5 py-2.5 text-left text-sm leading-5 text-white/85">
      <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ui-accent-workflow)]" />
      <span>{feedback.message}</span>
    </p>
  ) : null;

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        {saved}
        {!saved && inviteHeld ? (
          <p className="mx-auto max-w-[360px] text-sm leading-5 text-white/70">{TYPED_INVITE_CODE_HELD}</p>
        ) : null}
        <button
          type="button"
          onClick={openField}
          disabled={disabled}
          aria-expanded={false}
          className={clsx('ui-focus-ring mx-auto inline-flex min-h-11 items-center justify-center rounded-full px-3 text-[15px] leading-5 text-white/70 transition hover:text-white', disabled && 'pointer-events-none opacity-50')}
        >
          {saved || inviteHeld ? 'Use a different invite code' : 'Have an invite code?'}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mx-auto flex w-full max-w-[300px] flex-col gap-2 text-left">
      <label htmlFor={fieldId} className="pl-[18px] text-[13px] font-bold uppercase leading-[18px] tracking-[0.05em] text-white/70">
        Invite code
      </label>
      <div className="flex min-h-[48px] items-center gap-1 rounded-full border border-white/20 bg-[#0b0b0d]/90 pl-[18px] pr-1 transition focus-within:border-[var(--ui-focus)]">
        <input
          id={fieldId}
          ref={inputRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={2048}
          placeholder="K7P2QX or invite link"
          aria-invalid={feedback?.tone === 'error' || undefined}
          aria-describedby={feedback?.tone === 'error' ? messageId : undefined}
          className="sign-in-field-input font-mono uppercase placeholder:normal-case placeholder:font-sans"
        />
        <button
          type="submit"
          disabled={saving || disabled || !value.trim()}
          className="ui-focus-ring inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full bg-white px-4 text-sm font-bold text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
          {saving ? 'Saving…' : 'Apply'}
        </button>
      </div>
      {feedback?.tone === 'error' ? (
        <p id={messageId} role="alert" className="flex items-start gap-2 px-2 text-sm leading-5 text-red-200">
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{feedback.message}</span>
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setFeedback(null);
        }}
        className="ui-focus-ring mx-auto inline-flex min-h-11 items-center justify-center rounded-full px-3 text-sm text-white/60 transition hover:text-white"
      >
        Cancel
      </button>
    </form>
  );
}
