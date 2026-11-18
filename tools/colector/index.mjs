#!/usr/bin/env node
/**
 * COLECTOR — refresca el catálogo de canales desde la API propia de Drama Live.
 *
 *   node tools/colector/index.mjs                 # barre y escribe
 *   node tools/colector/index.mjs --ver           # barre y solo enseña el resumen
 *   node tools/colector/index.mjs --sin-escribir  # igual que --ver
 *   node tools/colector/index.mjs --minimo=3000   # no publica si trae menos
 *   node tools/colector/index.mjs --sin-externos  # sin la fuente que no es Drama
 *   node tools/colector/index.mjs --todo          # vuelta completa de verificación
 *   node tools/colector/index.mjs --api=https://otro.onrender.com
 *
 * Lo lanza la GitHub Action (`.github/workflows/colector.yml`) de madrugada. También
 * se puede probar en local sin tocar nada: por defecto NO escribe.
 *
 * Qué escribe (lo mismo que ya servía el repo, sin cambiar el contrato de la app):
 *   version.json · manifiesto.json · scopes/{corto,latam,global}.json
 *   shards/<slug>.json · canales/pequena.json · estado/barrido.json
 *
 * Reglas de seguridad, en este orden:
 *   1. Si Render no despierta            -> no se escribe NADA (sale con código 1).
 *   2. Si el barrido trae menos del mínimo -> no se escribe NADA.
 *   3. Si la huella no cambió            -> no se escribe NADA (no hay commit vacío).
 *   4. Todo se escribe primero en temporal y se renombra: nunca queda un JSON a medias.
 */

import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Barrido } from './barrido.mjs';
import { construir, normalesDe } from './catalogo.mjs';
import {
  EXTERNA_POR_DEFECTO, canalesExternos, probarExterno, colocarExternos,
} from './fuentes.mjs';
import {
  leerSalud, verificarCanales, resumenSalud, publicables, anotar,
  necesitaVueltaCompleta, cobertura,
} from './salud.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Un barrido tan corto no es un catálogo: es un fallo disfrazado. */
const MINIMO_POR_DEFECTO = 2_000;

/**
 * Techo de canales publicados = el máximo que la app muestra (`TOPE_GLOBAL` = 12.000).
 *
 * Ni uno más, por dos razones medidas:
 *   · peso: el catálogo va en git y cada 1.000 canales son ~230 KB en cada scope
 *   · calidad: a partir del puesto ~12.000 del barrido los canales están muertos
 *     (medido: del 0 al 12.000 emiten el 100 %; por detrás, casi ninguno)
 *
 * Publicar más de lo que la app enseña solo engorda el repo con canales que nadie ve.
 */
const TOPE_POR_DEFECTO = 12_000;

/** Si de golpe se pierde más de este % respecto a lo publicado ayer, no se publica. */
const PERDER_MAX = 0.5;

function argumentos(argv) {
  const a = {
    escribir: true, minimo: MINIMO_POR_DEFECTO, tope: TOPE_POR_DEFECTO,
    api: undefined, codigo: undefined, tipos: undefined, log: true,
    presupuestoMin: 90, concurrencia: 10, verificar: true,
    todo: false, coberturaMinima: 0.9,
    // La fuente externa (belkaperu) va activada: son los ~460 canales que NO son de
    // Drama y que se estaban perdiendo. `--sin-externos` la apaga.
    externos: true, fuenteExterna: undefined,
  };
  for (const x of argv.slice(2)) {
    if (x === '--ver' || x === '--sin-escribir' || x === '--dry-run') a.escribir = false;
    else if (x === '--silencio') a.log = false;
    else if (x.startsWith('--minimo=')) a.minimo = Number(x.split('=')[1]) || 0;
    else if (x.startsWith('--tope=')) a.tope = Number(x.split('=')[1]) || 0;
    else if (x.startsWith('--api=')) a.api = x.slice(6);
    else if (x.startsWith('--codigo=')) a.codigo = x.slice(9);
    else if (x.startsWith('--tipos=')) a.tipos = x.slice(8).split(',').map((s) => s.trim()).filter(Boolean);
    else if (x.startsWith('--presupuesto=')) a.presupuestoMin = Number(x.split('=')[1]) || 0;
    else if (x.startsWith('--concurrencia=')) a.concurrencia = Number(x.split('=')[1]) || 4;
    else if (x === '--sin-verificar') a.verificar = false;
    else if (x === '--todo') a.todo = true;
    else if (x === '--sin-externos') a.externos = false;
    else if (x.startsWith('--fuente-externa=')) a.fuenteExterna = x.slice(16);
    else if (x.startsWith('--cobertura=')) a.coberturaMinima = Number(x.split('=')[1]) / 100;
  }
  return a;
}

