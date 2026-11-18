/**
 * Tests del colector. Se ejecutan con el runner de Node, sin dependencias:
 *
 *   node --test tools/colector/
 *
 * Lo que se prueba aquí es justo lo que duele en producción: Render dormida, un 5xx
 * a mitad del barrido, un JSON truncado, y que un barrido malo NUNCA pise el catálogo
 * bueno. Todo con un `fetch` de mentira: estos tests no tocan la red.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Barrido, huella, idLiveDe, urlCanal } from './barrido.mjs';
import { construir, fusionar, normalesDe, partir, scopeDe, versionDe, SCOPES } from './catalogo.mjs';

// ─────────────────────────── ayudas ───────────────────────────

const temasTv = { temas: [
  { id_topic: 'hot_now', name_topic: 'Most watched', img_url_topic: 'x.png' },
  { id_topic: 'peru', name_topic: 'Peru', img_url_topic: 'pe.png' },
] };
const canalesPeru = { canales: [
  { id_live: 'live_tv_americatv', name: 'America TV', img_url: 'a.png', id_topic: 'peru', type: 'tv' },
  { id_live: 'live_tv_panamericana', name: 'Panamericana', img_url: 'p.png', id_topic: 'peru', type: 'tv' },
] };
const canalesHot = { canales: [
  { id_live: 'live_tv_americatv', name: 'America TV', img_url: 'a.png', id_topic: 'hot_now', type: 'tv' },
  { id_live: 'live_tv_beinsport1', name: 'Bein S. 1', img_url: 'b.png', id_topic: 'hot_now', type: 'tv' },
] };

/**
 * Un `fetch` de mentira con guion: cada entrada es `{ estado, cuerpo }` o `'red'`.
 * Si el guion se acaba, responde 404 (que es lo que haría Render con un tema muerto).
 */
function fetchGuion(guion, { alFinal } = {}) {
  const cola = [...guion];
  const llamadas = [];
  const f = async (url) => {
    llamadas.push(String(url));
    const paso = cola.length ? cola.shift() : (alFinal ?? { estado: 404, cuerpo: { detail: 'no' } });
    if (paso === 'red') throw new Error('ECONNRESET');
    if (paso === 'corte') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return {
      ok: paso.estado >= 200 && paso.estado < 300,
      status: paso.estado,
      text: async () => (typeof paso.cuerpo === 'string' ? paso.cuerpo : JSON.stringify(paso.cuerpo)),
    };
  };
  f.llamadas = llamadas;
  return f;
}

/** Reloj de mentira: cada `dormir` avanza el tiempo en vez de esperar. */
function relojFalso() {
  let t = 0;
  return {
    reloj: () => t,
    dormir: async (ms) => { t += ms; },
    ahora: () => t,
  };
}

function barridoCon(fetch, extra = {}) {
  const r = relojFalso();
  return new Barrido({
    fetch, reloj: r.reloj, dormir: r.dormir,
    ajustes: { reintentos: extra.reintentos ?? 3, tiempoMs: 1000, esperaMaxMs: extra.esperaMaxMs ?? 60_000 },
  });
}

// ─────────────────────────── el barrido ───────────────────────────

test('despierta Render antes de barrer: 502, 502 y luego 200', async () => {
  const f = fetchGuion([
    { estado: 502, cuerpo: 'arrancando' },
    { estado: 503, cuerpo: 'arrancando' },
    { estado: 200, cuerpo: { ok: true } },
  ]);
  const b = barridoCon(f);
  const r = await b.despertar();
  assert.equal(r.despierta, true);
  assert.equal(f.llamadas.length, 3);
  // La primera petición es la barata, no un tema.
  assert.match(f.llamadas[0], /\/salud$/);
});

test('si Render no despierta, el barrido FALLA en vez de publicar vacío', async () => {
  const f = fetchGuion([], { alFinal: { estado: 502, cuerpo: 'no' } });
  const b = barridoCon(f, { esperaMaxMs: 20_000 });
  await assert.rejects(() => b.despertar(), /no despertó/);
});

