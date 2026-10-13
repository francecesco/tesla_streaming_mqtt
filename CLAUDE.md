# CLAUDE.md — Tesla Fleet Telemetry → MQTT (self-hosted)

Contesto operativo per chi (persona o Claude Code) lavora su questo repository. Leggere **prima** di
modificare qualsiasi cosa. Il README spiega il *come*; questo file spiega *cosa non rompere e perché*.

- Lingua del progetto: italiano (README, commenti, output degli script).
- I valori della singola installazione stanno in `config.env` (non versionato). Eventuali note personali
  in `CLAUDE.local.md` (non versionato, caricato automaticamente da Claude Code se presente).

---

## 1. Cosa fa il progetto

L'auto spinge i dati via **Fleet Telemetry (WebSocket mTLS)** a `TELEMETRY_HOST:TELEMETRY_PORT`
→ **Tailscale Funnel** (TCP passthrough) → container **fleet-telemetry** sul server (127.0.0.1)
→ **MQTT** → topic `<MQTT_TOPIC_BASE>/<VIN>/v/<Campo>`.
Il nome Funnel del server (`<host>.<tailnet>.ts.net`) è contemporaneamente dominio dell'app Tesla
(`TESLA_DOMAIN`), sito della chiave pubblica e della pagina `/callback`, e hostname di telemetria.

Flusso degli script (PC admin): `00-keys` → `server/setup.sh` (sul server) → app su developer.tesla.com
→ `01-register` → `02-oauth` → pairing chiave virtuale dal telefono → `03-check` → `04-telemetry-config`
→ `05-telemetry-status`. Tutti includono `lib/common.sh` (carica `config.env`, sceglie la regione, helper).

---

## 2. Regole inviolabili

1. **`private-key.pem` non lascia mai il PC di amministrazione**: non va su git, sul server, in chat, nel
   cloud. È la chiave installata come chiave virtuale sull'auto. Se persa: nuova coppia (`00`),
   `setup.sh` (pubblica la nuova pem), `01`, nuovo pairing, `04`.
2. **Mai stampare segreti**: client_secret, access/refresh/partner token, password MQTT. Mantenerlo in
   ogni modifica (`read -s`, file 600 con `umask 077`, niente `set -x`, errori senza token).
3. **Niente che termini il TLS davanti a fleet-telemetry** (proxy Cloudflare/Tunnel, reverse proxy HTTP,
   Funnel `--https`/`--tls-terminated-tcp` sulla porta di telemetria): l'auto si autentica con un
   **certificato client mTLS** che deve arrivare intatto. Sulla porta di telemetria solo `tailscale funnel --tcp=`.
4. **`TELEMETRY_HOST` deve appartenere al dominio partner registrato** (`TESLA_DOMAIN`), altrimenti Tesla
   risponde `hostname domain does not match with partner account`. Con Funnel coincidono.
5. **La chiave pubblica deve restare pubblicata** su `https://<TESLA_DOMAIN>/.well-known/appspecific/com.tesla.3p.public-key.pem`.
   Non lanciare `tailscale funnel reset` / `tailscale serve reset` senza rieseguire subito `setup.sh`.
6. **Nessun dato personale nei file versionati**: niente domini/tailnet reali, IP, VIN, client_id, nomi utente,
   email, percorsi personali. Vanno in `config.env` / `credentials.env` / `CLAUDE.local.md`.
   Prima di ogni commit: `git status` + ricerca di segreti (vedi §6).

---

## 3. Punti critici e trappole (verificati sul campo)

### Tesla / Fleet API
- **Ordine obbligato: OAuth (`02`) PRIMA del pairing della chiave virtuale.** Altrimenti l'app Tesla
  risponde "Impossibile concedere l'accesso di terze parti … non hai concesso l'accesso al tuo account".
  Login OAuth e app sul telefono devono usare **lo stesso account**.
- Il **form di developer.tesla.com valida il dominio dal vivo**: deve già risolvere con certificato valido,
  non contenere "tesla", non risultare dietro reverse proxy. Prima `setup.sh`, poi il form.
- Il form **accetta i domini `*.ts.net`** di Funnel: è ciò che rende possibile l'architettura senza router.
- **Cambiare dominio partner con la stessa coppia di chiavi NON richiede un nuovo pairing**: sull'auto è
  memorizzata la chiave pubblica, non il dominio.
- **`GET fleet_telemetry_config` risponde `synced: true` anche quando sull'auto NON c'è alcuna config**
  (`hostname: None`). Il successo si verifica solo con `synced: true` **e** hostname/porta attesi
  (`04` lo fa). Mai fidarsi di `synced` da solo.
