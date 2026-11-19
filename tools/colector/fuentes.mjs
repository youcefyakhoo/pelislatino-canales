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

/**
 * Traducción de los grupos de la fuente externa a los del catálogo de Drama.
 *
 * IMPORTANTE: los nombres tienen que coincidir LETRA A LETRA con los que ya usa el
 * catálogo, y esos están en INGLÉS (`News`, `Movies`, `Sports`, `Kids`…). La primera
 * versión los traducía al español (`Noticias`, `Peliculas`) y el resultado fue que
 * NINGÚN canal externo caía en su pestaña: se creaban grupos nuevos y, como no existían
 * en Drama, todos se iban al principio del catálogo (600 de 600 en el alcance corto).
 * Drama sí tiene grupos de país en su idioma (`Peru`, `Mexico`), y esos se respetan.
 */
const GRUPOS = {
  internacionales: 'News',              // canales de otro país: la pestaña que más se usa
  internacional: 'News',
  noticias: 'News',
  news: 'News',
  peliculas: 'Movies',
  'peliculas de cine': 'Movies',
  movies: 'Movies',
  deportes: 'Sports',
  sports: 'Sports',
  general: 'Sports',
  all: 'Sports',
  entretenimiento: 'Entertainment',
  entertainment: 'Entertainment',
  infantil: 'Kids',
  kids: 'Kids',
  cultura: 'Documentary',
  documentales: 'Documentary',
  documentary: 'Documentary',
  musica: 'Music',
  music: 'Music',
  religion: 'Religious',
  religioso: 'Religious',
  religious: 'Religious',
};

