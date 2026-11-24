# Pruebas del modo nube (sin desplegar en Google)

`gas_mock.js` ejecuta el mismo `Code.gs` con un simulador de Apps Script (caché, propiedades, HMAC,
redirección 302 a otro dominio, sin respuesta a OPTIONS, latencia de 700 ms).

```bash
node gas_mock.js ../apps-script/Code.gs &                         # API simulada en :8787
node static_server.js ../../docs 8080 http://127.0.0.1:8787/exec &  # página como GitHub Pages
python3 unit.py          # 25 pruebas del script (usar un simulador recién iniciado)
mkdir -p shots && python3 e2e_cloud.py   # 17 pruebas con dos navegadores (requiere Playwright)
```
