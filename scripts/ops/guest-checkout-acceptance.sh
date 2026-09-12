#!/bin/bash
# End-to-end acceptance walk of the App Review 5.1.1(v) flow.
#
# Drives the same HTTP calls the mobile app makes, against the local stack:
# real routes, real migrations, real merge. The only thing not covered is RN
# rendering (unit-tested separately) and the StoreKit purchase itself, which
# cannot run outside a real device — so the purchase is simulated by crediting
# the guest exactly as a verified receipt would.
set -uo pipefail

ENVF="${SUPABASE_ENV_FILE:-$(mktemp -t supabase-local-env)}"
if [ ! -s "$ENVF" ]; then
  npx --yes supabase@2.75.0 status -o env > "$ENVF" 2>/dev/null \
    || { echo "Could not read local Supabase status. Start the stack first."; exit 1; }
fi
set -a; . "$ENVF"; set +a
SB="$API_URL"
API="${ACCEPTANCE_API_BASE_URL:-http://127.0.0.1:3000}"
AK="$PUBLISHABLE_KEY"
PSQL=(docker exec -i supabase_db_magicbooklet psql -U postgres -d postgres -tAc)

pass=0; fail=0
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; pass=$((pass+1));
  else echo "  FAIL  $1 — expected '$3', got '$2'"; fail=$((fail+1)); fi
}

echo "=============================================================="
echo " 1. Fresh install: guest identity, no registration"
echo "=============================================================="
"${PSQL[@]}" "DELETE FROM auth.users;" >/dev/null
G=$(curl -s -X POST "$SB/auth/v1/signup" -H "apikey: $AK" -H "Content-Type: application/json" -d '{}')
GTOK=$(printf '%s' "$G" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))')
GID=$(printf '%s' "$G" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("user",{}).get("id",""))')
check "guest session issued" "$([ -n "$GTOK" ] && echo yes || echo no)" "yes"
check "guest is anonymous" "$("${PSQL[@]}" "SELECT is_anonymous FROM auth.users WHERE id='$GID';")" "t"
check "guest starts with zero credits" "$("${PSQL[@]}" "SELECT credits FROM public.profiles WHERE id='$GID';")" "0"

echo
echo "=============================================================="
echo " 2. Guest cannot mint free credits"
echo "=============================================================="
"${PSQL[@]}" "UPDATE public.profiles SET username='realish-name', display_name='Realish' WHERE id='$GID';" >/dev/null
WC=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/credits/welcome/claim" \
  -H "Authorization: Bearer $GTOK" -H "Content-Type: application/json" -d '{"sourceSurface":"mobile"}')
check "welcome-credit claim refused for guest" "$WC" "403"
check "balance still zero after claim attempt" "$("${PSQL[@]}" "SELECT credits FROM public.profiles WHERE id='$GID';")" "0"

echo
echo "=============================================================="
echo " 3. Registered-only surfaces stay closed to guests"
echo "=============================================================="
PF=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$API/api/profile" \
  -H "Authorization: Bearer $GTOK" -H "Content-Type: application/json" -d '{"username":"squatted","displayName":"Squatter"}')
check "profile mutation refused for guest" "$PF" "403"

echo
echo "=============================================================="
echo " 4. Purchase (simulated) then guest spends its own credits"
echo "=============================================================="
"${PSQL[@]}" "UPDATE public.profiles SET credits=500 WHERE id='$GID';" >/dev/null
check "guest holds purchased credits" "$("${PSQL[@]}" "SELECT credits FROM public.profiles WHERE id='$GID';")" "500"
GEN=$("${PSQL[@]}" "SELECT public.start_generation('$GID',285,'veo-3-1','a guest video','video',8,NULL,NULL,NULL,NULL)->>'status';")
check "guest can start a paid generation" "$GEN" "started"
check "credits debited by the generation" "$("${PSQL[@]}" "SELECT credits FROM public.profiles WHERE id='$GID';")" "215"
check "creation belongs to the guest" "$("${PSQL[@]}" "SELECT count(*) FROM public.generations WHERE user_id='$GID';")" "1"

