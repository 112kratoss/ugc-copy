'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, LayoutTemplate, Plus, Search, Sparkles } from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import {
  Button,
  Kicker,
  StatusCallout,
  Surface,
  Text,
} from '@/app/components/DesignSystem';

import { listTemplates } from './api';
import { TemplateCard, TemplatePageShell } from './TemplatePrimitives';
import type { MediaTemplate } from './types';

type InputFilter = 'all' | 'image' | 'video';

function CatalogSkeleton() {
  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-label="Loading templates">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="ui-card overflow-hidden rounded-3xl">
          <div className="aspect-[4/5] animate-pulse bg-white/[0.05]" />
          <div className="space-y-3 p-5">
            <div className="h-3 w-24 animate-pulse rounded-full bg-white/[0.07]" />
            <div className="h-6 w-3/4 animate-pulse rounded-full bg-white/[0.08]" />
            <div className="h-4 w-full animate-pulse rounded-full bg-white/[0.05]" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function TemplateCatalogClient({
  mode = 'public',
  initialTemplates,
}: {
  mode?: 'public' | 'owner';
  initialTemplates?: MediaTemplate[];
}) {
  const { session, isLoading: isAuthLoading } = useAuth();
  const hasInitialPublicTemplates = mode === 'public' && initialTemplates !== undefined;
  const [templates, setTemplates] = useState<MediaTemplate[]>(
    hasInitialPublicTemplates ? initialTemplates : []
  );
  const [isLoading, setIsLoading] = useState(!hasInitialPublicTemplates);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [inputFilter, setInputFilter] = useState<InputFilter>('all');

  useEffect(() => {
    if (hasInitialPublicTemplates) return;
    if (mode === 'owner' && isAuthLoading) return;

    let active = true;
    void listTemplates({ token: session?.access_token, mine: mode === 'owner' })
      .then((nextTemplates) => {
        if (active) setTemplates(nextTemplates);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load templates.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [hasInitialPublicTemplates, isAuthLoading, mode, session?.access_token]);

  const filteredTemplates = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return templates.filter((template) => {
      const matchesQuery = !normalizedQuery || [
        template.name,
        template.description,
        template.category,
        template.creator?.displayName,
        template.creator?.username,
      ].some((value) => value?.toLowerCase().includes(normalizedQuery));
      const matchesInputs = inputFilter === 'all'
        || template.inputSlots.some((slot) => slot.kind === inputFilter);
      return matchesQuery && matchesInputs;
    });
  }, [inputFilter, query, templates]);

  const isOwnerMode = mode === 'owner';

  return (
    <TemplatePageShell>
      <Surface as="section" variant="panel" padding="none" className="ui-enter overflow-hidden p-6 sm:p-8">
        <div className="relative z-10 flex flex-col gap-7 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <Kicker icon={isOwnerMode ? LayoutTemplate : Sparkles}>
              {isOwnerMode ? 'Creator studio' : 'Community formats'}
            </Kicker>
            <Text as="h1" variant="pageTitle" className="mt-4">
              {isOwnerMode ? 'Your workflow templates' : 'Make the format your own'}
            </Text>
            <Text variant="body" className="mt-4 max-w-2xl">
              {isOwnerMode
                ? 'Build and publish reusable image or video workflows from the shared canvas.'
                : 'Choose a proven workflow, add its required media, and review each step before your final result.'}
            </Text>
          </div>
          <div className="flex flex-wrap gap-3">
            {isOwnerMode ? (
              <Button href="/templates" variant="secondary" icon={ArrowRight}>Browse templates</Button>
            ) : session?.user ? (
              <Button href="/templates/mine" variant="secondary" icon={LayoutTemplate}>My templates</Button>
            ) : null}
            <Button href="/templates/new" variant="primary" icon={Plus}>Create template</Button>
          </div>
        </div>
        <div className="pointer-events-none absolute right-[-7rem] top-[-8rem] h-72 w-72 rounded-full bg-rose-500/10 blur-[90px]" />
      </Surface>

      <div className="mt-8 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <label className="relative block w-full lg:max-w-md">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden />
          <span className="sr-only">Search templates</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={isOwnerMode ? 'Search your templates' : 'Search transformations and formats'}
            className="ui-focus-ring min-h-12 w-full rounded-full border border-white/10 bg-white/[0.04] py-3 pl-11 pr-4 text-sm text-white placeholder:text-zinc-500 focus:border-white/25"
          />
        </label>
        <div className="flex gap-2 overflow-x-auto pb-1 hide-scrollbar" aria-label="Filter by required media">
          {([
            ['all', 'All formats'],
            ['image', 'Uses images'],
            ['video', 'Uses video'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setInputFilter(value)}
              aria-pressed={inputFilter === value}
              className={`ui-focus-ring min-h-11 shrink-0 rounded-full border px-4 text-sm font-bold transition ${
                inputFilter === value
                  ? 'border-rose-300/25 bg-rose-400/12 text-rose-100'
                  : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.07]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-7">
        {isLoading ? <CatalogSkeleton /> : null}
        {!isLoading && error ? (
          <StatusCallout tone="danger" title="Templates are unavailable" body={error} />
        ) : null}
        {!isLoading && !error && filteredTemplates.length > 0 ? (
          <div className="ui-stagger grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filteredTemplates.map((template) => (
              <TemplateCard key={template.id} template={template} mode={mode} />
            ))}
          </div>
        ) : null}
        {!isLoading && !error && filteredTemplates.length === 0 ? (
          <Surface variant="soft" padding="lg" className="py-14 text-center">
            <LayoutTemplate className="mx-auto h-10 w-10 text-zinc-500" aria-hidden />
            <Text as="h2" variant="cardTitle" className="mt-4">
              {templates.length === 0
                ? isOwnerMode ? 'Create your first template' : 'No templates are live yet'
                : 'No matching templates'}
            </Text>
            <Text variant="bodySm" className="mx-auto mt-2 max-w-md">
              {templates.length === 0 && isOwnerMode
                ? 'Open the workflow canvas, define the public inputs and output, test it, then publish.'
                : 'Try another search or media filter.'}
            </Text>
            {isOwnerMode && templates.length === 0 ? (
              <Button href="/templates/new" variant="primary" icon={Plus} className="mt-6">
                Create template
              </Button>
            ) : null}
          </Surface>
        ) : null}
      </div>
    </TemplatePageShell>
  );
}
