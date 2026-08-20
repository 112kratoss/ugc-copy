'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { LogIn } from 'lucide-react';

import { Surface, Text } from '@/app/components/DesignSystem';
import { resolveSafeAdminRedirect } from '@/lib/admin-redirect';

const INPUT_CLASSES = 'ui-focus-ring w-full rounded-xl border border-[var(--ui-border-default)] '
  + 'bg-[var(--ui-surface-inset)] px-3.5 py-2.5 text-base text-[var(--ui-text-primary)] '
  + 'placeholder:text-[var(--ui-text-faint)]';

export function AdminLoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/admin/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(typeof payload?.error === 'string' ? payload.error : 'Sign in failed.');
        setPassword('');
        return;
      }

      router.replace(resolveSafeAdminRedirect(searchParams.get('next'), window.location.origin));
      router.refresh();
    } catch {
      setError('Sign in failed. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Surface variant="panel" padding="lg" className="w-full max-w-sm">
      <Text as="h1" variant="cardTitle">Admin sign in</Text>
      <Text variant="bodySm" className="mt-1.5">
        Restricted to Magicbooklet operators.
      </Text>

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="admin-username">
            <Text as="span" variant="label">Username</Text>
          </label>
          <input
            id="admin-username"
            name="username"
            type="text"
            autoComplete="username"
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className={INPUT_CLASSES}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="admin-password">
            <Text as="span" variant="label">Password</Text>
          </label>
          <input
            id="admin-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className={INPUT_CLASSES}
          />
        </div>

        {error ? (
          <p role="alert" className="text-sm font-semibold text-[var(--ui-accent-danger)]">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={submitting}
          className="ui-button ui-button-primary ui-focus-ring mt-1 w-full justify-center disabled:opacity-60"
        >
          <LogIn className="h-4 w-4" aria-hidden />
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </Surface>
  );
}
