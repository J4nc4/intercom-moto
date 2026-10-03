#!/usr/bin/env bash
# Genera los certificados del intercomunicador.
#   bash scripts/certs.sh ca            
#   bash scripts/certs.sh server IP...  
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs
cd certs

case "${1:-}" in
  ca)
    if [ -f ca.key ] && [ -f ca.crt ]; then
      echo "» La CA ya existe (certs/ca.crt). No se regenera para no romper la confianza del iPhone."
      exit 0
    fi
    echo "» Creando la autoridad certificadora propia (CA)…"
    openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
      -keyout ca.key -out ca.crt \
      -subj "/CN=Intercom Moto CA/O=Intercom Moto" \
      -addext "basicConstraints=critical,CA:TRUE" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -addext "subjectKeyIdentifier=hash" 2>/dev/null
    chmod 600 ca.key
    echo "✔ CA creada: certs/ca.crt"
    ;;

  server)
    shift
    [ -f ca.key ] || { echo "✖ Falta la CA. Ejecuta primero: bash setup.sh"; exit 1; }
    SAN="DNS:localhost,IP:127.0.0.1"
    for ip in "$@"; do SAN="$SAN,IP:$ip"; done

    if [ -f server.crt ] && [ -f server.key ] && [ "$(cat server.san 2>/dev/null)" = "$SAN" ] \
       && openssl x509 -checkend 2592000 -noout -in server.crt >/dev/null 2>&1; then
      echo "» Certificado del servidor vigente para: $SAN"
      exit 0
    fi

    echo "» Generando certificado del servidor para: $SAN"
    cat > server.ext <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$SAN
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF
    openssl req -new -newkey rsa:2048 -nodes -sha256 \
      -keyout server.key -out server.csr -subj "/CN=intercom-moto" 2>/dev/null
    # 397 días: dentro del límite que acepta iOS para certificados TLS.
    openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
      -days 397 -sha256 -extfile server.ext -out server.crt 2>/dev/null
    rm -f server.csr
    chmod 600 server.key
    echo "$SAN" > server.san
    echo "✔ Certificado del servidor listo"
    ;;

  *)
    echo "Uso: bash scripts/certs.sh ca | server IP..."
    exit 1
    ;;
esac
