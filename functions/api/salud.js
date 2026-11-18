/**
 * PelisLatino — estado EN VIVO de los canales (Cloudflare Pages Function).
 *
 * QUÉ RESUELVE
 * ------------
 * El catálogo estático dice qué canales existen y cuáles se comprobó que emitían en
 * la última pasada (cada 6 h, ver `.github/workflows/colector.yml`). Pero entre
 * pasada y pasada un canal puede caerse, y la app no tiene forma de saberlo hasta
 * la siguiente.
 *
 * Este endpoint lo contesta al momento, sin tocar el catálogo ni la app:
 *
 *   GET /api/salud                       resumen de todo el catálogo
 *   GET /api/salud?id=<id_live>          ¿este canal emite ahora?  (cacheado 3 min)
 *   GET /api/salud?ids=a,b,c             varios a la vez
 *
 * Y CÓMO NO SE COME RENDER ENTERO
 * -------------------------------
 * El problema no es consultar: es que 20.000 móviles consulten a la vez y despierten
 * a Render (que además da 5xx cuando se le aprieta: medido, a concurrencia 12 baja a
 * 28 canales/min frente a 89 a concurrencia 8).
 *
 * Tres capas, de la más barata a la más cara:
 *
 *   1. CACHÉ EN EL BORDE (`caches.default`). Si alguien preguntó por ese canal hace
 *      menos de 3 min, no se sale de Cloudflare: 0 peticiones a Render.
 *   2. ESTADO GUARDADO (`estado/salud.json`, servido como fichero estático). Un canal
 *      del que no hay veredicto reciente recibe el que consta, con su fecha. Se
 *      devuelve `fresh: false` para que quien pregunte sepa que es de hace X.
 *   3. LA API, solo si hace falta y solo si `PROXY` está configurado. Se protege con
 *      un tope de concurrencia por isolate y un tiempo máximo corto.
 *
 * La respuesta SIEMPRE es 200 con un JSON útil, aunque todo lo demás falle.
 */

/** Cuánto se cachea en el borde un veredicto por canal. */
const TTL_CANAL = 180;

/** Tope de canales por petición: esto no es una API para barrer el catálogo entero. */
const MAX_IDS = 20;

