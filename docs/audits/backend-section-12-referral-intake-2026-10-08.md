# Section 12E — referral intake and ownership

Status: 44 actual local Auth/PostgREST/SQL controls pass. No application defect
was reproduced and no runtime or schema change is proposed. Quality now runs
these controls in its isolated Supabase API job.

The suite exercises the four real route exports together with the production
proxy's shared identity-admission evaluator. Auth users, guest sessions, signed
tokens, revoked sessions, rate-limit buckets, referral rows and concurrent SQL
transactions are real. The only network boundary replacement forbids destinations
outside the isolated local Supabase API; business logic and RPCs are not mocked.

| Entry point | Verified behavior |
| --- | --- |
| `GET /api/referrals/me` | Unsigned, real guest and revoked-session rejection; own dashboard counts and unrelated account isolation |
| `POST /api/referrals/link` | Seven malformed/nonobject bodies rejected without state; authoritative owner despite a supplied other user ID; six concurrent requests converge on one code; external destination falls back to `/create`; exact 30-request limit and retry metadata |
| `POST /api/referrals/visit` | Seven malformed/nonobject bodies rejected; unsigned web/mobile intake; correct web/native channel; preserved first visit across a different later link; HttpOnly web cookie; exact 60-request limit |
| `POST /api/referrals/claim` | Seven malformed/nonobject bodies rejected; unsigned, guest and revoked-session rejection; caller-bound new-account claim; cookie claim and malformed encoding; replay without duplicate attribution; self/existing/expired/disabled rejection; two competing accounts produce one attribution; exact 20-request limit |
| Direct database access | Authenticated calls to the four privileged intake/dashboard RPCs fail with permission denied; private referral-code reads disclose no rows |

Intake creates no financial transactions or referral rewards. Each case checks
that invariant and removes only its exact owned users, codes, visits, attributions
and rate buckets. Independent post-cleanup SQL within every case confirms zero
owned rows. Typechecking of the full test project and scoped lint also pass.

Initial test development exposed two invalid fixtures: expiry earlier than the
visit's own timestamp, and disabled code without a reason. Both database
constraints correctly rejected those fixtures. A first admission wrapper also
transferred the request body into another Request, causing valid inputs to look
empty. The wrapper now forwards only URL/method/headers to admission. These logs
are retained as harness failures, not application findings.

This is route/admission/SQL evidence, not a browser or installed-native-app test.
It does not certify the complete Next server, CORS, mobile deep links, registration
callbacks, financial reward settlement, provider delivery, or arbitrary historical
repair. Existing 12B/12C financial lifecycle evidence remains separate. MAP-02,
AUTH-03 and PAY-04 retain their broader open obligations.

Private logs: `.audit-evidence/backend-social/referral-intake-initial.log`,
`referral-intake-local.log`, `referral-intake-expanded.log`,
`referral-intake-final.log` and `referral-intake-types.log`.
