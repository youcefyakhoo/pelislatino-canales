/**
 * Genera el catálogo ESTÁTICO: los JSON ya partidos, listos para que Cloudflare
 * Pages los sirva sin ejecutar ni una línea de Worker.
 *
 *   node tools/generar.js
 *
 * Sale esto en la raíz del repo:
 *
 *   manifiesto.json            el índice (11 KB)
 *   version.json               la huella de la fuente (para no bajar nada si no cambió)
 *   shards/<slug>.json         257 ficheros, uno por trozo de 150 canales
 *   scopes/corto.json          600 canales  (el alcance «corto» de la app)
 *   scopes/latam.json          2.500        (el «latam»)
 *   scopes/global.json         12.000       (el «global»)
 *   canales/pequena.json       la lista pequeña, ETAPA 1 (compat)
 *   canales/grande.json        el catálogo grande entero (compat)
 *   canales/todo.json          las dos fuentes fusionadas (compat)
 *
 * POR QUÉ ESTÁTICO
 * ----------------
 * Un Worker que parsea 3,5 MB en cada petición se come el límite de CPU y acaba
 * devolviendo 503 cuando llega una ráfaga (comprobado: 257 peticiones seguidas
 * a ?shard= dieron 195 respuestas 503). Un fichero estático lo sirve el borde
 * sin CPU, con caché automática y sin límite de peticiones: es una base de datos
 * de verdad, no un programa que la calcula.
 *
 * NO HAY DOS IMPLEMENTACIONES
 * ---------------------------
 * El generador no reescribe la conversión de esquema: se baja las fuentes con un
 * `fetch` de mentira y llama al MISMO `onRequest` que corre en el borde. Lo que
 * se guarda en disco es, byte a byte, lo que el worker habría devuelto.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

// ─────────────── red de mentira: los ficheros de origen, en local o de la red ───────────────

const cache = new Map();
const realFetch = globalThis.fetch;

/** Carga una fuente: de un fichero local si se pasa la ruta, o de su URL. */
async function leerFuente(url, rutaLocal) {
  if (rutaLocal) return JSON.parse(await readFile(rutaLocal, 'utf8'));
  const r = await realFetch(url, {
    headers: { 'User-Agent': 'PelisLatino-canales/1.0 (+generador)' },
  });
  if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
  return r.json();
}

// ─────────────── el worker, tal cual ───────────────

const worker = await import(join(RAIZ, 'functions', 'canales.js'));

/** Ejecuta onRequest contra un fichero local, y devuelve su texto. */
async function servir(qs, fuentes) {
  globalThis.fetch = async (u) => {
    const f = fuentes[u];
    if (!f) throw new Error('fuente no preparada: ' + u);
    return {
      ok: true, status: 200,
      headers: new Map([['etag', '"' + f.huella + '"'], ['last-modified', 'x']]),
      json: async () => f.json,
    };
  };
  try {
    const res = await worker.onRequest({
      request: new Request('https://generador.local/canales' + qs),
      env: {},
    });
    return { status: res.status, texto: await res.text() };
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ─────────────── el generador ───────────────

async function main() {
  const pequenaLocal = process.argv[2] || null;   // ruta a data_unificado.json
  const grandeLocal = process.argv[3] || null;    // ruta a canales-compacto.json

  console.log('bajando las fuentes...');
  const fuentes = {};
  fuentes[worker.PEQUENIA] = {
    json: await leerFuente(worker.PEQUENIA, pequenaLocal), huella: 'pequena',
  };
  fuentes[worker.GRANDE] = {
    json: await leerFuente(worker.GRANDE, grandeLocal), huella: 'grande',
  };
  console.log('  pequeña:', fuentes[worker.PEQUENIA].json.channels.length, 'entradas');
  console.log('  grande :', fuentes[worker.GRANDE].json.channels.length, 'entradas');

  const escribir = async (ruta, texto) => {
    await mkdir(dirname(join(RAIZ, ruta)), { recursive: true });
    await writeFile(join(RAIZ, ruta), texto);
    return texto.length;
  };

  console.log('generando...');
  let bytes = 0, cuantos = 0;

  // version + manifiesto
  const ver = await servir('?version=1', fuentes);
  const man = await servir('?manifiesto=1', fuentes);
  const m = JSON.parse(man.texto);
  bytes += await escribir('version.json', ver.texto); cuantos++;
  bytes += await escribir('manifiesto.json', man.texto); cuantos++;

  // los tres scopes de la app
  for (const s of Object.keys(worker.SCOPES)) {
    const r = await servir('?scope=' + s, fuentes);
    bytes += await escribir('scopes/' + s + '.json', r.texto); cuantos++;
  }

  // los shards, uno por fichero
  for (const s of m.indice) {
    const r = await servir('?shard=' + s.slug, fuentes);
    if (r.status !== 200) throw new Error('shard ' + s.slug + ' -> HTTP ' + r.status);
    bytes += await escribir('shards/' + s.slug + '.json', r.texto); cuantos++;
  }

  // ETAPA 1: la lista pequeña, estática también (0 CPU, es el camino más
  // sensible a la latencia). El resto de la compat de v7.16 (?solo=grande, la
  // raíz) la sigue sirviendo la función, así que no se duplica en disco.
  {
    const r = await servir('?solo=pequena', fuentes);
    bytes += await escribir('canales/pequena.json', r.texto); cuantos++;
  }

  console.log();
  console.log('  ficheros : ' + cuantos);
  console.log('  shards   : ' + m.indice.length);
  console.log('  canales  : ' + m.total + ' en ' + m.grupos + ' grupos');
  console.log('  version  : ' + m.version);
  console.log('  peso     : ' + (bytes / 1024 / 1024).toFixed(2) + ' MB');
  console.log();
  console.log('Listo. Commit y push: Cloudflare Pages lo redespliega solo.');
}

main().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
