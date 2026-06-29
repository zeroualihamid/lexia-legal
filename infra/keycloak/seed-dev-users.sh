#!/bin/sh
# Idempotent dev seed: realm user admin / admin with admin+superadmin roles.
set -e

KC="/opt/keycloak/bin/kcadm.sh"
SERVER="${KEYCLOAK_URL:-http://keycloak:8080}"
REALM="${KEYCLOAK_REALM:-legal-ai}"
ADMIN_USER="${KEYCLOAK_ADMIN:-admin}"
ADMIN_PASS="${KEYCLOAK_ADMIN_PASSWORD:?KEYCLOAK_ADMIN_PASSWORD required}"
DEV_USER="${LEXIA_DEV_USER:-admin}"
DEV_PASS="${LEXIA_DEV_PASSWORD:-admin}"
DEV_EMAIL="${LEXIA_DEV_EMAIL:-admin@lexia.local}"

echo "[keycloak-seed] waiting for Keycloak at ${SERVER}..."
for i in $(seq 1 60); do
  if $KC config credentials --server "$SERVER" --realm master --user "$ADMIN_USER" --password "$ADMIN_PASS" 2>/dev/null; then
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "[keycloak-seed] error: Keycloak not reachable at ${SERVER}" >&2
    exit 1
  fi
  sleep 2
done

echo "[keycloak-seed] authenticated to master as ${ADMIN_USER}..."

# Realm import can leave the "roles" client scope without protocol mappers, so JWTs
# lack realm_access.roles and the app treats everyone as PUBLIC.
ROLES_SCOPE_ID=$($KC get client-scopes -r "$REALM" -q name=roles --fields id --format csv --noquotes 2>/dev/null | tail -n 1 || true)
if [ -n "$ROLES_SCOPE_ID" ] && [ "$ROLES_SCOPE_ID" != "id" ]; then
  MAPPER_COUNT=$($KC get "client-scopes/${ROLES_SCOPE_ID}/protocol-mappers/models" -r "$REALM" --fields name --format csv --noquotes 2>/dev/null | grep -vc '^name$' || echo 0)
  if [ "$MAPPER_COUNT" -lt 1 ]; then
    echo "[keycloak-seed] restoring missing roles protocol mappers..."
    $KC create "client-scopes/${ROLES_SCOPE_ID}/protocol-mappers/models" -r "$REALM" -f - <<'EOF'
{
  "name": "realm roles",
  "protocol": "openid-connect",
  "protocolMapper": "oidc-usermodel-realm-role-mapper",
  "consentRequired": false,
  "config": {
    "user.attribute": "foo",
    "access.token.claim": "true",
    "claim.name": "realm_access.roles",
    "jsonType.label": "String",
    "multivalued": "true"
  }
}
EOF
    $KC create "client-scopes/${ROLES_SCOPE_ID}/protocol-mappers/models" -r "$REALM" -f - <<'EOF'
{
  "name": "client roles",
  "protocol": "openid-connect",
  "protocolMapper": "oidc-usermodel-client-role-mapper",
  "consentRequired": false,
  "config": {
    "user.attribute": "foo",
    "access.token.claim": "true",
    "claim.name": "resource_access.${client_id}.roles",
    "jsonType.label": "String",
    "multivalued": "true"
  }
}
EOF
  fi
fi

if [ -f /tmp/configure-registration.sh ]; then
  KEYCLOAK_USER_PROFILE_FILE="${KEYCLOAK_USER_PROFILE_FILE:-/tmp/user-profile.json}" \
    sh /tmp/configure-registration.sh || true
fi

# Dev admin must log in as admin/admin. registrationEmailAsUsername forces the
# username to equal email on API-created users; disable it for the seed user.
echo "[keycloak-seed] ensuring username-based login for dev admin..."
$KC update "realms/${REALM}" -s registrationEmailAsUsername=false -s loginWithEmailAllowed=true

USER_ID=$($KC get users -r "$REALM" -q "username=$DEV_USER" --fields id --format csv --noquotes 2>/dev/null | tail -n 1 || true)
if [ -z "$USER_ID" ] || [ "$USER_ID" = "id" ]; then
  USER_ID=$($KC get users -r "$REALM" -q "email=$DEV_EMAIL" --fields id --format csv --noquotes 2>/dev/null | tail -n 1 || true)
fi

