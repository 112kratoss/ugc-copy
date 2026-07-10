'use client';

import { CheckCircle2, Eye, EyeOff, Loader2, LockKeyhole, WandSparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { supabase } from '@/lib/supabase';

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError('Use at least 8 characters for your new password.');
      return;
    }

    if (password !== confirmPassword) {
      setError('The passwords do not match.');
      return;
    }

    setIsSaving(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setIsSaving(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    setSaved(true);
    window.setTimeout(() => {
      router.replace('/profile');
      router.refresh();
    }, 900);
  };

  return (
    <div className="ui-page ui-page-ambient flex min-h-screen flex-col p-4 sm:p-6">
      <Link href="/" className="ui-focus-ring flex w-fit items-center gap-2 rounded-2xl text-[var(--ui-text-primary)]">
        <span className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-[var(--ui-primary)] text-[var(--ui-primary-on)]">
          <WandSparkles className="h-5 w-5" aria-hidden />
        </span>
        <span className="text-sm font-extrabold">magicbooklet</span>
      </Link>

      <div className="flex flex-1 items-center justify-center py-10">
        <section className="w-full max-w-md rounded-[28px] border border-[var(--ui-border-default)] bg-[var(--ui-surface-1)] p-6 shadow-[var(--ui-shadow-panel)] sm:p-8">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--ui-primary-soft)] text-[var(--ui-primary)]">
            <LockKeyhole className="h-5 w-5" aria-hidden />
          </span>
          <h1 className="mt-5 text-3xl font-extrabold tracking-tight text-[var(--ui-text-primary)]">
            Choose a new password
          </h1>
          <p className="mt-2 text-sm leading-6 text-[var(--ui-text-muted)]">
            Set a new password for your creator account. You’ll return to your profile when it is saved.
          </p>

          {saved ? (
            <div role="status" className="mt-6 flex items-start gap-3 rounded-2xl border border-emerald-300/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" aria-hidden />
              Password updated. Opening your profile…
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              <label className="block" htmlFor="new-password">
                <span className="mb-1.5 block text-sm font-bold text-[var(--ui-text-secondary)]">New password</span>
                <div className="relative">
                  <input
                    id="new-password"
                    name="new-password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    minLength={8}
                    required
                    autoComplete="new-password"
                    className="ui-focus-ring w-full rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 py-3 pr-14 text-[var(--ui-text-primary)] outline-none focus:border-[var(--ui-focus)]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((visible) => !visible)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="ui-focus-ring absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-2)]"
                  >
                    {showPassword ? <EyeOff className="h-5 w-5" aria-hidden /> : <Eye className="h-5 w-5" aria-hidden />}
                  </button>
                </div>
              </label>

              <label className="block" htmlFor="confirm-password">
                <span className="mb-1.5 block text-sm font-bold text-[var(--ui-text-secondary)]">Confirm password</span>
                <input
                  id="confirm-password"
                  name="confirm-password"
                  type={showPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  minLength={8}
                  required
                  autoComplete="new-password"
                  className="ui-focus-ring w-full rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 py-3 text-[var(--ui-text-primary)] outline-none focus:border-[var(--ui-focus)]"
                />
              </label>

              {error ? (
                <div role="alert" className="rounded-2xl border border-rose-300/20 bg-rose-400/10 p-3 text-sm text-rose-200">
                  {error}
                </div>
              ) : null}

              <button
                type="submit"
                disabled={isSaving}
                className="ui-focus-ring flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-5 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] disabled:opacity-50"
              >
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                {isSaving ? 'Updating…' : 'Update password'}
              </button>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
