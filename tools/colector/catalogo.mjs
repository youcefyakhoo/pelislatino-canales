/**
 * Convierte un BARRIDO de la API en el catálogo que ya consume la app.
 *
 * El contrato NO cambia: la app solo pide
 *
 *   GET /version.json                 -> {"version":"…","total":N}
 *   GET /scopes/corto|latam|global.json
 *
 * y dentro espera `{"total":N,"canales":[{title,image,category,options:[{url}]}]}`.
 * Todo lo demás (manifiesto, shards) es para el refresco selectivo y para depurar.
 *
 * LA REGLA QUE HACE QUE ESTO NO ROMPA NADA
 * ----------------------------------------
 * Los canales que ya estaban en la app y siguen existiendo en Drama conservan su
 * ORDEN y su puesto. Los nuevos entran detrás. Así:
 *   · nadie ve su lista de canales desordenada de un día para otro
 *   · los canales que el usuario ya tenía en «favoritos» siguen ahí
 *   · si la API devuelve menos de lo esperado, no desaparecen canales por un fallo
 *     puntual del barrido: solo se cae lo que de verdad ya no entrega Drama.
 *
 * Sin dependencias: se ejecuta en Node y en la GitHub Action.
 */

import { clave, huella, idLiveDe, slug, urlCanal } from './barrido.mjs';
import { colocarExternos } from './fuentes.mjs';

/** Canales por shard. 150 es lo que usa el repo y lo que la app ya tolera. */
export const CHUNK = 150;

/** Los topes de la app (`AutoCanales.TOPE_CORTO / TOPE_LATAM / TOPE_GLOBAL`). */
export const SCOPES = { corto: 600, latam: 2500, global: 12000 };

/**
 * Grupos cuyo contenido es «de todo»: si un canal aparece ahí y en su país, la app
 * debe mostrarlo en el país, no en el cajón de sastre. Se usan como ÚLTIMO recurso.
 */
const GRUPOS_GENERICOS = new Set([
  'hot_now', 'most watched', 'all', 'general', 'unsorted', 'otros',
  'canales internacionales', 'internacional', 'deportes en vivo',
]);

/**
 * ¿Es un evento en directo (un partido), y no un canal de siempre?
 *
 * Se reconoce por el id: el proveedor los publica como
 * `live_tv_livematches_<hash>DaddyLive`. Importa porque estos canales aparecen y
 * desaparecen con cada partido: dan 403 cuando no se juega (medido: 598 de los 875
 * caídos del catálogo eran de este tipo).
 *
 * No se descartan —cuando hay partido funcionan y son lo que más se busca— pero van
 * al final: si la app recorta, lo que se queda son los canales estables.
 */
export function esEvento(id) {
  return /livematches|daddylive|sportsonline|koora/i.test(String(id || ''));
}

/**
 * El orden del catálogo: primero los canales estables (el orden del proveedor), al
 * final los eventos. Se aplica UNA vez, antes de partir en shards, y como es un
 * orden estable no cambia el sitio relativo de nada.
 */
export function ordenar(canales) {
  const estables = [];
  const eventos = [];
  for (const c of canales) {
    const id = c && (c.id || idLiveDe(c.options && c.options[0] && c.options[0].url));
    (esEvento(id) ? eventos : estables).push(c);
  }
  return [...estables, ...eventos];
}

/** El canal en el esquema nativo de la app. */
export function aCanalApi(canal) {
  return {
    title: canal.nombre,
    image: canal.logo || '',
    category: canal.tema,
    options: [{ url: urlCanal(canal.id) }],
    // Campo de apoyo (la app lo ignora): de dónde salió y en qué más grupos está.
    d: canal.tipo,
  };
}

/** Lo que la app pinta hoy, leído de un JSON con `canales[]` (formato nativo o servers). */
export function normalesDe(json) {
  const out = [];
  const lista = json && Array.isArray(json.canales) ? json.canales : [];
  for (const c of lista) {
    if (!c || !c.title) continue;
    let urls = [];
    if (Array.isArray(c.options)) urls = c.options.map((o) => o && o.url).filter(Boolean);
    else if (Array.isArray(c.servers)) urls = c.servers.map((o) => o && o.url).filter(Boolean);
    const id = urls.map(idLiveDe).find(Boolean) || null;
    out.push({
      titulo: String(c.title),
      imagen: String(c.image || c.imageUrl || ''),
      grupo: String(c.category || c.grupo || ''),
      id,
      urls,
    });
  }
  return out;
}

/**
 * Fusiona el barrido con lo que la app ya tenía.
 *
 * @param {object} barrido  salida de `Barrido.todo()`
 * @param {Array}  previos  salida de `normalesDe()` con el catálogo publicado ayer
 * @returns {{canales: Array, nuevos: number, quitados: number, sinId: number}}
 */
