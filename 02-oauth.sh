#!/usr/bin/env bash
# Passo 2 – Login OAuth (authorization code) con l'account proprietario dell'auto.
# Salva token (.tokens.json, 600) e VIN (.vin). Non stampa mai secret né token.
# Il redirect va alla pagina statica https://$TESLA_DOMAIN/callback servita dal server.
source "$(dirname "$0")/lib/common.sh"
umask 077
REDIRECT_URI="${OAUTH_REDIRECT_URI:-https://${TESLA_DOMAIN}/callback}"
SCOPES="openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds"
CLIENT_ID="$(cred client_id)"; CLIENT_SECRET="$(cred client_secret)"
[[ -n "$CLIENT_ID" && -n "$CLIENT_SECRET" ]] || { echo "ERRORE: credenziali mancanti in credentials.env"; exit 1; }

echo "1) Login Tesla nel browser (account proprietario dell'auto, concedi TUTTI gli scope)"
STATE="$(openssl rand -hex 16)"
AUTHORIZE="$(python3 - "$AUTHORIZE_URL" "$CLIENT_ID" "$REDIRECT_URI" "$SCOPES" "$STATE" <<'PY'
import sys, urllib.parse as u
base, cid, redir, scopes, state = sys.argv[1:]
print(base + "?" + u.urlencode({"response_type": "code", "client_id": cid, "redirect_uri": redir,
      "scope": scopes, "state": state, "prompt_missing_scopes": "true"}))
PY
)"
open_url "$AUTHORIZE" || echo "   Apri manualmente: $AUTHORIZE"
echo "   La pagina $REDIRECT_URI mostrerà il code (monouso, scade in pochi minuti)."
read -r -p "   Incolla il code: " CODE
CODE="${CODE//[[:space:]]/}"
[[ -n "$CODE" ]] || { echo "ERRORE: code vuoto"; exit 1; }

echo "2) Scambio code -> token"
curl -sS -X POST "$TOKEN_URL" -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=authorization_code \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "client_secret=$CLIENT_SECRET" \
  --data-urlencode "code=$CODE" \
  --data-urlencode "audience=$FLEET_API" \
  --data-urlencode "redirect_uri=$REDIRECT_URI" -o .tokens.json
ACCESS="$(json .tokens.json access_token)"
[[ -n "$ACCESS" ]] || { echo "   ERRORE dal server auth: $(cat .tokens.json)"; exit 1; }
date +%s > .tokens.obtained_at
[[ -n "$(json .tokens.json refresh_token)" ]] && echo "   OK: access + refresh token salvati in .tokens.json" \
  || echo "   ATTENZIONE: nessun refresh token (offline_access non concesso?)"

echo "3) Scope concessi"
python3 - "$ACCESS" <<'PY'
import base64, json, sys
p = sys.argv[1].split(".")[1]; p += "=" * (-len(p) % 4)
scp = json.loads(base64.urlsafe_b64decode(p)).get("scp", [])
print("   ", " ".join(scp))
for s in ("vehicle_device_data", "vehicle_location"):
    print("   OK " if s in scp else "   MANCA ", s)
PY

echo "4) Veicolo (non sveglia l'auto)"
curl -sS "$FLEET_API/api/1/vehicles" -H "Authorization: Bearer $ACCESS" -o .vehicles.json
VIN="$(json .vehicles.json response.0.vin)"
[[ -n "$VIN" ]] || { echo "   ERRORE: $(cat .vehicles.json)"; exit 1; }
printf '%s' "$VIN" > .vin
echo "   VIN salvato in .vin — nome: $(json .vehicles.json response.0.display_name), stato: $(json .vehicles.json response.0.state)"
echo
echo "Prossimo passo: dal telefono (app Tesla con lo STESSO account, vicino all'auto) apri"
echo "   https://tesla.com/_ak/${TESLA_DOMAIN}"
echo "poi lancia ./03-check.sh"
