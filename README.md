# Catálogo de canales en Cloudflare Pages

Un backend que se comporta como una **base de datos**: índice, particiones,
versión y consultas con `LIMIT`. No es un fichero gordo que se baja entero.

```
https://pelislatino-canales.pages.dev/canales
```

## La idea

La app tiene tres alcances (`AutoCanales.TOPE_CORTO` = 600,
`TOPE_LATAM` = 2.500, `TOPE_GLOBAL` = 12.000). Antes bajaba **siempre** los
3,4 MB y recortaba la lista en el móvil: con el alcance «corto» tiraba el 96 %
de lo descargado.

Ahora el catálogo está **partido en shards de 150 canales** y cada alcance baja
solo lo que va a usar.

## El reparto (medido con los ficheros de hoy)

| alcance | antes | ahora | ahorro |
|---|---|---|---|
| corto (600) | 3.402 KB | **143 KB** (6 shards) | **24 x** |
| latam (2.500) | 3.402 KB | **555 KB** (21 shards) | **6 x** |
| global (12.000) | 3.402 KB | 2.749 KB (202 shards) | 1,2 x |

Con «global» el ahorro es pequeño porque necesita casi todo el catálogo. Ahí
gana la otra pieza: la **versión**. Si la huella no ha cambiado, la app baja
**0 KB** y usa lo que tiene en disco.

## Por qué el reparto no cambia lo que se ve

Los shards se cortan **sin romper los grupos** y en el **orden del editor**
(Most watched, Peru, Live Matches, Sports...), que es el que la app ya respeta.
Comprobado: la respuesta de `?scope=corto` es un **prefijo exacto** de
`?solo=grande`, y los 257 shards juntos reconstruyen el catálogo entero
(15.014 canales, ni uno más ni uno menos).

Un grupo grande sale en varios shards (News, con 1.042 canales, en 7) y uno
pequeño en uno solo. Total: **257 shards de unos 13 KB**.

## Endpoints

| URL | para qué |
|---|---|
| `/canales` | todo fusionado (las dos fuentes) |
| `/canales?solo=pequena` | la lista pequeña, ETAPA 1 (462 canales) |
| `/canales?solo=grande` | el catálogo grande completo (15.014) |
| `/canales?version=1` | `{"version":"bc760260"}` - lo más barato que hay |
| `/canales?manifiesto=1` | el índice: versión, shards, conteos, scopes |
| `/canales?scope=corto\|latam\|global` | los shards en orden hasta el tope |
| `/canales?shard=peru-03` | UN shard |
| `/canales?limit=600&offset=1200` | paginación |

El manifiesto pesa **11 KB** y trae, por shard, su `slug`, cuántos canales tiene
y su `orden`. Con eso la app sabe exactamente qué bajar para su alcance.

## Cómo lo usa la app

1. `?version=1` -> si la huella es la misma que la guardada, no baja nada.
2. `?manifiesto=1` -> elige los shards que cubren su alcance.
3. `?shard=...` -> baja solo esos, y los guarda en disco **por shard**: cambiar
   de alcance no vuelve a bajar lo que ya tiene.

Todo se cachea en el borde (`caches.default`), así que el trabajo de partir el
catálogo se paga una vez por PoP y los demás lo reciben hecho.

## Desplegarlo

```bash
cd pelislatino-canales
npm i -g wrangler && wrangler login
wrangler pages deploy . --project-name=pelislatino-canales
```

Para cambiar las fuentes sin tocar el código:

```bash
wrangler pages secret put FUENTE_PEQUENIA   # belkaperu/belkafut data_unificado.json
wrangler pages secret put FUENTE_GRANDE     # youcefyakhoo/cesopppplop canales-compacto.json
```

## Comprobarlo

```bash
curl -s "https://pelislatino-canales.pages.dev/canales?version=1"      | jq .
curl -s "https://pelislatino-canales.pages.dev/canales?manifiesto=1"   | jq '.total, .shards'
curl -s "https://pelislatino-canales.pages.dev/canales?scope=corto"    | jq '.total, .shards'
curl -s "https://pelislatino-canales.pages.dev/canales?shard=peru-03"  | jq '.grupo, .total'
```

## Nota de mantenimiento

La conversión de esquema vive en dos sitios: en Java (`FuenteCanales
.parsearUnificado`, `CatalogoJson.aM3uUnico`) y aquí en JavaScript. Si cambia el
esquema de los ficheros de origen hay que tocar los dos. Está a propósito: así el
worker puede caerse sin que la app deje de funcionar.
