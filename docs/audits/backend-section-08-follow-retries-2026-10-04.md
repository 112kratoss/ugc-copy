# Section 8A — concurrent follow retries

October 4, 2026. Obligation: SOCIAL-02. Candidate based on main
`4e4186a5ac0fa08e1aa7897ee0027f5672f1f674` in the existing audit checkout.

## Reproduction

Two actual service calls through local PostgREST read no follow row. A fetch
barrier allows their INSERT requests to reach the database only after both reads.
PostgreSQL keeps one correct row, but one caller receives a 500 for the unique
constraint conflict. This is a false failure for the caller's explicit
`following: true` intent. The valid baseline has one failing concurrency case
and two passing controls (sequential follow/unfollow retry and block/refollow).
An earlier probe had an incorrect cleanup column name; its results are not used
as evidence. The corrected baseline log is retained separately.

## Change

On SQLSTATE 23505 only, the service reads the same follower/creator pair again.
If that row exists and the read succeeds, it returns `following: true`. The
request that successfully inserted the row owns notification scheduling. Other
insert failures and an unconfirmed duplicate still return 500. This does not
suppress real failures or schedule a second notification for the race loser.
No database migration or client contract change is needed.

## Validation and limits

- Three permanent real local SQL/PostgREST cases pass: sequential retry,
  concurrent retry (one saved row and one notification task), and block deletion
  followed by denied refollow. Fixture users are removed and read back as absent.
- 35 focused service/route tests pass, including confirmed duplicate success and
  rejection of unconfirmed 23505, foreign-key and cancellation errors.
- App/test typechecks, scoped ESLint and whitespace validation pass.
- No notification tasks are executed by the integration fixture. This verifies
  scheduling, not actual push delivery. No production mutations or paid calls.

Run the opt-in integration suite against the isolated local API and database:

```sh
AUDIT_STORAGE_CONFIG=.audit-evidence/backend-storage/local-status.json \
SUPABASE_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres \
npx vitest run --config vitest.social-postgrest.config.ts
```

Both endpoints are loopback-guarded. The config includes local credentials and
must remain private. Normal CI runs service regressions; it skips the opt-in
PostgREST cases. Private before/after logs are under
`.audit-evidence/backend-social/`. These checks exercise the service and actual
PostgREST/database, not the outer route's JWT admission or all social lifecycle
combinations. SOCIAL-02 remains failed until candidate CI/release is verified,
then returns to untested for its broader remaining scope.
