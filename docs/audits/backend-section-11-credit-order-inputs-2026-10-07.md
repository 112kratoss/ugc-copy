# Section 11Z — credit-order JSON roots

Native `/api/razorpay/order` requests containing null, malformed JSON or an empty
body return 500 before plan validation. All three fail with a real disposable
GoTrue bearer attached and without it: **six failures**, with eight other
nonobject-root controls passing. The intended validation order is already pinned
by focused tests: missing/invalid plans are rejected before Auth, service clients
or provider work. This is not evidence of a successful unsigned purchase.

The adapter now decodes an unknown root, admits only a nonarray object and sends
invalid roots through its existing private 400 missing-plan response. Valid object
plan lookup, prototype-name rejection, registered-user admission, provider request
context and order/transaction logic retain their behavior. No migration, pricing,
provider configuration, mobile runtime or historical balance change is included.

All **56 actual native/Auth/session/PostgREST/SQL cases pass**: 42 earlier
onboarding/admin-credit controls and fourteen new signed-header/unsigned root
controls. Before and after cleanup, independent SQL asserts zero owned purchase
transactions and Razorpay checkout intents, alongside exact-ID Auth/profile,
session, rate, onboarding, adjustment, grant/fingerprint and usage cleanup. Invalid
order roots never reach the Auth or provider call; no real provider order, charge
or customer balance is changed. All **33 focused** route/order/provider-context
controls, app/test types, scoped lint and diff checks pass.

The initial native request URL was corrected to the verified route path and the
baseline rerun before changing the adapter. Authoritative before/after evidence:
`.audit-evidence/backend-social/credit-order-inputs-correct-path-before.log`,
`credit-order-inputs-after.log` and `credit-order-inputs-focused.log`.
The shared actual suite already runs sequentially in Quality. Exact candidate/
main CI, standard release and independent source/schema/live verification remain.
MAP-02 retains this reproduced method finding until release. Genuine provider
delivery, deployed positive purchasing and the broader method matrix remain open.
