#!/usr/bin/env bash
# Installazione/aggiornamento di fleet-telemetry su un host Linux qualsiasi
# (NAS, mini PC, VPS...) con Docker + Compose v2 + Tailscale NATIVO.
# Idempotente: si può rieseguire. Uso:  sudo bash ./setup.sh
# Richiede accanto (o nella cartella padre): config.env e public-key.pem.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Lancia con: sudo bash ./setup.sh"; exit 1; }
cd "$(dirname "$0")"

# ---------------------------------------------------------------- 0. configurazione e prerequisiti
CFG=""; for c in ./config.env ../config.env; do [[ -f "$c" ]] && { CFG="$c"; break; }; done
[[ -n "$CFG" ]] || { echo "ERRORE: config.env non trovato (copialo accanto a setup.sh o nella cartella padre)"; exit 1; }
set -a; . "$CFG"; set +a
: "${TESLA_DOMAIN:?}" "${MQTT_BROKER:?}"
TELEMETRY_HOST="${TELEMETRY_HOST:-$TESLA_DOMAIN}"; TELEMETRY_PORT="${TELEMETRY_PORT:-8443}"
SERVER_DATA_DIR="${SERVER_DATA_DIR:-/opt/fleet-telemetry}"; FT_IMAGE="${FT_IMAGE:-tesla/fleet-telemetry:v0.9.5}"
FT_LOCAL_PORT="${FT_LOCAL_PORT:-4443}"; MQTT_TOPIC_BASE="${MQTT_TOPIC_BASE:-tesla}"
BASE="$SERVER_DATA_DIR"

echo "0) Prerequisiti"
for bin in docker tailscale python3 openssl sha256sum; do
  command -v "$bin" >/dev/null || { echo "   ERRORE: manca '$bin'"; exit 1; }
done
docker compose version >/dev/null 2>&1 || { echo "   ERRORE: serve Docker Compose v2 ('docker compose')"; exit 1; }
case "$TELEMETRY_PORT" in 8443|10000) ;; *) echo "   ERRORE: TELEMETRY_PORT deve essere 8443 o 10000 (porte Funnel; la 443 serve i file statici)"; exit 1;; esac
TS_NAME="$(tailscale status --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
if [[ "$TS_NAME" != "$TELEMETRY_HOST" || "$TS_NAME" != "$TESLA_DOMAIN" ]]; then
  echo "   ERRORE: il nome Tailscale di questo host è '$TS_NAME' ma config.env dice"
  echo "           TESLA_DOMAIN='$TESLA_DOMAIN' TELEMETRY_HOST='$TELEMETRY_HOST' (devono coincidere)"; exit 1
fi
PEM=""; for c in ./public-key.pem ../public-key.pem; do [[ -f "$c" ]] && { PEM="$c"; break; }; done
[[ -n "$PEM" ]] && openssl ec -pubin -in "$PEM" -noout 2>/dev/null || { echo "   ERRORE: public-key.pem mancante o non valida"; exit 1; }
echo "   OK: host Tailscale $TS_NAME, dati in $BASE, broker $MQTT_BROKER"

echo "1) Cartelle e file"
mkdir -p "$BASE/certs" "$BASE/config" "$BASE/www"
install -m 644 docker-compose.yml "$BASE/docker-compose.yml"
install -m 755 renew-cert.sh "$BASE/renew-cert.sh"
cat > "$BASE/.env" <<ENV
FT_IMAGE=$FT_IMAGE
FT_LOCAL_PORT=$FT_LOCAL_PORT
SERVER_DATA_DIR=$BASE
TELEMETRY_HOST=$TELEMETRY_HOST
ENV
chmod 644 "$BASE/.env"

echo "2) Certificato Let's Encrypt per $TELEMETRY_HOST (tailscale cert)"
"$BASE/renew-cert.sh" >/dev/null
openssl x509 -in "$BASE/certs/tls.crt" -noout -subject -issuer -enddate | sed 's/^/   /'

echo "3) Configurazione fleet-telemetry → MQTT $MQTT_BROKER (topic base '$MQTT_TOPIC_BASE')"
if [[ -z "${MQTT_USER:-}" ]]; then read -r -p "   Utente MQTT: " MQTT_USER; else echo "   Utente MQTT: $MQTT_USER"; fi
read -r -s -p "   Password MQTT: " MQTT_PASS; echo
MQTT_USER="$MQTT_USER" MQTT_PASS="$MQTT_PASS" MQTT_BROKER="$MQTT_BROKER" MQTT_TOPIC_BASE="$MQTT_TOPIC_BASE" \
  python3 - "$BASE/config/config.json" <<'PY'
import json, os, sys
cfg = json.load(open("config.template.json"))
m = cfg["mqtt"]
m["broker"], m["username"], m["password"], m["topic_base"] = (
    os.environ["MQTT_BROKER"], os.environ["MQTT_USER"], os.environ["MQTT_PASS"], os.environ["MQTT_TOPIC_BASE"])
json.dump(cfg, open(sys.argv[1], "w"), indent=2)
PY
chown 65532:65532 "$BASE/config/config.json"; chmod 600 "$BASE/config/config.json"

echo "4) Avvio/aggiornamento container"
docker compose -f "$BASE/docker-compose.yml" --env-file "$BASE/.env" up -d
docker restart fleet-telemetry >/dev/null   # rilegge config e certificato
sleep 5
docker logs --tail 5 fleet-telemetry 2>&1 | sed 's/^/   /'

echo "5) Contenuti statici pubblici (chiave pubblica Tesla + callback OAuth)"
install -m 644 "$PEM"            "$BASE/www/public-key.pem"
install -m 644 www/index.txt     "$BASE/www/index.txt"
install -m 644 www/callback.html "$BASE/www/callback.html"

echo "6) Tailscale Funnel"
echo "   HTTPS 443 (terminato da tailscaled): /  /.well-known/...public-key.pem  /callback"
echo "   TCP $TELEMETRY_PORT passthrough -> 127.0.0.1:$FT_LOCAL_PORT (mTLS terminato da fleet-telemetry)"
tailscale funnel --tcp=443 off >/dev/null 2>&1 || true   # un TCP su 443 sarebbe incompatibile con HTTPS 443
tailscale funnel --bg --set-path=/ "$BASE/www/index.txt" >/dev/null
tailscale funnel --bg --set-path=/.well-known/appspecific/com.tesla.3p.public-key.pem "$BASE/www/public-key.pem" >/dev/null
tailscale funnel --bg --set-path=/callback "$BASE/www/callback.html" >/dev/null
tailscale funnel --bg --tcp="$TELEMETRY_PORT" "tcp://localhost:$FT_LOCAL_PORT" >/dev/null
tailscale funnel status | sed 's/^/   /'

echo "7) Rinnovo automatico del certificato (settimanale)"
if [[ -d /etc/cron.d ]]; then
  echo "17 4 * * 1 root $BASE/renew-cert.sh >> /var/log/fleet-telemetry-cert.log 2>&1" > /etc/cron.d/fleet-telemetry-cert
  chmod 644 /etc/cron.d/fleet-telemetry-cert
  echo "   OK: /etc/cron.d/fleet-telemetry-cert (lunedì 04:17, ora locale del server)"
else
  echo "   ATTENZIONE: /etc/cron.d assente: pianifica a mano '$BASE/renew-cert.sh' come root una volta a settimana"
fi

echo
echo "FATTO. Se è la prima attivazione di Funnel su questo host e il DNS pubblico non compare entro 10 min:"
echo "   sudo systemctl restart tailscaled     (verifica: dig +short $TELEMETRY_HOST A @ns1.dnsimple.com)"
