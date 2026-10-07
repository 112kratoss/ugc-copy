# Section 12A — commerce request parsing

The native marketplace order handler returns 500 for null, malformed and empty
JSON. Resource-bundle order parsing throws uncaught SyntaxError for malformed
and empty JSON; a null-root request unnecessarily reaches lookup and returns 404
for the deliberately missing resource. Three verification handlers (credit,
marketplace and resource-bundle) also return 500 or throw for malformed/empty
JSON, while their null-object normalization controls already pass.

These are **eleven actual exception/500 cases**, plus the null resource-order
validation-order case. Reproduction uses native Request/NextResponse, real local
GoTrue bearer tokens, PostgREST and PostgreSQL. No payment provider is contacted.
The initial resource verification URL omitted its post ID; it was corrected to
the actual route shape and all six verification failures reproduced again
before changes. Private before evidence:
`.audit-evidence/backend-social/marketplace-order-inputs-before.log` and
`payment-verify-inputs-correct-path-before.log`.

The marketplace order adapter now admits only object roots before existing
required-field validation. Resource order input is typed unknown and validates
its object root before lookup. Its JSON SyntaxError returns a private 400.
The verification services convert only JSON SyntaxError into their existing
missing-parameter 400; other read errors retain their previous error path.
Auth ordering, rate limits, ownership, valid object processing, provider signatures,
order identity, settlement, pricing and replay behavior are preserved. No
migration or mobile runtime change is included.

All **97 actual cases pass**, comprising the earlier 56 onboarding/admin-credit/
credit-order cases and 41 commerce controls. The new controls cover seven roots
on each of five routes, unsigned ordering on all five, and a valid resource-order
object returning the existing missing-resource 404. Independent SQL checks find
zero fixture marketplace/resource orders, purchase transactions and checkout
intents before and after cleanup, along with zero grants/fingerprints and usage.
Owned Auth/profile/session/rate/onboarding/adjustment rows are independently zero
after cleanup. Evidence: `commerce-inputs-final.log`.

All **91 focused cases across eleven files**, app/test typechecks, scoped lint and
diff checks pass. The resource-order test helper explicitly retains its valid
object input type after the production callback becomes unknown. Existing
signature, ownership, provider error, settlement and mobile contract checks pass.
Evidence: `commerce-inputs-focused-final.log` and adjacent type/lint logs.
The actual suite already runs sequentially in Quality; exact-head/main CI,
verified #401 parent, standard deployment and independent readback remain.

MAP-02 retains this method finding until release; its wider behavior map stays
open. These controls do not certify real provider delivery, installed-client
purchasing or historical reconciliation. All fixture transport is restricted
to the dedicated loopback stack. No production balance, provider order or charge
was changed. The Supabase skill's current changelog and Auth guide were reviewed;
this change introduces no new SDK/API, schema or privilege behavior.
