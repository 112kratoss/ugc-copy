# Section 1 production verification — 2026-09-26

Status: the three confirmed identity/access/merge findings are fixed and deployed. This release does not certify every external authentication flow.

## Released change

- PR: https://github.com/112kratoss/ugc-copy/pull/215
- Production commit: `c40fbe9e4c7556888ed1e353a67b1a2eb9f582d6`.
- Exact-main Quality: https://github.com/112kratoss/ugc-copy/actions/runs/36247775307 — all jobs passed.
- Production release: https://github.com/112kratoss/ugc-copy/actions/runs/36248339686 — passed, completed at 14:26:44 UTC, including protected production health after promotion.
- Production `/api/app-version` returned the exact release commit at 14:41 UTC.

The migration closes guest profile-update access, aligns database/Storage and authenticated workflow mutations with session/ban/lifecycle admission, and preserves signed credit/promotional balances during account merge. Historical accounting is not rewritten.

## Verification evidence

- Reproduced failures before fixing the database: 14/22 identity assertions and 14/35 merge assertions failed. All 57 passed after the fix.
- Clean replay of all 250 migrations and all 73 pgTAP files / 1,356 assertions passed.
- PR and exact-main CI passed web, mobile, E2E, and database gates.
- Production disposable-account verifier: 17/17 passed (guest and owner boundaries; banned, revoked, merged and deleting identities; zero-credit merge and idempotent retry).
- Both disposable identities removed; no real purchase or paid generation used.
- Observed production from 14:26:44 through 14:41:11 UTC, spanning the 14:30 and 14:40 scheduler ticks. Recorded job results were skips with no due work; alert delivery remained unconfigured. No failed job runs or blocked database sessions were observed.
- Supabase logs during that window: 490 edge responses, all HTTP 200/201/204; Auth response statuses 200/204 with informational logs; Postgres had six LOG and two WARNING records, no ERROR/FATAL records. This is bounded Supabase evidence, not a claim that every Vercel/provider log was inspected.

## Migration ledger and remaining limits

- The deployed migration is recorded under Management API timestamp `20260926142403`; repository filename version is `20260926135311`. Its name is `harden_identity_access_and_merge_balances`, and the deployed SQL checksum exactly matches the file: MD5 `a2cf39e4101ea4bf864a1395f2eb6c36`.
- Read-only ledger report https://github.com/112kratoss/ugc-copy/actions/runs/36248637702 found 250 repository files and 250 ledger rows, no NULL statements, and 39 differing version identifiers (38 pre-existing plus this deployment). Matching-version names/statements had no drift. A global rewrite was not performed as part of this scoped release; the release planner supports unambiguous name matching.
- Manual post-observation protected-health requests rejected the available local OPS/CRON credentials with 401. The release workflow's production protected-health step passed. Local credential synchronization remains an operational follow-up; no secret was changed.
- Google/Apple provider round trips, hosted Auth configuration, and other unexercised scenarios in the main audit coverage ledger remain separate verification work. Existing sessionless signed-token compatibility remains unchanged.

This is a local post-release evidence record. The implementation, regression tests, production verifier, and main audit report are merged in PR #215.

## Continued production validation — 15:08 UTC

Reconfirmed PR #215 is merged, its release succeeded, and production still serves `c40fbe9e4c7556888ed1e353a67b1a2eb9f582d6`. No additional application fix was pending deployment.

An additional 22 live checks passed using one new disposable guest and one new disposable registered identity:

- Google OAuth initiation returns a redirect to `accounts.google.com` with the project callback (three assertions). This does not prove completion of Google login.
- Public email signup is rejected with 403 by the configured Auth hook. This closes the question of whether the deployed hook is actually invoked. Email/password signup and self-service email recovery are intentionally unsupported under the runbook's OAuth-only policy, rather than missing features to enable.
- Guest and registered identities access the regional feed; the guest cannot delete an account.
- Refresh produces a usable token for profile and regional-feed access.
- Local logout invalidates both API access paths, and the logged-out refresh token cannot create another session.
- Deletion without the explicit confirmation is rejected and leaves the account usable.
- Confirmed deletion after fresh authentication succeeds, removes the disposable Auth user, rejects subsequent profile/feed/deletion replay requests, and reports its deliberate delayed cleanup.

