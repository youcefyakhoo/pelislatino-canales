# Catálogo de canales en Cloudflare Pages

Un backend que se comporta como una **base de datos**: índice, particiones,
versión y consultas con límite. No es un fichero gordo que se baja entero.

```
https://pelislatino-canales.pages.dev
```

## La idea

La app tiene tres alcances (`AutoCanales.TOPE_CORTO` = 600, `TOPE_LATAM` =
2.500, `TOPE_GLOBAL` = 12.000). Antes bajaba **siempre** los 3,4 MB y recortaba
la lista en el móvil: con el alcance «corto» tiraba el 96 % de lo descargado.

Ahora el catálogo está **partido en 257 shards de 150 canales** y cada alcance
baja solo lo que va a usar.

## Por qué es estático y no un Worker que lo calcule

La primera versión tenía un Worker que parseaba los 3,5 MB en cada petición.
Funcionaba, pero al disparar 257 peticiones seguidas (una por shard) Cloudflare
devolvió **195 respuestas 503**: el Worker se come el límite de CPU y cuando
llega una ráfaga se cae.

Así que los JSON se **generan y se guardan**: Cloudflare los sirve como ficheros
estáticos, sin ejecutar código, con caché automática en el borde y sin límite de
peticiones. Es una base de datos de verdad, no un programa que la calcula.

| | Worker que lo calcula | JSON estático |
|---|---|---|
| CPU por petición | parsea 3,5 MB | **cero** |
| ráfaga de 257 peticiones | 195 caían con 503 | **ninguna cae** |
| caché | a mano, en el Worker | automática en el borde |
| límite de peticiones | el del Worker | el de Pages |

La función (`functions/canales.js`) se queda **solo para la compatibilidad** con
la app v7.16 (`?solo=pequena`, `?solo=grande`, la raíz).

## Qué hay en el repo

```
manifiesto.json          el índice de shards (~11 KB)
version.json             la huella del catálogo (512 B)
scopes/corto.json        600 canales   ~140 KB
scopes/latam.json        2.500         ~550 KB
scopes/global.json       12.000        ~2,7 MB
shards/<slug>.json       un fichero por trozo de 150 canales
canales/pequena.json     la lista pequeña, ETAPA 1
estado/salud.json        qué emite cada canal y cuándo se comprobó
estado/barrido.json      el parte de la última pasada (solo para depurar)

tools/colector/          barre tu API, VERIFICA y publica lo que funciona
tools/generar.js         plan B: regenera desde las fuentes de terceros
functions/canales.js     compatibilidad con v7.16
functions/api/salud.js   estado en vivo de un canal (/api/salud)
.github/workflows/       colector cada 6 h + legado manual
```

**263 JSON, 6,8 MB en total.**

## El reparto (medido con los ficheros de hoy)

| alcance | antes | ahora | ahorro |
|---|---|---|---|
| corto (600) | 3.402 KB | **146 KB** (6 shards) | **23 x** |
| latam (2.500) | 3.402 KB | **555 KB** (21 shards) | **6 x** |
| global (12.000) | 3.402 KB | 2,7 MB (202 shards) | 1,2 x |

Con «global» el ahorro es pequeño porque necesita casi todo el catálogo. Ahí
gana la otra pieza: la **versión**. Si la huella no ha cambiado, la app baja
**512 B** y usa lo que tiene en disco.

## Por qué el reparto no cambia lo que se ve

Los shards se cortan **sin romper los grupos** y en el **orden del editor**
(Most watched, Peru, Live Matches, Sports...), que es el que la app ya respeta.
Comprobado contra el worker en vivo:

- `scopes/corto.json` es un **prefijo exacto** de `?solo=grande`
- `scopes/latam.json` y `scopes/global.json`, también
- los 257 shards juntos reconstruyen los **15.014 canales**, ni uno más ni uno menos
- **0 canales roto** (sin URL, sin grupo o sin título)

Un grupo grande sale en varios shards (News, con 1.042 canales, en 7) y uno
pequeño en uno solo.

## Cómo lo usa la app

1. `GET /version.json` (512 B) -> si la huella es la misma que la guardada, no
   baja nada más.
2. `GET /scopes/<alcance>.json` -> una sola petición con exactamente los canales
   de su alcance, ya en el esquema nativo de la app.
3. Los shards (`/shards/<slug>.json`) quedan para el refresco selectivo: bajar
   solo los grupos que cambiaron.

## Refresco

### El colector: los canales que FUNCIONAN

`tools/colector/` barre tu API de Drama Live y publica el catálogo. Hay dos cosas
distintas, y la segunda es la que importa:

1. **El barrido** dice qué canales existen (265 temas → ~19.500 canales, ~100 s).
2. **La verificación** dice cuáles **emiten ahora**. Solo esos se publican.

```bash
node --test tools/colector/                  # 33 pruebas, sin red
node tools/colector/index.mjs --ver          # barre y enseña el resumen, sin escribir
node tools/colector/index.mjs                # barre, verifica y publica
node tools/colector/index.mjs --presupuesto=60 --concurrencia=6
```