if [ -n "$USER_ID" ] && [ "$USER_ID" != "id" ]; then
  CURRENT_USERNAME=$($KC get "users/${USER_ID}" -r "$REALM" --fields username --format csv --noquotes 2>/dev/null | tail -n 1 || true)
  if [ "$CURRENT_USERNAME" != "$DEV_USER" ]; then
    echo "[keycloak-seed] recreating user (was ${CURRENT_USERNAME}, want ${DEV_USER})..."
    $KC delete "users/${USER_ID}" -r "$REALM"
    USER_ID=""
  fi
fi

if [ -z "$USER_ID" ] || [ "$USER_ID" = "id" ]; then
  echo "[keycloak-seed] creating user ${DEV_USER} in realm ${REALM}..."
  $KC create users -r "$REALM" \
    -s username="$DEV_USER" \
    -s enabled=true \
    -s email="$DEV_EMAIL" \
    -s firstName=Admin \
    -s lastName=Lexia \
    -s emailVerified=true
  USER_ID=$($KC get users -r "$REALM" -q "username=$DEV_USER" --fields id --format csv --noquotes 2>/dev/null | tail -n 1 || true)
fi

if [ -n "$USER_ID" ] && [ "$USER_ID" != "id" ]; then
  echo "[keycloak-seed] ensuring user ${DEV_USER} is enabled (id=${USER_ID})..."
  $KC update "users/${USER_ID}" -r "$REALM" \
    -s enabled=true \
    -s emailVerified=true \
    -s email="$DEV_EMAIL" \
    -s username="$DEV_USER" \
    -s firstName=Admin \
    -s lastName=Lexia
fi

if [ -z "$USER_ID" ] || [ "$USER_ID" = "id" ]; then
  echo "[keycloak-seed] error: could not resolve user id for ${DEV_USER}" >&2
  exit 1
fi

echo "[keycloak-seed] setting password for ${DEV_USER}..."
$KC set-password -r "$REALM" --userid "$USER_ID" --new-password "$DEV_PASS" --temporary=false

for role in admin superadmin pro user; do
  if $KC get roles -r "$REALM" -q "name=$role" --fields name --format csv --noquotes 2>/dev/null | grep -q "^$role$"; then
    $KC add-roles -r "$REALM" --uusername "$DEV_USER" --rolename "$role" 2>/dev/null || \
      $KC add-roles -r "$REALM" --uid "$USER_ID" --rolename "$role" 2>/dev/null || true
  fi
done

# Allow redirect URIs for /lexia when realm was imported before this path existed.
REDIRECT_URIS='["http://localhost/lexia/*","http://localhost/lexia","http://localhost/lexia/admin","http://localhost/lexia/admin/*","http://localhost/*","http://localhost:3000/*","http://localhost:3000/lexia","http://localhost:3000/lexia/*","http://localhost:3000/lexia/admin","http://localhost:3000/lexia/admin/*","http://127.0.0.1:3000/*","http://127.0.0.1:3000/lexia","http://127.0.0.1:3000/lexia/*","http://localhost:5175/*","http://127.0.0.1:5175/*"]'
WEB_ORIGINS='["http://localhost","http://localhost:3000","http://127.0.0.1:3000","http://localhost:5175","http://127.0.0.1:5175"]'
if [ -n "${LEXIA_PUBLIC_URL:-}" ]; then
  BASE="${LEXIA_PUBLIC_URL%/}"
  REDIRECT_URIS=$(printf '%s' "$REDIRECT_URIS" | sed "s/]$/,\"${BASE}/lexia/*\",\"${BASE}/lexia\",\"${BASE}/lexia/admin\",\"${BASE}/lexia/admin/*\",\"${BASE}/*\"]/")
  WEB_ORIGINS=$(printf '%s' "$WEB_ORIGINS" | sed "s/]$/,\"${BASE}\"]/")
  echo "[keycloak-seed] including public URL ${BASE} in frontend client redirects"
fi
$KC update clients -r "$REALM" -q clientId=legal-ai-frontend \
  -s 'rootUrl=http://localhost/lexia' \
  -s 'baseUrl=http://localhost/lexia' \
  -s "redirectUris=${REDIRECT_URIS}" \
  -s "webOrigins=${WEB_ORIGINS}" \
  2>/dev/null || echo "[keycloak-seed] warn: could not patch legal-ai-frontend client (may need manual update)"

echo "[keycloak-seed] done — admin panel: http://localhost:3000/lexia/admin"
echo "[keycloak-seed] credentials: ${DEV_USER} / ${DEV_PASS}"
