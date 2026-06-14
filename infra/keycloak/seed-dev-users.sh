#!/bin/sh
# Idempotent dev seed: realm user admin / admin with admin+superadmin roles.
set -e

KC="/opt/keycloak/bin/kcadm.sh"
SERVER="${KEYCLOAK_URL:-http://127.0.0.1:8080}"
REALM="${KEYCLOAK_REALM:-legal-ai}"
ADMIN_USER="${KEYCLOAK_ADMIN:-admin}"
ADMIN_PASS="${KEYCLOAK_ADMIN_PASSWORD:?KEYCLOAK_ADMIN_PASSWORD required}"
DEV_USER="${LEXIA_DEV_USER:-admin}"
DEV_PASS="${LEXIA_DEV_PASSWORD:-admin}"

echo "[keycloak-seed] authenticating to master as ${ADMIN_USER}..."
$KC config credentials --server "$SERVER" --realm master --user "$ADMIN_USER" --password "$ADMIN_PASS"

if [ -f /tmp/configure-registration.sh ]; then
  KEYCLOAK_USER_PROFILE_FILE="${KEYCLOAK_USER_PROFILE_FILE:-/tmp/user-profile.json}" \
    sh /tmp/configure-registration.sh || true
fi

USER_ID=$($KC get users -r "$REALM" -q "username=$DEV_USER" --fields id --format csv --noquotes 2>/dev/null | tail -n 1 || true)
if [ -z "$USER_ID" ] || [ "$USER_ID" = "id" ]; then
  echo "[keycloak-seed] creating user ${DEV_USER} in realm ${REALM}..."
  $KC create users -r "$REALM" \
    -s username="$DEV_USER" \
    -s enabled=true \
    -s email="${DEV_USER}@lexia.local" \
    -s firstName=Admin \
    -s lastName=Lexia \
    -s emailVerified=true
  USER_ID=$($KC get users -r "$REALM" -q "username=$DEV_USER" --fields id --format csv --noquotes | tail -n 1)
fi

echo "[keycloak-seed] setting password for ${DEV_USER}..."
$KC set-password -r "$REALM" --username "$DEV_USER" --new-password "$DEV_PASS" --temporary=false

for role in admin superadmin pro user; do
  if $KC get roles -r "$REALM" -q "name=$role" --fields name --format csv --noquotes 2>/dev/null | grep -q "^$role$"; then
    $KC add-roles -r "$REALM" --uusername "$DEV_USER" --rolename "$role" 2>/dev/null || true
  fi
done

# Allow redirect URIs for /lexia when realm was imported before this path existed.
$KC update clients -r "$REALM" -q clientId=legal-ai-frontend \
  -s 'rootUrl=http://localhost/lexia' \
  -s 'baseUrl=http://localhost/lexia' \
  -s 'redirectUris=["http://localhost/lexia/*","http://localhost/lexia","http://localhost/*","http://localhost:3000/*","http://127.0.0.1:3000/*"]' \
  -s 'webOrigins=["http://localhost","http://localhost:3000","http://127.0.0.1:3000"]' \
  2>/dev/null || echo "[keycloak-seed] warn: could not patch legal-ai-frontend client (may need manual update)"

echo "[keycloak-seed] done — sign in at http://localhost/lexia/admin with ${DEV_USER} / ${DEV_PASS}"
