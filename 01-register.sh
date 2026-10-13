#!/usr/bin/env bash
# Passo 1 – Partner token + registrazione del dominio dell'app sulla Fleet API.
# Prerequisito: public-key.pem pubblicata dal server su https://$TESLA_DOMAIN/.well-known/...
# Non stampa mai client_secret né token.
source "$(dirname "$0")/lib/common.sh"
umask 077
PEM_URL="https://${TESLA_DOMAIN}/.well-known/appspecific/com.tesla.3p.public-key.pem"
CLIENT_ID="$(cred client_id)"; CLIENT_SECRET="$(cred client_secret)"
[[ -n "$CLIENT_ID" && -n "$CLIENT_SECRET" ]] || { echo "ERRORE: client_id/client_secret mancanti in credentials.env"; exit 1; }

echo "1) Chiave pubblicata su $PEM_URL"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
CODE="$(curl -sS -o "$TMP" -w '%{http_code}' "$PEM_URL" || true)"
der() { openssl ec -pubin -in "$1" -outform DER 2>/dev/null | python3 -c 'import sys;print(sys.stdin.buffer.read().hex())'; }
if [[ "$CODE" == "200" && -n "$(der "$TMP")" && "$(der "$TMP")" == "$(der public-key.pem)" ]]; then
  echo "   OK: HTTP 200, stessa chiave EC di public-key.pem"
else
  echo "   ERRORE: HTTP $CODE, chiave servita assente o diversa da public-key.pem"; exit 1
fi

echo "2) Partner token (audience $FLEET_API)"
curl -sS -X POST "$TOKEN_URL" -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=client_credentials \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "client_secret=$CLIENT_SECRET" \
  --data-urlencode 'scope=openid vehicle_device_data vehicle_cmds vehicle_charging_cmds' \
  --data-urlencode "audience=$FLEET_API" -o .partner_token.json
PARTNER_TOKEN="$(json .partner_token.json access_token)"
[[ -n "$PARTNER_TOKEN" ]] || { echo "   ERRORE: $(cat .partner_token.json)"; rm -f .partner_token.json; exit 1; }
printf '%s' "$PARTNER_TOKEN" > .partner_token; rm -f .partner_token.json
echo "   OK (salvato in .partner_token, permessi 600)"

echo "3) Registrazione dominio $TESLA_DOMAIN"
curl -sS -X POST "$FLEET_API/api/1/partner_accounts" \
  -H "Authorization: Bearer $PARTNER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"domain\":\"$TESLA_DOMAIN\"}" -w "\n   HTTP %{http_code}\n"

echo "4) Verifica chiave registrata presso Tesla"
curl -sS "$FLEET_API/api/1/partner_accounts/public_key?domain=$TESLA_DOMAIN" \
  -H "Authorization: Bearer $PARTNER_TOKEN" -o "$TMP"
REMOTE_HEX="$(json "$TMP" response.public_key | tr 'A-F' 'a-f')"
LOCAL_HEX="$(openssl ec -pubin -in public-key.pem -outform DER 2>/dev/null | tail -c 65 | python3 -c 'import sys;print(sys.stdin.buffer.read().hex())')"
if [[ -n "$REMOTE_HEX" && "$REMOTE_HEX" == "$LOCAL_HEX" ]]; then
  echo "   OK: Tesla ha registrato la tua chiave pubblica per $TESLA_DOMAIN"
else
  echo "   ATTENZIONE: risposta Tesla = $(cat "$TMP")"; exit 1
fi
