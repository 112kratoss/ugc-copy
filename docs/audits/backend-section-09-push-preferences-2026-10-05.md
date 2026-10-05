# Section 9K — preference and device-retirement controls

Baseline 2a0400c8. Seven actual local Auth/PostgREST/SQL cases pass without a
runtime change. Each creates two registered users through GoTrue and signs them
in independently; privileged registration establishes three isolated device
fixtures. Only the unrelated rate-limit helper is stubbed; verified auth,
preferences, token writes and RLS use the actual local services.

The cases prove:

- First-use preferences initialize with defaults; a later partial update preserves
  switches omitted from the request.
- Concurrent updates to different switches preserve both committed values.
- A pause committed after an empty preference read survives the delayed default
  initialization. A transport barrier controls that actual read/write race.
- The API derives the owner from verified auth despite a forged body userId;
  foreign preference reads return no rows and foreign upserts fail RLS.
- A named token takes precedence over a different device ID and allDevices;
  independent local and foreign device tokens remain active.
- Device-only retirement works and repeated retirement preserves disabled_at.
- allDevices alone is rejected and naming another account's token cannot retire it.

Users and token fixtures are removed after every case. No push provider is
contacted. Test source is mobile-push-preferences-postgrest.test.ts, with its
explicit local Vitest config. Test typechecking and scoped lint pass. Existing
preference/unregister service and route tests remain the normal CI contract gate.
Private evidence: .audit-evidence/backend-social/push-preferences-*.

This narrows JOB-03's remaining backend evidence gap; it does not establish
physical-device receipt delivery, OS permission changes, or every concurrent
sign-out/registration ordering. Notification aggregation/dedupe and history
read/update behavior still need reconciliation against existing evidence before
whole-obligation closure. No migration or runtime change is proposed here.
