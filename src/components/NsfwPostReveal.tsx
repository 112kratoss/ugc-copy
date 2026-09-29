'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { EyeOff } from 'lucide-react';
import ShowcaseMediaCarousel from '@/app/showcase/ShowcaseMediaCarousel';
import type { PublicPostDetail } from '@/lib/public-posts';

export default function NsfwPostReveal({ postId }: { postId: string }) {
  const [detail, setDetail] = useState<PublicPostDetail | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    fetch('/api/content-preferences', { cache: 'no-store' }).then((r) => r.json()).then((body) => {
      if (active) setEnabled(body.showMature === true);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  // Reveals are local to this mount, never written to shared/persisted feeds.
  useEffect(() => {
    if (!detail) return;
    const timeout = setTimeout(() => setDetail(null), 10 * 60 * 1000);
    return () => clearTimeout(timeout);
  }, [detail]);
  useEffect(() => {
    const hide = () => { if (document.hidden) setDetail(null); };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, []);
  async function reveal() {
    setBusy(true); setError(null);
    try {
      if (!enabled) {
        const preferences = await fetch('/api/content-preferences', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ showMature: true, confirmAdult: confirmed }),
        });
        const result = await preferences.json();
        if (!preferences.ok) throw new Error(result.error || 'Could not enable mature content.');
        setEnabled(true);
      }
      const response = await fetch(`/api/posts/${postId}/reveal`, { method: 'POST', cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not reveal this post.');
      if (!document.hidden) setDetail(result.detail);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Please retry.'); }
    finally { setBusy(false); }
  }
  async function disable() {
    setDetail(null); setBusy(true); setError(null);
    try {
      const response = await fetch('/api/content-preferences', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ showMature: false }) });
      if (!response.ok) throw new Error('Could not turn off mature content. Please retry.');
      setEnabled(false); setConfirmed(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Please retry.'); }
    finally { setBusy(false); }
  }
  return <section className="mx-auto max-w-3xl rounded-3xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-1)] p-6 text-center">
    <span className="inline-flex items-center gap-2 rounded-full border border-[var(--ui-border-default)] px-3 py-1 text-sm font-semibold"><EyeOff size={16} aria-hidden />NSFW · 18+</span>
    {detail ? <div className="mt-5 space-y-5 text-left">
      <h1 className="text-2xl font-semibold">{detail.title}</h1>
      {detail.body ? <p className="whitespace-pre-wrap">{detail.body}</p> : null}
      {detail.mediaItems.length ? <ShowcaseMediaCarousel mediaItems={detail.mediaItems} title={detail.title} /> : null}
      <button type="button" className="min-h-11 underline" onClick={() => setDetail(null)}>Hide this post</button>
    </div> : <>
      <h1 className="mt-5 text-2xl font-semibold">Mature content</h1>
      <p className="mt-3 text-sm text-[var(--ui-text-secondary)]">The creator marked this post NSFW. Its media and text stay hidden until you choose to reveal them.</p>
      {!enabled ? <label className="mt-5 flex min-h-11 cursor-pointer items-center justify-center gap-3 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I am 18 or older and want to view mature content.</label> : null}
      <button type="button" disabled={busy || (!enabled && !confirmed)} onClick={() => void reveal()} className="mt-5 min-h-11 rounded-xl bg-[var(--ui-text-primary)] px-5 py-3 text-sm font-semibold text-[var(--ui-surface-1)] disabled:opacity-50">{busy ? 'Loading…' : 'Reveal post'}</button>
      {!enabled ? <p className="mt-3 text-sm"><Link href={`/login?returnUrl=${encodeURIComponent(`/showcase/${postId}`)}`} className="underline">Sign in</Link> to manage your mature-content preference.</p> : null}
    </>}
    {error ? <p role="alert" className="mt-4 text-sm">{error}</p> : null}
    {enabled ? <button type="button" onClick={() => void disable()} disabled={busy} className="mt-5 min-h-11 text-sm underline">Turn off mature content</button> : null}
  </section>;
}
