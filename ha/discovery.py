#!/usr/bin/env python3
"""
Genera il messaggio di MQTT *device discovery* di Home Assistant per i topic di Fleet Telemetry.

Un solo messaggio retained su  <discovery_prefix>/device/tesla_<VIN>/config  crea il dispositivo
"Tesla" con tutte le entità (sensori, binary_sensor, device_tracker).

Uso:
  python3 ha/discovery.py --vin <VIN> [--topic-base tesla] [--name Tesla] [--model "Model 3"] > discovery.json
  # pubblicazione (retained), es.:
  mosquitto_pub -h <broker> -u <user> -P <pass> -r -q 1 \
      -t homeassistant/device/tesla_<VIN>/config -f discovery.json
  # rimozione del dispositivo: pubblicare un payload vuoto retained sullo stesso topic.

Note sui dati (verificati sul campo):
- distanze/velocità arrivano in miglia → convertite qui in km e km/h;
- i valori possono essere null (→ stato "sconosciuto") e il tipo può cambiare tra firmware
  (numero ↔ stringa) → i template usano sempre float(none) / test espliciti;
- nessuna "availability": quando l'auto dorme restano gli ultimi valori (messaggi retained).
"""
import argparse, json

MI_KM = 1.609344


def num(precision=None, factor=None):
    expr = "v" if factor is None else f"(v * {factor})"
    if precision is not None:
        expr = f"{expr} | round({precision})"
    return "{% set v = value_json | float(none) %}{{ " + expr + " if v is not none else 'None' }}"


def boolean(invert=False):
    on, off = ("OFF", "ON") if invert else ("ON", "OFF")
    return "{{ 'None' if value_json is none else ('" + on + "' if value_json | bool(false) else '" + off + "') }}"


def mapping(table, default="Sconosciuto"):
    return ("{% set m = " + json.dumps(table, ensure_ascii=False) + " %}"
            "{{ m.get(value_json, '" + default + "') if value_json is string else 'None' }}")


def door(key):
    return "{{ ('ON' if value_json['" + key + "'] else 'OFF') if value_json is mapping else 'None' }}"


CHARGE_STATE = {
    "DetailedChargeStateDisconnected": "Scollegata",
    "DetailedChargeStateNoPower": "Senza corrente",
    "DetailedChargeStateStarting": "Avvio",
    "DetailedChargeStateCharging": "In carica",
    "DetailedChargeStateComplete": "Completata",
    "DetailedChargeStateStopped": "Interrotta",
}
SENTRY = {
    "SentryModeStateOff": "Spenta", "SentryModeStateIdle": "In attesa", "SentryModeStateArmed": "Armata",
    "SentryModeStateAware": "Allerta", "SentryModeStatePanic": "Allarme", "SentryModeStateQuiet": "Silenziosa",
}
HVAC = {
    "HvacPowerStateOff": "Spenta", "HvacPowerStateOn": "Accesa",
    "HvacPowerStatePrecondition": "Precondizionamento", "HvacPowerStateOverheatProtect": "Protezione surriscaldamento",
}
GEAR = {"ShiftStateP": "P", "ShiftStateR": "R", "ShiftStateN": "N", "ShiftStateD": "D"}


