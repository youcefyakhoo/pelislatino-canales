# Catálogo de canales en Cloudflare Pages

Un solo `GET` devuelve el catálogo completo ya fusionado.

```
https://<tu-proyecto>.pages.dev/canales
```

## Desplegar

```bash
cd cloudflare-canales
npm i -g wrangler
wrangler login
wrangler pages deploy . --project-name=pelislatino-canales
```

Para cambiar las fuentes sin tocar el código:

```bash
wrangler pages secret put FUENTE_PEQUENIA
wrangler pages secret put FUENTE_GRANDE
```
