#!/usr/bin/env bash
# Passo 4 – Invia all'auto la configurazione Fleet Telemetry firmata da tesla-http-proxy.
# La chiave privata resta su questa macchina; il proxy gira solo su 127.0.0.1 per la durata dello script.
# Prima di lanciarlo svegliare l'auto (aprire l'app Tesla).
source "$(dirname "$0")/lib/common.sh"
HOST="$TELEMETRY_HOST"; PORT="$TELEMETRY_PORT"
VIN="$(vin)"
command -v go  >/dev/null || [[ -x bin/tesla-http-proxy ]] || { echo "ERRORE: serve Go per compilare tesla-http-proxy"; exit 1; }
command -v git >/dev/null || [[ -x bin/tesla-http-proxy ]] || { echo "ERRORE: serve git"; exit 1; }
mkdir -p proxy bin certs
umask 077

# ---------------------------------------------------------------- 1. CA per l'auto
echo "1) Catena certificati presentata da $HOST:$PORT"
rm -f certs/chain-*.pem
echo | openssl s_client -connect "$HOST:$PORT" -servername "$HOST" -showcerts 2>/dev/null \
  | awk '/-----BEGIN CERTIFICATE-----/{i++} /-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/{print > ("certs/chain-" i ".pem")}'
N=$(ls certs/chain-*.pem 2>/dev/null | wc -l | tr -d ' ')
(( N >= 2 )) || { echo "   ERRORE: catena non ottenuta (server/Funnel raggiungibile su $HOST:$PORT?)"; exit 1; }
for f in $(ls certs/chain-*.pem | sort -t- -k2 -n); do printf '   %s: ' "$f"; openssl x509 -in "$f" -noout -subject | sed 's/^subject=//'; done
curl -fsS https://letsencrypt.org/certs/isrgrootx1.pem   -o certs/isrg-root-x1.pem
curl -fsS https://letsencrypt.org/certs/isrg-root-x2.pem -o certs/isrg-root-x2.pem
# ca = intermedie presentate dal server + radici ISRG X1/X2 (robusto ai cambi di intermedia Let's Encrypt)
ls certs/chain-*.pem | sort -t- -k2 -n | tail -n +2 | xargs cat > certs/intermediates.pem
cat certs/isrg-root-x1.pem certs/isrg-root-x2.pem > certs/roots.pem
cat certs/intermediates.pem certs/roots.pem > certs/ca.pem
openssl verify -CAfile certs/roots.pem -untrusted certs/intermediates.pem certs/chain-1.pem | sed 's/^/   verify: /'

# ---------------------------------------------------------------- 2. tesla-http-proxy
echo "2) tesla-http-proxy ($VC_TAG)"
if [[ ! -x bin/tesla-http-proxy ]]; then
  # 'go install ...@latest' fallisce: il go.mod di vehicle-command contiene direttive replace.
  echo "   compilo vehicle-command $VC_TAG con $(go version | awk '{print $3}')..."
  BUILD="$(mktemp -d)"
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$VC_TAG" https://github.com/teslamotors/vehicle-command.git "$BUILD/vc"
  ( cd "$BUILD/vc" && go build -o "$ROOT/bin/tesla-http-proxy" ./cmd/tesla-http-proxy )
  rm -rf "$BUILD"
fi
# (niente 'cmd | grep -q': con pipefail il SIGPIPE farebbe fallire il controllo)
PROXY_HELP="$(bin/tesla-http-proxy -h 2>&1 || true)"
[[ "$PROXY_HELP" == *key-file* ]] || { echo "   ERRORE: binario proxy non valido"; exit 1; }
if [[ ! -f proxy/tls-cert.pem ]]; then
  openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout proxy/tls-key.pem -out proxy/tls-cert.pem -days 3650 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null
fi
bin/tesla-http-proxy -tls-key proxy/tls-key.pem -cert proxy/tls-cert.pem -key-file private-key.pem \
  -host 127.0.0.1 -port "$PROXY_PORT" > proxy/proxy.log 2>&1 &
PROXY_PID=$!; trap 'kill $PROXY_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do curl -s --cacert proxy/tls-cert.pem -o /dev/null "https://localhost:$PROXY_PORT/" && break; sleep 0.5; done
echo "   proxy attivo su https://localhost:$PROXY_PORT (pid $PROXY_PID)"

# ---------------------------------------------------------------- 3. payload
echo "3) Payload ($HOST:$PORT, scadenza +$CONFIG_EXP_DAYS giorni)"
python3 - "$VIN" "$HOST" "$PORT" "$CONFIG_EXP_DAYS" > .telemetry-config.json <<'PY'
import json, sys, time
vin, host, port, days = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
fields = {k: v for k, v in json.load(open("fields.json")).items() if not k.startswith("_")}
cfg = {"hostname": host, "port": port, "ca": open("certs/ca.pem").read(), "fields": fields,
       "alert_types": ["service"], "exp": int(time.time()) + days * 86400}
json.dump({"vins": [vin], "config": cfg}, sys.stdout, indent=1)
PY
python3 -c 'import json;c=json.load(open(".telemetry-config.json"))["config"];print("   campi:",len(c["fields"]),"| exp:",c["exp"],"| certificati in ca:",c["ca"].count("BEGIN CERTIFICATE"))'

# ---------------------------------------------------------------- 4. invio firmato
echo "4) POST fleet_telemetry_config via proxy"
TOKEN="$(./token.sh)"
RESP="$(curl -sS --cacert proxy/tls-cert.pem -X POST "https://localhost:$PROXY_PORT/api/1/vehicles/fleet_telemetry_config" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data @.telemetry-config.json -w "\n%{http_code}")"
CODE="${RESP##*$'\n'}"; BODY="${RESP%$'\n'*}"
echo "   HTTP $CODE  $BODY"
[[ "$CODE" == "200" ]] || { echo "   ERRORE: configurazione NON inviata (vedi messaggio sopra e proxy/proxy.log)"; exit 1; }

# ---------------------------------------------------------------- 5. attesa sync
echo "5) Attendo synced=true con hostname $HOST (auto sveglia/online; max 3 min)"
for _ in $(seq 1 18); do
  OUT="$(./05-telemetry-status.sh 2>/dev/null | sed -n 2p)"
  echo "   $(date +%H:%M:%S) $OUT"
  # synced=True da solo non basta: senza alcuna config Tesla risponde synced=True con hostname None
  if [[ "$OUT" == *"synced: True"* && "$OUT" == *"hostname: $HOST |"* && "$OUT" == *"port: $PORT |"* ]]; then
    echo "   OK: configurazione attiva sull'auto"; exit 0
  fi
  [[ "$OUT" == *"hostname: None"* ]] && { echo "   NESSUNA configurazione presente sull'auto"; exit 1; }
  sleep 10
done
echo "   ATTENZIONE: non ancora sincronizzata. L'auto la riceverà al prossimo risveglio; ricontrolla con ./05-telemetry-status.sh"