/** Escribe varios ficheros: primero a `.tmp`, luego `rename` (atómico). */
async function escribirTodo(ficheros, raiz) {
  let bytes = 0;
  for (const [ruta, contenido] of Object.entries(ficheros)) {
    const destino = join(raiz, ruta);
    await mkdir(dirname(destino), { recursive: true });
    const tmp = destino + '.tmp';
    await writeFile(tmp, contenido);
    await rename(tmp, destino);
    bytes += contenido.length;
  }
  return bytes;
}

/**
 * Borra los shards que ya no referencia el manifiesto.
 *
 * Sin esto, cada barrido deja atrás los shards de grupos que cambiaron de nombre o
 * desaparecieron (medido: 56 huérfanos en el primer run, 281 ficheros para 225
 * shards). No rompen nada, pero engordan el repo para siempre y confunden al depurar.
 */
async function limpiarShards(raiz, vigentes) {
  let borrados = 0;
  try {
    for (const f of await readdir(join(raiz, 'shards'))) {
      if (!f.endsWith('.json')) continue;
      if (!vigentes.has(f)) { await unlink(join(raiz, 'shards', f)); borrados++; }
    }
  } catch { /* no existe shards/ todavía */ }
  return borrados;
}

/** Lee un JSON; si no existe o está roto, devuelve null (nunca lanza). */
async function leerJson(ruta) {
  try { return JSON.parse(await readFile(ruta, 'utf8')); } catch { return null; }
}

/** Los canales que ya están publicados, para conservar su orden. */
async function previos(raiz) {
  for (const ruta of ['scopes/global.json', 'canales/pequena.json']) {
    const j = await leerJson(join(raiz, ruta));
    const lista = normalesDe(j);
    if (lista.length) return lista;
  }
  return [];
}

