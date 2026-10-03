#!/usr/bin/env bash
# Enciende el intercomunicador. Ejecutar con el hotspot YA activado.
#   bash start.sh              -> detecta la IP del hotspot
#   bash start.sh 192.168.X.1  -> usa la IP que indiques
set -euo pipefail
cd "$(dirname "$0")"

[ -f certs/ca.key ] || { echo "✖ Primero ejecuta: bash setup.sh"; exit 1; }

detect_ips() {
  {
    ifconfig 2>/dev/null | awk '/inet /{print $2}' | sed 's/^addr://'
    ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1
    node -e 'try{for(const l of Object.values(require("os").networkInterfaces()))for(const i of l)if(i.family==="IPv4"&&!i.internal)console.log(i.address)}catch(e){}' 2>/dev/null
  } | grep -E '^[0-9]+(\.[0-9]+){3}$' | grep -v '^127\.' || true
}

if [ "$#" -gt 0 ]; then
  IPS="$*"
else
  IPS="$(detect_ips | tr '\n' ' ')"
fi

# 192.168.43.1 es la IP clásica del hotspot en muchos Android: se incluye siempre.
ALL="$(printf '%s\n' $IPS 192.168.43.1 | grep -E '^[0-9]+(\.[0-9]+){3}$' | sort -u | tr '\n' ' ')"

if [ -z "$(printf '%s' "$IPS" | tr -d ' ')" ]; then
  echo "⚠ No pude detectar la IP del hotspot."
  echo "  Mírala en el iPhone: Ajustes › Wi-Fi › (i) junto a la red › Router"
  echo "  y vuelve a ejecutar:  bash start.sh ESA_IP"
  echo "  (Se continúa con 192.168.43.1 por si es esa.)"
fi

bash scripts/certs.sh server $ALL

# Evita que Android duerma Termux mientras el servidor está encendido
if command -v termux-wake-lock >/dev/null 2>&1; then termux-wake-lock || true; fi

LAN_IPS="$(printf '%s' "$IPS" | xargs)" exec node server.js
