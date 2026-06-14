#!/bin/sh
# Registration: email + password only (no username / name fields on sign-up).
set -e

KC="/opt/keycloak/bin/kcadm.sh"
SERVER="${KEYCLOAK_URL:-http://127.0.0.1:8080}"
REALM="${KEYCLOAK_REALM:-legal-ai}"
ADMIN_USER="${KEYCLOAK_ADMIN:-admin}"
ADMIN_PASS="${KEYCLOAK_ADMIN_PASSWORD:?KEYCLOAK_ADMIN_PASSWORD required}"
PROFILE_FILE="${KEYCLOAK_USER_PROFILE_FILE:-/opt/keycloak/data/import/user-profile.json}"

echo "[keycloak-registration] authenticating to master as ${ADMIN_USER}..."
$KC config credentials --server "$SERVER" --realm master --user "$ADMIN_USER" --password "$ADMIN_PASS"

echo "[keycloak-registration] enabling registrationEmailAsUsername..."
$KC update "realms/${REALM}" -s registrationEmailAsUsername=true -s loginWithEmailAllowed=true

if [ -f "$PROFILE_FILE" ]; then
  echo "[keycloak-registration] applying user profile (email-only registration form)..."
  $KC update "realms/${REALM}/users/profile" -r "$REALM" -f "$PROFILE_FILE"
else
  echo "[keycloak-registration] warn: profile file not found at ${PROFILE_FILE}"
fi

echo "[keycloak-registration] done — registration uses email + password only"
