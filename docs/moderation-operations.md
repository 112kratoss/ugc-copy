# Moderation Operations

This workflow is restricted to trusted staff using the Supabase service role. Never paste the service-role key into a command, ticket, report note, or chat. Keep it in the protected runtime environment (the local script loads `.env.local` when present).

## Before first use

1. Apply all pending Supabase migrations, including `20260728143000_post_comments_integrity.sql`.
2. Give each moderator a real Magicbooklet auth account. Its `auth.users.id` is the required reviewer id and becomes part of the audit record.
3. Fill and approve the operating roster below. Placeholder values mean the launch gate is still open.
4. Set `CHILD_SAFETY_CONTACT_EMAIL` to the staffed safety inbox. `/child-safety` falls back to general support so the page always works, but that fallback is not proof of staffed safety coverage.
5. Configure and successfully run `.github/workflows/backend-alert-watchdog.yml` with the production `OPS_READ_SECRET`.

## Required operating roster

Do not put credentials, private phone numbers, or personal data in this repository. Replace each placeholder with a role or on-call alias in the restricted operations system and link that system from the release record.

| Responsibility | Assignment before launch |
| --- | --- |
| Safety accountable owner | `<assign safety owner>` |
| Primary queue moderator | `<assign primary moderator>` |
| Backup / absence cover | `<assign backup moderator>` |
| Child-safety escalation contact | `<assign monitored inbox and on-call alias>` |
| Legal / required-reporting escalation | `<assign approved escalation path>` |

## Queue service levels

- Review the queue often enough that no report reaches four hours without staff attention. The backend alert payload emits `MODERATION_QUEUE_AGE_WARNING` at four hours and `MODERATION_QUEUE_AGE_SLO_BREACH` at 24 hours.
- Keep fewer than 10 open reports during normal operation. The payload warns at 10 and degrades at 25.
- A credible child-safety or imminent-harm concern must be acknowledged within one hour and access restricted immediately once the content is located. Complete legally required escalation without waiting for the general 24-hour review SLO.
- Every other report must receive an initial decision or documented investigation state within 24 hours.
- Record the coverage schedule and hand-off procedure in the restricted operations system. A CLI, endpoint, or mailbox does not constitute staffing.

The protected `/api/ops/backend-alerts` response includes `signals.moderationOpenCount`, `signals.moderationOldestAgeMinutes`, and source-labelled moderation alerts. The external watchdog treats a degraded queue as a failed run.

## Queue review

```sh
npm run ops:moderation -- list
npm run ops:moderation -- list --limit 100 --json
```

The JSON form includes user-supplied report details and must be handled as sensitive operational data. Review the queue on a staffed schedule and after any safety alert; an unattended CLI is not a substitute for staffing or alert delivery.

## Reported posts

After reviewing the post, report details, and any linked unlock, take down a violating post with an explicit rationale:

```sh
npm run ops:moderation -- take-down-post \
  --report-id <report-uuid> \
  --reviewer-id <moderator-auth-user-uuid> \
  --note "Policy section and concise evidence summary" \
  --confirm
```

The transactional action hides the post, makes a linked generation private, drafts a published resource bundle, unlists an active marketplace asset, and resolves duplicate open reports for that post. After the database commit, the command deletes every post-scoped object and preview from the public `showcase_media` bucket and verifies that none still exists. If deletion or verification fails, the command exits unsuccessfully; rerun the same command to retry the idempotent cleanup.

A creation's post serves a copy filed under the creation (`showcase/<generation>/`, or `private-posts/<generation>/` when marked NSFW); the take-down deletes that copy and leaves the creator's private original. When the creation was deleted after it was posted, the post keeps serving its copy and records the creation in `posts.deleted_generation_id` (the database writes it when the delete unlinks the post), and the take-down deletes the copy from that folder; the original is left only in the folder of the post's owner or of a guest linked to them. A post with media in any other creation's folder, or with an original in someone else's folder, makes the command refuse with "outside the reported post scope" before deleting anything; find the row that names the other folder, or whose folder holds the original, before rerunning it. A post unlinked before that record existed (2026-10-30) whose folder the migration could not prove refuses the same way on every rerun: check that no other post or post media row names a file in its folder, then remove the copy by hand.

