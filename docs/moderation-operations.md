# Moderation Operations

This workflow is restricted to trusted staff using the Supabase service role. Never paste the service-role key into a command, ticket, report note, or chat. Keep it in the protected runtime environment (the local script loads `.env.local` when present).

## Before first use

1. Apply all pending Supabase migrations, including `20260721113000_operational_post_moderation.sql`.
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

Public Showcase uploads use a five-minute browser and image-cache TTL. Storage deletion invalidates the origin object, and the shorter TTL bounds any already-cached client copy. A returned `externalMediaRevocationRequired: true` means the post also references a provider-hosted URL that this command cannot delete; complete that provider action and record it in the incident system before closing the case.

Dismiss a report only after confirming the content does not violate policy:

```sh
npm run ops:moderation -- dismiss-post \
  --report-id <report-uuid> \
  --reviewer-id <moderator-auth-user-uuid> \
  --note "Concise dismissal rationale" \
  --confirm
```

## User and generation reports

For a user or generation report, first complete the required manual safety action. Then record the outcome:

```sh
npm run ops:moderation -- resolve-subject --report-id <report-uuid> --reviewer-id <moderator-auth-user-uuid> --confirm
npm run ops:moderation -- dismiss-subject --report-id <report-uuid> --reviewer-id <moderator-auth-user-uuid> --confirm
```

The subject-report schema records final status, reviewer, and review time. Keep detailed investigation notes in the restricted incident system until a dedicated resolution-note field is approved.

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
