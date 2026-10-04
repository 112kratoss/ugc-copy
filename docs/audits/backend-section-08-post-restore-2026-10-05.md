# Section 8F — recipe restoration and delayed archive requests

Two distinct failures were reproduced in the actual local PostgREST path used by
post archive/restore. Both prevent a restored post's recipe from being available.

## Service-role restore permission

Restoring a post with a recipe returned HTTP/service 500 with SQLSTATE 42501:
`permission denied for function post_resource_bundle_quality_issue_for`. The
post exposure trigger runs with the caller's privileges and calls a predicate
whose only executable role was postgres. Tests that ran mutations as postgres
missed this. Read-only production inspection on October 4 confirms the same
function grants and invoker trigger; no production mutation was made.

Migration `20261004161150_allow_service_recipe_exposure_quality_check.sql` grants
EXECUTE on this one predicate to service_role, retaining denial to anonymous and
authenticated roles. The trusted service already reads these rows. No function
body, trigger authority, client grant or quality rule changes.

The ten permanent pgTAP assertions reproduce five failures against the pre-fix
clean replay. They actually SET ROLE service_role for archive/restore, verify
valid recipes republish and unfinished recipes remain drafts, and check client
roles cannot call the helper. They run in the normal database CI job.

## Delayed archive overwrites a newer restore

After the permission fix, actual free and paid recipe cases still failed. The
archive statement commits and atomically demotes its recipe. While its HTTP
response is delayed, another request restores the post and republishes the
recipe. When the older archive service resumes, its separate legacy demotion
writes `draft` again, leaving an active public post with a draft recipe.

The service now leaves recipe exposure entirely to the existing post trigger.
Removing the extra write keeps archive/restore transactional and prevents the
older request from overwriting the newer restore. Four actual PostgREST controls
pass: sequential archive/restore, denied foreign actions, and delayed responses
for free and paid recipes. Before permission: three failures/one pass; after
permission alone: two race failures/two passes; after both changes: four pass.

## Validation and remaining work

Fifteen focused lifecycle/migration tests, test typecheck and scoped lint pass.
All transport fixture posts/users and rate entries are removed and user absence
checked. Test clients and database URLs require loopback. Development servers
are stopped. No real purchase, provider request or customer repair was performed.
Docker had stopped between sessions; the first resumed verification could not
connect, then passed after Docker was restarted. That infrastructure failure is
preserved separately from the product reproduction.

Clean migration replay, full SQL assertions, production migration plan, PR CI
and standard release verification remain pending. Private evidence is under
`.audit-evidence/backend-social/post-lifecycle-*` and `post-restore-*`.
SOCIAL-01 is failed until release; broader visibility/lifecycle coverage remains
open. Historical recipe status alone cannot attribute this race or justify
republishing drafts, so no blanket data repair is proposed.
