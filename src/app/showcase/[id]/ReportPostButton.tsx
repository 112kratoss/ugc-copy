'use client';

import { useState } from 'react';
import { Flag, Loader2 } from 'lucide-react';

import { getCurrentInternalPath } from '@/lib/share';

const REPORT_REASONS = [
  { value: 'spam', label: 'Spam' },
  { value: 'stolen_content', label: 'Stolen content' },
  { value: 'misleading_unlock', label: 'Misleading recipe' },
  { value: 'unsafe_content', label: 'Unsafe content' },
  { value: 'payment_issue', label: 'Payment issue' },
  { value: 'other', label: 'Other' },
];

interface ReportPostButtonProps {
  postId: string;
  bundleId?: string | null;
  accessToken?: string | null;
}

export default function ReportPostButton({ postId, bundleId = null, accessToken = null }: ReportPostButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [reason, setReason] = useState('misleading_unlock');
  const [details, setDetails] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submitReport = async () => {
    if (!accessToken) {
      window.location.href = `/login?returnUrl=${encodeURIComponent(getCurrentInternalPath(`/showcase/${postId}`))}`;
      return;
    }

    try {
      setIsSubmitting(true);
      setFeedback(null);
      setError(null);

      const response = await fetch(`/api/posts/${postId}/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          reason,
          details,
          bundleId,
        }),
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to submit report.');
      }

      setFeedback('Report submitted for review.');
      setIsOpen(false);
      setDetails('');
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : 'Failed to submit report.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="rounded-[24px] border border-white/8 bg-black/30 p-5">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        className="inline-flex items-center gap-2 text-sm font-medium text-zinc-400 transition hover:text-white"
      >
        <Flag className="h-4 w-4" />
        Report post or recipe
      </button>

      {isOpen ? (
        <div className="mt-4 space-y-3">
          <select
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="w-full rounded-2xl border border-white/10 bg-zinc-950 px-4 py-3 text-sm text-white outline-none"
          >
            {REPORT_REASONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <textarea
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            rows={3}
            placeholder="Optional context for the review team."
            className="w-full rounded-2xl border border-white/10 bg-zinc-950 px-4 py-3 text-sm text-white outline-none"
          />
          <button
            type="button"
            onClick={() => void submitReport()}
            disabled={isSubmitting}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08] disabled:opacity-60"
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Submit report
          </button>
        </div>
      ) : null}

      {feedback ? <p className="mt-3 text-sm text-emerald-200">{feedback}</p> : null}
      {error ? <p className="mt-3 text-sm text-rose-200">{error}</p> : null}
    </div>
  );
}