Lo lanza `.github/workflows/colector.yml` cada 6 horas.

#### Qué significa «emite»

No es un cartel de la API: `/opciones` **descarga el manifiesto** y exige `#EXTM3U`
(o contenido de audio/vídeo) antes de decir que sí. Es la prueba que usa la app.

Ojo con el atajo que parece obvio: un `HEAD` al proxy (`/p/…/0.m3u8`) **no sirve**.
Medido: da 200 hasta en canales que la API marca muertos, y en ráfaga devuelve 5xx en
el 100 % de los casos. Dice «resolví», no «emite».

#### Cómo se reparte el trabajo

Verificar un canal cuesta ~0,6 s contra la API. Son 15.000 canales (`--tope`): 2,5 h
de trabajo por vuelta completa. No se hace de golpe:

- cada pasada verifica **30 min** (unos 2.000 canales), empezando por los más viejos
- cada canal tiene un veredicto de menos de **36 h** de antigüedad
- el estado vive en `estado/salud.json` y **va en el commit**: no se pierde entre pasadas
- se guarda cada 500 canales: si un runner muere, no se pierde la pasada

Concurrencia 6. No es timidez: medido, a 12 Render se satura y baja a **28 canales/min**
frente a **89 a 8**. Más concurrencia es más lento con un plan gratuito.

#### Reglas que evitan desastres

| situación | qué hace |
|---|---|
| Render dormido | `/salud` con espera creciente antes de empezar (hasta 3 min) |
| 502/503 a mitad | vuelve a despertar y repite al final los temas que fallaron |
| un tema da 404 | no se reintenta: ya no existe |
| un canal no contesta | **no se penaliza**: se conserva su último veredicto |
| un canal falla una vez | no se retira: hacen falta **2 pasadas** distintas |
| un canal retirado | se revisa igualmente cada **7 días**, por si volvió |
| nunca verificado | se publica solo si ya estaba en el catálogo de ayer |
| el barrido trae muy poco | **no se publica nada** (mínimo 2.000 y caída máxima del 50 %) |
| la huella no cambia | no hay commit |

#### La primera vez

El catálogo arranca con lo que haya verificado y lo que ya estaba publicado. En la
primera pasada se queda en ~11.600 canales; cada pasada añade más hasta estabilizarse.
Si quieres empezar de cero con todo verificado: lanza el workflow con
**«Recomprobar TODO»** marcado y déjalo varias pasadas (o sube `--presupuesto`).

### El generador de terceros (plan B)

`tools/generar.js` sigue ahí y regenera el catálogo desde `data_unificado.json`
(belkaperu) y `canales-compacto.json` (cesopppplop). **No se ejecuta solo**: su
workflow (`refrescar.yml`) es ahora solo manual, porque escribía los mismos ficheros
y pisaba lo del colector. Es la vuelta atrás si la API no está disponible.

## Estado en vivo: `/api/salud`

`functions/api/salud.js` es una Pages Function que dice si un canal emite **ahora**,
sin esperar a la siguiente pasada:

```bash
curl 'https://pelislatino-canales.pages.dev/api/salud'                     # resumen
curl 'https://pelislatino-canales.pages.dev/api/salud?id=live_tv_beinsport1'
curl 'https://pelislatino-canales.pages.dev/api/salud?ids=a,b,c'           # máx 20
```

Tres capas para no tumbar Render: **caché en el borde** (3 min por canal),
**estado guardado** (con su fecha, `fresh: false` si no es de ahora) y solo si hace
falta, la API — con tope de tiempo de 6 s y sin esperar a que despierte.

La app **no lo usa todavía**: el catálogo ya solo trae canales verificados. Está para
cuando quieras consultar un canal suelto o comprobar el estado del catálogo.

## Desplegarlo

```bash
npm i -g wrangler && wrangler login
wrangler pages deploy . --project-name=pelislatino-canales
```

Si el proyecto está conectado a este repo, cada push se despliega solo.

## Comprobarlo

```bash
curl -s https://pelislatino-canales.pages.dev/version.json          | jq .
curl -s https://pelislatino-canales.pages.dev/manifiesto.json       | jq '.total, .shards'
curl -s https://pelislatino-canales.pages.dev/scopes/corto.json     | jq '.total, .shards'
curl -s https://pelislatino-canales.pages.dev/shards/peru-03.json   | jq '.grupo, .total'
```

## Nota de mantenimiento

La conversión de esquema vive en dos sitios: en Java (`FuenteCanales
.parsearUnificado`, `CatalogoJson.aM3uUnico`) y en JavaScript
(`functions/canales.js`). Si cambia el esquema de los ficheros de origen hay que
tocar los dos. Está a propósito: así el worker puede caerse sin que la app deje
de funcionar.

El generador **no** reescribe la conversión: baja las fuentes con un `fetch` de
mentira y llama al mismo `onRequest` que corre en el borde. Lo que se guarda en
disco es, byte a byte, lo que el worker habría devuelto.