async function main() {
  const op = argumentos(process.argv);
  const log = op.log ? (...x) => console.log(...x) : () => {};

  const barrido = new Barrido({
    api: op.api,
    codigo: op.codigo,
    log,
    ajustes: {
      concurrencia: Number(process.env.CONCURRENCIA || 6),
      esperaMaxMs: Number(process.env.ESPERA_MAX_MS || 180_000),
    },
  });

  log(`colector: ${barrido.api} · código ${barrido.codigo}` +
      `${op.escribir ? '' : ' · MODO PRUEBA: no se escribe nada'}`);
  const datos = await barrido.todo({
    tipos: op.tipos,
    progreso: ({ tipo, hechos, total }) => log(`  ${tipo}: ${hechos}/${total} temas`),
  });

  const deAyer = await previos(RAIZ);
  log(`publicado ayer: ${deAyer.length} canales · barrido: ${datos.canales.length}`);

  // ────────────────────────── LA SALUD ──────────────────────────
  // Aquí se decide qué canales FUNCIONAN. El barrido dice qué existe; esto dice qué
  // emite, y solo eso se publica. Ver tools/colector/salud.mjs.
  const rutaSalud = join(RAIZ, 'estado/salud.json');
  let salud = leerSalud(await leerJson(rutaSalud));
  const idsDelBarrido = datos.canales.map((c) => c.id);
  const idsDeAyer = deAyer.map((p) => p.id).filter(Boolean);

  let informe = null;
  if (op.verificar) {
    const antes = resumenSalud(salud);
    log(`salud guardada: ${antes.emiten} emiten · ${antes.caidos} caídos · ${antes.nunca} sin comprobar`);
    // QUÉ SE COMPRUEBA Y QUÉ NO.
    //
    // El barrido trae 19.568 canales, pero la app nunca enseña más de 12.000
    // (`AutoCanales.TOPE_GLOBAL`). Verificar los 4.500 del final es gastar 40 min por
    // pasada en canales que nadie va a ver. Se verifica hasta `tope` (15.000), que es
    // el prefijo que se publica y sobra para el alcance global.
    //
    // Los que desaparecieron del barrido pero estaban ayer también entran: un canal
    // puede salir de un tema y seguir emitiendo.
    const desaparecidos = idsDeAyer.filter((id) => !idsDelBarrido.includes(id));
    const porVerificar = [...new Set([
      ...idsDelBarrido.slice(0, op.tope || idsDelBarrido.length),
      ...desaparecidos,
    ])];
    // Los candidatos de verdad son los que la app puede llegar a mostrar (el prefijo
    // que se publica). La cobertura se mide sobre eso, no sobre los 19.000 del barrido.
    const candidatos = op.tope ? porVerificar.slice(0, op.tope) : porVerificar;

    // ── ¿vuelta completa? ──
    // Si hay muchos canales sin veredicto, una pasada normal no cierra el hueco:
    // solo mira lo caducado y la deuda crece. Ver `necesitaVueltaCompleta`.
    const cob = cobertura(salud, candidatos);
    const completa = op.todo || necesitaVueltaCompleta(salud, candidatos, op.coberturaMinima);
    log(`cobertura: ${(cob * 100).toFixed(1)} % de ${candidatos.length} canales con veredicto` +
        `${completa ? ' -> VUELTA COMPLETA' : ''}`);

    informe = await verificarCanales(barrido, salud, candidatos, {
      todo: completa,
      concurrencia: op.concurrencia,
      presupuestoMs: op.presupuestoMin * 60_000,
      // Cada 500 canales se guarda el estado: si la pasada se corta a la mitad (o el
      // runner muere), no se pierde lo comprobado. Es lo que permite pasadas de horas.
      guardarCada: 500,
      // En modo prueba (--ver) no se escribe NADA en disco, ni siquiera el estado.
      guardar: op.escribir
        ? (s) => escribirTodo({ 'estado/salud.json': JSON.stringify(s) }, RAIZ)
        : null,
      log,
      progreso: ({ comprobados, emiten, noEmiten, pendientes }) =>
        log(`  verificados ${comprobados} (emiten ${emiten}, no ${noEmiten}) · faltan ${pendientes}`),
    });
    salud = informe.salud;
    log(`verificación: ${informe.comprobados} canales en ${Math.round(informe.ms / 1000)} s` +
        ` · emiten ${informe.emiten} · no emiten ${informe.noEmiten} · sin respuesta ${informe.desconocidos}` +
        `${informe.agotado ? ` · PRESUPUESTO AGOTADO, quedan ${informe.pendientes} (sigue en la próxima pasada)` : ''}`);
    const cobDespues = cobertura(salud, candidatos);
    log(`cobertura tras la pasada: ${(cobDespues * 100).toFixed(1)} %` +
        (cobDespues < op.coberturaMinima
          ? ` — AVISO: por debajo del ${Math.round(op.coberturaMinima * 100)} %, la próxima va completa`
          : ''));
    if (informe.comprobados && op.escribir) {
      await escribirTodo({ 'estado/salud.json': JSON.stringify(salud) }, RAIZ);
    }
  }

  // ── los que desaparecen del barrido: ¿siguen emitiendo? ──
  //
  // No se borra un canal solo porque Drama deje de listarlo. Pero la comprobación
  // tampoco se hace con un HEAD al proxy: medido, ese HEAD da 200 en canales que la
  // API marca muertos (dice «resolví», no «emite»). Se pregunta a `/opciones`, que
  // descarga el manifiesto de verdad, siempre que la salud no lo sepa ya.
  const salen = new Set(datos.canales.map((c) => c.id));
  const desaparecen = deAyer
    .filter((p) => p.id && !salen.has(p.id))
    .map((p) => p.id);
  const conservados = new Set();
  for (const id of desaparecen) {
    if (salud.canales[id] && salud.canales[id].estado === 'emite') conservados.add(id);
  }
  const sinVeredicto = desaparecen.filter((id) => !conservados.has(id) && !salud.canales[id]);
  if (sinVeredicto.length) {
    log(`comprobando ${sinVeredicto.length} canales que desaparecen del barrido…`);
    let n = 0;
    const nota = await barrido.enParalelo(sinVeredicto.slice(0, 400), async (id) => {
      const r = await barrido.verificar(id);
      if (r.estado !== 'desconocido') salud.canales[id] = anotar(salud.canales[id], r, Date.now());
      if (++n % 100 === 0) log(`  ${n}/${sinVeredicto.length}`);
      return r.estado === 'emite' ? id : null;
    }, op.concurrencia);
    for (const id of nota) if (id) conservados.add(id);
  }
  if (desaparecen.length) {
    log(`  siguen emitiendo (se conservan): ${conservados.size} · se retiran: ${desaparecen.length - conservados.size}`);
  }

  // ─────────────────── LA SEGUNDA FUENTE (NO Drama) ───────────────────
  //
  // Drama no tiene todo. Los ~460 canales que no son de Drama (HBO, Cartoon Network,
  // CNN, BBC…) salen de belkaperu/belkafut como URLs http(s) directas, y el colector
  // los estaba tirando: medido, de 691 servidores externos 0 quedaban publicados.
  // Se añaden aquí, con su propia comprobación (no la de Drama).
  let externos = [];
  const rutaExternos = join(RAIZ, 'estado/externos.json');
  let saludExt = (await leerJson(rutaExternos)) || { version: 1, canales: {} };
  if (op.externos) {
    const fuente = op.fuenteExterna || process.env.FUENTE_EXTERNA || EXTERNA_POR_DEFECTO;
    log(`fuente externa: ${fuente}`);
    try {
      const ctl = new AbortController();
      const corte = setTimeout(() => ctl.abort(), 60_000);
      const r = await fetch(fuente, { signal: ctl.signal, headers: { 'User-Agent': 'PelisLatino-colector/1.0' } });
      clearTimeout(corte);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const json = await r.json();
      externos = canalesExternos(json);
      log(`  ${externos.length} canales externos (URLs directas, no Drama)`);
    } catch (e) {
      // Si la fuente externa falla, NO se pierden los que ya estaban publicados: se
      // recuperan del catálogo de ayer, que los trae como canales sin id_live.
      log(`  aviso: la fuente externa no se pudo leer (${e.message}); se conservan los de ayer`);
      externos = deAyer
        .filter((p) => !p.id && p.urls.length)
        .map((p) => ({
          id: 'ext_' + p.urls[0], nombre: p.titulo, logo: p.imagen,
          tema: p.grupo, tipo: 'externo', url: p.urls[0], externo: true,
        }));
      log(`  recuperados de ayer: ${externos.length}`);
    }

    // Verificación: solo los que no tengan un veredicto reciente. Aquí no hay API a la
    // que preguntar, se pide el stream. Se prueban pocos a la vez: los servidores son
    // de terceros y algunos son viejos.
    const ahora = Date.now();
    const VIGENCIA_EXT = 12 * 3600_000;
    const aProbar = externos.filter((c) => {
      const s = saludExt.canales[c.id];
      return !s || !s.at || ahora - Date.parse(s.at) > VIGENCIA_EXT || s.estado === 'desconocido';
    });
    if (aProbar.length) {
      log(`  comprobando ${aProbar.length} externos…`);
      let hechos = 0;
      await barrido.enParalelo(aProbar, async (c) => {
        const r = await probarExterno(c.url, { tiempoMs: 12_000 });
        saludExt.canales[c.id] = { estado: r.estado, at: new Date().toISOString(), motivo: r.motivo, ms: r.ms };
        if (++hechos % 100 === 0) log(`    ${hechos}/${aProbar.length}`);
      }, 6);
    }
    // Qué se publica: emite, o desconocido (no se castiga un servidor lento), o el
    // primer fallo de un canal que venía funcionando. 403/404 repetido = fuera.
    externos = externos.filter((c) => {
      const s = saludExt.canales[c.id];
      if (!s) return true;
      if (s.estado === 'emite') return true;
      if (s.estado === 'desconocido') return true;
      // no-emite: se cae si el motivo es definitivo (40x / servidor caído).
      return !/40[34]|servidor caído|sin #EXTM3U/i.test(s.motivo || '');
    });
    const cuenta = externos.length;
    const vivos = externos.filter((c) => (saludExt.canales[c.id] || {}).estado === 'emite').length;
    log(`  externos publicados: ${cuenta} (${vivos} verificados emitiendo)`);
    if (op.escribir) {
      await escribirTodo({ 'estado/externos.json': JSON.stringify(saludExt) }, RAIZ);
    }
  }

  // ── el filtro de verdad: solo lo que consta que emite ──
  // Un canal nunca comprobado se queda si ya estaba publicado; si no, la app se
  // quedaría vacía mientras avanza la primera pasada (tarda días en verse todo).
  const sanos = new Set(publicables(salud, idsDelBarrido, idsDeAyer));
  const datosPublicables = { ...datos, canales: datos.canales.filter((c) => sanos.has(c.id)) };
  const deAyerPublicables = deAyer.filter((p) => !p.id || sanos.has(p.id));
  log(`se publican ${datosPublicables.canales.length} de ${datos.canales.length} canales del barrido`);

  // Los externos se meten en su grupo, al final de él, para que caigan dentro de los
  // alcances (que son prefijos: corto = 600).
  if (externos.length) {
    // Repartidos por grupos, no pegados al final: el alcance corto es un prefijo de
    // 600 y el catálogo de Drama tiene ~1.000 por grupo, así que al final no se vería
    // ninguno. Ver `colocarExternos`.
    datosPublicables.canales = colocarExternos(datosPublicables.canales, externos, { tope: op.tope });
    log(`catálogo con externos: ${datosPublicables.canales.length} canales`);
  }

  let salida;
  try {
    salida = construir(datosPublicables, {
      previos: deAyerPublicables, minimo: op.minimo, tope: op.tope, perderMax: PERDER_MAX,
      conservados,
    });
  } catch (e) {
    console.error('NO SE PUBLICA:', e.message);
    process.exit(1);
  }

  const r = salida.resumen;
  log('');
  log(`  canales   : ${r.canales} (nuevos ${r.nuevos}, quitados ${r.quitados}, sin id ${r.sinId}` +
      `${r.recortados ? `, recortados ${r.recortados}` : ''})`);
  log(`  grupos    : ${r.grupos} · shards: ${r.shards}`);
  log(`  version   : ${r.version}`);
  log(`  despertar : ${r.despertarMs} ms · barrido: ${Math.round(r.msBarrido / 1000)} s`);
  if (r.fallos.length) {
    log(`  avisos    : ${r.fallos.length} temas con fallo (se sigue con el resto)`);
    for (const f of r.fallos.slice(0, 10)) log(`     · ${f}`);
  }

  // La versión ya publicada: si es la misma, no hay nada que hacer.
  let versionActual = '';
  try {
    versionActual = JSON.parse(await readFile(join(RAIZ, 'version.json'), 'utf8')).version || '';
  } catch { /* primera vez */ }
  if (versionActual && versionActual === r.version) {
    log('\nla huella no cambió: no se escribe nada.');
    return;
  }

  if (!op.escribir) {
    log('\n(--ver) no se escribe nada.');
    return;
  }

  const sano = resumenSalud(salud);
  log(`  salud     : ${sano.emiten} emiten · ${sano.caidos} caídos · ${sano.nunca} sin comprobar`);

  const bytes = await escribirTodo(salida.ficheros, RAIZ);
  const vigentes = new Set(
    Object.keys(salida.ficheros).filter((f) => f.startsWith('shards/')).map((f) => f.slice(7)),
  );
  const sobran = await limpiarShards(RAIZ, vigentes);
  if (sobran) log(`borrados ${sobran} shards que ya no usa el manifiesto`);
  // El estado del barrido NO se sirve a la app: es para saber qué pasó.
  await escribirTodo({
    'estado/barrido.json': JSON.stringify({
      ...r, at: datos.at, api: datos.api,
      salud: resumenSalud(salud),
      cobertura: Number(cobertura(salud, datos.canales.map((c) => c.id)).toFixed(4)),
      externos: externos.length,
      externosVivos: externos.filter((c) => (saludExt.canales[c.id] || {}).estado === 'emite').length,
      verificacion: informe && {
        comprobados: informe.comprobados, emiten: informe.emiten,
        noEmiten: informe.noEmiten, desconocidos: informe.desconectados ?? informe.desconocidos,
        agotado: informe.agotado, segundos: Math.round(informe.ms / 1000),
      },
    }, null, 2),
  }, RAIZ);

  log(`\nescritos ${Object.keys(salida.ficheros).length} ficheros · ${(bytes / 1024).toFixed(0)} KB`);
  log('commit y push: Cloudflare Pages lo redespliega solo.');
}

main().catch((e) => {
  console.error('COLECTOR FALLÓ:', e && e.message ? e.message : e);
  process.exit(1);
});
