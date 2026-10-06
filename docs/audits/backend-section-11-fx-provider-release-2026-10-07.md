# Section 11A — FX provider validation release

PR [#380](https://github.com/112kratoss/ugc-copy/pull/380) passed exact-head
Quality 37510388702 on 6e67f92937586b14c7a5423293beac39a5494fea. With
mobile-store release idle, it merged October 6 18:40:11 UTC as
eac420e23b42e804f0307c5c0285b770eacae17b. Exact-main Quality 37513081761 and
standard production release 37514320846 passed. Another actor's immediately
preceding mobile change (#378) is preserved in this main revision.

Independent verification at 2026-10-06T19:01:32.531Z confirms the exact live
build, unchanged public schema fingerprint and all 110 security advisor
findings unchanged. Feed/admin/unsigned generation-webhook checks return
200/307/401. Live FX returns HTTP 200 with all six supported rates finite and
positive and client-visible `Cache-Control: public`. Vercel removes the
`s-maxage` directive from that response; the live header alone does not certify
the effective edge TTL. Candidate adapter/provider HTTP checks verify the
hourly cache policy and no-store invalid-payload response.

The released runtime rejects incomplete or invalid supported rates; 28 actual
loopback provider HTTP controls and 54 focused cases pass. The production
provider returned healthy data; no malformed payload was injected into
production and no incorrect charge or customer incident is established. No
schema change, paid provider call or customer repair was performed. Private
evidence is under `.audit-evidence/backend-social/fx-provider-release/`.

This release also includes 10I's eight signed refund acknowledgement/retry
controls, with all 61 actual local deletion/access cases passing. Their fixture
cleanup reads back empty. Operations diagnostics/admin authorization and the
new overview purchase-counter findings remain separately open. OPS-04 stays
failed until those known defects are released; the full audit is in progress.
