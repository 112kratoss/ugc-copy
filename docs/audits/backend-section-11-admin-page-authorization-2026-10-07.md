# Section 11C — gate privileged admin page reads independently

An authoritative session revocation redirects admin pages to login, but the
parent layout's redirect did not prevent child pages from fetching and
serializing private data. A signed cookie with a revoked local database session
returned HTTP 307 with fixture data in the response body for activity, content,
system, users and user detail. This reproduced in both development and a clean
production Next build; Playwright's browser-associated request independently
confirmed the production activity response contained the fixture marker.
Browser navigation itself reached login. No production incident is attributed.

All ten privileged admin pages now await `requireAdminIdentity()` before parsing
parameters or constructing a service client. The helper verifies the existing
credential version and authoritative session row, and redirects to login on
denial. The layout and proxy remain additional checks. Next renders layouts and
pages concurrently, so a parent redirect is not the data-access boundary.
No API mutation policy, database, dependency or mobile contract changes.

Verification uses an isolated tracked-source snapshot outside the checkout, its
own locked dependencies and `.next`, explicit loopback Supabase credentials,
a disposable reviewer and uniquely identified private content/contact fixtures.
It never loads the checkout's `.env.local`. Baseline and candidate use the
standard production build; runtime file digests prove the candidate snapshot
matches the edited sources. An initial Webpack fixture build failed generated
type checks; a default Turbopack attempt rejected dependencies symlinked outside
the fixture. Installing the same locked dependencies in the isolated fixture and
using the standard build passes, without changing application source to bypass
either check.

The baseline seven-page HTML/RSC matrix confirms five private-marker leaks in
HTML responses. Candidate production checks cover all ten pages in both HTML
and RSC requests: all 20 revoked-session responses redirect with no fixture data.
All ten active-session pages return 200 and the applicable pages contain their
expected private fixture markers. Playwright confirms the activity redirect
body no longer contains the marker and navigation reaches login. Private
before/after responses and browser evidence are under
`.audit-evidence/backend-social/ops-next/`.

Ten regular-CI regressions ensure denied pages cannot construct a privileged
client. Three helper regressions cover revoked/missing/unavailable sessions.
All 55 focused auth/page/session cases, app/test types and scoped lint pass.
The candidate production build passes. Cleanup deletes only the specific fixture
IDs and reads back zero Auth users, profiles, posts, generations, contacts,
admin sessions and rate buckets. The fixture server and browser are stopped.

This is added to operations PR #381 with 11B's separately reproduced timestamp
fix. Its title and description must reflect both fixes. AUTH-02 is reopened for
the admin authorization failure until release verification; previously exercised
Apple/web login evidence is preserved. OPS-04 remains failed, with broader
collector semantics and deployed-method coverage still open. Do not merge until
parent FX #380 is independently verified live. No claim of full audit completion.
