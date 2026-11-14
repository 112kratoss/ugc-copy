import { ChevronDown, Sparkles } from 'lucide-react';

/**
 * The top bar's balance and account button, and the placeholder drawn in their place while the
 * account loads: one shape, from the same classes, so nothing in the bar moves when the account
 * lands (`app-shell-account-restore.ts` says why). The real controls add their focus ring and
 * hover (`AppShellAccount`).
 */
export const APP_SHELL_CREDITS_PILL_CLASS =
  'inline-flex min-h-12 shrink-0 items-center gap-2 rounded-full border border-amber-300/20 bg-amber-400/10 px-3 text-sm font-bold text-amber-100';
export const APP_SHELL_ACCOUNT_BUTTON_CLASS =
  'flex min-h-12 items-center gap-2 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] p-1 pr-2';
export const APP_SHELL_AVATAR_FRAME_CLASS =
  'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-[rgba(255,122,89,0.35)] bg-[var(--ui-primary-soft)] font-extrabold text-[var(--ui-primary-strong)]';

/**
 * The balance before it is read: a bar as wide as the last balance this browser showed, with
 * " credits" beside it from 640px as the balance has (`.app-shell-credits-pending` in globals.css).
 */
export function AppShellCreditsPendingLabel() {
  return (
    <span aria-hidden className="app-shell-credits-pending">
      <span className="app-shell-credits-pending-digits" />
      <span className="hidden sm:inline"> credits</span>
    </span>
  );
}

/**
 * Both controls, inert, for a browser that holds a session the account has not read yet. Drawn by
 * the server too, behind `.app-shell-when-signed-in` (`DeferredAppShellAccount`).
 */
export default function AppShellAccountPending({ className = '' }: { className?: string }) {
  return (
    <>
      <span aria-hidden className={`${APP_SHELL_CREDITS_PILL_CLASS} ${className}`.trim()}>
        <Sparkles className="h-4 w-4" aria-hidden />
        <AppShellCreditsPendingLabel />
      </span>
      <span aria-hidden className={`${APP_SHELL_ACCOUNT_BUTTON_CLASS} ${className}`.trim()}>
        <span className={`${APP_SHELL_AVATAR_FRAME_CLASS} h-9 w-9`} />
        <ChevronDown className="hidden h-4 w-4 text-zinc-500 sm:block" />
      </span>
    </>
  );
}