Both fixture identities were removed. A read-only check of the deletion fixture's durable job confirms `resweep_waiting`, no error, completed initial storage cleanup, and a next eligible resweep at **2026-09-26 17:23:35 UTC** (22:53:35 IST). Final resweep completion has not yet been observed; its expiry guard was not bypassed. No customer identity, paid work, or purchase was used.

The public Auth settings report Google, Apple, and anonymous users enabled, email auto-confirm enabled, and phone auth disabled. Email enabled supports legacy/admin-created identities; the verified signup hook still rejects public email creation. These public settings do not expose the redirect allowlist, CAPTCHA/rates, or full session configuration.

A browser Apple OAuth initiation probe returns 400 with `Unsupported provider: missing OAuth secret`. Source inspection shows the shipped web login uses Google and iOS Apple login uses native `signInWithIdToken`; the browser flow is not the shipped Apple path. This is not evidence of a broken native sign-in. Native Apple login, reauthentication, and provider revocation remain unverified with a real test identity.

Hosted full-configuration inspection remains blocked: no Management API token is available in the task environment, and the Supabase dashboard opened at its sign-in page. No Auth configuration or credential was changed. Other remaining coverage in the main report (including real provider round trips, mobile deep links, admin session flows, and concurrency/race scenarios not represented by the completed tests) is not certified by these 22 checks.


## Continued validation — 2026-09-27 IST

The previous deletion fixture completed its final resweep at **2026-09-26 17:30:07 UTC (23:00:07 IST)**. The durable job is `completed` with no error. This closes the delayed-cleanup observation for that empty disposable account; it does not certify deletion of accounts with purchased resources or real provider identities.

Another **21 live merge/privilege assertions passed**. Ordinary authenticated clients were denied direct execution of `merge_guest_account`, `redeem_account_merge_ticket`, and `prepare_account_deletion` with SQLSTATE 42501, and denied reads of merge tickets/history, deletion jobs, and admin sessions. An expired ticket was rejected, registered callers could not prepare guest tickets, and guests could not redeem them.

Two distinct tickets for one disposable guest were concurrently redeemed by two disposable registered targets. Exactly one merge won and the other returned conflict; the guest was linked to the authenticated winner despite a conflicting target ID in the request body. There was one merge ledger row, concurrent retries returned `already_merged`, aggregate fixture balances were conserved, and the consumed guest lost regional-feed admission. All three identities were removed in guest-first order. No customer balances were edited, and no paid work was invoked. This is one controlled concurrency scenario, not an exhaustive race/load certification.

All **eight deployed admin action POST routes** rejected unauthenticated empty requests with HTTP 401 and private/no-store caching: moderation post reports, generations, subject reports, posts; contact; payouts; user sanctions; user credits. Positive admin login/logout/session-replay remains unverified.

Sanitized assertion evidence: [follow-up evidence](backend-section-01-followup-evidence.json). No new application or database defect was confirmed in these checks, so no new production change was needed. The deployed commit remains `c40fbe9`.

At the user's direction the hosted-settings review moved to Chrome. Chrome also displayed the Supabase sign-in page; the tab was left available for the user's sign-in. Full hosted configuration and real provider round trips remain pending.


## Hosted Auth review completed in Chrome — 2026-09-27 IST

The user signed into Chrome and the earlier dashboard-access blocker is resolved. Inspected the production branch of project `ildfmhozpibwiopeavfg` through the dashboard. No settings were saved and no secrets were revealed/copied.

| Control | Observed production setting |
| --- | --- |
| Session controls | Access token 3,600 seconds; refresh replay detection enabled; reuse interval 10 seconds; multiple sessions allowed; no absolute or inactivity session timeout |
| Abuse controls | CAPTCHA off; anonymous sign-ins 30/hour/IP; signup/signin 30/5 minutes/IP; token verification 30/5 minutes/IP; refresh 150/5 minutes/IP; IP forwarding off |
| Signup | New and anonymous users enabled; manual linking disabled; email confirmation disabled; Before User Created Postgres hook enabled (public email signup rejection already verified live) |
| Google | Enabled; client ID and masked OAuth secret configured; nonce checks retained; missing email disallowed |
| Apple | Enabled for native bundle `com.magicbooklet.mobile`; missing email disallowed; browser OAuth is not configured, consistent with the shipped native-only Apple flow |
| Password policy | Minimum 8; lowercase/uppercase/digits/symbols required; leaked-password protection on; secure email and password change on; requiring current password on change off |
| Email OTP | 3,600-second expiry; 8 digits. This configuration is not proof of mail delivery, which remains intentionally unsupported by the OAuth-only runbook policy. |
| Redirects | Site URL `https://magicbooklet.com`; exact apex/www callbacks; localhost and 127.0.0.1 callbacks plus `/**`; team-scoped Vercel preview wildcard; `magicbooklet://oauth/callback` |

