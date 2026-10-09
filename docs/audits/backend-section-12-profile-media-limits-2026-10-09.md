# Section 12S — profile-media rate and admission failures

Five additional actual local Storage/PostgREST/SQL cases pass, bringing the
permanent profile-media suite to thirteen. No application or schema change was
needed. These extend the [12O ownership and recovery controls](backend-section-12-profile-media-controls-2026-10-09.md).

The signing case issues thirty capabilities through the real service. The
thirty-first call returns 429 with the rate-limit contract, makes no Storage
signing request, and creates no extra reservation. The other owner can still sign
using its independent rate bucket. Capabilities stay in memory and are never
written to the report or evidence.

The cleanup case succeeds thirty times, then recreates the exact disposable
object with the service client. The thirty-first cleanup returns 429 before
Storage deletion and leaves that object present. An unrelated owner's cleanup
still succeeds, and its existing object is preserved.

Three transport-failure cases reject the real client's rate-limit RPC (sign and
cleanup) or upload-eligibility RPC. Each returns 500, creates no reservation or
signed capability, and makes no deletion. The object remains present. Removing
the fault permits a successful retry. These are local HTTP failures against real
services and durable state, not mocked successful admission results.

Every case verifies exact user/reservation/object/rate-row cleanup and reconciled
upload counters. The first run could not connect because Docker was stopped;
it wrote no fixture. Restarting existing volumes without reset allowed all
thirteen cases to pass in 11.65 seconds. Private logs are `profile-media-limits-*`
under `.audit-evidence/backend-social/`.

SOCIAL-04/MEDIA-08/09 remain open for their broader route, hosted, publication
and lifecycle requirements. Candidate CI and release inclusion remain pending.
