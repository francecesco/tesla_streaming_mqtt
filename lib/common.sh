#!/usr/bin/env bash
# Funzioni e variabili comuni agli script di amministrazione.
# Va incluso (source), non eseguito. Funziona su macOS e Linux.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[[ -f config.env ]] || { echo "ERRORE: manca config.env (cp config.env.example config.env e compilalo)" >&2; exit 1; }
set -a; . ./config.env; set +a
: "${TESLA_REGION:?TESLA_REGION mancante in config.env}" "${TESLA_DOMAIN:?TESLA_DOMAIN mancante in config.env}"
TELEMETRY_HOST="${TELEMETRY_HOST:-$TESLA_DOMAIN}"
TELEMETRY_PORT="${TELEMETRY_PORT:-8443}"
CONFIG_EXP_DAYS="${CONFIG_EXP_DAYS:-360}"
VC_TAG="${VC_TAG:-v0.4.1}"
PROXY_PORT="${PROXY_PORT:-4443}"

case "$TESLA_REGION" in
  eu) FLEET_API="https://fleet-api.prd.eu.vn.cloud.tesla.com" ;;
  na) FLEET_API="https://fleet-api.prd.na.vn.cloud.tesla.com" ;;
  *)  echo "ERRORE: TESLA_REGION deve essere 'eu' o 'na'" >&2; exit 1 ;;
esac
TOKEN_URL="https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token"
AUTHORIZE_URL="https://auth.tesla.com/oauth2/v3/authorize"

for bin in curl openssl python3; do
  command -v "$bin" >/dev/null || { echo "ERRORE: serve '$bin'" >&2; exit 1; }
done

# cred NOME -> valore da credentials.env (tollera spazi attorno a '=' e apici)
cred() { sed -nE "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*['\"]?([^'\"]*)['\"]?[[:space:]]*\$/\1/p" credentials.env 2>/dev/null | head -1; }

# json FILE PERCORSO -> valore (es. json .vehicles.json response.0.vin); vuoto se assente
json() {
  python3 - "$1" "$2" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for k in sys.argv[2].split("."):
    try:
        d = d[int(k)] if isinstance(d, list) else d[k]
    except Exception:
        sys.exit(0)
if d is not None:
    print(json.dumps(d) if isinstance(d, (dict, list)) else d)
PY
}

# Apre un URL nel browser (macOS / Linux desktop); ritorna 1 se non possibile
open_url() {
  if command -v open >/dev/null 2>&1; then open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1
  else return 1; fi
}

# VIN salvato da 02-oauth.sh
vin() { [[ -s .vin ]] || { echo "ERRORE: .vin mancante, lancia ./02-oauth.sh" >&2; exit 1; }; cat .vin; }