The exact allowlist and other sanitized values are in the follow-up JSON. Local/preview redirects broaden the permitted destinations and should be reviewed as development access policy; this inspection did not establish that an unauthorized party controls any allowed destination.

### Open hardening item: anonymous-signup abuse protection

CAPTCHA is disabled while anonymous sign-in is enabled. This was already recorded in `docs/scaling-audit.md` and is reconfirmed here. The 30/hour/IP limit is a mitigation but does not provide a bot challenge. Supabase recommends CAPTCHA for anonymous sign-ins to limit account/MAU growth: https://supabase.com/docs/guides/auth/auth-anonymous . The production check is configuration evidence, not an attempted abuse/load test.

The mobile guest path calls `signInAnonymously()` without a CAPTCHA token (`ugc-mobile/lib/auth.tsx`). Do not turn on the dashboard requirement independently: prepare the client challenge/token flow and provider credentials, verify it, and coordinate with installed mobile versions before enforcing it. No setting was changed during this audit.

### Remaining sign-off boundaries

Confirmed fixes remain deployed. The current live evidence totals 17 original identity checks, 22 session/deletion checks, 21 merge/privilege checks, and 8 admin POST rejections. The hosted configuration review and the prior deletion fixture's final cleanup are now complete. The section still excludes real Google/Apple login completion, mobile deep-link return, Apple account revocation, positive admin login/logout/replay, JWT signing-key rotation, and broader lifecycle races. These require their respective test accounts/devices or a controlled test environment; configuration presence and mocked tests are not substitutes.


## Real Google and admin verification — 2026-09-27 IST

With explicit authorization, the existing Chrome account was signed out. Opening `/profile` then redirected to `/login?returnUrl=%2Fprofile`. Clicking Continue with Google completed the real provider flow and returned to the same profile, with its credit balance unchanged. Supabase Auth logs recorded a Google login in the test window. No content, purchases, or account deletion was performed on this account. Browser evidence is retained locally in `.audit-evidence/google-signin.png` and is not intended for publication.

The user explicitly authorized resetting the forgotten shared operator credential. A new random password was generated, its scrypt hash verified, and production `ADMIN_PASSWORD_HASH` updated; the configured local operator username was installed as production `ADMIN_USERNAME`. `ADMIN_SESSION_SECRET` and reviewer identity were not rotated. The plaintext credential is stored outside the repository in a private mode-0600 local file and was never printed into chat/logs.

Production release [36265315695](https://github.com/112kratoss/ugc-copy/actions/runs/36265315695) successfully deployed the environment change at the same quality-verified source commit `c40fbe9`. The protected production release gate passed.

All **12 authenticated admin checks passed**: new credential login; HttpOnly, Secure and SameSite=Lax cookie flags; authenticated admin page access; empty credit action reaching 400 input validation without a mutation; logout; clearing the cookie; revoked-cookie POST replay returning 401; revoked-cookie page access redirecting; correct login destination; and anonymous admin page redirect. The test session was logged out. Credential-version invalidation on password change remains source/test evidence; an old valid production credential session was unavailable for a before/after rotation probe.

The paired iPhone has Magic Booklet 0.1.7 (57) installed. iPhone Mirroring could not connect, so the user was asked to complete native Apple sign-in on the phone. No Apple login event was present in the inspected 19:08–19:28 UTC window. Native Apple completion and revocation remain pending and are not claimed passed.


## Native Apple sign-in confirmed — 2026-09-27 00:59 IST

The user reported completing sign-in on the iPhone. The corresponding 19:27:00–19:29:16 UTC backend window contains one `login` audit event with provider `apple`, plus an Auth `/token` login for provider `apple` returning HTTP 200. User-observed app success and backend authentication evidence now confirm the native Apple sign-in path. This supersedes the pending Apple-login status above. Apple provider revocation/account deletion, mobile Google deep-link return, and JWT-key rotation remain separate untested scenarios. No account deletion or provider revocation was attempted on the user's account.
