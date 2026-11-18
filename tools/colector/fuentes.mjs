/**
 * LA SEGUNDA FUENTE: los canales que NO son de Drama.
 *
 * POR QUÉ EXISTE
 * --------------
 * El colector nació para barrer la API de Drama y de ahí sacaba TODO. El problema es
 * que Drama no tiene todo: hay 460 canales que la app venía mostrando (HBO, Cartoon
 * Network, CNN, BBC, ESPN…) que salen de otro sitio, y el colector los estaba tirando
 * sin avisar. Medido el 2026-11-18: de los 691 servidores de la fuente externa, CERO
 * seguían en el catálogo publicado.
 *
 * Y no eran canales muertos: de una muestra de 24, los 24 contestaban 200.
 *
 * DE DÓNDE SALEN (esto es lo que hay que entender)
 * ------------------------------------------------
 *   · Drama (API propia)          -> `dramalive://play?id_live=…`
 *   · externa (belkaperu/belkafut) -> URLs http(s) directas, de tres clases:
 *       1. m3u8 de un CDN o servidor de TV (45.228.234.30, 190.14.10.19,
 *          200.10.30.241, la20hd.com, streamx-hd.com…)
 *       2. páginas .html/.php que hay que resolver (embed.saohgdasregions.fun)
 *       3. listas .m3u alojadas en GitHub Pages (belkaperu.github.io,
 *          alilus.github.io) que apuntan a un stream
 *
 * CÓMO SE COMPRUEBAN
 * ------------------
 * Aquí no hay API que preguntar: se pide el propio stream.
 *   · un .m3u8 tiene que devolver 2xx Y empezar por `#EXTM3U` (un 200 de una página
 *     de error también es 200; el contenido es lo que manda)
 *   · una página se da por buena con 2xx: el reproductor la resuelve luego
 *   · 403/404 -> muerto. 5xx o tiempo agotado -> dudoso, no se retira a la primera
 *
 * Los servidores son de terceros y algunos son antiguos: se prueban con pocas
 * peticiones a la vez para no machacarlos (y porque no son nuestros).
 */

import { huella } from './barrido.mjs';

/** La lista externa por defecto. Se puede cambiar por entorno (`FUENTE_EXTERNA`). */
export const EXTERNA_POR_DEFECTO =
  'https://raw.githubusercontent.com/belkaperu/belkafut/refs/heads/main/data_unificado.json';

/** Prefijo de los ids de esta fuente: así no se confunden con los `live_tv_…`. */
export const PREFIJO = 'ext_';

/** Traducción de los grupos de la fuente externa a los del catálogo. */
const GRUPOS = {
  internacionales: 'Internacionales',
  internacional: 'Internacionales',
  peliculas: 'Peliculas',
  peliculas: 'Peliculas',
  películas: 'Peliculas',
  noticias: 'Noticias',
  deportes: 'Deportes',
  general: 'Deportes en Vivo',
  all: 'Deportes en Vivo',
  entretenimiento: 'Entretenimiento',
  infantil: 'Contenido Infantil',
  cultura: 'Cultura',
  musica: 'Musica',
  música: 'Musica',
  religion: 'Religioso',
};

