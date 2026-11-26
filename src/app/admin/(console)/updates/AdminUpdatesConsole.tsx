'use client';

import Link from 'next/link';
import clsx from 'clsx';
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ExternalLink,
  Eye,
  EyeOff,
  Megaphone,
  MessageSquare,
  MessageSquareOff,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  Send,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { Button, StatusCallout, Surface, Text } from '@/components/DesignSystem';
import type { ConfirmationRequest } from '@/components/feedback-state';
import { useConfirmation } from '@/components/useConfirmation';
import type {
  AdminRoadmapItem,
  AdminSupportHub,
  AdminSupportUpdate,
  SupportUpdateAnnounce,
} from '@/lib/admin-support-hub-service';

import {
  SUPPORT_HUB_WORDS,
  SUPPORT_ROADMAP_SUMMARY_MAX_LENGTH,
  SUPPORT_ROADMAP_TITLE_MAX_LENGTH,
  SUPPORT_UPDATE_BODY_MAX_LENGTH,
  SUPPORT_UPDATE_KINDS,
  SUPPORT_UPDATE_TITLE_MAX_LENGTH,
  supportRoadmapShippedAlertWords,
  supportRoadmapVoteWords,
  supportUpdatePreview,
  type SupportRoadmapStatus,
  type SupportUpdateKind,
} from '../../../../../ugc-mobile/lib/support-hub-policy/support-hub-policy';
import { EmptyState, PageHeader, StatusBadge, adminPostHref, formatTimestamp } from '../AdminUi';

/**
 * The console's side of Help & Support's Updates and Roadmap (`/admin/updates`;
 * plan: docs/plans/help-support-updates-roadmap-plan-2026-11-26.md).
 *
 * Everything is read from `GET /api/admin/support-hub` once the page's script
 * runs, and again after every action, so the server's HTML holds no field
 * (nothing typed before the script ran can be lost on hydration). Each action
 * is a `POST` to the same route; a refusal is said where it was asked, in the
 * server's words.
 */

const SUPPORT_HUB_ENDPOINT = '/api/admin/support-hub';

const SESSION_ENDED = 'Your console session has ended. Sign in again, then press Try again.';
const ACTION_FAILED = 'That did not go through. Try again.';
const ACTION_OFFLINE = 'That did not go through. Check your connection, then try again.';

const INPUT_CLASSES = 'ui-focus-ring w-full rounded-xl border border-[var(--ui-border-default)] '
  + 'bg-[var(--ui-surface-inset)] px-3 py-2.5 text-sm text-[var(--ui-text-primary)] '
  + 'placeholder:text-[var(--ui-text-faint)]';

const CHOICE_CLASSES = 'h-4 w-4 accent-[var(--ui-primary)]';

const ROW_CLASSES = 'rounded-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] px-4 py-3';

const ANNOUNCE_CHOICES: ReadonlyArray<{ value: SupportUpdateAnnounce; label: string; hint: string }> = [
  { value: 'quiet', label: 'Quiet', hint: 'Only the dot on Updates.' },
  { value: 'alert', label: 'Alert', hint: 'An alert in the app to every account.' },
  { value: 'alert_push', label: 'Alert + push', hint: 'The alert, and a notification on every phone with the app.' },
];

/** What a quietly published update can still be announced with, once. */
const LATER_ANNOUNCE_CHOICES = ANNOUNCE_CHOICES.filter((choice) => choice.value !== 'quiet');

const PUBLISHED_WORDS: Record<SupportUpdateAnnounce, string> = {
  quiet: 'Published. It shows under Updates now.',
  alert: 'Published. The alert is going out to every account.',
  alert_push: 'Published. The alert and the push are going out to every account.',
};

/** Asked before a push to every phone, for a new update or one published quietly. */
function pushQuestion(title: string, confirmLabel: string): ConfirmationRequest {
  return {
    title: 'Send a push to every phone?',
    message: `“${title.trim()}” goes to every account as an alert in the app, and as a notification on every phone with the app. A push cannot be called back.`,
    confirmLabel,
    tone: 'danger',
  };
}

/** The statuses an item can be given by hand: shipping has its own action, which names the update. */
type OpenStatus = Exclude<SupportRoadmapStatus, 'shipped'>;
const OPEN_STATUSES: readonly OpenStatus[] = ['exploring', 'building'];

const STATUS_WORDS: Record<SupportRoadmapStatus, string> = {
  exploring: SUPPORT_HUB_WORDS.roadmapGroups.exploring,
  building: SUPPORT_HUB_WORDS.roadmapGroups.building,
  shipped: 'Shipped',
};