test('un 404 no se reintenta (el tema ya no existe); un 5xx sí', async () => {
  const f = fetchGuion([
    { estado: 404, cuerpo: { detail: 'no existe' } },
  ]);
  const b = barridoCon(f);
  const r = await b.pedir('/canales/232425/inexistente');
  assert.equal(r.ok, false);
  assert.equal(f.llamadas.length, 1);   // sin reintentos

  const f2 = fetchGuion([
    { estado: 503, cuerpo: 'x' },
    { estado: 200, cuerpo: { vale: 1 } },
  ]);
  const b2 = barridoCon(f2);
  const r2 = await b2.pedir('/temas/232425?tipo=tv');
  assert.equal(r2.ok, true);
  assert.equal(f2.llamadas.length, 2);
});

test('un JSON truncado se reintenta y no rompe el barrido', async () => {
  const f = fetchGuion([
    { estado: 200, cuerpo: '{"temas":[{"id_topic":"pe' },   // cortado a mitad
    { estado: 200, cuerpo: temasTv },
  ]);
  const b = barridoCon(f);
  const r = await b.pedir('/temas/232425?tipo=tv');
  assert.equal(r.ok, true);
  assert.equal(r.datos.temas.length, 2);
});

test('una caída de red a mitad se reintenta', async () => {
  const f = fetchGuion(['red', { estado: 200, cuerpo: { ok: 1 } }]);
  const b = barridoCon(f);
  const r = await b.pedir('/salud');
  assert.equal(r.ok, true);
});

test('un tema que falla NO tumba el barrido: se sigue con el resto', async () => {
  const f = fetchGuion([
    { estado: 200, cuerpo: { ok: true } },          // despertar
    { estado: 200, cuerpo: temasTv },               // temas tv
    { estado: 200, cuerpo: canalesHot },            // hot_now
    { estado: 500, cuerpo: 'boom' },                // peru: falla (y sus reintentos)
    { estado: 500, cuerpo: 'boom' },
    { estado: 500, cuerpo: 'boom' },
    { estado: 500, cuerpo: 'boom' },
  ]);
  const b = barridoCon(f, { reintentos: 3 });
  const d = await b.todo({ tipos: ['tv'] });
  assert.equal(d.canales.length, 2);                 // los de hot_now
  assert.equal(d.tipos.tv.fallos.length, 1);
  assert.match(d.tipos.tv.fallos[0], /peru/);
});

