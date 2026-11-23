# Intercom Moto — Modo nube (Google Apps Script + tokens)

En este modo **ningún celular hace de servidor ni de hotspot**. Cada celular usa sus propios datos móviles:

```
[Casco]==BT==[Android · Firefox]                         [iPhone · Safari]==BT==[Casco]
                  │   página: GitHub Pages (HTTPS)             │
                  ├──── señalización + token ──▶ Google Apps Script ◀── señalización + token ──┤
                  │                              (valida el token, guarda las ofertas SDP/ICE,
                  │                               entrega credenciales TURN temporales)
                  └════════════ voz Opus P2P (DTLS-SRTP) ═══════════════════════════════┘
                         directa, o por el TURN de Cloudflare si la red móvil no deja
```

| | Modo hotspot (original) | Modo nube (este) |
|---|---|---|
| Quién hace de servidor | El Android, con Termux | Google Apps Script (gratis) |
| Red | Hotspot del Android, **sin Internet** | **Datos móviles** en los dos celulares |
| Certificado en el iPhone | Sí (CA propia) | **No** (GitHub Pages ya es HTTPS) |
| Control de acceso | Quien esté en el hotspot | **Token firmado por persona** |
| Sin señal celular | Funciona | Se corta y se recupera al volver la señal |

Los dos modos conviven en el repositorio: usa el de nube en carretera con cobertura y el de hotspot como plan B en zonas sin señal.

---

## Por qué está hecho así (resultado de la validación)

- **La página no puede vivir dentro de Apps Script.** Google muestra las páginas de `HtmlService` dentro de un iframe de `googleusercontent.com` sin el permiso `allow="microphone"`. Ahí `getUserMedia` falla con `NotAllowedError`, y Google lo marcó como *Won't Fix*. Por eso la página se publica en **GitHub Pages** y Apps Script se usa solo como API.
- **Apps Script no maneja CORS con consulta previa (OPTIONS).** La página envía cada llamada como un POST "simple" (`Content-Type: text/plain`) y sigue la redirección a `googleusercontent.com`. En las pruebas hubo **0 peticiones OPTIONS**.
- **Apps Script no puede transportar audio** (no tiene WebSockets ni UDP). Solo intercambia las ofertas y los candidatos de conexión; la voz va directo entre los celulares.
- **Las redes móviles usan CGNAT.** Entre el 25 y el 35 % de las conexiones móviles no logran comunicarse directamente y necesitan un **servidor TURN**. El script pide credenciales temporales a **Cloudflare Realtime TURN** (1.000 GB gratis al mes), sin que la llave salga nunca de Google.
- **Cuotas de Apps Script:** el límite es de 30 ejecuciones simultáneas por cuenta. La página agrupa los candidatos ICE y consulta cada 1,2 s mientras conecta y cada 5 s ya conectada. En la prueba hubo como máximo 4 ejecuciones simultáneas.

---

## Instalación (una sola vez, desde un computador)

### 1. Publicar la página en GitHub Pages
1. Sube el repositorio a GitHub (ver la guía principal).
2. En el repositorio: **Settings › Pages**. En **Source** elige *Deploy from a branch*, rama **main** y carpeta **/docs**. Guarda.
3. Al minuto tendrás la dirección: `https://TU_USUARIO.github.io/intercom-moto/`

### 2. Crear el TURN gratuito en Cloudflare (recomendado)
1. Crea una cuenta en **dash.cloudflare.com**.
2. Menú **Realtime › TURN Server › Create** (puede aparecer como *Calls › TURN*). Ponle un nombre, por ejemplo `intercom-moto`.
3. Copia dos datos: **Turn Token ID** y **API Token**. El API Token se muestra **solo una vez**.

Sin este paso funciona igual en muchas redes, pero entre dos operadores móviles puede no conectar.

### 3. Crear el script en Google Apps Script
1. Entra a **script.google.com** › **Nuevo proyecto**. Ponle de nombre *Intercom Moto*.
2. Borra el contenido de `Código.gs` y pega todo el archivo `nube/apps-script/Code.gs`. Guarda.
3. Haz clic en el engranaje **Configuración del proyecto** y baja a **Propiedades del script**. Agrega:

   | Propiedad | Valor |
   |---|---|
   | `PAGE_URL` | `https://TU_USUARIO.github.io/intercom-moto/` |
   | `CF_TURN_KEY_ID` | tu Turn Token ID de Cloudflare |
   | `CF_TURN_API_TOKEN` | tu API Token de Cloudflare |

4. Vuelve al editor. En la lista de funciones elige **configurar** y pulsa **Ejecutar**. Autoriza los permisos: Google advierte que la app no está verificada porque es tuya; entra en *Configuración avanzada › Ir a Intercom Moto*.
5. Ejecuta **probarTurn**. En el registro debe aparecer `✔ TURN configurado`.

### 4. Implementar como Aplicación web
1. **Implementar › Nueva implementación**. En el engranaje, elige el tipo **Aplicación web**.
2. **Ejecutar como:** *Yo*. **Quién tiene acceso:** *Cualquier usuario*.
   Esto es necesario para que los celulares puedan llamar al script sin iniciar sesión en Google. La protección la dan los tokens: sin uno válido, el script no deja hacer nada.
