#!/usr/bin/env bash
# Rinnova il certificato Let's Encrypt emesso da Tailscale per TELEMETRY_HOST e
# riavvia fleet-telemetry SOLO se il certificato è cambiato (il container lo legge all'avvio).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
set -a; . "$DIR/.env"; set +a
CERTS="$SERVER_DATA_DIR/certs"
before="$(sha256sum "$CERTS/tls.crt" 2>/dev/null | cut -d' ' -f1 || true)"
tailscale cert --cert-file "$CERTS/tls.crt" --key-file "$CERTS/tls.key" "$TELEMETRY_HOST"
# l'immagine gira come utente nonroot (uid 65532)
chown 65532:65532 "$CERTS/tls.crt" "$CERTS/tls.key"; chmod 644 "$CERTS/tls.crt"; chmod 600 "$CERTS/tls.key"
after="$(sha256sum "$CERTS/tls.crt" | cut -d' ' -f1)"
if [[ "$before" != "$after" ]]; then docker restart fleet-telemetry >/dev/null 2>&1 || true; echo "$(date -Is) cert rinnovato, container riavviato"; fi