echo
echo "=============================================================="
echo " 5. Guest prepares to register (merge ticket)"
echo "=============================================================="
TK=$(curl -s -X POST "$API/api/account/merge/prepare" -H "Authorization: Bearer $GTOK" -H "Content-Type: application/json" -d '{}')
TICKET=$(printf '%s' "$TK" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("ticket",""))')
check "ticket minted for guest" "$(printf '%s' "$TICKET" | grep -cE '^[a-f0-9]{64}$')" "1"
check "only the hash is stored" "$("${PSQL[@]}" "SELECT count(*) FROM public.account_merge_tickets WHERE ticket_hash='$TICKET';")" "0"
check "a ticket row exists for this guest" "$("${PSQL[@]}" "SELECT count(*) FROM public.account_merge_tickets WHERE guest_user_id='$GID';")" "1"

echo
echo "=============================================================="
echo " 6. They create an account"
echo "=============================================================="
EMAIL="acceptance-$(printf '%s' "$GID" | cut -c1-8)@example.test"
R=$(curl -s -X POST "$SB/auth/v1/signup" -H "apikey: $AK" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Str0ng-Passw0rd!\"}")
RTOK=$(printf '%s' "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))')
RID=$(printf '%s' "$R" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("user",{}).get("id",""))')
check "registered account created" "$([ -n "$RTOK" ] && echo yes || echo no)" "yes"
check "registered account is not anonymous" "$("${PSQL[@]}" "SELECT is_anonymous FROM auth.users WHERE id='$RID';")" "f"

echo
echo "=============================================================="
echo " 7. Redeem: credits and creations carry over"
echo "=============================================================="
M=$(curl -s -X POST "$API/api/account/merge" -H "Authorization: Bearer $RTOK" \
  -H "Content-Type: application/json" -d "{\"ticket\":\"$TICKET\"}")
check "merge reported success" "$(printf '%s' "$M" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status",""))')" "merged"
check "credits landed on the account" "$("${PSQL[@]}" "SELECT credits FROM public.profiles WHERE id='$RID';")" "215"
check "guest row drained" "$("${PSQL[@]}" "SELECT credits FROM public.profiles WHERE id='$GID';")" "0"
check "guest row linked" "$("${PSQL[@]}" "SELECT merged_into_user_id='$RID' FROM public.profiles WHERE id='$GID';")" "t"
check "financial/creation rows keep the guest UUID" "$("${PSQL[@]}" "SELECT count(*) FROM public.generations WHERE user_id='$GID';")" "1"
check "account can act for the guest identity" "$("${PSQL[@]}" "SELECT count(*) FROM public.linked_account_ids('$RID');")" "2"

echo
echo "=============================================================="
echo " 8. The creation is visible to the new account"
echo "=============================================================="
LIST=$(curl -s "$API/api/generations?limit=20" -H "Authorization: Bearer $RTOK")
check "linked creation appears in the library" \
  "$(printf '%s' "$LIST" | python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: print("parse-error"); raise SystemExit
print(len(d.get("generations",[])))' 2>/dev/null)" "1"

echo
echo "=============================================================="
echo " 9. Retry safety and spent-session handling"
echo "=============================================================="
M2=$(curl -s -X POST "$API/api/account/merge" -H "Authorization: Bearer $RTOK" \
  -H "Content-Type: application/json" -d "{\"ticket\":\"$TICKET\"}")
check "replayed redemption is idempotent" "$(printf '%s' "$M2" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status",""))')" "already_merged"
check "no second payout" "$("${PSQL[@]}" "SELECT credits FROM public.profiles WHERE id='$RID';")" "215"
SM=$(curl -s -X POST "$API/api/account/merge/prepare" -H "Authorization: Bearer $GTOK" -H "Content-Type: application/json" -d '{}')
check "spent guest session rejected" "$(printf '%s' "$SM" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("code",""))')" "SESSION_MERGED"

echo
echo "=============================================================="
echo " Cleanup"
echo "=============================================================="
# Leave the database as this script found it. Without this, the rows created
# here (a 285-credit generation, rate-limit counters, onboarding events) leak
# into `supabase test db` — backend_cost_aggregates.test.sql aggregates over
# whole tables rather than isolating its fixtures, so it fails on any residue.
"${PSQL[@]}" "DELETE FROM auth.users WHERE id IN ('$GID','$RID');" >/dev/null
"${PSQL[@]}" "DELETE FROM public.backend_rate_limits WHERE scope IN ('account:merge-guest','onboarding:event','credits:welcome-claim','owner-generations:read','showcase-feed:for-you-read');" >/dev/null
"${PSQL[@]}" "DELETE FROM public.onboarding_events;" >/dev/null
echo "  removed the accounts and counters this run created"

echo
echo "=============================================================="
printf " RESULT: %d passed, %d failed\n" "$pass" "$fail"
echo "=============================================================="
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