test('si Render se duerme A MITAD, se despierta otra vez y no se queda en timeouts', async () => {
  // Guion por RUTA, no por orden: así se prueba de verdad el camino
  // «503 -> this.durmiendo -> despertar() -> seguir».
  let unaCaida = true;
  let saludes = 0;
  const f = async (url) => {
    const u = String(url);
    if (/\/salud$/.test(u)) {
      saludes++;
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    }
    if (/\/temas\//.test(u)) return { ok: true, status: 200, text: async () => JSON.stringify(temasTv) };
    if (/canales\/232425\/peru/.test(u) && unaCaida) {
      unaCaida = false;
      return { ok: false, status: 503, text: async () => 'dormido' };   // Render se durmió
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(canalesPeru) };
  };
  const b = barridoCon(f, { reintentos: 0 });
  const d = await b.todo({ tipos: ['tv'] });
  // El reintento interno salva el tema, y como hubo un 503 se vuelve a comprobar la salud.
  assert.ok(d.canales.length >= 2, 'los canales del tema que falló no se pierden');
  assert.ok(saludes >= 2, 'se vuelve a despertar tras el 503');
});

test('un canal que sale en dos temas se cuenta UNA vez y guarda los dos grupos', async () => {
  const f = fetchGuion([
    { estado: 200, cuerpo: { ok: true } },
    { estado: 200, cuerpo: temasTv },
    { estado: 200, cuerpo: canalesHot },
    { estado: 200, cuerpo: canalesPeru },
  ]);
  const b = barridoCon(f);
  const d = await b.todo({ tipos: ['tv'] });
  const ids = d.canales.map((c) => c.id);
  assert.equal(ids.length, new Set(ids).size, 'sin duplicados');
  const america = d.canales.find((c) => c.id === 'live_tv_americatv');
  assert.deepEqual(america.temas.sort(), ['Most watched', 'Peru']);
  assert.equal(america.tema, 'Most watched', 'se queda con el primero del proveedor');
});

// ─────────────────────────── el catálogo ───────────────────────────

const canal = (id, nombre, tema = 'Peru', logo = '') => ({ id, nombre, logo, tema, tipo: 'tv' });

test('los canales de ayer conservan su ORDEN y los nuevos entran detrás', () => {
  const barrido = {
    api: 'x', at: '2026-01-01', ms: 1,
    canales: [canal('live_tv_c', 'C'), canal('live_tv_a', 'A'), canal('live_tv_b', 'B')],
    grupos: [], tipos: {},
  };
  const previos = [
    { titulo: 'B', imagen: '', grupo: 'Peru', id: 'live_tv_b', urls: [] },
    { titulo: 'A', imagen: '', grupo: 'Peru', id: 'live_tv_a', urls: [] },
  ];
  const f = fusionar(barrido, previos);
  assert.deepEqual(f.canales.map((c) => c.title), ['B', 'A', 'C']);
  assert.equal(f.nuevos, 1);
});

test('un canal de la fuente vieja sin id_live se conserva tal cual', () => {
  const barrido = { api: 'x', at: '', ms: 0, canales: [canal('live_tv_a', 'A')], grupos: [], tipos: {} };
  const previos = [
    { titulo: 'Directo HD', imagen: 'i.png', grupo: 'Peru', id: null, urls: ['https://cdn/x.m3u8'] },
    { titulo: 'A', imagen: '', grupo: 'Peru', id: 'live_tv_a', urls: [] },
  ];
  const f = fusionar(barrido, previos);
  assert.equal(f.canales[0].title, 'Directo HD');
  assert.equal(f.canales[0].options[0].url, 'https://cdn/x.m3u8');
  assert.equal(f.sinId, 1);
});

test('un canal que ya no da Drama desaparece, y se informa', () => {
  const barrido = { api: 'x', at: '', ms: 0, canales: [canal('live_tv_a', 'A')], grupos: [], tipos: {} };
  const previos = [
    { titulo: 'A', imagen: '', grupo: 'Peru', id: 'live_tv_a', urls: [] },
    { titulo: 'Muerto', imagen: '', grupo: 'Peru', id: 'live_tv_muerto', urls: [] },
  ];
  const f = fusionar(barrido, previos);
  assert.equal(f.canales.length, 1);
  assert.equal(f.quitados, 1);
});

test('el canal sale con el esquema que la app ya abre', () => {
  const barrido = { api: 'x', at: '', ms: 0, canales: [canal('live_tv_a', 'A')], grupos: [], tipos: {} };
  const f = fusionar(barrido, []);
  const c = f.canales[0];
  assert.equal(c.title, 'A');
  assert.equal(c.options[0].url, 'dramalive://play?id_live=live_tv_a&u=1&a=all_streams_redirect');
  assert.equal(idLiveDe(c.options[0].url), 'live_tv_a');
});

test('los shards no rompen grupos y reconstruyen el total exacto', () => {
  const canales = [];
  for (let i = 0; i < 400; i++) canales.push({ title: 'C' + i, image: '', category: i < 250 ? 'Sports' : 'News' });
  const { shards, manifiesto } = partir(canales, { chunk: 150, version: 'v' });
  const sports = shards.filter((s) => s.grupo === 'Sports');
  assert.equal(sports.length, 2);                       // 250 -> 150 + 100
  assert.deepEqual(sports.map((s) => s.total), [150, 100]);
  assert.equal(shards.reduce((n, s) => n + s.total, 0), 400);
  assert.equal(manifiesto.total, 400);
  assert.equal(manifiesto.shards, shards.length);
  // Los slugs no se repiten (dos grupos con el mismo nombre no pueden pisarse).
  assert.equal(new Set(shards.map((s) => s.slug)).size, shards.length);
});

test('los scopes son prefijos exactos del catálogo', () => {
  const canales = Array.from({ length: 3000 }, (_, i) => ({ title: 'C' + i, image: '', category: 'G' }));
  assert.equal(scopeDe(canales, 'corto').total, SCOPES.corto);
  assert.deepEqual(scopeDe(canales, 'latam').canales, canales.slice(0, SCOPES.latam));
});

test('la huella cambia si cambia un título y no si no cambia nada', () => {
  const a = [{ title: 'A', image: '', category: 'G' }];
  const b = [{ title: 'A', image: '', category: 'G' }];
  const c = [{ title: 'A (720p)', image: '', category: 'G' }];
  assert.equal(versionDe(a), versionDe(b));
  assert.notEqual(versionDe(a), versionDe(c));
});

test('si el barrido trae menos del mínimo, NO se construye nada', () => {
  const barrido = { api: 'x', at: '', ms: 0, canales: [canal('live_tv_a', 'A')], grupos: [], tipos: {} };
  assert.throws(() => construir(barrido, { minimo: 100 }), /mínimo/);
});

test('el catálogo construido tiene TODO lo que pide la app', () => {
  const canales = Array.from({ length: 30 }, (_, i) => canal('live_tv_' + i, 'Canal ' + i));
  const barrido = { api: 'x', at: '2026-01-01', ms: 1, canales, grupos: [], tipos: { tv: { fallos: [] } } };
  const { ficheros, resumen } = construir(barrido, {});
  for (const ruta of ['version.json', 'manifiesto.json', 'scopes/corto.json', 'scopes/latam.json', 'scopes/global.json', 'canales/pequena.json']) {
    assert.ok(ficheros[ruta], 'falta ' + ruta);
  }
  const corto = JSON.parse(ficheros['scopes/corto.json']);
  assert.equal(corto.canales.length, 30);
  assert.ok(corto.canales[0].options[0].url.startsWith('dramalive://'));
  const ver = JSON.parse(ficheros['version.json']);
  assert.equal(ver.total, 30);
  assert.equal(ver.version, resumen.version);
  // el manifiesto apunta a ficheros que existen
  for (const s of JSON.parse(ficheros['manifiesto.json']).indice) {
    assert.ok(ficheros['shards/' + s.slug + '.json'], 'falta el shard ' + s.slug);
  }
});

test('se lee lo publicado ayer en formato nativo y en formato servers', () => {
  const nativo = normalesDe({ canales: [{ title: 'A', image: 'i', category: 'G', options: [{ url: urlCanal('live_tv_a') }] }] });
  assert.equal(nativo[0].id, 'live_tv_a');
  const servers = normalesDe({ channels: [], canales: [{ name: 'x' }] });
  assert.equal(servers.length, 0);   // sin title no entra
});

test('huella estable: el mismo texto da el mismo valor', () => {
  assert.equal(huella('hola'), huella('hola'));
  assert.match(huella('hola'), /^[0-9a-f]{8}$/);
});

// ─────────────────── la guardia antes de borrar ───────────────────

test('un canal que ya no sale en el barrido NO se borra si sigue emitiendo', () => {
  const barrido = { api: 'x', at: '', ms: 0, canales: [canal('live_tv_a', 'A')], grupos: [], tipos: {} };
  const previos = [
    { titulo: 'A', imagen: '', grupo: 'Peru', id: 'live_tv_a', urls: [] },
    { titulo: 'Sigue vivo', imagen: 'i.png', grupo: 'Peru', id: 'live_tv_vivo', urls: [] },
  ];
  const f = fusionar(barrido, previos, { conservados: new Set(['live_tv_vivo']) });
  assert.deepEqual(f.canales.map((c) => c.title), ['A', 'Sigue vivo']);
  assert.equal(f.quitados, 0);
});

test('sin la guardia, el que ya no sale sí se retira', () => {
  const barrido = { api: 'x', at: '', ms: 0, canales: [canal('live_tv_a', 'A')], grupos: [], tipos: {} };
  const previos = [
    { titulo: 'A', imagen: '', grupo: 'Peru', id: 'live_tv_a', urls: [] },
    { titulo: 'Muerto', imagen: '', grupo: 'Peru', id: 'live_tv_muerto', urls: [] },
  ];
  const f = fusionar(barrido, previos, { conservados: new Set() });
  assert.equal(f.quitados, 1);
});

test('sigueEmitiendo: 200 conserva, 404 retira, y ante la duda CONSERVA', async () => {
  const responde = (estado) => async () => ({
    status: estado, ok: estado >= 200 && estado < 300, text: async () => '',
  });
  const r = (fetch) => new Barrido({ fetch, dormir: async () => {}, reloj: () => 0, ajustes: { reintentos: 1 } });
  assert.equal(await r(responde(200)).sigueEmitiendo('live_tv_x'), true);
  assert.equal(await r(responde(404)).sigueEmitiendo('live_tv_x'), false);
  assert.equal(await r(responde(403)).sigueEmitiendo('live_tv_x'), false);
  // 5xx tras reintentos: no se sabe -> se conserva
  assert.equal(await r(responde(502)).sigueEmitiendo('live_tv_x'), true);
  // sin id: no hay nada que comprobar
  assert.equal(await r(responde(200)).sigueEmitiendo(null), false);
});

test('si de golpe se pierde más de la mitad respecto a ayer, no se publica', () => {
  const pocos = { api: 'x', at: '', ms: 0, canales: [canal('live_tv_a', 'A')], grupos: [], tipos: {} };
  const previos = Array.from({ length: 100 }, (_, i) => (
    { titulo: 'C' + i, imagen: '', grupo: 'G', id: 'live_tv_' + i, urls: [] }
  ));
  assert.throws(() => construir(pocos, { previos, perderMax: 0.5 }), /huele a fallo/);
});

test('el tope recorta sin romper nada y lo informa', () => {
  const canales = Array.from({ length: 50 }, (_, i) => canal('live_tv_' + i, 'C' + i));
  const barrido = { api: 'x', at: '', ms: 0, canales, grupos: [], tipos: {} };
  const f = fusionar(barrido, [], { tope: 10 });
  assert.equal(f.canales.length, 10);
  assert.equal(f.recortados, 40);
});

// ───────────────────── la salud: qué canales funcionan ─────────────────────

import {
  anotar, caducado, emite, publicable, publicables, resumenSalud, tocaComprobar,
  leerSalud, saludVacia, verificarCanales, HORAS_VIGENCIA, FALLOS_PARA_RETIRAR,
} from './salud.mjs';

const HORA = 3600_000;
const T0 = Date.parse('2026-10-04T00:00:00Z');

test('un canal solo es publicable si consta que EMITE', () => {
  assert.equal(publicable({ estado: 'emite' }, false), true);
  assert.equal(publicable({ estado: 'no-emite', fallos: 2 }, true), false);
  // nunca comprobado: se queda solo si ya estaba publicado
  assert.equal(publicable(undefined, true), true);
  assert.equal(publicable(undefined, false), false);
  assert.equal(publicable({ estado: 'desconocido' }, true), true);
});

test('desconocido NO penaliza: un bache de red no retira canales', () => {
  const antes = { estado: 'emite', at: new Date(T0 - 2 * HORA).toISOString(), fallos: 0, ok: 5 };
  const despues = anotar(antes, { estado: 'desconocido', motivo: 'HTTP 502' }, T0);
  assert.equal(despues.estado, 'emite');
  assert.equal(despues.fallos, 0);
  assert.equal(despues.at, antes.at, 'no se toca la fecha de la última comprobación buena');
});

test('un fallo no retira: hacen falta dos pasadas', () => {
  let r = anotar(undefined, { estado: 'no-emite', motivo: '404' }, T0);
  assert.equal(r.fallos, 1);
  assert.equal(r.estado, 'no-emite');
  assert.equal(tocaComprobar(r, T0 + HORA), true, 'con 1 fallo se le da otra oportunidad');
  r = anotar(r, { estado: 'no-emite', motivo: '404' }, T0 + 2 * HORA);
  assert.equal(r.fallos, FALLOS_PARA_RETIRAR);
  assert.equal(tocaComprobar(r, T0 + 3 * HORA), false, 'retirado: no se gasta tiempo en él');
  assert.equal(tocaComprobar(r, T0 + 8 * 24 * HORA), true, 'pero se revisa a los 7 días');
});

test('un solo éxito limpia el historial de fallos', () => {
  let r = { estado: 'no-emite', at: new Date(T0).toISOString(), fallos: 5, ok: 0 };
  r = anotar(r, { estado: 'emite', opciones: 2 }, T0 + HORA);
  assert.equal(r.estado, 'emite');
  assert.equal(r.fallos, 0);
  assert.equal(r.ok, 1);
});

test('un canal que emite se re-verifica cuando caduca; antes no', () => {
  const r = anotar(undefined, { estado: 'emite', opciones: 1 }, T0);
  assert.equal(caducado(r, T0 + HORA), false);
  assert.equal(tocaComprobar(r, T0 + HORA), false);
  assert.equal(tocaComprobar(r, T0 + (HORAS_VIGENCIA + 1) * HORA), true);
});

test('estado/salud.json roto o vacío no rompe nada', () => {
  assert.equal(resumenSalud(leerSalud(null)).canales, 0);
  assert.equal(resumenSalud(leerSalud({ canales: 'no' })).canales, 0);
  assert.equal(resumenSalud(leerSalud(saludVacia())).canales, 0);
});

test('verificarCanales: comprueba, anota y respeta el presupuesto', async () => {
  const respuestas = {
    live_tv_a: { estado: 'emite', opciones: 2, ms: 10 },
    live_tv_b: { estado: 'no-emite', ms: 10, motivo: 'HTTP 404' },
    live_tv_c: { estado: 'desconocido', ms: 10, motivo: 'HTTP 502' },
  };
  const falsa = { durmiendo: false, verificar: async (id) => respuestas[id] || { estado: 'no-emite' } };
  const r = await verificarCanales(falsa, saludVacia(), ['live_tv_a', 'live_tv_b', 'live_tv_c'], {
    concurrencia: 2, presupuestoMs: 60_000,
  });
  assert.equal(r.comprobados, 3);
  assert.equal(r.emiten, 1);
  assert.equal(r.noEmiten, 1);
  assert.equal(r.desconocidos, 1);
  assert.equal(r.salud.canales.live_tv_a.estado, 'emite');
  assert.equal(r.agotado, false);
});

test('verificarCanales: con presupuesto agotado deja el resto para la próxima', async () => {
  let n = 0;
  const falsa = {
    durmiendo: false,
    verificar: async () => { n++; await new Promise((r) => setTimeout(r, 25)); return { estado: 'emite' }; },
  };
  const ids = Array.from({ length: 40 }, (_, i) => 'live_tv_' + i);
  const r = await verificarCanales(falsa, saludVacia(), ids, { concurrencia: 2, presupuestoMs: 120 });
  assert.ok(r.comprobados < 40, 'no los hace todos');
  assert.ok(r.agotado, 'avisa de que quedan');
  assert.ok(r.comprobados >= 2);
});

test('publicables: solo los que emiten, más los abuelos sin comprobar', () => {
  const salud = {
    canales: {
      live_tv_a: { estado: 'emite' },
      live_tv_b: { estado: 'no-emite', fallos: 2 },
    },
  };
  assert.deepEqual(publicables(salud, ['live_tv_a', 'live_tv_b', 'live_tv_c'], ['live_tv_c']),
    ['live_tv_a', 'live_tv_c']);
});

// ─────── «no emite» solo cuando es un veredicto, no un mal día ───────

function barridoQueResponde(cuerpo, estado = 200) {
  return new Barrido({
    fetch: async () => ({ ok: estado < 300, status: estado, text: async () => JSON.stringify(cuerpo) }),
    reloj: () => 0, dormir: async () => {}, ajustes: { reintentos: 0 },
  });
}

test('verificar: si alguna opción emite, el canal emite', async () => {
  const b = barridoQueResponde({ opciones: [{ emite: false, error: 'HTTP 404' }, { emite: true }] });
  const r = await b.verificar('live_tv_x');
  assert.equal(r.estado, 'emite');
  assert.equal(r.opciones, 1);
});

test('verificar: 403/404 en las opciones es un veredicto (no emite)', async () => {
  for (const error of ['HTTP 404', 'HTTP 403', 'HTTP 410']) {
    const r = await barridoQueResponde({ opciones: [{ emite: false, error }] }).verificar('live_tv_x');
    assert.equal(r.estado, 'no-emite', error + ' debería ser un veredicto');
  }
});

test('verificar: 5xx, 429 o tiempo agotado NO son veredicto (desconocido)', async () => {
  const transitorios = [
    'HTTP 502', 'HTTP 503', 'HTTP 504', 'HTTP 429',
    'HTTPSConnectionPool: Max retries exceeded',
    'connect timeout',
  ];
  for (const error of transitorios) {
    const r = await barridoQueResponde({ opciones: [{ emite: false, error }] }).verificar('live_tv_x');
    assert.equal(r.estado, 'desconocido', error + ' NO debería retirar el canal');
  }
});

test('verificar: sin ninguna opción sí es un veredicto', async () => {
  const r = await barridoQueResponde({ opciones: [] }).verificar('live_tv_x');
  assert.equal(r.estado, 'no-emite');
  assert.equal(r.motivo, 'sin opciones');
});

test('verificar: un 404 del canal no se reintenta y es veredicto', async () => {
  let veces = 0;
  const b = new Barrido({
    fetch: async () => { veces++; return { ok: false, status: 404, text: async () => '{}' }; },
    reloj: () => 0, dormir: async () => {}, ajustes: { reintentos: 3 },
  });
  const r = await b.verificar('live_tv_x');
  assert.equal(r.estado, 'no-emite');
  assert.equal(veces, 1);
});

test('verificar: si la API no contesta, es desconocido (no penaliza)', async () => {
  const b = new Barrido({
    fetch: async () => { throw new Error('ECONNRESET'); },
    reloj: () => 0, dormir: async () => {}, ajustes: { reintentos: 1 },
  });
  const r = await b.verificar('live_tv_x');
  assert.equal(r.estado, 'desconocido');
});

test('verificar: un DNS roto del canal es veredicto; un timeout no', async () => {
  const dns = "HTTPSConnectionPool(host='hamis.romponalis.st', port=443): Max retries exceeded " +
              "(Caused by NameResolutionError: Failed to resolve 'hamis.romponalis.st')";
  assert.equal((await barridoQueResponde({ opciones: [{ emite: false, error: dns }] }).verificar('x')).estado, 'no-emite');
  const cong = 'Read timed out. (read timeout=10)';
  assert.equal((await barridoQueResponde({ opciones: [{ emite: false, error: cong }] }).verificar('x')).estado, 'desconocido');
});

test('un evento terminado (403 de DaddyLive) se retira tras dos pasadas', () => {
  const caido = { estado: 'no-emite', fallos: 2, motivo: 'HTTP 403', at: new Date(T0).toISOString() };
  assert.equal(publicable(caido, true), false, 'aunque estuviera en el catálogo de ayer');
  const uno = { estado: 'no-emite', fallos: 1, motivo: 'HTTP 403', at: new Date(T0).toISOString() };
  assert.equal(publicable(uno, true), false, 'un 403 ya es motivo para no publicarlo');
  assert.equal(tocaComprobar(uno, T0 + HORA), true, 'pero se le da una segunda oportunidad');
});

test('los eventos (livematches) se ordenan al final del catálogo', async () => {
  const { catalogoDePrueba } = await import('./catalogo.mjs').then((m) => ({ catalogoDePrueba: m.ordenar }));
  const canales = [
    { title: 'Evento A', image: '', category: 'Live Matches' },
    { title: 'Bein S. 1', image: '', category: 'Sports' },
    { title: 'Evento B', image: '', category: 'Live Matches' },
    { title: 'MBC Iraq', image: '', category: 'Most watched' },
  ];
  const ids = canales.map((c, i) => ({ ...c, id: c.category === 'Live Matches' ? 'live_tv_livematches_x' + i : 'live_tv_normal' + i }));
  const ordenados = catalogoDePrueba(ids);
  assert.deepEqual(ordenados.map((c) => c.title), ['Bein S. 1', 'MBC Iraq', 'Evento A', 'Evento B']);
});