function countWords(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

/** How far an update's announcement got: nothing for a quiet one, "sent to N" while it runs and once done. */
function supportUpdateBroadcastWords(broadcast: AdminSupportUpdate['broadcast']): string {
  if (!broadcast) return 'Quiet: no alert went out';
  const how = broadcast.push ? 'Alert + push' : 'Alert';
  const sent = countWords(broadcast.sentCount, 'account', 'accounts');
  return broadcast.finished ? `${how} sent to ${sent}, finished` : `${how} sent to ${sent} so far, not finished`;
}

// Reading and acting ----------------------------------------------------------

type HubRead = 'loading' | 'ready' | 'failed' | 'signed-out';
type ActionBody = { action: string } & Record<string, unknown>;
type ActionResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };
type Act = (body: ActionBody) => Promise<ActionResult>;

function readHub(value: unknown): AdminSupportHub | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.officialAccountReady !== 'boolean' || !Array.isArray(record.updates) || !Array.isArray(record.roadmap)) {
    return null;
  }
  return {
    officialAccountReady: record.officialAccountReady,
    updates: record.updates as AdminSupportUpdate[],
    roadmap: record.roadmap as AdminRoadmapItem[],
  };
}

/** One read of everything the page draws, or why there is none. */
async function readSupportHub(): Promise<AdminSupportHub | 'failed' | 'signed-out'> {
  try {
    const response = await fetch(SUPPORT_HUB_ENDPOINT, { cache: 'no-store' });
    const data: unknown = await response.json().catch(() => null);
    if (response.status === 401) return 'signed-out';
    return (response.ok && readHub(data)) || 'failed';
  } catch {
    return 'failed';
  }
}

