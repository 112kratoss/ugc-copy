'use client';

import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  LockKeyhole,
  RotateCcw,
  WandSparkles,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import { getSafeAuthNextPath } from '@/lib/auth-onboarding';
import {
  getPasswordRequirements,
  getPasswordValidationMessage,
} from '@/lib/password-policy';
import { supabase } from '@/lib/supabase';

type RecoveryState = 'checking' | 'ready' | 'missing';
type ResetErrorField = 'password' | 'confirmPassword' | null;

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <div className="ui-page flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[var(--ui-primary)]" aria-label="Loading password recovery" />
      </div>
    }>
      <ResetPasswordContent />
    </Suspense>
  );
}

function ResetPasswordContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = getSafeAuthNextPath(searchParams.get('next'));
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [recoveryState, setRecoveryState] = useState<RecoveryState>('checking');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<ResetErrorField>(null);
  const [saved, setSaved] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);
  const passwordRequirements = getPasswordRequirements(password);
  const recoveryHref = `/login?returnUrl=${encodeURIComponent(next)}&recovery=1`;

  useEffect(() => {
    let isActive = true;

    supabase.auth.getSession()
      .then(({ data, error: sessionError }) => {
        if (!isActive) return;
        setRecoveryState(sessionError || !data.session ? 'missing' : 'ready');
      })
      .catch(() => {
        if (isActive) setRecoveryState('missing');
      });

    return () => {
      isActive = false;
    };
  }, []);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setErrorField(null);

    const passwordError = getPasswordValidationMessage(password);
    if (passwordError) {
      setError(passwordError);
      setErrorField('password');
      passwordRef.current?.focus();
      return;
    }

    if (password !== confirmPassword) {
      setError('The passwords do not match. Re-enter the same password.');
      setErrorField('confirmPassword');
      confirmPasswordRef.current?.focus();
      return;
    }

    setIsSaving(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError(updateError.message);
        passwordRef.current?.focus();
        return;
      }

      setSaved(true);
      window.setTimeout(() => {
        router.replace(next);
        router.refresh();
      }, 900);
    } catch (updateError) {
      setError(updateError instanceof Error
        ? updateError.message
        : 'Could not update your password. Check your connection and try again.');
      passwordRef.current?.focus();
    } finally {
      setIsSaving(false);
    }
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
        <main className="w-full max-w-md rounded-[28px] border border-[var(--ui-border-default)] bg-[var(--ui-surface-1)] p-6 shadow-[var(--ui-shadow-panel)] sm:p-8">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--ui-primary-soft)] text-[var(--ui-primary)]">
            <LockKeyhole className="h-5 w-5" aria-hidden />
          </span>
          <h1 className="mt-5 text-3xl font-extrabold tracking-tight text-[var(--ui-text-primary)]">
            Choose a new password
          </h1>
          <p className="mt-2 text-sm leading-6 text-[var(--ui-text-muted)]">
            Use a strong, unique password. When it is saved, we’ll continue where you left off.
          </p>

          {recoveryState === 'checking' ? (
            <div role="status" className="mt-6 flex items-center gap-3 rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] p-4 text-sm text-[var(--ui-text-secondary)]">
              <Loader2 className="h-5 w-5 animate-spin text-[var(--ui-primary)]" aria-hidden />
              Checking your recovery link…
            </div>
          ) : recoveryState === 'missing' ? (
            <div className="mt-6">
              <div role="alert" className="flex items-start gap-3 rounded-2xl border border-rose-300/20 bg-rose-400/10 p-4 text-sm text-rose-100">
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-200" aria-hidden />
                <p>This recovery link is missing, expired, or already used. Request a fresh link to continue securely.</p>
              </div>
              <Link
                href={recoveryHref}
                className="ui-focus-ring mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-5 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)]"
              >
                <RotateCcw className="h-4 w-4" aria-hidden />
                Request a new reset link
              </Link>
            </div>
          ) : saved ? (
            <div role="status" className="mt-6 flex items-start gap-3 rounded-2xl border border-emerald-300/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" aria-hidden />
              Password updated. Continuing…
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-bold text-[var(--ui-text-secondary)]" htmlFor="new-password">
                  New password
                </label>
                <div className="relative">
                  <input
                    id="new-password"
                    ref={passwordRef}
                    name="new-password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      if (errorField === 'password') {
                        setError(null);
                        setErrorField(null);
                      }
                    }}
                    minLength={8}
                    required
                    autoComplete="new-password"
                    aria-invalid={errorField === 'password'}
                    aria-describedby={`reset-password-requirements${errorField === 'password' ? ' reset-password-error' : ''}`}
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
                <div id="reset-password-requirements" className="mt-3 rounded-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-3">
                  <p className="text-xs font-bold text-[var(--ui-text-secondary)]">Your password needs:</p>
                  <ul className="mt-2 grid gap-1.5 text-xs sm:grid-cols-2">
                    {passwordRequirements.map((requirement) => (
                      <li
                        key={requirement.id}
                        className={`flex items-center gap-2 ${requirement.isMet ? 'text-emerald-300' : 'text-[var(--ui-text-faint)]'}`}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        {requirement.label}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <label className="block" htmlFor="confirm-password">
                <span className="mb-1.5 block text-sm font-bold text-[var(--ui-text-secondary)]">Confirm password</span>
                <input
                  id="confirm-password"
                  ref={confirmPasswordRef}
                  name="confirm-password"
                  type={showPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(event) => {
                    setConfirmPassword(event.target.value);
                    if (errorField === 'confirmPassword') {
                      setError(null);
                      setErrorField(null);
                    }
                  }}
                  minLength={8}
                  required
                  autoComplete="new-password"
                  aria-invalid={errorField === 'confirmPassword'}
                  aria-describedby={errorField === 'confirmPassword' ? 'reset-password-error' : undefined}
                  className="ui-focus-ring w-full rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 py-3 text-[var(--ui-text-primary)] outline-none focus:border-[var(--ui-focus)]"
                />
              </label>

              {error ? (
                <div id="reset-password-error" role="alert" className="rounded-2xl border border-rose-300/20 bg-rose-400/10 p-3 text-sm text-rose-200">
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
        </main>
      </div>
    </div>
  );
}