3. **Implementar** y copia la **URL de la aplicación web** (termina en `/exec`).

> Si después cambias el código: **Implementar › Gestionar implementaciones › ✏️ Editar › Versión: Nueva versión**. Si no, Google sigue sirviendo el código anterior.

### 5. Conectar la página con el script
Edita `docs/config.js` en GitHub (botón ✏️) y pega tu URL:
```js
window.INTERCOM_CONFIG = {
  SCRIPT_URL: 'https://script.google.com/macros/s/AKfy...TU_ID.../exec',
};
```
Esta URL **no es secreta** y puede quedar en el repositorio público.

### 6. Crear los tokens del viaje
1. En el editor de Apps Script ejecuta **crearTokensViaje**.
2. En el **Registro de ejecución** aparecen dos enlaces, uno para *Piloto* y otro para *Pasajero*:
   ```
   Enlace: https://TU_USUARIO.github.io/intercom-moto/#t=v1.eyJy...
   ```
3. Envía a cada persona **solo su propio enlace**, por ejemplo por WhatsApp. Cada token sirve para una persona y vence en 30 días.

---

## Uso en cada viaje

1. Datos móviles activados en los dos celulares, y cada intercomunicador emparejado con su celular por Bluetooth.
2. **Android:** abre el enlace en **Firefox**. **iPhone:** ábrelo en **Safari**.
   La primera vez el token queda guardado y la página lo borra de la barra de direcciones. Guarda la página en favoritos (`https://TU_USUARIO.github.io/intercom-moto/`).
3. Toquen **Conectar** en los dos. En unos segundos aparece **"Conectado — hablen normalmente"**.
4. En **Registro**, la línea *Ruta:* indica si la voz va directa entre los celulares o pasa por el TURN.

Lo demás funciona igual que en el modo hotspot: botón de silencio, prueba de pantalla bloqueada (en Android usa Firefox) y reconexión automática.

**Consumo de datos (estimado):** unos **40 MB por hora en cada celular**, contando voz Opus a 24 kb/s en ambos sentidos con sus cabeceras y las consultas al script. Es una estimación, no una medición en red móvil.

---

## Seguridad

- **Qué impide que otros entren:** cada token está firmado con HMAC-SHA256 usando un secreto que solo existe en tu Apps Script. Un token alterado, inventado o vencido se rechaza. Sin token válido nadie puede entrar a la sala, leer o enviar mensajes, ni obtener credenciales TURN.
- **Sala de dos:** aunque alguien tuviera un tercer token válido, la sala solo admite dos personas.
- **Revocar:** ejecuta `revocarToken('id')` (el id aparece al crear el token) o `revocarTodos()`, que invalida **todos** los tokens al instante. Después crea nuevos con `crearTokensViaje()`.
- **La llave de Cloudflare** queda en las Propiedades del script; los celulares solo reciben credenciales temporales (12 h).
- **El token va en el fragmento `#t=`** del enlace. Esa parte de la URL nunca se envía a GitHub, y la página la borra al cargarse.
- **La voz** viaja cifrada de extremo a extremo con DTLS-SRTP. Ni Google ni Cloudflare pueden escucharla, aunque pase por el TURN.
- Trata cada enlace como una contraseña: no lo publiques. Si se filtra, revócalo.

## Limitaciones honestas

- **Sin señal celular no hay comunicación.** El audio se corta y vuelve solo cuando regresa la señal: la página reintenta y reinicia ICE. Para zonas sin cobertura usa el modo hotspot.
- **Conectar tarda unos segundos**, porque cada llamada a Apps Script toma entre 0,5 y 2 s. Una vez conectados, la voz no pasa por Google y su latencia es la de la red móvil.
- **Google puede vaciar su caché.** Si se pierde la sala, la página la rehace sola y el audio no se corta (comprobado en las pruebas).
- **Pantalla bloqueada:** igual que antes. Firefox en Android sigue funcionando; Chrome corta el micrófono; en el iPhone depende de la versión de iOS.

## Qué se validó y qué no

Se probó con un **simulador de Apps Script**. Ejecuta el mismo `Code.gs` y reproduce la caché, las propiedades, la firma HMAC, la redirección 302 a otro dominio, el rechazo a OPTIONS y una latencia de 700 ms. Encima corrieron dos navegadores:

- 25 pruebas del script: tokens alterados, vencidos y revocados; sala llena; tolerancia de 9 min con pantalla bloqueada; expulsión a los 10 min; límite de 100 KB de la caché; filtro del puerto 53 del TURN.
- 17 pruebas de extremo a extremo: conexión y audio en ambos sentidos; servidor caído; caché perdida; pantalla bloqueada; recarga; tercer token; token falso; token revocado; 0 OPTIONS; máximo 4 ejecuciones simultáneas.

**No se probó:** el despliegue real en Google, el TURN real de Cloudflare ni la conexión entre dos operadores móviles reales. Antes del viaje, prueben en casa con los dos celulares **solo con datos** (Wi-Fi apagado) y revisen la línea *Ruta:* del registro.
