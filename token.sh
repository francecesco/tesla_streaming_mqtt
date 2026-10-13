#!/usr/bin/env bash
# Stampa su stdout un access token valido, rinnovandolo se scade entro 10 minuti.
# Uso: TOKEN="$(./token.sh)"   (messaggi su stderr, mai il token)
# Tesla ruota il refresh token a ogni uso: non eseguire più istanze in parallelo.
source "$(dirname "$0")/lib/common.sh"
umask 077
[[ -f .tokens.json ]] || { echo "ERRORE: nessun token, lancia ./02-oauth.sh" >&2; exit 1; }

OBT="$(cat .tokens.obtained_at 2>/dev/null || echo 0)"
EXP="$(json .tokens.json expires_in)"; NOW="$(date +%s)"
if (( NOW > OBT + ${EXP:-0} - 600 )); then
  OLD_RT="$(json .tokens.json refresh_token)"
  [[ -n "$OLD_RT" ]] || { echo "ERRORE: nessun refresh token, rilancia ./02-oauth.sh" >&2; exit 1; }
  TMP="$(mktemp ./.tokens.XXXXXX)"
  curl -sS -X POST "$TOKEN_URL" -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode grant_type=refresh_token \
    --data-urlencode "client_id=$(cred client_id)" \
    --data-urlencode "refresh_token=$OLD_RT" -o "$TMP"
  if [[ -z "$(json "$TMP" access_token)" ]]; then echo "ERRORE refresh:" >&2; cat "$TMP" >&2; rm -f "$TMP"; exit 1; fi
  # se Tesla non restituisce un nuovo refresh token, conserva il precedente
  python3 - "$TMP" "$OLD_RT" <<'PY'
import json, sys
p, old = sys.argv[1], sys.argv[2]
d = json.load(open(p)); d.setdefault("refresh_token", old); json.dump(d, open(p, "w"))
PY
  mv "$TMP" .tokens.json; date +%s > .tokens.obtained_at
  echo "token rinnovato" >&2
fi
json .tokens.json access_token
