# Section 10I — signed cash refund delivery failures

Eight actual local cases deliver a signed refund with an injected PostgREST
failure before its authoritative RPC commits, or a lost acknowledgement after
the RPC has committed. Each runs against a live creator, deleted creator, failed
Storage deletion and failed Auth deletion. The route uses the real HMAC verifier,
webhook service/dispatcher, local PostgREST and PostgreSQL. No provider is called.

Before commit, the first 500 leaves the order paid and entitlement present.
After commit, the first 500 leaves the order failed, entitlement removed and one
completed adjustment. Both durably record the correct processing-failure event.
A signed retry followed by another replay returns 200, produces one adjustment
and one surviving seller-wallet reversal, leaves the wallet at zero, and denies
new file URL issuance. Failed deletion jobs then resume through Auth cleanup.
Deleted creators have no surviving wallet row; that case checks order and
entitlement conservation instead of fabricating a wallet expectation.

All eight targeted cases pass on Node 24.21.0 (4.24 seconds). All 61 actual local
delete/access cases pass (168.69 seconds), with tracked fixture cleanup. Test
types and scoped lint pass. No runtime/schema change.

The transport wrapper asks local PostgREST to return inserted telemetry IDs;
event fields and the real durable insertion are unchanged. Only those exact
fixture IDs are deleted, with independent empty readback. Financial/Auth/Storage
fixture cleanup remains scoped by the tracked IDs and object paths.

This is actual local acknowledgement-loss/retry evidence, not genuine Razorpay
delivery, Vercel networking or installed-client checkout/restore. It does not
close PAY-05 or the broader payment/job matrices. Release verification remains
for this evidence batch; the 10H runtime fix is its parent candidate.