- La config arriva all'auto solo quando è **online**: svegliarla (app Tesla) prima di `04`.
- `exp` = invio + `CONFIG_EXP_DAYS`: **rinnovare prima della scadenza** rilanciando `04`, altrimenti lo
  streaming si ferma senza errori evidenti.
- Il **refresh token ruota a ogni uso**: `token.sh` è l'unico punto che lo rinnova e salva sempre il nuovo.
  Non eseguire script in parallelo, non ripristinare `.tokens.json` vecchi (→ serve rifare `02-oauth.sh`).
- **Campi**: solo nomi dell'`enum Field` di `protos/vehicle_data.proto` (es. `HvacPower` esiste,
  `HvacPowerState` e `ChargerActualCurrent` no). I campi di posizione richiedono lo scope `vehicle_location`.
- Il **tipo di un valore può cambiare tra firmware** (numero ↔ stringa): lato consumer convertire sempre.
- Limiti: max 5 app di terze parti in streaming per veicolo; max 20 chiavi sull'auto.
- Partner token: audience = URL Fleet API della regione (`TESLA_REGION`); la registrazione va fatta per regione.

### Certificati / catena CA
- Funnel usa certificati Let's Encrypt; con la generazione Y la catena è
  `leaf → YE1 → Root YE (cross-firmata da ISRG Root X2) → ISRG Root X2 (cross-firmata da ISRG Root X1)`.
  Il campo `ca` inviato all'auto contiene **le intermedie presentate dal server + ISRG Root X1 e X2
  autofirmate**: regge i cambi di intermedia senza reinviare la config. `04` verifica con `openssl verify`.
