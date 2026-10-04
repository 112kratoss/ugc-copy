# Section 8G — malformed social requests

Actual local Next HTTP exercised malformed JSON and JSON `null` on fourteen
social POST routes using a disposable registered identity. Thirteen responses
were HTTP 500 across seven routes; fifteen controls returned valid client errors
or enforced the website-only content-preference restriction.

| Endpoint | Before | After |
| --- | --- | --- |
| `/api/profile/share` | Malformed/null: 500 | 400, missing creator username |
| `/api/showcase/share` | Malformed/null: 500 | 400, missing post ID |
| `/api/showcase/publish` | Malformed/null: 500 | 400, missing generation ID |
| `/api/showcase/remix` | Malformed/null: 500 | 400, missing post ID |
| `/api/showcase/save` | Malformed/null: 500 | 400, missing post ID |
| `/api/posts/:postId/report` | Malformed: unhandled 500; null: 400 | Both 400, invalid report reason |
| `/api/posts` | JSON content type: form parser throws, 500 | 400, invalid post form data |

The five JSON adapters normalize parse failure/null into their existing missing
field validation. Post reporting also routes parse failures through its existing
normalizer. Post creation catches only the form-reading step before catalog,
preparation or persistence. Errors from later database/provider work retain the
existing handling. Rate-limit and identity ordering remain unchanged.

All 28 actual HTTP checks pass afterward with zero server errors. The existing
follow, follow-notification, contact, moderation-report, comment and feed-event
rejections remain unchanged; bearer content-preference writes stay denied with
403 and do not certify the website-cookie path. The initial probe expected every
response to be JSON and stopped at the unhandled report error; its partial results
were saved, then the complete probe recorded non-JSON responses explicitly.

Permanent adapter baseline: thirteen failures/one pass. All fourteen controls
now pass, asserting private no-store, exact errors and no table access. In total,
69 focused web cases and 130 mobile contract cases pass. App/test types and scoped
lint pass. The mobile fixture tests assert error preservation and no retry.

Both HTTP runs removed their fixture post and Auth identity, removed identity-keyed
rate entries and checked Auth absence. No notification, paid provider call,
production mutation or historical repair occurred. The dev server was stopped.
Private before/after evidence: `.audit-evidence/backend-social/social-input-*`.

No migration or mobile runtime change is needed. PR/CI/release remain pending.
SOCIAL-01/02/04 remain open; these malformed-input controls do not establish
complete method coverage, request byte limits or successful sharing/publication
lifecycle coverage. No new checklist obligation was added.
