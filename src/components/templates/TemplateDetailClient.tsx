'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleDollarSign,
  Flag,
  Image as ImageIcon,
  LayoutTemplate,
  Loader2,
  Pencil,
  ShieldCheck,
  Sparkles,
  UserRound,
  Video,
} from 'lucide-react';

import { useAuth } from '@/components/AuthProvider';
import {
  Button,
  Kicker,
  MediaFrame,
  Pill,
  StatusCallout,
  Surface,
  Text,
} from '@/components/DesignSystem';

import RecoverableMediaVideo from '@/components/RecoverableMediaVideo';
import { ModerationRequestError, reportTemplate, type TemplateReportReason } from '@/lib/moderation-client';
import { getTemplate } from './api';
import { getTemplateCreatorLabel, TemplatePageShell } from './TemplatePrimitives';
import type { MediaTemplate, TemplateStatus } from './types';

/**
 * The creator's own template that is not live. The server shows it to them
 * alone and refuses to start a run of it, so the page says which state it is
 * in and offers the canvas where "Use this template" stood: that button led to
 * "Could not start template — Template not found." and a Try again that
 * repeated it.
 */
const NOT_LIVE_STATUS: Record<Exclude<TemplateStatus, 'active'>, { label: string; title: string; body: string }> = {
  draft: {
    label: 'Draft',
    title: 'This template is a draft',
    body: 'Only you can see it. Test it and publish it from the workflow canvas before anyone can use it.',
  },
  // Its creator, a catalog release that dropped its model, or a moderation
  // take-down can disable it, so the line names no way back.
  disabled: {
    label: 'Disabled',
    title: 'This template is disabled',
    body: 'Only you can see it, and no one can start it.',
  },
};

/** A moderation take-down holds the template: unlike the creator's own Disable, there is no way back. */
const TAKEN_DOWN_STATUS = {
  label: 'Taken down',
  title: 'This template was taken down',
  body: "Moderation removed it from the catalog. Only you can see it, and it can't be published again.",
};

/** A post's own report reasons less the two about a recipe: a template has no price. */
const TEMPLATE_REPORT_REASONS: ReadonlyArray<{ value: TemplateReportReason; label: string }> = [
  { value: 'spam', label: 'Spam' },
  { value: 'stolen_content', label: 'Stolen content' },
  { value: 'unsafe_content', label: 'Unsafe content' },
  { value: 'other', label: 'Other' },
];

/**
 * Report template, laid out and sent as a post page's report row is
 * (`ReportPostButton`): a reason, optional context, then the moderation
 * queue. Signing in is asked for at Submit and comes back to this page.
 */
