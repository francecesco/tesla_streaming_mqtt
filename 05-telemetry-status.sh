#!/usr/bin/env bash
# Stato della configurazione di telemetria sull'auto + errori riportati dal veicolo.
# Riga 2 dell'output = riga di stato usata da 04-telemetry-config.sh.
source "$(dirname "$0")/lib/common.sh"
VIN="$(vin)"; TOKEN="$(./token.sh)"
echo "== fleet_telemetry_config"
curl -sS "$FLEET_API/api/1/vehicles/$VIN/fleet_telemetry_config" -H "Authorization: Bearer $TOKEN" \
  | python3 -c 'import json,sys; r=json.load(sys.stdin).get("response",{}); c=r.get("config") or {}; print("synced:", r.get("synced"), "| hostname:", c.get("hostname"), "| port:", c.get("port"), "| campi:", len(c.get("fields") or {}), "| exp:", c.get("exp"))'
echo "== fleet_telemetry_errors"
curl -sS "$FLEET_API/api/1/vehicles/$VIN/fleet_telemetry_errors" -H "Authorization: Bearer $TOKEN"; echo