- Il certificato di fleet-telemetry viene da `tailscale cert`; il container lo legge solo all'avvio →
  `renew-cert.sh` riavvia **solo se** il certificato cambia. Cert e config devono essere leggibili dall'uid
  **65532** (utente nonroot dell'immagine).
- Non richiedere certificati in loop: rate limit Let's Encrypt (blocco fino a 34 h).

### Tailscale Funnel
- Porte ammesse: **443, 8443, 10000**. La 443 è occupata dall'HTTPS dei file statici → telemetria su 8443/10000.
- Tailscale deve essere **nativo** sull'host: `tailscale cert`/`funnel` e `localhost` devono riferirsi allo
  stesso namespace di rete del container pubblicato su 127.0.0.1.
- Prima attivazione: "Funnel is not enabled on your tailnet" + link → aprirlo (aggiunge `nodeAttrs: funnel`).
  Servono anche MagicDNS e HTTPS Certificates.
- **Il record DNS pubblico può non comparire** se Funnel è stato configurato prima che il nodo avesse il
  permesso: si risolve con `sudo systemctl restart tailscaled`. Verificare sull'autoritativo
  `dig +short <TESLA_DOMAIN> A @ns1.dnsimple.com`: i resolver pubblici tengono in cache la risposta vuota
  (NOERROR/NODATA, il nome esiste per via del TXT `_acme-challenge`).
- **`tailscale debug hostinfo` NON mostra lo stato del daemon** (stampa l'hostinfo calcolato dalla CLI):
  non usarlo per `IngressEnabled`. Usare `journalctl -u tailscaled | grep IngressEnabled` o `tailscale debug netmap`.
- All'avvio i log possono riportare `invalid packet filter permitting traffic to unlocked nodes`: netmap
  transitoria con i peer di ingresso Funnel (`UnsignedPeerAPIOnly`); si risolve da sola. Una policy ACL
  "allow all" va bene: il control plane esclude già gli IP degli ingress.
- Dal PC admin nella tailnet, `<TESLA_DOMAIN>` risolve via MagicDNS sull'IP 100.x e **non** passa dai relay:
  per test realistici usare l'IP di un relay (`-connect <IP_RELAY>:8443 -servername <TESLA_DOMAIN>`).
- Un CNAME da un dominio custom verso il nome `*.ts.net` **non funziona**: i relay instradano per SNI.

### Script e ambiente
- `openssl s_client -connect ":443"` con IP vuoto si collega a `localhost:443` del PC (es. un server di
  sviluppo locale) e mostra un certificato fuorviante: controllare sempre che l'IP non sia vuoto.
- Plugin come `dotenv` di oh-my-zsh caricano automaticamente i file `.env`: per questo i file si chiamano
  `config.env` e `credentials.env`.
- `go install github.com/teslamotors/vehicle-command/cmd/tesla-http-proxy@...` **fallisce** (direttive
  `replace` nel go.mod) → `04` clona il tag `VC_TAG` e usa `go build`.
- Con `set -o pipefail`, `cmd | grep -q` può fallire per SIGPIPE anche se c'è il match: catturare l'output
  in una variabile e testarlo.
- Copie/riscritture possono far perdere il bit eseguibile: sul server usare `sudo bash ./setup.sh`;
  nel repo gli script devono essere committati come `100755`.
- In `.gitignore` i commenti vanno su righe proprie: un `# ...` in coda a un pattern lo rende inefficace.
- JSON gestito con `python3` (portabile macOS/Linux, escape corretto dei PEM); niente `jq`/`plutil`.

### MQTT / consumer
- Aggiungere un utente al broker (es. `logins` di Mosquitto in HA) non tocca gli altri client; un riavvio
  del broker causa pochi secondi di disconnessione.
- Messaggi QoS 1 **retained**: dopo un riavvio i consumer ritrovano l'ultimo valore.
- Verifica connessione lato broker: log `New client connected from <ip-server> as fleet-telemetry`.

---

## 4. Convenzioni degli script

- Bash `set -euo pipefail`; script admin: `source "$(dirname "$0")/lib/common.sh"` (fa `cd` nella root
  del repo, carica `config.env`, definisce `FLEET_API`, `TOKEN_URL`, `cred`, `json`, `open_url`, `vin`).
- Nessun valore specifico dell'installazione nel codice: tutto da `config.env` con default sensati.
- Numerati nell'ordine d'uso; `token.sh` è l'unico modo di ottenere un access token.
- Output in italiano con prefisso di step; esiti `OK:` / `ERRORE:` / `ATTENZIONE:`.
- Ogni script verifica il proprio esito in modo **positivo** (es. hostname atteso), non per assenza di errori.
- `server/setup.sh` deve restare **idempotente** e controllare i prerequisiti prima di agire.
- Portabilità: macOS e Linux sul PC admin (niente `plutil`, `base64 -D`, `sed -i` non portabile).

---

## 5. Procedure operative

| Obiettivo | Procedura |
|---|---|
| Aggiungere/modificare campi | `fields.json` → auto sveglia → `./04-telemetry-config.sh` |
| Rinnovare la config prima di `exp` | `./04-telemetry-config.sh` |
| Stato / errori | `./05-telemetry-status.sh`; server: `sudo docker logs --since 10m fleet-telemetry` |
| Token scaduto/revocato | `./02-oauth.sh` (stesso account) |
| Chiave virtuale rimossa dall'auto | `https://tesla.com/_ak/<TESLA_DOMAIN>` dal telefono → `./03-check.sh` |
| Aggiornare fleet-telemetry | `FT_IMAGE` in `config.env` → copiare `server/` + `config.env` → `sudo bash ./setup.sh` |
| Spostare il servizio su un altro server | nuovo host in tailnet → `TESLA_DOMAIN` = suo nome Funnel → `setup.sh` → aggiungere origin+redirect nel portale Tesla → `01` → `04` (pairing non necessario se la coppia di chiavi è la stessa) |
| Ruotare la coppia di chiavi | backup della vecchia → nuova coppia → `setup.sh` → `01` → pairing → `04` → rimuovere la vecchia chiave dall'auto |
| Disaster recovery PC admin | clonare il repo, ripristinare `private-key.pem`, `credentials.env`, `config.env` dal backup → `00-keys.sh` (rigenera solo la pubblica) → `02-oauth.sh` |

---

## 6. Prima di ogni commit (repository pubblico)

```bash
git status --short                      # nessun config.env, credentials.env, *.pem, .tokens*, .vin, CLAUDE.local.md
git grep -nIE 'BEGIN (EC )?PRIVATE KEY|eyJhbGciOi|ta-secret\.[A-Za-z0-9]{8}' -- . ':!credentials.env.example'
git grep -nIE '\b[0-9A-HJ-NPR-Z]{17}\b'  # possibili VIN
```
Controllare anche, a mano, che non compaiano il proprio dominio/tailnet, IP LAN, client_id, email.

---

## 7. Decisioni di progetto (e perché)

- **Self-hosted** invece di servizi gestiti: dati in casa, nessun abbonamento.
- **Tailscale Funnel** invece di port forward / Cloudflare: nessuna modifica al router, IP dinamico o CGNAT
  irrilevanti, IP di casa non esposto, TCP passthrough compatibile con mTLS.
- **Dominio dell'app = nome Funnel `*.ts.net`**: unico modo per rispettare "hostname nel dominio partner"
  restando su Funnel (i relay non accettano domini custom).
- **`ca` = intermedie + radici ISRG X1/X2**: robusto ai rinnovi Let's Encrypt.
- **Proxy compilato e avviato on-demand sul PC admin**: la chiave privata resta in un solo posto.
- **MQTT retained, QoS 1**: i consumer ritrovano gli ultimi valori dopo un riavvio.
