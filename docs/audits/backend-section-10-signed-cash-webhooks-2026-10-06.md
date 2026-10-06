# Section 10G — signed cash adjustment webhook lifecycle controls

Twelve actual local cases exercise refund, dispute opening and dispute won
through the production webhook route adapter, real HMAC verifier, webhook
service/dispatcher, PostgREST and PostgreSQL. Each event runs against four
creator states: live, fully deleted, failed Storage deletion and failed Auth
deletion. Orders are created through the authoritative quote and order-recording
RPCs and completed by the actual capture RPC. No payment provider is contacted.

Changing the signed body rejects the request with 400 before creating any
privileged client; the original entitlement remains. Correct signatures then
return 200 with private/no-store headers. Re-delivery returns 200 and produces
one adjustment bound to the correct payment/order. Refund and dispute fail the
order, remove the purchase and deny fresh application-issued file URLs. Dispute
won preserves paid status/entitlement and records manual review without automatic
regrant. Failed deletions resume through actual Auth cleanup; the preserved
manual-review buyer file remains readable with matching bytes after deletion.

All twelve targeted cases pass on Node 24.21.0 (7.45 seconds), and the expanded
49-case actual deletion/access suite passes with tracked Storage/Auth/SQL/job
fixture cleanup. Test types and scoped lint pass. No new runtime/schema change.
The 10E and 10F fixes are prerequisites for these positive cases.

The adapter runs in-process with the local admin-client constructor and an
isolated local webhook secret. This exercises real signature/dispatcher/SQL
behavior but does not certify Vercel networking, genuine provider delivery,
external retries or an installed-client purchase/restore. PAY-05 remains
external; broader PAY-04, MARKET-03, AUTH-03 and MEDIA rows stay open. Existing
signed capabilities remain subject to their TTL/cache lifecycle; denial here is
of new application-issued URLs. Release and independent unchanged-schema/live
verification remain for this evidence-only batch.
