# Invoker trigger helper review — October 5, 2026

After the service-role recipe restore failure, a scoped local catalog review
checked explicit `public.function(...)` calls from invoker functions against
service-role EXECUTE grants. The clean replay contains 327 public functions and
118 noninternal triggers on public/auth/storage tables. This is a conservative
name-based review, not a complete SQL dependency graph: overload resolution,
unqualified calls, dynamic SQL, other schemas and nested role transitions still
require separate evidence under MAP-02/DB-03.

After 8F, one candidate remains: `reject_post_resource_bundle_revision_rewrite()`
calls the private `post_resource_bundle_revision_content_matches(...)` helper
when `bundle_id` changes to null. The only trigger binding is BEFORE UPDATE on
`post_resource_bundle_revisions`. The service role has neither table-level nor
column-level UPDATE permission there. The table's bundle foreign key uses
ON DELETE SET NULL.

Actual SQL under service_role confirms direct revision rewrite is denied with
42501 while deleting the bundle succeeds and leaves the existing revision with
null bundle_id. This exercises the foreign-key action and immutable-revision
trigger together, not just a metadata inference. The transaction was rolled back
and the fixture user was independently checked absent. No new defect or permission
change is justified by this candidate.

Private scripts/results: `.audit-evidence/backend-social/invoker-helper-review.*`
and `invoker-revision-control.*`. No production mutation. This evidence does not
close the broader invoker/definer or account deletion obligations.