function useSupportHub() {
  const [hub, setHub] = useState<AdminSupportHub | null>(null);
  const [read, setRead] = useState<HubRead>('loading');
  const latestRead = useRef(0);

  const reload = useCallback(() => {
    const attempt = latestRead.current + 1;
    latestRead.current = attempt;
    return readSupportHub().then((next) => {
      // A read that comes back after a later one was asked changes nothing.
      if (attempt !== latestRead.current) return;
      if (typeof next === 'string') {
        setRead(next);
      } else {
        setHub(next);
        setRead('ready');
      }
    });
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = useCallback<Act>(async (body) => {
    let result: ActionResult;
    try {
      const response = await fetch(SUPPORT_HUB_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (response.status === 401) {
        setRead('signed-out');
        return { ok: false, error: SESSION_ENDED };
      }
      result = response.ok
        ? { ok: true, data: data ?? {} }
        : { ok: false, error: typeof data?.error === 'string' ? data.error : ACTION_FAILED };
    } catch {
      result = { ok: false, error: ACTION_OFFLINE };
    }
    // Whatever the answer, the page then shows what the server holds.
    await reload();
    return result;
  }, [reload]);

  return { hub, read, reload, act };
}

/** One control's action: which of its presses is under way, and what the last one answered. */
function useAction(act: Act) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (key: string, body: ActionBody): Promise<ActionResult> => {
    setPending(key);
    setError(null);
    setNotice(null);
    const result = await act(body);
    setPending(null);
    if (!result.ok) setError(result.error);
    return result;
  };

  const clear = () => {
    setError(null);
    setNotice(null);
  };

  return { pending, error, notice, setNotice, clear, run };
}

/**
 * An inline form takes the place of the button that opened it, so the focus
 * goes into its first field (`autoFocus`) and, once it closes, back to that
 * button, found by the id given here, where it is still drawn.
 */
function useFocusReturn(open: boolean) {
  const returnTo = useRef<string | null>(null);
  useEffect(() => {
    if (open || returnTo.current === null) return;
    document.getElementById(returnTo.current)?.focus();
    returnTo.current = null;
  }, [open]);
  return returnTo;
}

function ActionFeedback({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <>
      {error ? <p role="alert" className="mt-2 text-sm font-semibold text-[var(--ui-accent-danger)]">{error}</p> : null}
      {notice ? <p role="status" className="mt-2 text-sm font-semibold text-[#5ee9a4]">{notice}</p> : null}
    </>
  );
}

/** A labelled field, with what it holds against its limit where it has one. */
function Field({
  id,
  label,
  length,
  max,
  children,
}: {
  id: string;
  label: string;
  length?: number;
  max?: number;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id}>
          <Text as="span" variant="label">{label}</Text>
        </label>
        {max !== undefined ? (
          <Text as="span" variant="caption" id={`${id}-count`} className="tabular-nums">
            {`${(length ?? 0).toLocaleString('en-US')}/${max.toLocaleString('en-US')}`}
          </Text>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/** "Who hears about it": each choice named by its label and described by its hint. */
function AnnounceChoices({
  name,
  choices,
  value,
  onChange,
  autoFocus = false,
}: {
  name: string;
  choices: typeof ANNOUNCE_CHOICES;
  value: SupportUpdateAnnounce;
  onChange: (value: SupportUpdateAnnounce) => void;
  autoFocus?: boolean;
}) {
  return (
    <fieldset>
      <legend>
        <Text as="span" variant="label">Who hears about it</Text>
      </legend>
      <div className="mt-2 flex flex-col gap-3">
        {choices.map((choice) => (
          <label key={choice.value} className="flex cursor-pointer items-start gap-3">
            <input
              type="radio"
              name={name}
              value={choice.value}
              checked={value === choice.value}
              onChange={() => onChange(choice.value)}
              autoFocus={autoFocus && value === choice.value}
              aria-labelledby={`${name}-${choice.value}`}
              aria-describedby={`${name}-${choice.value}-hint`}
              className={clsx(CHOICE_CLASSES, 'mt-0.5')}
            />
            <span>
              <span id={`${name}-${choice.value}`} className="block text-sm font-semibold text-[var(--ui-text-primary)]">
                {choice.label}
              </span>
              <span id={`${name}-${choice.value}-hint`} className="block text-xs leading-5 text-[var(--ui-text-muted)]">
                {choice.hint}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// The page --------------------------------------------------------------------

export function AdminUpdatesConsole() {
  const { hub, read, reload, act } = useSupportHub();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await reload();
    } finally {
      setRefreshing(false);
    }
  };

  const tryAgain = (
    <Button variant="secondary" icon={RefreshCw} iconPosition="start" pending={refreshing} onClick={() => void refresh()}>
      Try again
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Updates & roadmap"
        description="What people read under Updates and Roadmap in Help & Support. An update is a public post of @magicbooklet, so it also shows on that profile and in feeds; the roadmap is a short list of what is being built, with no dates."
        actions={(
          <Button variant="secondary" icon={RefreshCw} iconPosition="start" pending={refreshing} onClick={() => void refresh()}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        )}
      />

      {read === 'signed-out' ? (
        <StatusCallout
          tone="warning"
          className="mb-6"
          title="Your console session has ended"
          body="Sign in again in a new tab, then come back and press Try again. What you were writing stays on this page."
          action={(
            <div className="flex flex-wrap gap-2">
              <a href="/admin/login" target="_blank" rel="noopener" className="ui-button ui-button-secondary ui-focus-ring">
                Sign in
              </a>
              {tryAgain}
            </div>
          )}
        />
      ) : read === 'failed' ? (
        <StatusCallout
          tone="warning"
          className="mb-6"
          title={hub ? 'This page could not be refreshed' : 'Updates and the roadmap could not be loaded'}
          body={hub
            ? 'What it shows may be out of date. Check your connection, then try again.'
            : 'Check your connection, then try again.'}
          action={tryAgain}
        />
      ) : null}

      {hub ? (
        <>
          <UpdateComposer officialAccountReady={hub.officialAccountReady} act={act} />
          <UpdateList updates={hub.updates} act={act} />
          <RoadmapSection hub={hub} act={act} />
        </>
      ) : read === 'loading' ? (
        <p role="status" className="text-sm leading-6 text-[var(--ui-text-muted)]">Loading updates and the roadmap…</p>
      ) : null}
    </>
  );
}

// Updates ---------------------------------------------------------------------

function UpdateComposer({ officialAccountReady, act }: { officialAccountReady: boolean; act: Act }) {
  const id = useId();
  const confirm = useConfirmation();
  const action = useAction(act);
  const [kind, setKind] = useState<SupportUpdateKind>('announcement');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [commentsOn, setCommentsOn] = useState(true);
  const [announce, setAnnounce] = useState<SupportUpdateAnnounce>('quiet');

  const publishing = action.pending === 'publish';
  const canPublish = officialAccountReady && title.trim() !== '' && body.trim() !== '' && !publishing;

  const publish = async () => {
    if (!canPublish) return;
    action.clear();
    const chosen = announce;
    if (chosen === 'alert_push' && !(await confirm(pushQuestion(title, 'Publish and push')))) return;
    const result = await action.run('publish', {
      action: 'publish',
      kind,
      title: title.trim(),
      body: body.trim(),
      commentsLocked: !commentsOn,
      announce: chosen,
    });
    if (!result.ok) return;
    setTitle('');
    setBody('');
    setCommentsOn(true);
    setAnnounce('quiet');
    action.setNotice(PUBLISHED_WORDS[chosen]);
  };

  return (
    <section aria-labelledby={`${id}-heading`}>
      <Surface variant="card" padding="md">
        <Text as="h2" id={`${id}-heading`} variant="cardTitle">Post an update</Text>
        <Text variant="bodySm" className="mt-1">
          New marks a feature that just shipped; Announcement is anything else, news or a question to people.
          Either is posted as @magicbooklet and shows first under Updates.
        </Text>

        {!officialAccountReady ? (
          <StatusCallout
            tone="warning"
            className="mt-4"
            title="No account holds the @magicbooklet handle"
            body="Updates are posted as @magicbooklet, so publishing is off until an account holds that handle. Give it to the team’s account, then press Refresh."
          />
        ) : null}

        <div className="mt-4 flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
            <Field id={`${id}-kind`} label="Kind">
              <select
                id={`${id}-kind`}
                value={kind}
                onChange={(event) => setKind(event.target.value as SupportUpdateKind)}
                className={INPUT_CLASSES}
              >
                {SUPPORT_UPDATE_KINDS.map((option) => (
                  <option key={option} value={option}>{SUPPORT_HUB_WORDS.kinds[option]}</option>
                ))}
              </select>
            </Field>
            <Field id={`${id}-title`} label="Title" length={title.length} max={SUPPORT_UPDATE_TITLE_MAX_LENGTH}>
              <input
                id={`${id}-title`}
                type="text"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={SUPPORT_UPDATE_TITLE_MAX_LENGTH}
                aria-describedby={`${id}-title-count`}
                className={INPUT_CLASSES}
              />
            </Field>
          </div>

          <Field id={`${id}-body`} label="Body" length={body.length} max={SUPPORT_UPDATE_BODY_MAX_LENGTH}>
            <textarea
              id={`${id}-body`}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={6}
              maxLength={SUPPORT_UPDATE_BODY_MAX_LENGTH}
              aria-describedby={`${id}-body-count`}
              placeholder="Plain text. Links work as they do in any text post."
              className={INPUT_CLASSES}
            />
          </Field>

          <label className="flex min-h-12 items-center gap-3 text-sm text-[var(--ui-text-secondary)]">
            <input
              type="checkbox"
              checked={commentsOn}
              onChange={(event) => setCommentsOn(event.target.checked)}
              className={CHOICE_CLASSES}
            />
            Comments on
          </label>

          <AnnounceChoices name={`${id}-announce`} choices={ANNOUNCE_CHOICES} value={announce} onChange={setAnnounce} />

          <div>
            <Button
              variant="primary"
              icon={Send}
              iconPosition="start"
              disabled={!canPublish}
              pending={publishing}
              onClick={() => void publish()}
            >
              {publishing ? 'Publishing…' : 'Publish'}
            </Button>
          </div>
        </div>
        <ActionFeedback error={action.error} notice={action.notice} />
      </Surface>
    </section>
  );
}

function UpdateList({ updates, act }: { updates: AdminSupportUpdate[]; act: Act }) {
  const headingId = useId();
  return (
    <section className="mt-8">
      <Text as="h2" id={headingId} variant="cardTitle" className="mb-3">All updates</Text>
      {updates.length === 0 ? (
        <EmptyState message="No updates yet. The first one you publish shows here." />
      ) : (
        <ul aria-labelledby={headingId} className="space-y-2">
          {updates.map((update) => <UpdateRow key={update.id} update={update} act={act} />)}
        </ul>
      )}
    </section>
  );
}

function UpdateRow({ update, act }: { update: AdminSupportUpdate; act: Act }) {
  const id = useId();
  const confirm = useConfirmation();
  const action = useAction(act);
  const [mode, setMode] = useState<'view' | 'edit' | 'announce'>('view');
  const [title, setTitle] = useState(update.title);
  const [body, setBody] = useState(update.body);
  const [announceWith, setAnnounceWith] = useState<SupportUpdateAnnounce>('alert');
  const focusReturnRef = useFocusReturn(mode !== 'view');

  const busy = action.pending !== null;
  const live = update.published && !update.hiddenByReview;
  const publicHref = live ? adminPostHref(update.id) : null;
  const unfinished = update.broadcast !== null && !update.broadcast.finished;
  // One published quietly can still be announced, once, while it is live.
  const announceable = live && update.broadcast === null;

  const open = (next: 'edit' | 'announce') => {
    action.clear();
    focusReturnRef.current = `${id}-${next}`;
    setTitle(update.title);
    setBody(update.body);
    setAnnounceWith('alert');
    setMode(next);
  };

  const close = () => {
    action.clear();
    setMode('view');
  };

  const save = async () => {
    const result = await action.run('edit', { action: 'edit', postId: update.id, title: title.trim(), body: body.trim() });
    if (result.ok) setMode('view');
  };

  const announce = async () => {
    const push = announceWith === 'alert_push';
    if (push && !(await confirm(pushQuestion(update.title, 'Announce and push')))) return;
    const result = await action.run('announce', { action: 'announce', postId: update.id, push });
    if (!result.ok) return;
    setMode('view');
    action.setNotice(push
      ? 'Announced. The alert and the push are going out to every account.'
      : 'Announced. The alert is going out to every account.');
  };

  const continueSending = async () => {
    const result = await action.run('continueBroadcast', { action: 'continueBroadcast', postId: update.id });
    if (result.ok) action.setNotice('Sending again in the background. Press Refresh in a minute to see how far it got.');
  };

  return (
    <li className={ROW_CLASSES}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={SUPPORT_HUB_WORDS.kinds[update.kind]} tone="neutral" />
        <StatusBadge status={update.published ? 'Live' : 'Taken down'} tone={update.published ? 'ok' : 'warning'} />
        {update.hiddenByReview ? <StatusBadge status="Hidden by review" tone="danger" /> : null}
        <Text as="span" variant="caption">{formatTimestamp(update.createdAt)}</Text>
      </div>
      <Text as="h3" variant="cardTitle" className="mt-2 text-base leading-6 [overflow-wrap:anywhere]">{update.title}</Text>

      {mode === 'edit' ? (
        <div className="mt-3 flex flex-col gap-3">
          <Field id={`${id}-title`} label="Title" length={title.length} max={SUPPORT_UPDATE_TITLE_MAX_LENGTH}>
            <input
              id={`${id}-title`}
              type="text"
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={SUPPORT_UPDATE_TITLE_MAX_LENGTH}
              aria-describedby={`${id}-title-count`}
              className={INPUT_CLASSES}
            />
          </Field>
          <Field id={`${id}-body`} label="Body" length={body.length} max={SUPPORT_UPDATE_BODY_MAX_LENGTH}>
            <textarea
              id={`${id}-body`}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={8}
              maxLength={SUPPORT_UPDATE_BODY_MAX_LENGTH}
              aria-describedby={`${id}-body-count`}
              className={INPUT_CLASSES}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={!title.trim() || !body.trim()}
              pending={action.pending === 'edit'}
              onClick={() => void save()}
            >
              {action.pending === 'edit' ? 'Saving…' : 'Save changes'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={close}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Text variant="bodySm" className="mt-1 [overflow-wrap:anywhere]">{supportUpdatePreview(update.body)}</Text>
          <Text variant="caption" className="mt-2">
            {[
              countWords(update.commentCount, 'comment', 'comments'),
              update.commentsLocked ? 'Comments off' : null,
              countWords(update.reactionPeople, 'person reacted', 'people reacted'),
              supportUpdateBroadcastWords(update.broadcast),
            ].filter(Boolean).join(' · ')}
          </Text>
          {mode === 'announce' ? (
            <div className="mt-3 flex flex-col gap-3">
              <AnnounceChoices
                name={`${id}-announce-with`}
                choices={LATER_ANNOUNCE_CHOICES}
                value={announceWith}
                onChange={setAnnounceWith}
                autoFocus
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  icon={Megaphone}
                  iconPosition="start"
                  pending={action.pending === 'announce'}
                  onClick={() => void announce()}
                >
                  {action.pending === 'announce' ? 'Announcing…' : 'Announce'}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button id={`${id}-edit`} variant="secondary" icon={Pencil} iconPosition="start" disabled={busy} onClick={() => open('edit')}>
                Edit
              </Button>
              <Button
                variant="secondary"
                icon={update.commentsLocked ? MessageSquare : MessageSquareOff}
                iconPosition="start"
                disabled={busy}
                pending={action.pending === 'lock'}
                onClick={() => void action.run('lock', { action: 'lock', postId: update.id, locked: !update.commentsLocked })}
              >
                {action.pending === 'lock'
                  ? 'Saving…'
                  : update.commentsLocked ? 'Turn comments on' : 'Turn comments off'}
              </Button>
              <Button
                variant="secondary"
                icon={update.published ? EyeOff : Eye}
                iconPosition="start"
                disabled={busy}
                pending={action.pending === 'publishState'}
                onClick={() => void action.run('publishState', { action: 'publishState', postId: update.id, published: !update.published })}
              >
                {action.pending === 'publishState'
                  ? (update.published ? 'Taking down…' : 'Putting back up…')
                  : (update.published ? 'Take down' : 'Put back up')}
              </Button>
              {unfinished ? (
                <Button
                  variant="secondary"
                  icon={Send}
                  iconPosition="start"
                  disabled={busy}
                  pending={action.pending === 'continueBroadcast'}
                  onClick={() => void continueSending()}
                >
                  {action.pending === 'continueBroadcast' ? 'Sending…' : 'Continue sending'}
                </Button>
              ) : null}
              {announceable ? (
                <Button
                  id={`${id}-announce`}
                  variant="secondary"
                  icon={Megaphone}
                  iconPosition="start"
                  disabled={busy}
                  onClick={() => open('announce')}
                >
                  Announce…
                </Button>
              ) : null}
              {publicHref ? (
                <Link href={publicHref} target="_blank" rel="noreferrer" className="ui-button ui-button-ghost ui-focus-ring">
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  Open post
                </Link>
              ) : (
                <Text as="span" variant="caption">
                  {update.published ? 'Hidden by review: it has no public page.' : 'Taken down: it has no public page.'}
                </Text>
              )}
            </div>
          )}
        </>
      )}
      <ActionFeedback error={action.error} notice={action.notice} />
    </li>
  );
}

// Roadmap ---------------------------------------------------------------------

function RoadmapSection({ hub, act }: { hub: AdminSupportHub; act: Act }) {
  const headingId = useId();
  // An item ships with an update people can read: one that is up and not hidden by review.
  const shippable = hub.updates.filter((update) => update.published && !update.hiddenByReview);

  return (
    <section className="mt-10">
      <Text as="h2" id={headingId} variant="sectionTitle">Roadmap</Text>
      <Text variant="bodySm" className="mt-1.5">
        People see Building first, then Exploring, then what shipped in the last 30 days, each group in this order.
        Each person who reacts to an item counts as one vote.
      </Text>
      <RoadmapComposer act={act} />
      {hub.roadmap.length === 0 ? (
        <div className="mt-4">
          <EmptyState message="Nothing on the roadmap yet. Add the first item above." />
        </div>
      ) : (
        <ol aria-labelledby={headingId} className="mt-4 space-y-2">
          {hub.roadmap.map((item, index) => (
            <RoadmapRow
              key={item.id}
              item={item}
              first={index === 0}
              last={index === hub.roadmap.length - 1}
              updates={hub.updates}
              shippable={shippable}
              act={act}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function RoadmapComposer({ act }: { act: Act }) {
  const id = useId();
  const action = useAction(act);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [status, setStatus] = useState<OpenStatus>('exploring');

  const adding = action.pending === 'create';

  const add = async () => {
    if (!title.trim() || adding) return;
    const result = await action.run('create', { action: 'roadmapCreate', title: title.trim(), summary: summary.trim(), status });
    if (!result.ok) return;
    setTitle('');
    setSummary('');
    setStatus('exploring');
    action.setNotice('Added to the end of the roadmap.');
  };

  return (
    <section aria-labelledby={`${id}-heading`} className="mt-4">
      <Surface variant="card" padding="md">
        <Text as="h3" id={`${id}-heading`} variant="cardTitle">Add an item</Text>
        <div className="mt-4 flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
            <Field id={`${id}-status`} label="Status">
              <select
                id={`${id}-status`}
                value={status}
                onChange={(event) => setStatus(event.target.value as OpenStatus)}
                className={INPUT_CLASSES}
              >
                {OPEN_STATUSES.map((option) => <option key={option} value={option}>{STATUS_WORDS[option]}</option>)}
              </select>
            </Field>
            <Field id={`${id}-title`} label="Title" length={title.length} max={SUPPORT_ROADMAP_TITLE_MAX_LENGTH}>
              <input
                id={`${id}-title`}
                type="text"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={SUPPORT_ROADMAP_TITLE_MAX_LENGTH}
                aria-describedby={`${id}-title-count`}
                className={INPUT_CLASSES}
              />
            </Field>
          </div>
          <Field id={`${id}-summary`} label="One line (optional)" length={summary.length} max={SUPPORT_ROADMAP_SUMMARY_MAX_LENGTH}>
            <textarea
              id={`${id}-summary`}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              rows={2}
              maxLength={SUPPORT_ROADMAP_SUMMARY_MAX_LENGTH}
              aria-describedby={`${id}-summary-count`}
              className={INPUT_CLASSES}
            />
          </Field>
          <div>
            <Button
              variant="primary"
              icon={Plus}
              iconPosition="start"
              disabled={!title.trim()}
              pending={adding}
              onClick={() => void add()}
            >
              {adding ? 'Adding…' : 'Add to roadmap'}
            </Button>
          </div>
        </div>
        <ActionFeedback error={action.error} notice={action.notice} />
      </Surface>
    </section>
  );
}

function RoadmapRow({
  item,
  first,
  last,
  updates,
  shippable,
  act,
}: {
  item: AdminRoadmapItem;
  first: boolean;
  last: boolean;
  updates: AdminSupportUpdate[];
  shippable: AdminSupportUpdate[];
  act: Act;
}) {
  const id = useId();
  const confirm = useConfirmation();
  const action = useAction(act);
  const [mode, setMode] = useState<'view' | 'edit' | 'ship'>('view');
  const [title, setTitle] = useState(item.title);
  const [summary, setSummary] = useState(item.summary);
  const [status, setStatus] = useState<OpenStatus>(item.status === 'building' ? 'building' : 'exploring');
  const [updateId, setUpdateId] = useState('');
  const focusReturnRef = useFocusReturn(mode !== 'view');

  const busy = action.pending !== null;
  const shipped = item.status === 'shipped';
  const shippedUpdate = item.shippedUpdateId ? updates.find((update) => update.id === item.shippedUpdateId) ?? null : null;
  const chosenUpdate = shippable.find((update) => update.id === updateId) ?? null;
  const alertTitle = supportRoadmapShippedAlertWords(item.title).title;

  const open = (next: 'edit' | 'ship') => {
    action.clear();
    focusReturnRef.current = `${id}-${next}`;
    setTitle(item.title);
    setSummary(item.summary);
    setStatus(item.status === 'building' ? 'building' : 'exploring');
    setUpdateId('');
    setMode(next);
  };

  const close = () => {
    action.clear();
    setMode('view');
  };

  const save = async () => {
    const result = await action.run('edit', {
      action: 'roadmapUpdate',
      itemId: item.id,
      title: title.trim(),
      summary: summary.trim(),
      status,
    });
    if (result.ok) setMode('view');
  };

  const ship = async () => {
    if (!chosenUpdate) return;
    const sure = await confirm({
      title: `Mark “${item.title}” shipped?`,
      message: item.people > 0
        ? `Everyone who reacted (${countWords(item.people, 'person', 'people')}) gets a “${alertTitle}” alert that opens “${chosenUpdate.title}”. It goes out once and cannot be called back.`
        : `Nobody has reacted to it yet, so no alert goes out. It moves to Shipped, linked to “${chosenUpdate.title}”.`,
      confirmLabel: 'Mark shipped',
    });
    if (!sure) return;
    const result = await action.run('ship', { action: 'roadmapShip', itemId: item.id, updatePostId: chosenUpdate.id });
    if (!result.ok) return;
    setMode('view');
    const told = typeof result.data.told === 'number' ? result.data.told : 0;
    action.setNotice(told > 0 ? `Marked shipped. ${countWords(told, 'person was', 'people were')} told it’s live.` : 'Marked shipped.');
  };

  return (
    <li className={ROW_CLASSES}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge
          status={STATUS_WORDS[item.status]}
          tone={item.status === 'shipped' ? 'ok' : item.status === 'building' ? 'warning' : 'neutral'}
        />
        {item.archived ? <StatusBadge status="Archived" tone="neutral" /> : null}
        <Text as="span" variant="caption">{supportRoadmapVoteWords(item.people)}</Text>
      </div>
      <Text as="h3" variant="cardTitle" className="mt-2 text-base leading-6 [overflow-wrap:anywhere]">{item.title}</Text>

      {mode === 'edit' ? (
        <div className="mt-3 flex flex-col gap-3">
          <Field id={`${id}-title`} label="Title" length={title.length} max={SUPPORT_ROADMAP_TITLE_MAX_LENGTH}>
            <input
              id={`${id}-title`}
              type="text"
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={SUPPORT_ROADMAP_TITLE_MAX_LENGTH}
              aria-describedby={`${id}-title-count`}
              className={INPUT_CLASSES}
            />
          </Field>
          <Field id={`${id}-summary`} label="One line (optional)" length={summary.length} max={SUPPORT_ROADMAP_SUMMARY_MAX_LENGTH}>
            <textarea
              id={`${id}-summary`}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              rows={2}
              maxLength={SUPPORT_ROADMAP_SUMMARY_MAX_LENGTH}
              aria-describedby={`${id}-summary-count`}
              className={INPUT_CLASSES}
            />
          </Field>
          <Field id={`${id}-status`} label="Status">
            <select
              id={`${id}-status`}
              value={status}
              onChange={(event) => setStatus(event.target.value as OpenStatus)}
              className={INPUT_CLASSES}
            >
              {OPEN_STATUSES.map((option) => <option key={option} value={option}>{STATUS_WORDS[option]}</option>)}
            </select>
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={!title.trim()} pending={action.pending === 'edit'} onClick={() => void save()}>
              {action.pending === 'edit' ? 'Saving…' : 'Save changes'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
          </div>
        </div>
      ) : mode === 'ship' ? (
        <div className="mt-3 flex flex-col gap-3">
          {shippable.length === 0 ? (
            <Text variant="bodySm">
              Publish an update about it first: shipping points everyone who reacted to the update that announced it.
            </Text>
          ) : (
            <Field id={`${id}-update`} label="The update that announced it">
              <select
                id={`${id}-update`}
                autoFocus
                value={updateId}
                onChange={(event) => setUpdateId(event.target.value)}
                className={INPUT_CLASSES}
              >
                <option value="">Choose an update</option>
                {shippable.map((update) => (
                  <option key={update.id} value={update.id}>
                    {`${update.title} · ${SUPPORT_HUB_WORDS.kinds[update.kind]} · ${formatTimestamp(update.createdAt)}`}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Text variant="caption">
            {`Everyone who reacted (${countWords(item.people, 'person', 'people')}) gets a “${alertTitle}” alert that opens the update. It goes out once.`}
          </Text>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              icon={Rocket}
              iconPosition="start"
              disabled={!chosenUpdate}
              pending={action.pending === 'ship'}
              onClick={() => void ship()}
            >
              {action.pending === 'ship' ? 'Marking shipped…' : 'Mark shipped'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
          </div>
        </div>
      ) : (
        <>
          {item.summary ? <Text variant="bodySm" className="mt-1 [overflow-wrap:anywhere]">{item.summary}</Text> : null}
          {shipped ? (
            <Text variant="caption" className="mt-2">
              {`Shipped ${formatTimestamp(item.shippedAt)} · `}
              {item.shippedUpdateId ? (
                <Link
                  href={adminPostHref(item.shippedUpdateId)}
                  target="_blank"
                  rel="noreferrer"
                  className="ui-focus-ring underline"
                >
                  {shippedUpdate ? `Read “${shippedUpdate.title}”` : 'Read the update'}
                </Link>
              ) : 'its update was deleted'}
            </Text>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              icon={ArrowUp}
              iconPosition="start"
              disabled={busy || first}
              pending={action.pending === 'up'}
              onClick={() => void action.run('up', { action: 'roadmapMove', itemId: item.id, direction: 'up' })}
            >
              Move up
            </Button>
            <Button
              variant="secondary"
              icon={ArrowDown}
              iconPosition="start"
              disabled={busy || last}
              pending={action.pending === 'down'}
              onClick={() => void action.run('down', { action: 'roadmapMove', itemId: item.id, direction: 'down' })}
            >
              Move down
            </Button>
            {!shipped ? (
              <Button id={`${id}-edit`} variant="secondary" icon={Pencil} iconPosition="start" disabled={busy} onClick={() => open('edit')}>
                Edit
              </Button>
            ) : null}
            <Button
              variant="secondary"
              icon={item.archived ? ArchiveRestore : Archive}
              iconPosition="start"
              disabled={busy}
              pending={action.pending === 'archive'}
              onClick={() => void action.run('archive', { action: 'roadmapArchive', itemId: item.id, archived: !item.archived })}
            >
              {item.archived ? 'Restore' : 'Archive'}
            </Button>
            {!shipped && !item.archived ? (
              <Button id={`${id}-ship`} variant="secondary" icon={Rocket} iconPosition="start" disabled={busy} onClick={() => open('ship')}>
                Mark shipped
              </Button>
            ) : null}
          </div>
        </>
      )}
      <ActionFeedback error={action.error} notice={action.notice} />
    </li>
  );
}
