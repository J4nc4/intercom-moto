#!/usr/bin/env bash
# Preparación (UNA sola vez, con Internet). En Termux: bash setup.sh
set -euo pipefail
cd "$(dirname "$0")"

if command -v pkg >/dev/null 2>&1; then
  echo "» Instalando Node.js y OpenSSL en Termux…"
  pkg install -y nodejs-lts || pkg install -y nodejs
  command -v openssl >/dev/null 2>&1 || pkg install -y openssl-tool || pkg install -y openssl
  # Herramientas para detectar la IP del hotspot (opcionales)
  pkg install -y net-tools iproute2 >/dev/null 2>&1 || true
fi

for bin in node openssl; do
  command -v "$bin" >/dev/null 2>&1 || { echo "✖ Falta '$bin'. Instálalo y vuelve a ejecutar."; exit 1; }
done

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 16 ? 0 : 1)'; then
  echo "✖ Se necesita Node.js 16 o superior (tienes $(node -v))."
  exit 1
fi

bash scripts/certs.sh ca

# Copia del certificado en Descargas (útil para instalarlo en otro dispositivo)
if [ -d "$HOME/storage/downloads" ]; then
  cp certs/ca.crt "$HOME/storage/downloads/IntercomMoto-CA.crt" && \
    echo "» Copia del certificado en Descargas: IntercomMoto-CA.crt"
fi

cat <<'EOF'

✔ Preparación completa.

Siguiente paso:
  1. Activa el hotspot Wi-Fi del Android y conecta el iPhone.
  2. Ejecuta:  bash start.sh
EOF