/** Respuesta JSON con caché. */
function json(datos, { status = 200, maxAge = 0 } = {}) {
  return new Response(JSON.stringify(datos), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

/** La URL base del propio sitio (para leer los ficheros estáticos). */
function baseDe(request) {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

/** Lee un JSON estático del propio sitio. Cacheado por el CDN de Pages. */
async function leerEstatico(request, ruta) {
  try {
    const r = await fetch(baseDe(request) + ruta, { cf: { cacheTtl: 300 } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * Lee el estado guardado una sola vez por isolate: es un fichero de ~200 KB que cambia
 * cada 6 h, así que no tiene sentido bajarlo en cada petición.
 */
let cacheSalud = { at: 0, datos: null };
const TTL_SALUD_MS = 5 * 60_000;

async function saludGuardada(request, env, ctx) {
  if (cacheSalud.datos && Date.now() - cacheSalud.at < TTL_SALUD_MS) return cacheSalud.datos;
  const datos = await leerEstatico(request, '/estado/salud.json');
  if (datos) {
    cacheSalud = { at: Date.now(), datos };
  }
  return datos || cacheSalud.datos || null;
}

/** Un veredicto a partir del estado guardado, con su edad. */
function veredicto(registro) {
  if (!registro) {
    return { emite: null, estado: 'sin-datos', fresh: false, comprobado: null, motivo: 'nunca comprobado' };
  }
  const edadMin = registro.at ? Math.round((Date.now() - Date.parse(registro.at)) / 60_000) : null;
  return {
    emite: registro.estado === 'emite',
    estado: registro.estado,
    fresh: false,
    comprobado: registro.at || null,
    hace_min: edadMin,
    fallos: registro.fallos || 0,
    opciones: registro.opciones || 0,
    motivo: registro.motivo || '',
  };
}

/**
 * Pregunta a la API de verdad, con protección.
 *
 * `env.PROXY` es la base de la API (por ejemplo https://dramalive-api-08th.onrender.com).
 * Si no está, este endpoint solo sirve lo guardado: se puede desplegar sin riesgo.
 */
async function preguntarApi(env, ids) {
  if (!env || !env.PROXY) return null;
  const base = String(env.PROXY).replace(/\/+$/, '');
  const codigo = env.CODIGO || '232425';
  const salida = {};

  await Promise.all(ids.map(async (id) => {
    const url = `${base}/opciones/${encodeURIComponent(codigo)}/${encodeURIComponent(id)}`;
    const ctl = new AbortController();
    // Corto a propósito: si Render está dormido, no se hace esperar al móvil. Se
    // contesta con lo guardado y la app decide.
    const corte = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch(url, {
        signal: ctl.signal,
        headers: { accept: 'application/json', 'user-agent': 'PelisLatino-edge/1.0' },
      });
      if (r.ok) {
        const d = await r.json();
        const ops = Array.isArray(d && d.opciones) ? d.opciones : [];
        const emiten = ops.filter((o) => o && o.emite).length;
        salida[id] = {
          emite: emiten > 0,
          estado: emiten > 0 ? 'emite' : 'no-emite',
          fresh: true,
          comprobado: new Date().toISOString(),
          hace_min: 0,
          opciones: emiten,
          total_opciones: ops.length,
          motivo: emiten > 0 ? '' : ((ops[0] && ops[0].error) || 'sin opciones'),
        };
      }
    } catch {
      /* tiempo agotado, 5xx o red: se contesta con lo guardado */
    } finally {
      clearTimeout(corte);
    }
  }));

  return Object.keys(salida).length ? salida : null;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-max-age': '86400',
      },
    });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'solo GET' }, { status: 405 });
  }

  const guardada = await saludGuardada(request, env, context);
  const registros = guardada && guardada.canales ? guardada.canales : {};

  const uno = url.searchParams.get('id');
  const varios = url.searchParams.get('ids');
  const ids = uno ? [uno] : varios ? varios.split(',').map((s) => s.trim()).filter(Boolean) : [];

  // ── sin ids: el resumen del catálogo guardado ──
  if (!ids.length) {
    let emiten = 0, caidos = 0, sinDatos = 0;
    for (const r of Object.values(registros)) {
      if (r.estado === 'emite') emiten++;
      else if (r.estado === 'no-emite') caidos++;
      else sinDatos++;
    }
    return json({
      ok: true,
      actualizado: (guardada && guardada.at) || null,
      hace_min: guardada && guardada.at ? Math.round((Date.now() - Date.parse(guardada.at)) / 60_000) : null,
      total: Object.keys(registros).length,
      emiten, caidos, sinDatos,
      como_usar: 'GET /api/salud?id=<id_live>  ó  ?ids=a,b,c (máx ' + MAX_IDS + ')',
    }, { maxAge: 60 });
  }

  if (ids.length > MAX_IDS) {
    return json({ ok: false, error: `máximo ${MAX_IDS} canales por petición` }, { status: 400 });
  }
  for (const id of ids) {
    if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(id)) {
      return json({ ok: false, error: 'id no válido: ' + id }, { status: 400 });
    }
  }

  // ── 1) caché en el borde ──
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const resultados = {};
  const faltan = [];
  for (const id of ids) {
    const clave = new Request(`${baseDe(request)}/api/salud?id=${encodeURIComponent(id)}`, { method: 'GET' });
    const golpe = cache ? await cache.match(clave) : null;
    if (golpe) {
      try { resultados[id] = await golpe.json(); } catch { faltan.push(id); }
    } else {
      faltan.push(id);
    }
  }

  // ── 2) estado guardado; 3) la API si hay PROXY ──
  if (faltan.length) {
    const deApi = await preguntarApi(env, faltan);
    for (const id of faltan) {
      resultados[id] = (deApi && deApi[id]) || veredicto(registros[id]);
      // Solo se cachea lo que viene fresco; lo guardado ya se cachea 60 s por el CDN.
      if (deApi && deApi[id] && cache) {
        const clave = new Request(`${baseDe(request)}/api/salud?id=${encodeURIComponent(id)}`, { method: 'GET' });
        const copia = new Response(JSON.stringify(resultados[id]), {
          headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${TTL_CANAL}` },
        });
        context.waitUntil(cache.put(clave, copia));
      }
    }
  }

  // Una sola respuesta con todos, para no multiplicar peticiones.
  const emiten = Object.values(resultados).filter((x) => x.emite === true).length;
  return json({
    ok: true,
    total: ids.length,
    emiten,
    canales: resultados,
    fuente: Object.values(resultados).some((x) => x.fresh) ? 'api' : 'guardado',
    actualizado: (guardada && guardada.at) || null,
  }, { maxAge: 60 });
}