/** Normaliza un nombre de grupo: minúsculas y sin tildes. */
function clave(t) {
  return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/** El grupo del catálogo al que va un canal externo. */
export function grupoDe(categoria) {
  return GRUPOS[clave(categoria)] || 'Directo (sin Drama)';
}

/** El id estable de un canal externo: su URL. Si la URL cambia, es otro canal. */
export function idExterno(url) {
  return PREFIJO + huella(String(url));
}

/**
 * Saca los canales externos del JSON de la fuente.
 *
 * El fichero trae `channels[]` con `servers[]{url}`. Un canal con varios servidores
 * vale por varios: si uno cae, el otro sigue, y como cada uno se publica como una
 * opción, la app los prueba todos (es lo que se pidió en el pedido 57: mostrar TODAS
 * las opciones).
 *
 * @returns {Array<{id, nombre, logo, tema, tipo, url, externo:true}>}
 */
export function canalesExternos(json) {
  const lista = json && Array.isArray(json.channels) ? json.channels : [];
  const porUrl = new Map();
  for (const c of lista) {
    if (!c) continue;
    const nombre = String(c.name || c.title || '').trim();
    for (const s of (c.servers || [])) {
      const url = String((s && s.url) || '').trim();
      // Solo http(s): un dramalive:// aquí duplicaría la fuente de Drama.
      if (!/^https?:\/\//i.test(url)) continue;
      if (porUrl.has(url)) continue;
      porUrl.set(url, {
        id: idExterno(url),
        nombre: nombre || 'Canal',
        logo: String(c.imageUrl || ''),
        tema: grupoDe(c.category),
        tipo: 'externo',
        url,
        externo: true,
      });
    }
  }
  return [...porUrl.values()];
}

/**
 * ¿Emite esta URL externa?
 *
 * @param {string} url
 * @param {object} opciones  `fetch`, `tiempoMs`
 * @returns {Promise<{estado:'emite'|'no-emite'|'desconocido', motivo:string, ms:number}>}
 */
export async function probarExterno(url, opciones = {}) {
  const fetch = opciones.fetch || globalThis.fetch;
  const tiempoMs = opciones.tiempoMs || 12_000;
  const t0 = Date.now();
  const esLista = /\.m3u8?(\?|$)/i.test(url);

  const pedir = async (method, extra = {}) => {
    const ctl = new AbortController();
    const corte = setTimeout(() => ctl.abort(), tiempoMs);
    try {
      const r = await fetch(url, {
        method,
        signal: ctl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13) PelisLatino/1.0',
          Accept: esLista ? 'application/vnd.apple.mpegurl,*/*' : 'text/html,*/*',
          ...extra,
        },
      });
      return r;
    } finally { clearTimeout(corte); }
  };

  try {
    // Para un .m3u8 hay que LEER: un 200 de una página de error no es un canal.
    const r = await pedir(esLista ? 'GET' : 'HEAD', esLista ? { Range: 'bytes=0-2048' } : {});
    const ms = Date.now() - t0;
    if (r.status === 403 || r.status === 404 || r.status === 410) {
      return { estado: 'no-emite', motivo: 'HTTP ' + r.status, ms };
    }
    if (r.status >= 500) return { estado: 'desconocido', motivo: 'HTTP ' + r.status, ms };
    if (r.status < 200 || r.status >= 300) {
      // 3xx que no sigue, 401…: no es un veredicto de muerte.
      return { estado: 'desconocido', motivo: 'HTTP ' + r.status, ms };
    }

    if (esLista) {
      const texto = (await r.text()).slice(0, 4096);
      if (!/#EXTM3U/i.test(texto)) {
        // 200 pero no es una lista: es una página de error o un HTML con el player.
        return { estado: 'no-emite', motivo: 'sin #EXTM3U', ms };
      }
    } else if (r.method === 'HEAD') {
      // Algunos servidores no implementan HEAD (o devuelven 200 mentiroso). Si el
      // cuerpo no dice nada, se pregunta con un GET corto.
      const r2 = await pedir('GET', { Range: 'bytes=0-1024' });
      if (r2.status >= 400 && r2.status < 500) {
        return { estado: 'no-emite', motivo: 'HTTP ' + r2.status, ms };
      }
    }
    return { estado: 'emite', motivo: '', ms };
  } catch (e) {
    const ms = Date.now() - t0;
    const nombre = String((e && e.name) || '');
    // Un fallo de DNS o SSL es del servidor; un tiempo agotado puede ser un mal minuto.
    if (/ENOTFOUND|CERT|SSL|ECONNREFUSED/i.test(String(e && e.message))) {
      return { estado: 'no-emite', motivo: 'servidor caído', ms };
    }
    return { estado: 'desconocido', motivo: nombre === 'AbortError' ? 'tiempo agotado' : String(e && e.message || e).slice(0, 80), ms };
  }
}

/**
 * COLOCA los externos en el catálogo PUBLICADO, repartidos por grupos.
 *
 * El problema que resuelve, medido en la app (7.39.3):
 *   · la app recorta la lista PLANA al tope del alcance (corto 600, latam 2.500) ANTES
 *     de agrupar por categoría, y luego pinta una pestaña por categoría
 *   · el catálogo de Drama tiene ~1.000 canales por grupo y 154 grupos
 *
 * Así que si los 677 externos se añaden al catálogo de Drama (12.000), con el alcance
 * corto NO SE VE NINGUNO: los primeros 600 son todos de Drama. Comprobado.
 *
 * La colocación es PROPORCIONAL:
 *   · cada categoría de Drama cede un hueco cada `paso` canales, donde
 *     `paso = canalesDrama / externos` (unos 18 con las cifras de hoy)
 *   · en ese hueco entra el siguiente externo de su categoría
 *   · los externos de categorías que Drama no tiene van al principio, en su bloque
 *
 * Resultado: los externos caen dentro del alcance corto (unos 33 de 600), siguen
 * apareciendo en SU pestaña, y el catálogo de Drama conserva su orden relativo.
 */