/** Normaliza un nombre de grupo: minúsculas y sin tildes. */
function clave(t) {
  return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/** El grupo del catálogo al que va un canal externo. */
export function grupoDe(categoria) {
  // Si no se reconoce, va a `Entertainment` (existe en el catálogo) en vez de crear un
  // grupo nuevo: un grupo con 3 canales que el usuario no encuentra no sirve de nada.
  return GRUPOS[clave(categoria)] || 'Entertainment';
}

/** Los grupos que crea la fuente externa: para avisar si alguno no existe en Drama. */
export const GRUPOS_EXTERNOS = Object.freeze(Object.values(GRUPOS));

/** Nombre normalizado, para comparar canales y para el id. */
export function normalizar(t) {
  return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * El id estable de un canal externo: su NOMBRE normalizado.
 *
 * Antes era la URL, y estaba mal: belkafut reparte un mismo canal en varios servidores
 * (`America TV` con 3 URLs), así que salía tres veces en el catálogo. Con el nombre,
 * el canal es uno y sus servidores son OPCIONES (que es lo que pidió el pedido 57:
 * mostrar todas).
 */
export function idExterno(nombre) {
  return PREFIJO + huella(normalizar(nombre));
}

/**
 * Agrupa las entradas de belkafut: un canal por nombre, con TODAS sus URLs.
 *
 * Medido: 691 URLs → 460 canales. Los 231 restantes eran el mismo canal repetido.
 */
export function agruparPorNombre(externos) {
  const porId = new Map();
  for (const c of externos) {
    const id = c.id || idExterno(c.nombre);
    const previo = porId.get(id);
    if (!previo) {
      porId.set(id, { ...c, id, urls: [c.url] });
      continue;
    }
    if (!previo.urls.includes(c.url)) previo.urls.push(c.url);
    // El logo y el grupo del primero mandan; si el primero no traía logo, se usa otro.
    if (!previo.logo && c.logo) previo.logo = c.logo;
  }
  return [...porId.values()];
}

/**
 * Quita los externos cuyo nombre ya está en el catálogo de Drama.
 *
 * Son 122 de 691. La app dedupe por nombre (`FusionRejilla.conDramaPrimero`), así que
 * esos no se verían igualmente; publicarlos solo engorda el JSON. Y si el de Drama
 * está en el catálogo es porque consta que emite (lo comprueba `salud.mjs`).
 */
export function quitarRepetidos(externos, titulosDrama) {
  // Se compara con el nombre SIN la etiqueta de calidad: Drama titula `America TV (720p)`
  // y belkafut `America TV`. Sin quitarla, los 122 repetidos seguirían entrando.
  const sinCalidad = (t) => normalizar(String(t || '').replace(/\(\s*\d{3,4}\s*[pi]\s*\)/gi, ''));
  const ya = new Set((titulosDrama || []).map(sinCalidad));
  return externos.filter((c) => !ya.has(sinCalidad(c.nombre)));
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
        // El id va por NOMBRE: `agruparPorNombre` junta después los servidores del
        // mismo canal. Poniendo aquí el id de la URL, cada servidor era «otro canal».
        id: idExterno(nombre || url),
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
  // El `paso` se calcula sobre el TAMAÑO QUE SE VA A PUBLICAR (`tope`), no sobre el
  // catálogo entrante. Con 691 externos y tope 12.000: uno cada 18 canales, ~33 dentro
  // del alcance corto. Calculándolo sobre la entrada (11.999) salían 600 en el corto:
  // los externos copaban los 600 puestos y no se veía Drama.
  // CUOTA: los externos son un COMPLEMENTO, no el catálogo. Se les reserva una
  // fracción del alcance corto (`cuota`, 10 % por defecto = 60 de 600) y se reparten
  // por igual: un externo cada `paso` canales de Drama.
  //
  // Lo que había antes y por qué no valía: `paso = canales / externos`. Con 691
  // externos y 12.000 canales daba 17, pero luego el alcance corto recortaba a 600 y
  // se quedaba con 600 externos y casi ningún canal de Drama. Y con `paso` calculado
  // sobre 600 daba 1: un externo entre cada dos canales.
  const corto = Math.min(canales.length, opciones.corto || 600);
  const cuota = opciones.cuota || 0.10;
  const deseados = Math.min(externos.length, Math.max(1, Math.round(corto * cuota)));
  const paso = Math.max(1, Math.round(corto / deseados));

  // Los que Drama no tiene (Cultura, Directo…) van al principio, en un bloque: si
  // fueran al final no se verían en el alcance corto, que es donde hay que verlos.
  const gruposDrama = new Set(canales.map((c) => clave(c.category)));
  const sinGrupo = externos.filter((c) => !gruposDrama.has(clave(c.tema)));
  const conGrupo = externos.filter((c) => gruposDrama.has(clave(c.tema)));

  const aOpcion = (c) => ({
    title: c.nombre,
    image: c.logo,
    category: c.tema,
    // Todas sus URLs: si un servidor cae, la app prueba el siguiente.
    options: (c.urls && c.urls.length ? c.urls : [c.url]).map((u) => ({ url: u })),
    d: 'externo',   // la app lo ignora; sirve para auditar
  });

  // Cola por grupo, respetando el orden de la fuente.
  const colas = new Map();
  for (const c of conGrupo) {
    const k = clave(c.tema);
    if (!colas.has(k)) colas.set(k, []);
    colas.get(k).push(c);
  }

  // Los «sin grupo» NO van en bloque al principio: con 388 externos y 600 puestos, el
  // alcance corto empezaba con 78 externos seguidos y no se veía ni un canal de Drama.
  // Se intercalan también con el mismo `paso`.
  const colaSinGrupo = sinGrupo.slice();
  const salida = [];
  const puestos = new Set();
  for (let i = 0; i < canales.length; i++) {
    salida.push(canales[i]);
    // Un hueco cada `paso`: entra el siguiente externo de la MISMA categoría del canal
    // que acaba de pasar; si esa categoría ya no tiene, se usa la siguiente con cola.
    // El primer hueco es de los «sin grupo» (así aparecen desde el principio, pero no
    // todos juntos); después, los del grupo del canal que acaba de pasar.
    if ((i + 1) % paso === 0 && salida.length < tope && (colaSinGrupo.length || puestos.size < conGrupo.length)) {
      const k = clave(canales[i].category);
      let elegido = colas.get(k);
      if (!elegido || !elegido.length) {
        for (const [, cola] of colas) { if (cola.length) { elegido = cola; break; } }
      }
      // Alterna: un «sin grupo» cada dos huecos, para que no se junten todos.
      const deSinGrupo = colaSinGrupo.length && (puestos.size % 2 === 0 || !(elegido && elegido.length));
      const c = deSinGrupo ? colaSinGrupo.shift() : (elegido && elegido.length ? elegido.shift() : null);
      if (c) {
        salida.push(aOpcion(c));
        puestos.add(c.id);
      }
    }
  }
  // Los que no cupieron (no debería, pero por si acaso) al final.
  for (const c of colaSinGrupo) salida.push(aOpcion(c));
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
    options: (c.urls && c.urls.length ? c.urls : [c.url]).map((u) => ({ url: u })),
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
