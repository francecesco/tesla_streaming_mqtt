#!/usr/bin/env bash
# Passo 3 – Verifica che la chiave virtuale (public key dell'app) sia associata all'auto.
source "$(dirname "$0")/lib/common.sh"
VIN="$(vin)"; TOKEN="$(./token.sh)"
curl -sS -X POST "$FLEET_API/api/1/vehicles/fleet_status" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"vins\":[\"$VIN\"]}" -o .fleet_status.json
python3 - "$VIN" <<'PY'
import json, sys
vin = sys.argv[1]
r = json.load(open(".fleet_status.json")).get("response") or {}
info = (r.get("vehicle_info") or {}).get(vin, {})
print("firmware:", info.get("firmware_version"), "| telemetry client:", info.get("fleet_telemetry_version"),
      "| chiavi sull'auto:", info.get("total_number_of_keys"))
print("   OK: chiave virtuale associata" if vin in (r.get("key_paired_vins") or [])
      else "   ATTENZIONE: chiave NON associata (o non ancora visibile: può tardare qualche minuto)")
PY