Public Showcase uploads use a five-minute browser and image-cache TTL. Storage deletion invalidates the origin object, and the shorter TTL bounds any already-cached client copy. A returned `externalMediaRevocationRequired: true` means the post also references a provider-hosted URL that this command cannot delete; complete that provider action and record it in the incident system before closing the case.

Dismiss a report only after confirming the content does not violate policy:

```sh
npm run ops:moderation -- dismiss-post \
  --report-id <report-uuid> \
  --reviewer-id <moderator-auth-user-uuid> \
  --note "Concise dismissal rationale" \
  --confirm
```

## Copyright and trademark complaints

The Terms (section 8, 2026-10-30) keep AI fan art of well-known characters up: it stays personal and unsold and comes down when the rights owner asks. A resemblance alone is not a reason to remove a post; a complaint from the owner, or from someone acting for them, is. Complaints arrive two ways: a "Stolen content" report on the post (web post page, or the app viewer's ••• menu; it needs an account) or an email to the support address with the details section 8 lists.

1. Check the complaint names a work, the posts, and who is asking (the owner or their agent), with the good-faith statement. Ask by email for what is missing; a "Stolen content" report from someone not shown to be the owner is not enough on its own.
2. While you decide, hide the post from `/admin` → Content (reversible, and it records who and why). Do not take it down yet: a take-down cannot be restored.
3. Email the poster (the account's address) with the complaint and how to reply. Section 8 promises no automatic notice, so this email is the notice.
4. If it infringes, take it down: from the report (`take-down-post` above) or, for an emailed complaint, from `/admin` → Content. If it does not, restore it from `/admin` → Content and dismiss the report. A poster whose post was taken down by mistake posts it again, as section 8 says.
5. A paid recipe or bundle featuring someone else's characters or brands breaks section 8 whoever complains: take it down, and before paying out, check the seller's requests for earnings from it (section 8 lets us withhold them).
6. Keep a note of each confirmed infringement per account; suspend an account that keeps infringing (`/admin` → Users).

Emailed complaints do not enter the queue or its 24-hour alerts: answer them from the support inbox within the same service level.

## Comment reports

The queue includes the comment id, post id, current status, and a short body
preview. After confirming a violation, resolve the report:

```sh
npm run ops:moderation -- resolve-subject \
  --report-id <report-uuid> \
  --reviewer-id <moderator-auth-user-uuid> \
  --note "Policy section and concise evidence summary" \
  --confirm
```

`--note` is required. Subject decisions now persist a rationale to
`moderation_reports.resolution_note`, matching post takedowns; the resolver
rejects a decision that would leave the audit record unexplained.

For a comment target, this command atomically soft-removes an active comment as
`removed_by_moderation`, repairs the post and parent-reply counters, records the
reviewer and review time, and resolves every open duplicate report for that
comment. It is idempotent when the comment or report was already resolved.

Dismiss a non-violating comment report with `dismiss-subject`; dismissal leaves
the comment untouched and closes only the selected report.

## Template reports

A viewer can report a published template from its page on the web and in the
app (`targetType: 'template'`; reasons `spam`, `stolen_content`,
`unsafe_content`, `other`). The queue shows the template's name, description,
status and creator; review the demo at `/templates/<slug>`.

After confirming a violation, resolve the report with `resolve-subject` (the
console's button reads "Take down template"). For a template target the
resolver, in one transaction, disables the template (`status='disabled'`,
`is_active=false`, as the creator's own Disable does) so it leaves the catalog,
its page answers not found and no new run starts; records the reviewer, the
review time and the note; and resolves every open duplicate report for that
template. It is idempotent when the template or report was already resolved.
Runs already started finish from their snapshot. The catalog's cached page can
show the card for up to five minutes, as after the creator's own Disable. The
take-down also sets `templates.moderation_disabled_at`, a hold: the creator's
publish and test runs answer 409 `TEMPLATE_TAKEN_DOWN`, and their page reads
"Taken down". No product path lifts it; a deliberate reversal clears that column
by SQL (`update public.templates set moderation_disabled_at = null where id = …`),
after which the creator can publish again.

Dismiss a non-violating template report with `dismiss-subject`; dismissal leaves
the template live and closes only the selected report.

## User and generation reports

For a user or generation report, first complete the required manual safety action. Then record the outcome:

```sh
npm run ops:moderation -- resolve-subject --report-id <report-uuid> --reviewer-id <moderator-auth-user-uuid> --note "<rationale>" --confirm
npm run ops:moderation -- dismiss-subject --report-id <report-uuid> --reviewer-id <moderator-auth-user-uuid> --note "<rationale>" --confirm
```

The same subject-report command records final status, reviewer, review time,
and the rationale supplied via `--note`. For user and generation targets,
complete the required manual safety action before resolving. Keep any material
beyond a concise rationale — full investigation detail, personal data, external
report identifiers — in the restricted incident system rather than in the note.

## Generation-time refusals

Every image, video, motion and catalog start checks its prompts with `src/lib/generation-prompt-safety.ts` before any credit hold, and `createKieTask` repeats the check on the exact provider payload. It refuses four things only: sexual content involving minors (`minor_sexualization`), undressing a person (`undressing`), see-through or x-ray views of clothing (`see_through_clothing`), and nudity (`nudity`). Since 2026-10-05 the last three also match the same request said another way: cloth named as a material ("remove the cloth fabric from the woman", which Google Play's reviewer typed on 2026-09-17 and only the provider stopped), a garment that leaves by itself ("her dress disappears"), a person shown "without her clothes", the view "under her dress", and nudity without its usual words ("wearing only heels"). A garment swapped for another one and an edit to the garment itself (wrinkles, a logo, a towel on a chair) still pass. Adult swimwear, lingerie, fashion and dance prompts pass by the owner's decision (2026-09-29). The user gets HTTP 422 with failure code `prompt_blocked` and is not charged.

Each refusal logs a `generation_prompt_blocked` warning carrying the category, account id and model, never the prompt. Repeated `minor_sexualization` refusals from one account are a child-safety matter: follow the escalation below and restrict the account rather than waiting for a report. The rules are text-only, so they cannot see what an uploaded reference image shows; the providers' own filters and user reports remain the backstop for that.

## Safety escalation and verification

- For suspected child sexual abuse material or child exploitation, do not download or redistribute the material. Preserve only the minimum identifiers required, immediately restrict access, and follow the child-safety escalation and legally required reporting process for the applicable jurisdiction.
- Treat storage, provider, CDN, preview, and marketplace exposure as part of the same incident. Hiding an application row alone is not proof that an asset is unavailable.
- For suspected child sexual abuse material, verify revocation using object metadata, provider status, and access-control responses only. Never retrieve the media merely to prove that removal worked.
- After every action:
  1. Run `npm run ops:moderation -- list` and verify the report left the open queue.
  2. Confirm the post, generation, profile, marketplace listing, preview, and search/feed surfaces no longer return the item.
  3. Confirm the command reports `mediaRevocationVerified: true`. If it reports `externalMediaRevocationRequired: true`, revoke the provider object and expire any provider-side access before closing the incident.
  4. Verify known URLs now return an authorization failure or not-found response without downloading the object.
  5. Record the checks, timestamps, reviewer id, and any required external report identifier in the restricted incident record.
- Before launch, run a synthetic report through submission, queue alerting, moderator action, public-surface removal, asset revocation, and alert recovery. Do not use real harmful content for the drill.
