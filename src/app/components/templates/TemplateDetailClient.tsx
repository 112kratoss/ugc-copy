'use client';

import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleDollarSign,
  Image as ImageIcon,
  LayoutTemplate,
  Loader2,
  Pencil,
  ShieldCheck,
  Sparkles,
  UserRound,
  Video,
} from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import {
  Button,
  Kicker,
  MediaFrame,
  Pill,
  StatusCallout,
  Surface,
  Text,
} from '@/app/components/DesignSystem';

import { getTemplate } from './api';
import { getTemplateCreatorLabel, TemplatePageShell } from './TemplatePrimitives';
import type { MediaTemplate } from './types';

export default function TemplateDetailClient({ slug }: { slug: string }) {
  const { session, isLoading: isAuthLoading } = useAuth();
  const [template, setTemplate] = useState<MediaTemplate | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
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
  const isOwner = session?.user?.id === template.creatorUserId;
  const OutputIcon = template.outputKind === 'video' ? Video : ImageIcon;

  return (
    <TemplatePageShell>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Button href="/templates" variant="ghost" icon={ArrowLeft} iconPosition="start">Browse templates</Button>
        {isOwner ? (
          <Button href={`/templates/${template.id}/edit`} variant="secondary" icon={Pencil}>Open in workflow canvas</Button>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)] lg:items-start">
        <Surface variant="panel" padding="none" className="overflow-hidden">
          <MediaFrame aspectRatio="16 / 10" className="relative rounded-none border-0 border-b border-white/8">
            {template.videoUrl ? (
              <video src={template.videoUrl} poster={template.thumbnailUrl || undefined} controls playsInline preload="metadata" className="h-full w-full bg-black object-contain">
                Your browser does not support video playback.
              </video>
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
              <Pill accent={template.outputKind} icon={Sparkles}>{template.category || 'Creative'}</Pill>
              <Pill accent="neutral" icon={OutputIcon}>{template.outputKind} output</Pill>
              <Pill accent="neutral">{template.inputSlots.filter((slot) => slot.required).length} required input{template.inputSlots.filter((slot) => slot.required).length === 1 ? '' : 's'}</Pill>
            </div>
            <Text as="h1" variant="pageTitle" className="mt-5">{template.name}</Text>
            <Text variant="body" className="mt-4 max-w-3xl">
              {template.description || `Add the requested media and follow the guided steps to create a new ${template.outputKind}.`}
            </Text>

            <div className="mt-6 flex items-center gap-3 border-t border-white/8 pt-5">
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
              <div className="ml-auto text-sm font-semibold text-zinc-400">
                {template.useCount.toLocaleString()} {template.useCount === 1 ? 'use' : 'uses'}
              </div>
            </div>
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

            <Button href={`/templates/${template.slug || template.id}/create`} variant="accent" accent={template.outputKind} icon={ArrowRight} className="mt-5 w-full">
              Use this template
            </Button>
            <Text variant="caption" className="mt-3 text-center">You stay in control at every approval step.</Text>
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
