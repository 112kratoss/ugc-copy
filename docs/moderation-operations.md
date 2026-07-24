# Moderation Operations

This workflow is restricted to trusted staff using the Supabase service role. Never paste the service-role key into a command, ticket, report note, or chat. Keep it in the protected runtime environment (the local script loads `.env.local` when present).

## Before first use

1. Apply all pending Supabase migrations, including `20260721113000_operational_post_moderation.sql`.
2. Give each moderator a real Magicbooklet auth account. Its `auth.users.id` is the required reviewer id and becomes part of the audit record.
3. Assign a primary and backup moderator, an on-call response target, and the designated child-safety contact published at `/child-safety`.

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

The transactional action hides the post, drafts a published resource bundle, unlists an active marketplace asset, and resolves duplicate open reports for that post. It retains the source row and media references for trusted review and appeal handling.

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
- If a storage or provider URL must be revoked, handle that as a separate incident action; hiding the application post does not revoke an already known external media URL.
- After every action, run `npm run ops:moderation -- list` again and verify the report left the open queue and the affected public surface no longer exposes the post.
- Configure an external alert or a staffed queue-check schedule before launch. This CLI does not notify moderators when a new report arrives.