export function colocarExternos(canales, externos, opciones = {}) {
  if (!externos.length) return canales;
  const tope = opciones.tope || canales.length || 12000;
  const paso = Math.max(1, Math.round(canales.length / Math.max(1, externos.length)));

  // Los que Drama no tiene (Cultura, Directo…) van al principio, en un bloque: si
  // fueran al final no se verían en el alcance corto, que es donde hay que verlos.
  const gruposDrama = new Set(canales.map((c) => clave(c.category)));
  const sinGrupo = externos.filter((c) => !gruposDrama.has(clave(c.tema)));
  const conGrupo = externos.filter((c) => gruposDrama.has(clave(c.tema)));

  const aOpcion = (c) => ({
    title: c.nombre,
    image: c.logo,
    category: c.tema,
    options: [{ url: c.url }],
    d: 'externo',   // la app lo ignora; sirve para auditar
  });

  // Cola por grupo, respetando el orden de la fuente.
  const colas = new Map();
  for (const c of conGrupo) {
    const k = clave(c.tema);
    if (!colas.has(k)) colas.set(k, []);
    colas.get(k).push(c);
  }

  const salida = sinGrupo.map(aOpcion);
  const puestos = new Set();
  for (let i = 0; i < canales.length; i++) {
    salida.push(canales[i]);
    // Un hueco cada `paso`: entra el siguiente externo de la MISMA categoría del canal
    // que acaba de pasar; si esa categoría ya no tiene, se usa la siguiente con cola.
    if ((i + 1) % paso === 0 && puestos.size < conGrupo.length && salida.length < tope) {
      const k = clave(canales[i].category);
      let elegido = colas.get(k);
      if (!elegido || !elegido.length) {
        for (const [kk, cola] of colas) { if (cola.length) { elegido = cola; break; } }
      }
      if (elegido && elegido.length) {
        const c = elegido.shift();
        salida.push(aOpcion(c));
        puestos.add(c.id);
      }
    }
  }
  // Los que no cupieron (no debería, pero por si acaso) al final.
  for (const cola of colas.values()) for (const c of cola) salida.push(aOpcion(c));
  return salida;
}

/**
 * Mete los canales externos en su grupo, AL FINAL de los canales de ese grupo.
 *
 * Por qué al final de su grupo y no sueltos al final del catálogo: los alcances de la
 * app (`corto` = 600, `latam` = 2.500) son PREFIJOS. Si los 460 externos van detrás de
 * los 12.000 de Drama, no los ve nadie. Metidos en su grupo, los de Deportes y Noticias
 * caen donde el usuario ya los busca.
 *
 * Si el grupo no existe, se crea al final.
 */
export function insertarExternos(canales, externos) {
  if (!externos.length) return canales;
  const porGrupo = new Map();
  for (const c of externos) {
    const k = clave(c.tema);
    if (!porGrupo.has(k)) porGrupo.set(k, []);
    porGrupo.get(k).push(c);
  }

  const aOpcion = (c) => ({
    title: c.nombre,
    image: c.logo,
    category: c.tema,
    options: [{ url: c.url }],
    // Campo de apoyo (la app lo ignora): de dónde salió.
    d: 'externo',
  });

  // Una sola pasada. La primera versión insertaba grupo a grupo con `splice`, y al
  // meter el primero se desplazaban los índices de los siguientes: los externos de
  // Noticias acababan dentro de Deportes. Medido por el test.
  const ultimo = new Map();
  for (let i = 0; i < canales.length; i++) {
    ultimo.set(clave(canales[i].category), i);
  }

  const salida = [];
  const puestos = new Set();
  for (let i = 0; i < canales.length; i++) {
    salida.push(canales[i]);
    const k = clave(canales[i].category);
    if (ultimo.get(k) === i && porGrupo.has(k) && !puestos.has(k)) {
      puestos.add(k);
      for (const c of porGrupo.get(k)) salida.push(aOpcion(c));
    }
  }

  // Los grupos que no existen en el catálogo, al final.
  for (const [k, suyos] of porGrupo) {
    if (puestos.has(k)) continue;
    for (const c of suyos) salida.push(aOpcion(c));
  }
  return salida;
}
