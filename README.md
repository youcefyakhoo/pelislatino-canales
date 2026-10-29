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
manifiesto.json          el índice: 11 KB
version.json             la huella de la fuente: 512 B
scopes/corto.json        600 canales   146 KB
scopes/latam.json        2.500         555 KB
scopes/global.json       12.000        2,7 MB
shards/<slug>.json       257 ficheros, uno por trozo de 150 canales
canales/pequena.json     la lista pequeña, ETAPA 1 (462)
tools/generar.js         regenera todo desde las fuentes
functions/canales.js     compatibilidad con v7.16
.github/workflows/       refresco diario automático
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

Las fuentes son las de siempre:

- `data_unificado.json` (belkaperu/belkafut) - 517 entradas, 462 jugables
- `canales-compacto.json` (youcefyakhoo/cesopppplop) - 15.299 entradas

Hay una **GitHub Action** que regenera todo cada día a las 05:17 UTC y hace
commit si algo cambió; Cloudflare Pages redespliega solo. También se puede
lanzar a mano desde la pestaña Actions, o en local:

```bash
node tools/generar.js
```

Para cambiar las fuentes sin tocar el código (variables de entorno del Worker):

```bash
wrangler pages secret put FUENTE_PEQUENIA
wrangler pages secret put FUENTE_GRANDE
```

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