function ReportTemplateRow({
  templateId,
  slug,
  accessToken,
}: {
  templateId: string;
  slug: string;
  accessToken: string | null;
}) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  // No reason until the viewer picks one, as on a post.
  const [reason, setReason] = useState<TemplateReportReason | ''>('');
  const [details, setDetails] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const finish = (message: string) => {
    setFeedback(message);
    setIsOpen(false);
    setReason('');
    setDetails('');
  };

  const submitReport = async () => {
    if (!reason) return;
    if (!accessToken) {
      router.push(`/login?returnUrl=${encodeURIComponent(`/templates/${slug}`)}`);
      return;
    }
    setIsSubmitting(true);
    setFeedback(null);
    setError(null);
    try {
      await reportTemplate({ templateId, accessToken, reason, details });
      finish('Report submitted for review.');
    } catch (reportError) {
      if (reportError instanceof ModerationRequestError && reportError.status === 409) {
        // Their earlier report is still open: what they asked for is done.
        finish('You already reported this template. Our moderation team will review it.');
      } else {
        setError(reportError instanceof Error && reportError.message
          ? `Could not report this template. ${reportError.message}`
          : 'Could not report this template.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mt-5 border-t border-white/8 pt-4">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        aria-expanded={isOpen}
        className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-zinc-400 transition hover:text-white"
      >
        <Flag className="h-4 w-4" aria-hidden />
        Report template
      </button>

      {isOpen ? (
        <div className="mt-4 space-y-3">
          <select
            aria-label="Report reason"
            value={reason}
            onChange={(event) => setReason(event.target.value as TemplateReportReason)}
            className="w-full rounded-2xl border border-white/10 bg-zinc-950 px-4 py-3 text-sm text-white outline-none"
          >
            <option value="" disabled>Choose a reason</option>
            {TEMPLATE_REPORT_REASONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <textarea
            aria-label="Report details"
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="Optional context for the review team."
            className="w-full rounded-2xl border border-white/10 bg-zinc-950 px-4 py-3 text-sm text-white outline-none"
          />
          <button
            type="button"
            onClick={() => void submitReport()}
            disabled={isSubmitting || !reason}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08] disabled:opacity-60"
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Submit report
          </button>
        </div>
      ) : null}

      {feedback ? <p role="status" className="mt-3 text-sm text-emerald-200">{feedback}</p> : null}
      {error ? <p role="alert" className="mt-3 text-sm text-rose-200">{error}</p> : null}
    </div>
  );
}

export default function TemplateDetailClient({ slug }: { slug: string }) {
  const { session, isLoading: isAuthLoading } = useAuth();
  const [template, setTemplate] = useState<MediaTemplate | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Wait for the session: a signed-in visitor fetched once anonymously and
    // again with the token, throwing the first answer away.
    if (isAuthLoading) return;
    let active = true;
    setError(null);
    void getTemplate(slug, session?.access_token)
      .then((nextTemplate) => { if (active) setTemplate(nextTemplate); })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load this template.');
      })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [isAuthLoading, session?.access_token, slug]);

  if (isLoading) {
    return (
      <TemplatePageShell>
        <div className="flex min-h-[65vh] items-center justify-center" role="status">
          <Loader2 className="h-8 w-8 animate-spin text-rose-200" aria-hidden />
          <span className="sr-only">Loading template</span>
        </div>
      </TemplatePageShell>
    );
  }

  if (error || !template) {
    return (
      <TemplatePageShell>
        <Button href="/templates" variant="ghost" icon={ArrowLeft} iconPosition="start">Back to templates</Button>
        <StatusCallout tone="danger" title="Template unavailable" body={error || 'This template could not be found.'} className="mt-6" />
      </TemplatePageShell>
    );
  }

  const creatorLabel = getTemplateCreatorLabel(template);
  const creatorUsername = template.creator?.username ?? null;
  const isOwner = session?.user?.id === template.creatorUserId;
  const notLiveStatus = template.status === 'active'
    ? null
    : template.moderationDisabledAt
      ? TAKEN_DOWN_STATUS
      : NOT_LIVE_STATUS[template.status];
  const OutputIcon = template.outputKind === 'video' ? Video : ImageIcon;
  const creatorIdentity = (
    <>
      {template.creator?.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={template.creator.avatarUrl} alt="" className="h-10 w-10 rounded-full border border-white/10 object-cover" />
      ) : (
        <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-zinc-300">
          <UserRound className="h-4 w-4" aria-hidden />
        </div>
      )}
      <div>
        <div className="text-xs font-semibold text-zinc-500">Created by</div>
        <div className="text-sm font-bold text-white">{creatorLabel}</div>
      </div>
    </>
  );

  return (
    <TemplatePageShell>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Button href="/templates" variant="ghost" icon={ArrowLeft} iconPosition="start">Browse templates</Button>
        {/* A template that is not live offers the canvas where its start button stood instead. */}
        {isOwner && !notLiveStatus ? (
          <Button href={`/templates/${template.id}/edit`} variant="secondary" icon={Pencil}>Open in workflow canvas</Button>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)] lg:items-start">
        <Surface variant="panel" padding="none" className="overflow-hidden">
          <MediaFrame aspectRatio="16 / 10" className="relative rounded-none border-0 border-b border-white/8">
            {template.videoUrl ? (
              <RecoverableMediaVideo url={template.videoUrl} poster={template.thumbnailUrl} label={`${template.name} demo`}
                resolveRetry={async signal => {
                  const fresh = await getTemplate(template.id, session?.access_token, signal);
                  if (fresh.id !== template.id || !fresh.videoUrl) throw new Error('Demo unavailable');
                  return { url: fresh.videoUrl, poster: fresh.thumbnailUrl };
                }} />
            ) : template.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={template.thumbnailUrl} alt={`${template.name} preview`} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 bg-[radial-gradient(circle_at_70%_10%,rgba(244,63,94,0.2),transparent_40%),#09090b] text-rose-100">
                <OutputIcon className="h-12 w-12" aria-hidden />
                <span className="text-sm font-bold">Preview coming soon</span>
              </div>
            )}
          </MediaFrame>

          <div className="p-6 sm:p-8">
            <div className="flex flex-wrap items-center gap-2">
              {notLiveStatus ? <Pill accent="amber">{notLiveStatus.label}</Pill> : null}
              <Pill accent={template.outputKind} icon={Sparkles}>{template.category || 'Creative'}</Pill>
              <Pill accent="neutral" icon={OutputIcon}>{template.outputKind} output</Pill>
              <Pill accent="neutral">{template.inputSlots.filter((slot) => slot.required).length} required input{template.inputSlots.filter((slot) => slot.required).length === 1 ? '' : 's'}</Pill>
            </div>
            <Text as="h1" variant="pageTitle" className="mt-5">{template.name}</Text>
            <Text variant="body" className="mt-4 max-w-3xl">
              {template.description || `Add the requested media and follow the guided steps to create a new ${template.outputKind}.`}
            </Text>

            <div className="mt-6 flex items-center gap-3 border-t border-white/8 pt-5">
              {/* The creator's page is where the viewer can see their other work, and report or block them. */}
              {creatorUsername ? (
                <Link
                  href={`/creators/${encodeURIComponent(creatorUsername)}`}
                  className="ui-focus-ring flex min-w-0 items-center gap-3 rounded-2xl transition-opacity hover:opacity-90"
                >
                  {creatorIdentity}
                </Link>
              ) : (
                <div className="flex min-w-0 items-center gap-3">{creatorIdentity}</div>
              )}
              <div className="ml-auto text-sm font-semibold text-zinc-400">
                {template.useCount.toLocaleString()} {template.useCount === 1 ? 'use' : 'uses'}
              </div>
            </div>
            {/* The server refuses a creator's report of their own template. */}
            {isOwner ? null : (
              <ReportTemplateRow
                templateId={template.id}
                slug={template.slug || template.id}
                accessToken={session?.access_token ?? null}
              />
            )}
          </div>
        </Surface>

        <div className="space-y-5 lg:sticky lg:top-24">
          <Surface variant="panel" padding="lg">
            <Kicker icon={LayoutTemplate}>What you add</Kicker>
            {template.inputSlots.length ? (
              <div className="mt-5 space-y-3">
                {template.inputSlots.map((slot, index) => {
                  const SlotIcon = slot.kind === 'video' ? Video : ImageIcon;
                  return (
                    <div key={slot.key} className="flex gap-3 rounded-2xl border border-white/8 bg-black/20 p-4">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-sky-300/20 bg-sky-400/10 text-sky-200">
                        <SlotIcon className="h-4 w-4" aria-hidden />
                      </div>
                      <div>
                        <Text as="h2" variant="label">{index + 1}. {slot.label}</Text>
                        <Text variant="bodySm" className="mt-1">{slot.description || `Choose a clear ${slot.kind}.`}</Text>
                        <Text variant="caption" className="mt-1 capitalize">{slot.kind} · {slot.required ? 'Required' : 'Optional'}</Text>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Text variant="bodySm" className="mt-4">No uploads are required for this workflow.</Text>
            )}

            <div className="mt-5 flex items-center justify-between rounded-2xl border border-amber-300/15 bg-amber-400/[0.06] p-4">
              <div>
                <Text as="span" variant="label">Estimated total</Text>
                <Text variant="caption" className="mt-1">Retries show their own cost before you confirm.</Text>
              </div>
              <span className="inline-flex items-center gap-1.5 text-sm font-bold text-amber-100">
                <CircleDollarSign className="h-4 w-4" aria-hidden />
                {template.estimatedTotalCredits === null ? 'Shown at start' : `${template.estimatedTotalCredits} credits`}
              </span>
            </div>

            {notLiveStatus ? (
              <>
                <StatusCallout
                  tone="warning"
                  title={notLiveStatus.title}
                  body={isOwner ? notLiveStatus.body : 'It cannot be started right now.'}
                  className="mt-5"
                />
                {isOwner ? (
                  <Button href={`/templates/${template.id}/edit`} variant="secondary" icon={Pencil} className="mt-5 w-full">
                    Open in workflow canvas
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                <Button href={`/templates/${template.slug || template.id}/create`} variant="accent" accent={template.outputKind} icon={ArrowRight} className="mt-5 w-full">
                  Use this template
                </Button>
                <Text variant="caption" className="mt-3 text-center">You stay in control at every approval step.</Text>
              </>
            )}
          </Surface>

          <Surface variant="soft" padding="lg">
            <Kicker icon={ShieldCheck}>How it works</Kicker>
            <div className="mt-4 space-y-4">
              {[
                'Add only the media listed in the public manifest.',
                'Follow live generation and approval steps.',
                `Download or share the finished ${template.outputKind}.`,
              ].map((label) => (
                <div key={label} className="flex gap-3 text-sm text-zinc-300">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden />
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </Surface>
        </div>
      </div>
    </TemplatePageShell>
  );
}
