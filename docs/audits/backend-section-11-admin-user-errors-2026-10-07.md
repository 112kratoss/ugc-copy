# Section 11H — unknown support data and actual recovery

Ten injected read failures reproduce in the real Supabase SDK collector: spend,
web/mobile purchases, grants, wallet, reports, recent generation count/list and
both follow counts are returned as zeros or empty records. The collector now
checks every result, propagates the authoritative Auth failure, and removes the
follow-count zero fallbacks. A missing profile still returns null.

The actual production Next build reproduces the page-level consequence through
a loopback HTTP fault proxy and Playwright. A profile failure claims the user is
missing; a seven-credit spend becomes zero on aggregate failure; a suspended
account loses its suspension on state failure. Auth failure leaves an apparently
complete support record. This is local fixture evidence, not a production incident.

The user page now lets failed reads reach the existing console error boundary,
including adjustment/sanction histories and account state. Missing and malformed
IDs retain the recoverable missing-record panel. Unknown data is no longer shown
alongside actionable support forms. No balance, access policy, schema or grant
is changed by this fix.

The recovery check also reproduces Try again staying on the error after the
backend is restored. The installed Next 16.3.3 implementation supplies `retry`,
which refetches the segment before clearing its error, while `reset` only clears
the error state. The console now uses the supplied retry function. The installed
code/docs were checked; the [Next 16.2 release notes](https://nextjs.org/blog/next-16-2)
describe the underlying refetch versus reset distinction. No custom refresh
mechanism or dependency update was added.

The final production build passes all 17 browser cases: fifteen independent
read failures show the existing error panel with sidebar/retry controls and no
support record; a healthy suspended fixture shows its real seven-credit spend;
a genuinely missing profile shows the missing-record panel. Clicking the actual
Try again button after restoring the backend recovers the seven credits and
suspension without a page reload. The three changed runtime files match saved
candidate digests.

All 41 actual API/SQL collector cases pass, including eleven user failure controls
and six partial failure controls across the other collector modules. All 65
focused cases across nine files, app/test types, scoped lint and the production
build pass. The fixture's seven-credit usage row is inert: independently checked
profile balances are unchanged. No paid request, settlement or customer repair
was performed.

An additional 46 actual production Next controls cover all five OPS API route
files: supported GET/generated HEAD, generated OPTIONS, unsupported methods,
old-client/future-schema admission, same/foreign CORS origins and complete
out-of-range diagnostic reports. The prior 25 actual ingress cases retain valid
reports, body limits, SQL limiter/retry and insert-failure coverage. This expands
OPS-04/MAP-02 evidence; it does not certify every unrelated entrypoint.

Specific Auth/profile/post/generation/usage/contact/admin-session/rate/telemetry
fixture cleanup reads back empty. The browser, production fixture server and
fault proxy are stopped. A disk-full interruption was resolved by removing only
generated dependencies/build files from the completed previous audit fixture;
its source and evidence remain preserved, and the final matrix passes.

Private reproduction, build, digests, browser, retry, method and cleanup evidence
is under `.audit-evidence/backend-social/admin-user-*`. Exact-head Quality,
independently verified parent, standard release and live checks remain required.
OPS-04 stays failed until these reproduced defects are released and verified;
the complete audit remains open.