def build(vin, base, name, model):
    v = f"{base}/{vin}/v"
    uid = f"tesla_{vin.lower()}"
    c = {}

    def add(key, platform, label, topic, tpl=None, **kw):
        e = {"platform": platform, "name": label, "unique_id": f"{uid}_{key}", "state_topic": topic}
        if tpl:
            e["value_template"] = tpl
        e.update(kw)
        c[key] = e

    def sensor(key, field, label, tpl, **kw):
        add(key, "sensor", label, f"{v}/{field}", tpl, **kw)

    def binary(key, field, label, tpl, **kw):
        add(key, "binary_sensor", label, f"{v}/{field}", tpl, payload_on="ON", payload_off="OFF", **kw)

    def enum(key, field, label, table, **kw):
        sensor(key, field, label, mapping(table), device_class="enum",
               options=list(table.values()) + ["Sconosciuto"], **kw)

    # ── Batteria ──────────────────────────────────────────────────────────────
    sensor("battery_level", "BatteryLevel", "Batteria", num(1), device_class="battery",
           unit_of_measurement="%", state_class="measurement", suggested_display_precision=0)
    sensor("soc", "Soc", "SoC utilizzabile", num(1), device_class="battery",
           unit_of_measurement="%", state_class="measurement", suggested_display_precision=1, enabled_by_default=False)
    sensor("est_range", "EstBatteryRange", "Autonomia stimata", num(1, MI_KM), device_class="distance",
           unit_of_measurement="km", state_class="measurement", suggested_display_precision=0)
    sensor("rated_range", "RatedRange", "Autonomia nominale", num(1, MI_KM), device_class="distance",
           unit_of_measurement="km", state_class="measurement", suggested_display_precision=0)
    sensor("energy_remaining", "EnergyRemaining", "Energia residua", num(2), device_class="energy_storage",
           unit_of_measurement="kWh", state_class="measurement", suggested_display_precision=1)
    sensor("pack_voltage", "PackVoltage", "Tensione batteria", num(1), device_class="voltage",
           unit_of_measurement="V", state_class="measurement", suggested_display_precision=0, entity_category="diagnostic")
    sensor("pack_current", "PackCurrent", "Corrente batteria", num(1), device_class="current",
           unit_of_measurement="A", state_class="measurement", suggested_display_precision=1, entity_category="diagnostic")
    sensor("module_temp_max", "ModuleTempMax", "Temperatura batteria max", num(1), device_class="temperature",
           unit_of_measurement="°C", state_class="measurement", suggested_display_precision=0, entity_category="diagnostic")
    sensor("module_temp_min", "ModuleTempMin", "Temperatura batteria min", num(1), device_class="temperature",
           unit_of_measurement="°C", state_class="measurement", suggested_display_precision=0, entity_category="diagnostic")
    binary("battery_heater", "BatteryHeaterOn", "Riscaldatore batteria", boolean(), device_class="heat")

    # ── Ricarica ──────────────────────────────────────────────────────────────
    enum("charge_state", "DetailedChargeState", "Stato ricarica", CHARGE_STATE, icon="mdi:ev-station")
    binary("charging", "DetailedChargeState", "In carica",
           "{{ ('ON' if value_json == 'DetailedChargeStateCharging' else 'OFF') if value_json is string else 'None' }}",
           device_class="battery_charging")
    binary("plugged_in", "DetailedChargeState", "Cavo collegato",
           "{{ ('OFF' if value_json in ['DetailedChargeStateDisconnected', 'DetailedChargeStateUnknown'] else 'ON') if value_json is string else 'None' }}",
           device_class="plug")
    sensor("ac_power", "ACChargingPower", "Potenza ricarica AC", num(2), device_class="power",
           unit_of_measurement="kW", state_class="measurement", suggested_display_precision=1)
    sensor("dc_power", "DCChargingPower", "Potenza ricarica DC", num(2), device_class="power",
           unit_of_measurement="kW", state_class="measurement", suggested_display_precision=0)
    sensor("ac_energy_in", "ACChargingEnergyIn", "Energia ricarica AC (sessione)", num(3), device_class="energy",
           unit_of_measurement="kWh", state_class="total_increasing", suggested_display_precision=2)
    sensor("dc_energy_in", "DCChargingEnergyIn", "Energia ricarica DC (sessione)", num(3), device_class="energy",
           unit_of_measurement="kWh", state_class="total_increasing", suggested_display_precision=2)
    sensor("charge_amps", "ChargeAmps", "Corrente di ricarica", num(1), device_class="current",
           unit_of_measurement="A", state_class="measurement", suggested_display_precision=0)
    sensor("charge_current_request", "ChargeCurrentRequest", "Corrente di ricarica impostata", num(0),
           device_class="current", unit_of_measurement="A", suggested_display_precision=0)
    sensor("charger_voltage", "ChargerVoltage", "Tensione caricatore", num(1), device_class="voltage",
           unit_of_measurement="V", state_class="measurement", suggested_display_precision=0)
    sensor("charger_phases", "ChargerPhases", "Fasi caricatore", num(0), icon="mdi:sine-wave",
           entity_category="diagnostic")
    sensor("charge_limit", "ChargeLimitSoc", "Limite di carica", num(0), unit_of_measurement="%",
           icon="mdi:battery-charging-high", suggested_display_precision=0)
    sensor("time_to_full", "TimeToFullCharge", "Tempo a carica completa", num(2), device_class="duration",
           unit_of_measurement="h", suggested_display_precision=1)
    sensor("cable_type", "ChargingCableType", "Tipo cavo",
           "{{ value_json | replace('CableType', '') if value_json is string else 'None' }}",
           icon="mdi:ev-plug-type2", entity_category="diagnostic")
    binary("charge_port", "ChargePortDoorOpen", "Sportello di ricarica", boolean(), device_class="door",
           icon="mdi:ev-plug-type2")
    binary("fast_charger", "FastChargerPresent", "Supercharger collegato", boolean(), icon="mdi:ev-station")

    # ── Guida e posizione ─────────────────────────────────────────────────────
    c["location"] = {"platform": "device_tracker", "name": "Posizione", "unique_id": f"{uid}_location",
                     "json_attributes_topic": f"{v}/Location", "source_type": "gps", "icon": "mdi:car"}
    sensor("speed", "VehicleSpeed", "Velocità", num(1, MI_KM), device_class="speed",
           unit_of_measurement="km/h", state_class="measurement", suggested_display_precision=0)
    sensor("gear", "Gear", "Marcia", "{% set m = " + json.dumps(GEAR) + " %}"
           "{{ m.get(value_json, 'Sconosciuto') if value_json is string else 'None' }}",
           device_class="enum", options=["P", "R", "N", "D", "Sconosciuto"], icon="mdi:car-shift-pattern")
    sensor("heading", "GpsHeading", "Direzione", num(0), unit_of_measurement="°", icon="mdi:compass",
           entity_category="diagnostic")
    sensor("odometer", "Odometer", "Contachilometri", num(1, MI_KM), device_class="distance",
           unit_of_measurement="km", state_class="total_increasing", suggested_display_precision=0)
    sensor("destination", "DestinationName", "Destinazione", "{{ value_json if value_json is string else 'None' }}",
           icon="mdi:map-marker")
    sensor("minutes_to_arrival", "MinutesToArrival", "Tempo all'arrivo", num(1), device_class="duration",
           unit_of_measurement="min", suggested_display_precision=0)
    sensor("km_to_arrival", "MilesToArrival", "Distanza all'arrivo", num(1, MI_KM), device_class="distance",
           unit_of_measurement="km", suggested_display_precision=1)

    # ── Stato veicolo ─────────────────────────────────────────────────────────
    binary("locked", "Locked", "Sbloccata", boolean(invert=True), device_class="lock")
    for key, field, label, dc in [
        ("door_df", "DriverFront", "Porta anteriore sinistra", "door"),
        ("door_pf", "PassengerFront", "Porta anteriore destra", "door"),
        ("door_dr", "DriverRear", "Porta posteriore sinistra", "door"),
        ("door_pr", "PassengerRear", "Porta posteriore destra", "door"),
        ("trunk", "TrunkRear", "Bagagliaio", "opening"),
        ("frunk", "TrunkFront", "Frunk", "opening"),
    ]:
        binary(key, "DoorState", label, door(field), device_class=dc)
    binary("any_open", "DoorState", "Aperture",
           "{{ ('ON' if value_json.values() | select | list | count > 0 else 'OFF') if value_json is mapping else 'None' }}",
           device_class="opening")
    enum("sentry", "SentryMode", "Modalità Sentinella", SENTRY, icon="mdi:cctv")
    binary("sentry_active", "SentryMode", "Sentinella attiva",
           "{{ ('OFF' if value_json == 'SentryModeStateOff' else 'ON') if value_json is string else 'None' }}",
           icon="mdi:shield-car")
    enum("hvac", "HvacPower", "Climatizzazione", HVAC, icon="mdi:fan")
    sensor("inside_temp", "InsideTemp", "Temperatura interna", num(1), device_class="temperature",
           unit_of_measurement="°C", state_class="measurement", suggested_display_precision=1)
    sensor("outside_temp", "OutsideTemp", "Temperatura esterna", num(1), device_class="temperature",
           unit_of_measurement="°C", state_class="measurement", suggested_display_precision=1)
    for key, field, label in [("tpms_fl", "TpmsPressureFl", "Pressione anteriore sinistra"),
                              ("tpms_fr", "TpmsPressureFr", "Pressione anteriore destra"),
                              ("tpms_rl", "TpmsPressureRl", "Pressione posteriore sinistra"),
                              ("tpms_rr", "TpmsPressureRr", "Pressione posteriore destra")]:
        sensor(key, field, label, num(3), device_class="pressure", unit_of_measurement="bar",
               state_class="measurement", suggested_display_precision=2)

    # ── Diagnostica ───────────────────────────────────────────────────────────
    # Connettività. Il topic riceve un evento per connessione: {ConnectionId, Status, CreatedAt}.
    # L'auto a volte tiene aperte DUE connessioni insieme e ne chiude una mentre l'altra continua a
    # trasmettere (visto il 15/10: DISCONNECTED alle 20:09:26, dati ogni 10 s fino alle 20:10:07).
    # Guardare solo l'ultimo evento darebbe "off" con i dati che arrivano. Si tiene quindi l'elenco
    # delle connessioni aperte nell'attributo "connessioni_aperte" (id -> CreatedAt): CONNECTED
    # aggiunge, DISCONNECTED toglie, il sensore è "on" se l'elenco non è vuoto. Le voci più vecchie
    # di 24 h vengono scartate, così un DISCONNECTED perso non lascia il sensore acceso per sempre.
    # I due template partono entrambi dagli attributi precedenti + il messaggio e il calcolo è
    # idempotente, quindi il risultato non dipende dall'ordine in cui HA li applica.
    conn = f"{base}/{vin}/connectivity"
    altre_aperte = ("{%- set old = this.attributes.get('connessioni_aperte') or {} -%}"
                    "{%- set id = value_json.ConnectionId -%}")
    filtro = ("{%- for k, t in old.items() if k != id and as_timestamp(t, 0) > as_timestamp(now()) - 86400 -%}")
    add("streaming", "binary_sensor", "Streaming connesso", conn,
        "{%- if value_json is not mapping -%}None{%- else -%}" + altre_aperte +
        "{%- set ns = namespace(n=0) -%}" + filtro + "{%- set ns.n = ns.n + 1 -%}{%- endfor -%}"
        "{{ 'ON' if value_json.Status == 'CONNECTED' or ns.n > 0 else 'OFF' }}{%- endif -%}",
        payload_on="ON", payload_off="OFF", device_class="connectivity", entity_category="diagnostic",
        json_attributes_topic=conn,
        json_attributes_template=(
            "{%- if value_json is mapping -%}" + altre_aperte +
            "{%- set ns = namespace(d={}) -%}" + filtro + "{%- set ns.d = dict(ns.d, **{k: t}) -%}{%- endfor -%}"
            "{%- if value_json.Status == 'CONNECTED' -%}{%- set ns.d = dict(ns.d, **{id: value_json.CreatedAt}) -%}{%- endif -%}"
            "{{ {'connessioni_aperte': ns.d} | tojson }}"
            "{%- else -%}{{ {'connessioni_aperte': this.attributes.get('connessioni_aperte') or {}} | tojson }}{%- endif -%}"))
    sensor("firmware", "Version", "Firmware", "{{ value_json if value_json is string else 'None' }}",
           icon="mdi:update", entity_category="diagnostic")
    sensor("vehicle_name", "VehicleName", "Nome veicolo", "{{ value_json if value_json is string else 'None' }}",
           icon="mdi:car-info", entity_category="diagnostic")

    return {
        "device": {"identifiers": [uid], "name": name, "manufacturer": "Tesla", "model": model,
                   "serial_number": vin},
        "origin": {"name": "tesla_streaming_mqtt", "url": "https://github.com/francecesco/tesla_streaming_mqtt"},
        "components": c,
        "qos": 1,
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--vin", required=True)
    ap.add_argument("--topic-base", default="tesla")
    ap.add_argument("--name", default="Tesla")
    ap.add_argument("--model", default="Model 3")
    ap.add_argument("--discovery-prefix", default="homeassistant")
    ap.add_argument("--print-topic", action="store_true", help="stampa solo il topic di discovery")
    a = ap.parse_args()
    if a.print_topic:
        print(f"{a.discovery_prefix}/device/tesla_{a.vin.lower()}/config")
    else:
        print(json.dumps(build(a.vin, a.topic_base, a.name, a.model), ensure_ascii=False, separators=(",", ":")))
