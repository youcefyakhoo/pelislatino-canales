/**
 * PelisLatino - catálogo de canales en el borde (Cloudflare Pages Function).
 *
 * QUÉ ES
 * -------
 * Una BASE DE DATOS de canales, no un fichero gordo que se baja entero.
 *
 *   · manifiesto  - el índice: versión, cuántos shards hay y qué canales trae cada uno
 *   · shards      - el catálogo PARTIDO en trozos de ~150 canales, en el orden del editor
 *   · versión     - una huella de 12 caracteres: si no cambió, la app no baja nada
 *   · scopes      - corto (600) / latam (2.500) / global (12.000), los topes de la app
 *   · paginación  - limit/offset, como cualquier consulta
 *
 * POR QUÉ PARTIRLO
 * ----------------
 * La app tiene tres alcances (AutoCanales.TOPE_CORTO / TOPE_LATAM / TOPE_GLOBAL).
 * Antes bajaba SIEMPRE los 3,5 MB y luego recortaba la lista en el móvil: con el
 * alcance «corto» tiraba el 96 % de lo descargado. Medido con los ficheros de hoy:
 *
 *   alcance   antes      ahora (shards)    ahorro
 *   corto     3.411 KB   164 KB   (6)      21 x
 *   latam     3.411 KB   571 KB   (21)      6 x
 *   global    3.411 KB   2,7 MB  (202)    1,2 x  -> aquí gana la VERSIÓN: si no
 *                                                 cambió nada, baja 0 KB
 *
 * El orden de los shards es el del editor (Most watched, Peru, Live Matches...),
 * que es el que la app ya respeta: cortar por shards NO cambia lo que se ve.
 *
 * ENDPOINTS
 * ---------
 *   /canales                       todo fusionado (las dos fuentes) - compat v7.16
 *   /canales?solo=pequena          la lista pequeña, ETAPA 1        - compat v7.16
 *   /canales?solo=grande           el catálogo grande completo       - compat v7.16
 *   /canales?manifiesto=1          el índice de shards
 *   /canales?version=1             {"version":"..."} - para comprobar si cambió
 *   /canales?scope=corto|latam|global   los shards en orden hasta el tope
 *   /canales?shard=<slug>          UN shard
 *   /canales?limit=600&offset=1200 paginación
 *
 * Las URLs de origen se cambian sin tocar el código (variables de entorno):
 *   FUENTE_PEQUENIA   por defecto: belkaperu/belkafut data_unificado.json
 *   FUENTE_GRANDE     por defecto: youcefyakhoo/cesopppplop canales-compacto.json
 */

export const PEQUENIA = 'https://raw.githubusercontent.com/belkaperu/belkafut/refs/heads/main/data_unificado.json';
export const GRANDE = 'https://raw.githubusercontent.com/youcefyakhoo/cesopppplop/refs/heads/main/canales-compacto.json';

/** Canales por shard. Con 150: 257 shards de ~13 KB. */
export const CHUNK = 150;

/** Los topes de la app (AutoCanales.TOPE_CORTO / TOPE_LATAM / TOPE_GLOBAL). */
export const SCOPES = { corto: 600, latam: 2500, global: 12000 };

// ─────────────────────────── utilidades ───────────────────────────