export function fusionar(barrido, previos = [], { tope = 0, conservados = null } = {}) {
  // `conservados`: ids que ya no salen en el barrido pero que se comprobó que SIGUEN
  // emitiendo. Se quedan en su sitio, con su grupo de ayer.
  const porId = new Map();
  for (const c of barrido.canales) porId.set(c.id, c);

  const salida = [];
  const yaPuestos = new Set();
  let sinId = 0;

  // 1) Los que ya estaban, en su orden. Se quedan si Drama los sigue dando… o si se
  //    comprobó que, sin listarlos, siguen emitiendo (`conservados`).
  for (const p of previos) {
    if (p.id && !porId.has(p.id) && conservados && conservados.has(p.id)) {
      yaPuestos.add(p.id);
      salida.push({
        title: p.titulo,
        image: p.imagen,
        category: p.grupo || 'En vivo',
        options: (p.urls.length ? p.urls : [urlCanal(p.id)]).map((url) => ({ url })),
      });
      continue;
    }
    if (p.id && porId.has(p.id)) {
      const c = porId.get(p.id);
      yaPuestos.add(p.id);
      salida.push({
        title: c.nombre || p.titulo,
        image: c.logo || p.imagen,
        category: c.tema || p.grupo,
        options: [{ url: urlCanal(p.id) }],
      });
    } else if (!p.id) {
      // Canales de las fuentes viejas sin id_live (https directo, Xtream…). Se
      // conservan TAL CUAL: son los que hoy emiten y no dependen de Drama. Tirarlos
      // sería vaciar la app de canales que funcionan.
      sinId++;
      salida.push({
        title: p.titulo,
        image: p.imagen,
        category: p.grupo,
        options: (p.urls.length ? p.urls : ['']).map((url) => ({ url })),
      });
    }
  }

  // 2) Los nuevos que trajo la API, detrás y en el orden del proveedor.
  const nuevos = [];
  for (const c of barrido.canales) {
    if (yaPuestos.has(c.id)) continue;
    yaPuestos.add(c.id);
    // Un canal que ya viene en el esquema de la app (title + options) se deja TAL CUAL.
    // Son los externos de `fuentes.mjs`: si se les pasa por `aCanalApi` salen vacíos,
    // porque esa función espera el esquema de Drama (nombre/logo/tema).
    nuevos.push(Array.isArray(c.options) && c.title ? c : aCanalApi(c));
  }
  // Dentro de los nuevos se respeta el orden de `barrido.canales`, que es el de los
  // temas del proveedor.
  //
  // A BUCLE, no con `push(...nuevos)`: con 143.177 canales (TV + radio de los 465
  // temas) el spread revienta la pila — «Maximum call stack size exceeded», medido
  // en el primer barrido real.
  for (const c of nuevos) salida.push(c);

  // Tope: el catálogo no puede crecer sin límite (el repo se sirve por git y la app
  // baja un prefijo). Si hay más, se queda lo primero en el orden del proveedor y los
  // que ya estaban tienen prioridad (van delante).
  let recortados = 0;
  const final = tope > 0 && salida.length > tope ? salida.slice(0, tope) : salida;
  if (final.length < salida.length) recortados = salida.length - final.length;

  return {
    canales: final,
    nuevos: nuevos.length,
    quitados: previos.filter((p) => p.id && !porId.has(p.id) && !(conservados && conservados.has(p.id))).length,
    sinId,
    recortados,
  };
}

/**
 * Reparte los canales en shards SIN romper grupos, y devuelve también el manifiesto.
 *
 * Un grupo grande (Sports con 1.042 canales) sale en varios shards; uno pequeño, en
 * uno. Se corta en el orden en que vienen, que es el orden del editor.
 */
export function partir(canales, { chunk = CHUNK, version = '' } = {}) {
  const grupos = [];
  const porGrupo = new Map();
  for (const c of canales) {
    const k = clave(c.category) || 'en-vivo';
    if (!porGrupo.has(k)) {
      porGrupo.set(k, { clave: k, nombre: c.category || 'En vivo', canales: [] });
      grupos.push(porGrupo.get(k));
    }
    porGrupo.get(k).canales.push(c);
  }

  const shards = [];
  const usados = new Set();
  for (const g of grupos) {
    const trozos = Math.max(1, Math.ceil(g.canales.length / chunk));
    for (let i = 0; i < trozos; i++) {
      const suyos = g.canales.slice(i * chunk, (i + 1) * chunk);
      if (!suyos.length) continue;
      const base = slug(g.nombre);
      let nombre = trozos === 1 ? `${base}-01` : `${base}-${String(i + 1).padStart(2, '0')}`;
      // TV y radio comparten nombres de grupo («Peru», «Sports»): sin esto, el shard
      // de la radio PISA el de la tele y el manifiesto apunta dos veces al mismo.
      let choque = 1;
      while (usados.has(nombre)) nombre = `${base}-${String(++choque).padStart(2, '0')}`;
      usados.add(nombre);
      shards.push({
        slug: nombre,
        grupo: g.nombre,
        orden: shards.length,
        total: suyos.length,
        canales: suyos,
      });
    }
  }

  const indice = shards.map((s) => ({ slug: s.slug, n: s.total, orden: s.orden }));
  const manifiesto = {
    version,
    total: canales.length,
    grupos: grupos.length,
    shards: shards.length,
    chunk,
    scopes: SCOPES,
    indice,
  };
  return { shards, manifiesto };
}

