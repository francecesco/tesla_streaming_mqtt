#!/usr/bin/env bash
# Passo 0 – Genera la coppia di chiavi EC (prime256v1) dell'app.
# La chiave privata non deve mai lasciare questa macchina: fanne un backup cifrato.
set -euo pipefail
cd "$(dirname "$0")"
umask 077
if [[ -f private-key.pem ]]; then
  echo "private-key.pem esiste già: NON la sovrascrivo (è quella installata sull'auto)."
else
  openssl ecparam -name prime256v1 -genkey -noout -out private-key.pem
  echo "OK: private-key.pem generata (permessi 600). Salvane una copia in un posto sicuro."
fi
openssl ec -in private-key.pem -pubout -out public-key.pem 2>/dev/null
chmod 644 public-key.pem
echo "OK: public-key.pem (da pubblicare sul server)"