/** Minúsculas y sin tildes: «Películas» y «peliculas» tienen que caer juntas. */
function clave(t) {
  return String(t || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim();
}

/** Solo se aceptan URLs que de verdad se pueden abrir. */
function esUrl(u) {
  return typeof u === 'string' && (/^https?:\/\//i.test(u) || /^(rtmp|rtp|dramalive):/i.test(u));
}

/** Huella corta y estable de un texto (FNV-1a de 32 bits, en hexadecimal). */
function huella(texto) {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

/** «Most watched» -> «most-watched»: seguro para URL y para nombre de fichero. */
function slug(t) {
  return clave(t)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'en-vivo';
}

/** Grupo -> rótulo bueno, tal como los publica cada fichero. */
function mapaGrupos(cats) {
  const m = new Map();
  for (const c of (cats || [])) {
    const name = c && c.name;
    if (!name) continue;
    const rotulo = (c.display_name && c.display_name.trim()) || name;
    const k = clave(name);
    if (!m.has(k)) m.set(k, rotulo);
  }
  // «all» y «general» no tienen rótulo propio: los dos agrupan deportes.
  m.set('all', 'Deportes en Vivo');
  m.set('general', 'Deportes en Vivo');
  return m;
}

function opciones(servers, options) {
  const out = [];
  for (const s of (servers || [])) {
    if (!s || !esUrl(s.url)) continue;
    out.push({ label: (s.name || '').trim(), url: s.url });
  }
  for (const o of (options || [])) {
    if (!o || !esUrl(o.url)) continue;
    out.push({ label: (o.label || '').trim(), url: o.url });
  }
  return out;
}

/**
 * data_unificado.json - los canales van SUELTOS en `channels[]` y cada uno
 * repite su grupo en minúsculas.
 */
function deUnificado(json) {
  const grupos = mapaGrupos(json.categories);
  const salida = [];
  for (const c of (json.channels || [])) {
    const ops = opciones(c.servers, c.options);
    if (!ops.length) continue;                       // sin URL jugable no hay canal
    const titulo = (c.title || c.name || '').trim();
    if (!titulo) continue;
    const k = clave(c.category);
    salida.push({
      title: titulo,
      image: (c.imageUrl || '').trim(),
      category: grupos.get(k) || (c.category || 'En vivo').trim(),
      options: ops,
    });
  }
  return salida;
}

/**
 * canales-compacto.json - los canales van SUELTOS en `channels[]` y cada uno
 * lleva su grupo en `category`, que es el `display_name` de `categories[]`.
 *
 * Espeja `CatalogoJson.aM3uUnico` (Java): el orden lo manda `categories[]`, un
 * canal con un grupo que no está en el índice se añade al final en vez de
 * perderse, y de cada canal sale SU PRIMER servidor (igual que `fila()`).
 */
function deCompacto(json) {
  const porGrupo = new Map();
  for (const c of (json.categories || [])) {
    const dn = c && c.display_name && c.display_name.trim();
    if (dn && !porGrupo.has(dn)) porGrupo.set(dn, []);
  }
  for (const c of (json.channels || [])) {
    if (!c) continue;
    const grupo = (c.category && c.category.trim()) || 'En vivo';
    if (!porGrupo.has(grupo)) porGrupo.set(grupo, []);
    porGrupo.get(grupo).push(c);
  }
  const salida = [];
  for (const [grupo, canales] of porGrupo) {
    for (const c of canales) {
      const url = c.servers && c.servers[0] && c.servers[0].url;
      if (!esUrl(url)) continue;
      const titulo = (c.name || c.title || '').trim();
      if (!titulo) continue;
      salida.push({
        title: titulo,
        image: (c.imageUrl || c.image || '').trim(),
        category: grupo,
        options: [{ label: '', url }],
      });
    }
  }
  return salida;
}

/**
 * Etiquetas legibles. Si el nombre del servidor no dice nada se DEJA VACÍA (no se
 * manda el campo): la app rellena «Ver» / «Servidor N» ella sola en `sanear()`,
 * y así el payload pesa menos. Solo se numeran las que chocan entre sí.
 */
function etiquetar(canales) {
  for (const c of canales) {
    const vistas = new Set();
    c.options = c.options.map((o, i) => {
      let base = (o.label || '').trim();
      if (base && vistas.has(base)) base = base + ' ' + (i + 1);   // no repetir etiqueta
      if (base) vistas.add(base);
      return base ? { label: base, url: o.url } : { url: o.url };
    });
  }
  return canales;
}

/** Mismo título = mismo canal: los servidores se suman como opciones. */
function dedupe(canales) {
  const porTitulo = new Map();
  const salida = [];
  for (const c of canales) {
    const k = c.title.toLowerCase();
    const previo = porTitulo.get(k);
    if (previo) { previo.options.push(...c.options); continue; }
    porTitulo.set(k, c);
    salida.push(c);
  }
  return salida;
}

// ─────────────────────────── las fuentes ───────────────────────────

/** Baja una fuente y se queda también con su huella (etag + last-modified). */
async function traer(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'PelisLatino-canales/1.0 (+cloudflare-pages)' },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
  return {
    json: await r.json(),
    huella: (r.headers.get('etag') || '') + '|' + (r.headers.get('last-modified') || ''),
  };
}

/** El catálogo GRANDE ya convertido, con la huella de su fuente. Es la base de
 *  los shards: el manifiesto, la versión y los scopes salen de aquí. */
async function catalogoGrande(env) {
  const url = env.FUENTE_GRANDE || GRANDE;
  const src = await traer(url);
  const canales = etiquetar(dedupe(deCompacto(src.json)));
  return { canales, version: huella(url + src.huella) };
}

/** La lista PEQUEÑA (ETAPA 1), ya convertida. */
async function catalogoPequeno(env) {
  const url = env.FUENTE_PEQUENIA || PEQUENIA;
  const src = await traer(url);
  return etiquetar(deUnificado(src.json));
}

// ─────────────────────────── los shards ───────────────────────────

/**
 * Parte el catálogo en trozos de CHUNK canales, SIN romper los grupos: un grupo
 * de 1.042 canales sale en 7 shards, y uno de 15 en un shard solo.
 *
 * El `orden` es la posición global: recorriendo los shards por `orden` se vuelve
 * a obtener la lista EXACTA que la app ve hoy, así que cortar por shards no
 * cambia nada de lo que se ve, solo cuánto se baja.
 */
function partir(canales) {
  const shards = [];
  const porGrupo = new Map();
  for (const c of canales) {
    const g = (c.category && c.category.trim()) || 'En vivo';
    if (!porGrupo.has(g)) porGrupo.set(g, []);
    porGrupo.get(g).push(c);
  }
  let orden = 0;
  for (const [grupo, cs] of porGrupo) {
    for (let i = 0; i < cs.length; i += CHUNK) {
      const trozo = cs.slice(i, i + CHUNK);
      shards.push({
        slug: slug(grupo) + '-' + String(Math.floor(i / CHUNK) + 1).padStart(2, '0'),
        grupo: grupo,
        canales: trozo,
        orden: orden++,
      });
    }
  }
  return shards;
}

/** El manifiesto: el índice de la "base de datos". */
function manifiesto(shards, version) {
  return {
    version: version,
    total: shards.reduce((a, s) => a + s.canales.length, 0),
    grupos: new Set(shards.map(s => s.grupo)).size,
    shards: shards.length,
    chunk: CHUNK,
    scopes: SCOPES,
    indice: shards.map(s => ({ slug: s.slug, n: s.canales.length, orden: s.orden })),
  };
}

/** Los shards en orden hasta cubrir `tope` canales. */
function shardsHasta(shards, tope) {
  const out = [];
  let acc = 0;
  for (const s of shards) {
    if (acc >= tope) break;
    out.push(s);
    acc += s.canales.length;
  }
  return out;
}

/** JSON con cabeceras de BD: caché en el borde + CORS + versión. */
function json(cuerpo, version, extra) {
  const h = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=300, stale-while-revalidate=600',
    'access-control-allow-origin': '*',
  };
  if (version) h['x-version'] = version;
  for (const k in (extra || {})) h[k] = extra[k];
  return new Response(JSON.stringify(cuerpo), { headers: h });
}

function error(motivo, status) {
  return new Response(JSON.stringify({ error: motivo }), {
    status: status || 502,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}

/**
 * Envoltorio de caché del borde: la primera petición paga el trabajo de partir
 * el catálogo y las siguientes lo reciben ya hecho.
 *
 * Se cachea el DATO (objeto plano), no la Response: una Response sólo se puede
 * leer una vez, y guardarla en el borde para luego devolverla daba
 * «Body has already been read» en la segunda petición. Si `caches` no está
 * disponible (o falla) se calcula al vuelo: nunca se deja de servir.
 *
 * @return el objeto cacheado, o recién construido
 */
async function enBorde(clave, construir) {
  try {
    const c = await caches.default.open('pelislatino-canales');
    const hit = await c.match(clave);
    if (hit) return hit.json();
  } catch (e) { /* sin borde: se calcula y se sigue */ }
  const datos = await construir();
  try {
    const c = await caches.default.open('pelislatino-canales');
    await c.put(clave, new Response(JSON.stringify(datos), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=600, stale-while-revalidate=1200',
      },
    }));
  } catch (e) { /* sin borde: da igual, la siguiente petición lo recalcula */ }
  return datos;
}

// ─────────────────────────── el servicio ───────────────────────────

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const q = url.searchParams;
  const env = context.env || {};
  const solo = (q.get('solo') || '').toLowerCase();

  try {
    // ---- la lista pequeña de la ETAPA 1 (compat) ----
    if (solo === 'pequena') {
      const canales = await catalogoPequeno(env);
      if (!canales.length) return error('la fuente pequeña no dio canales');
      return json({ total: canales.length, canales: canales }, null,
        { 'x-canales': String(canales.length) });
    }

    // ---- todo lo demás se apoya en el catálogo grande ----
    const src = env.FUENTE_GRANDE || GRANDE;
    const datos = await enBorde('grande:' + src, () => catalogoGrande(env));
    const canales = datos.canales;
    const version = datos.version;
    if (!canales.length) return error('la fuente grande no dio canales');

    // ---- compat: el catálogo grande completo ----
    if (solo === 'grande') {
      return json({ total: canales.length, canales: canales }, version,
        { 'x-canales': String(canales.length) });
    }

    // ---- la versión: lo más barato que hay, para no bajar nada si no cambió ----
    if (q.get('version') !== null) {
      return json({ version: version, total: canales.length }, version);
    }

    // ---- el manifiesto: el índice de shards ----
    if (q.get('manifiesto') !== null) {
      const man = await enBorde('shards:' + version, () => manifiesto(partir(canales), version));
      return json(man, version);
    }

    // ---- UN shard ----
    const shard = q.get('shard');
    if (shard) {
      const uno = await enBorde('shard:' + version + ':' + shard, () => {
        const encontrado = partir(canales).find(x => x.slug === shard);
        return encontrado ? {
          slug: encontrado.slug, grupo: encontrado.grupo, orden: encontrado.orden,
          total: encontrado.canales.length, canales: encontrado.canales,
        } : null;
      });
      return uno ? json(uno, version) : error('no existe el shard «' + shard + '»', 404);
    }

    // ---- un scope: los shards en orden hasta el tope de la app ----
    const scope = (q.get('scope') || '').toLowerCase();
    if (scope) {
      const tope = SCOPES[scope];
      if (!tope) return error('scope desconocido: ' + scope + ' (corto, latam, global)', 400);
      const troceado = await enBorde('scope:' + version + ':' + scope, () => {
        const elegidos = shardsHasta(partir(canales), tope);
        const planos = [];
        for (const s of elegidos) planos.push(...s.canales);
        // LIMIT de verdad: el último shard puede pasarse del tope, y el móvil lo
        // iba a recortar igual (AutoCanales.limitar). Recortando aquí se baja menos.
        return {
          scope: scope, tope: tope, total: Math.min(planos.length, tope),
          shards: elegidos.map(s => s.slug), canales: planos.slice(0, tope),
        };
      });
      return json(troceado, version, { 'x-canales': String(troceado.total) });
    }

    // ---- paginación, como una consulta cualquiera ----
    const limit = q.get('limit');
    if (limit !== null) {
      const n = Math.max(1, Math.min(canales.length, parseInt(limit, 10) || 100));
      const off = Math.max(0, Math.min(canales.length, parseInt(q.get('offset') || '0', 10) || 0));
      const trozo = canales.slice(off, off + n);
      return json({
        total: canales.length, offset: off, limit: n,
        quedan: Math.max(0, canales.length - off - trozo.length), canales: trozo,
      }, version);
    }

    // ---- sin parámetros: TODO fusionado (las dos fuentes), como en v7.16 ----
    const pequena = await catalogoPequeno(env).catch(() => []);
    const fusion = etiquetar(dedupe([].concat(pequena, canales)));
    return json({ total: fusion.length, canales: fusion }, version,
      { 'x-canales': String(fusion.length) });
  } catch (e) {
    return error(String((e && e.message) || e));
  }
}