/** Los canales de un alcance, en el orden del catálogo (prefijo exacto). */
export function scopeDe(canales, alcance) {
  const tope = SCOPES[alcance];
  if (!tope) throw new Error('alcance desconocido: ' + alcance);
  const suyos = canales.slice(0, tope);
  const grupos = new Set(suyos.map((c) => clave(c.category)));
  return {
    scope: alcance,
    tope,
    total: suyos.length,
    shards: [...grupos].length,
    canales: suyos,
  };
}

/**
 * La versión publicada. Es la huella de lo que de verdad se sirve: si cambió un
 * título, un logo o el orden, cambia la huella y la app se entera. Si el barrido no
 * trajo nada nuevo, la huella es la misma y la app NO baja nada (eso es lo que hace
 * que esto salga gratis en datos).
 */
export function versionDe(canales) {
  const semilla = canales.map((c) => c.title + '|' + c.image + '|' + c.category).join('\n');
  return huella(semilla);
}

/**
 * Construye TODOS los ficheros del catálogo a partir del barrido.
 *
 * @param {object} barrido
 * @param {object} opciones
 * @param {Array}  opciones.previos  canales publicados ayer (para conservar el orden)
 * @param {number} opciones.minimo   si el barrido trae menos que esto, no se publica
 * @returns {{ficheros: Record<string,string>, resumen: object}}
 */
export function construir(barrido, {
  previos = [], minimo = 0, tope = 0, perderMax = 0, conservados = null, externos = [],
} = {}) {
  // El orden final lo manda `fusionar` (los canales de ayer primero, en su orden). Los
  // externos se intercalan AQUÍ, sobre ese orden ya resuelto: si se meten antes, la
  // fusión los manda al final (no tienen `id` de Drama) y el tope se los come. Medido:
  // así quedaban 0 externos en el alcance corto.
  const f = fusionar(barrido, previos, { tope: 0, conservados });
  if (externos && externos.length) {
    f.canales = colocarExternos(f.canales, externos, { tope });
  }
  if (tope > 0 && f.canales.length > tope) f.canales = f.canales.slice(0, tope);
  if (minimo && f.canales.length < minimo) {
    throw new Error(
      `el barrido trajo ${f.canales.length} canales y el mínimo para publicar es ${minimo}. ` +
      'No se toca nada: se queda el catálogo anterior.',
    );
  }
  // Guardia RELATIVA: si de golpe se pierde más de `perderMax` de lo publicado ayer,
  // es un barrido malo (Render a medio despertar, proveedor devolviendo vacíos), no
  // un cambio real del catálogo. Se prefiere lo de ayer.
  if (perderMax > 0 && previos.length && f.canales.length < previos.length * (1 - perderMax)) {
    throw new Error(
      `el barrido trae ${f.canales.length} canales y ayer se publicaron ${previos.length} ` +
      `(se perdería más del ${Math.round(perderMax * 100)} %). No se publica: huele a fallo.`,
    );
  }
  // Los eventos al final: si la app recorta por alcance, se quedan los canales estables.
  const ordenados = ordenar(f.canales);
  const version = versionDe(ordenados);
  const { shards, manifiesto } = partir(ordenados, { version });

  const ficheros = {
    'version.json': JSON.stringify({ version, total: f.canales.length }),
    'manifiesto.json': JSON.stringify(manifiesto),
  };
  for (const [alcance] of Object.entries(SCOPES)) {
    ficheros[`scopes/${alcance}.json`] = JSON.stringify(scopeDe(ordenados, alcance));
  }
  for (const s of shards) {
    ficheros[`shards/${s.slug}.json`] = JSON.stringify(s);
  }
  // Compat con la etapa 1 de la app (lista pequeña, un solo fichero).
  ficheros['canales/pequena.json'] = JSON.stringify({
    total: Math.min(ordenados.length, SCOPES.corto),
    canales: ordenados.slice(0, SCOPES.corto),
  });

  return {
    ficheros,
    resumen: {
      api: barrido.api,
      at: barrido.at,
      canales: f.canales.length,
      nuevos: f.nuevos,
      quitados: f.quitados,
      sinId: f.sinId,
      recortados: f.recortados || 0,
      grupos: manifiesto.grupos,
      shards: manifiesto.shards,
      version,
      despertarMs: barrido.despertarMs,
      msBarrido: barrido.ms,
      fallos: Object.entries(barrido.tipos || {})
        .flatMap(([tipo, i]) => (i.fallos || []).map((x) => tipo + '/' + x)),
    },
  };
}
