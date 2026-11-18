/**
 * Tests de la salud: qué se publica, qué se comprueba y cuándo hace falta una vuelta
 * completa. Sin red: el `fetch` es de mentira.
 *
 *   node --test tools/colector/
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Barrido } from './barrido.mjs';
import {
  anotar, cobertura, emite, publicable, publicables, necesitaVueltaCompleta,
  resumenSalud, tocaComprobar, verificarCanales, HORAS_VIGENCIA,
} from './salud.mjs';

const AHORA = Date.parse('2026-11-18T21:00:00Z');
const haceHoras = (h) => new Date(AHORA - h * 3600_000).toISOString();

const reg = (estado, horas, fallos = 0) => ({ estado, at: haceHoras(horas), fallos, ok: 0 });

// ─────────────────────── qué se publica ───────────────────────

test('solo se publica lo que consta que emite (o aguanta su primer fallo)', () => {
  assert.equal(publicable(reg('emite', 1), false), true);
  assert.equal(publicable(reg('no-emite', 1, 2), true), false);   // 2 fallos: fuera
  assert.equal(publicable(reg('no-emite', 1, 1), true), true);    // 1 fallo: otra oportunidad
});

test('un canal sin veredicto se queda si ya estaba publicado (no se vacía la app)', () => {
  assert.equal(publicable(undefined, true), true);     // abuelo
  assert.equal(publicable(undefined, false), false);   // nuevo y sin comprobar: no
  assert.equal(publicable(reg('desconocido', 1), true), true);
});

test('un «desconocido» NO penaliza: se conserva el estado anterior', () => {
  const previo = reg('emite', 5);
  const r = anotar(previo, { estado: 'desconocido', motivo: 'HTTP 503' }, AHORA);
  assert.equal(r.estado, 'emite');
  assert.equal(r.at, previo.at);            // la fecha buena no se toca
  assert.equal(r.motivo, 'HTTP 503');       // pero queda rastro
});

test('un 403/404 retira al momento; un fallo dudoso necesita dos pasadas', () => {
  // Definitivo: el canal ya no existe.
  const d = anotar(reg('emite', 1), { estado: 'no-emite', motivo: 'HTTP 403' }, AHORA);
  assert.equal(d.definitivo, true);
  assert.equal(publicable(d, true), false);

  // Dudoso (5xx / tiempo): puede ser un mal minuto.
  let r = anotar(reg('emite', 1), { estado: 'no-emite', motivo: 'HTTP 503' }, AHORA);
  assert.equal(r.definitivo, undefined);
  assert.equal(publicable(r, true), true, 'con un fallo dudoso sigue publicado');
  r = anotar(r, { estado: 'no-emite', motivo: 'tiempo agotado' }, AHORA);
  assert.equal(r.fallos, 2);
  assert.equal(publicable(r, true), false, 'al segundo fallo dudoso se retira');
});

test('emite() es estricto: solo el estado «emite»', () => {
  assert.equal(emite(reg('emite', 1)), true);
  assert.equal(emite(reg('desconocido', 1)), false);
  assert.equal(emite(undefined), false);
});

// ─────────────────────── qué se comprueba ───────────────────────

test('toca comprobar: lo nunca visto y lo caducado', () => {
  assert.equal(tocaComprobar(undefined, AHORA), true);
  // 35 h < 36 h de vigencia: el dato todavía vale, no se gasta tiempo en él.
  assert.equal(tocaComprobar(reg('emite', HORAS_VIGENCIA - 1), AHORA), false);
  // 37 h: caducado, toca volver a mirarlo.
  assert.equal(tocaComprobar(reg('emite', HORAS_VIGENCIA + 1), AHORA), true);
});

test('un retirado no gasta tiempo hasta que pasa la semana', () => {
  assert.equal(tocaComprobar(reg('no-emite', 2, 2), AHORA), false);
  assert.equal(tocaComprobar(reg('no-emite', 24 * 8, 2), AHORA), true);
});

// ─────────────────────── cobertura y vuelta completa ───────────────────────

const ids = (n, prefijo = 'c') => Array.from({ length: n }, (_, i) => prefijo + i);

test('la cobertura cuenta solo veredictos, no «desconocido»', () => {
  const salud = { canales: {
    c0: reg('emite', 1), c1: reg('no-emite', 1), c2: reg('desconocido', 1),
  } };
  assert.equal(cobertura(salud, ['c0', 'c1', 'c2', 'c3']), 0.5);
  assert.equal(cobertura(salud, []), 1);
});

test('el caso real: 13 % de cobertura -> hace falta vuelta completa', () => {
  const todos = ids(1000);
  const salud = { canales: Object.fromEntries(todos.slice(0, 130).map((i) => [i, reg('emite', 1)])) };
  assert.equal(necesitaVueltaCompleta(salud, todos), true);
});

test('con el 95 % de cobertura, la pasada normal basta', () => {
  const todos = ids(100);
  const salud = { canales: Object.fromEntries(todos.slice(0, 95).map((i) => [i, reg('emite', 1)])) };
  assert.equal(necesitaVueltaCompleta(salud, todos), false);
});

test('«desconocido» no cuenta como cobertura: es lo que hay que cerrar', () => {
  const todos = ids(100);
  const salud = { canales: Object.fromEntries(todos.map((i) => [i, reg('desconocido', 1)])) };
  assert.equal(cobertura(salud, todos), 0);
  assert.equal(necesitaVueltaCompleta(salud, todos), true);
});

// ────────────────── la pasada de verificación ──────────────────

/** Barrido de mentira: dice «emite» salvo para los ids de `muertos`. */
function barridoFalso({ muertos = new Set(), retraso = 0, motivo = 'HTTP 503' } = {}) {
  return {
    durmiendo: false,
    async verificar(id) {
      if (retraso) await new Promise((r) => setTimeout(r, retraso));
      return muertos.has(id)
        ? { estado: 'no-emite', opciones: 0, motivo, ms: 1 }
        : { estado: 'emite', opciones: 1, ms: 1 };
    },
  };
}

test('la vuelta completa mira TAMBIÉN los ya retirados', async () => {
  const todos = ids(10);
  const salud = { canales: Object.fromEntries(todos.map((i) => [i, reg('no-emite', 2, 9)])) };
  // sin todo: nada que hacer (todos retirados y recientes)
  const sin = await verificarCanales(barridoFalso(), salud, todos, { ahora: AHORA });
  assert.equal(sin.comprobados, 0);
  // con todo: los 10
  const con = await verificarCanales(barridoFalso(), salud, todos, { ahora: AHORA, todo: true });
  assert.equal(con.comprobados, 10);
  assert.equal(con.emiten, 10);
});

test('lo nunca visto va PRIMERO en la cola, antes que lo caducado', async () => {
  const salud = { canales: {
    viejo1: reg('emite', 48), viejo2: reg('emite', 48),
  } };
  const orden = [];
  const b = { durmiendo: false, async verificar(id) { orden.push(id); return { estado: 'emite', ms: 1 }; } };
  await verificarCanales(b, salud, ['viejo1', 'nuevo1', 'viejo2', 'nuevo2'], {
    ahora: AHORA, concurrencia: 1,
  });
  assert.deepEqual(orden.slice(0, 2).sort(), ['nuevo1', 'nuevo2']);
});

test('el presupuesto corta la pasada y lo no mirado queda como pendiente', async () => {
  const todos = ids(50);
  const r = await verificarCanales(barridoFalso({ retraso: 5 }), { canales: {} }, todos, {
    ahora: AHORA, concurrencia: 2, presupuestoMs: 40,
  });
  assert.equal(r.agotado, true);
  assert.ok(r.comprobados > 0 && r.comprobados < 50);
  assert.equal(r.pendientes, 50 - r.comprobados);
});

test('un fallo DEFINITIVO saca al canal en la misma pasada', async () => {
  const muertos = new Set(['c1']);
  const todos = ids(3);
  // motivo 403 -> definitivo
  const r = await verificarCanales(
    barridoFalso({ muertos, motivo: 'HTTP 403' }), { canales: {} }, todos, { ahora: AHORA },
  );
  assert.deepEqual([...publicables(r.salud, todos)].sort(), ['c0', 'c2']);
});

test('un fallo DUDOSO aguanta una pasada y cae en la segunda', async () => {
  const muertos = new Set(['c1']);
  const todos = ids(3);
  const b = barridoFalso({ muertos, motivo: 'HTTP 503' });
  // primera pasada: un fallo dudoso -> sigue publicado
  let r = await verificarCanales(b, { canales: {} }, todos, { ahora: AHORA });
  assert.equal(r.salud.canales.c1.fallos, 1);
  assert.deepEqual([...publicables(r.salud, todos)].sort(), ['c0', 'c1', 'c2']);
  // segunda pasada (6 h después, vuelta completa): dos fallos -> fuera
  r = await verificarCanales(b, r.salud, todos, { ahora: AHORA + 6 * 3600_000, todo: true });
  assert.equal(r.salud.canales.c1.fallos, 2);
  assert.deepEqual([...publicables(r.salud, todos)].sort(), ['c0', 'c2']);
});

test('un acierto limpia el historial de fallos', async () => {
  let r = await verificarCanales(
    barridoFalso({ muertos: new Set(['c1']), motivo: 'HTTP 503' }), { canales: {} }, ['c1'], { ahora: AHORA },
  );
  assert.equal(r.salud.canales.c1.fallos, 1);
  r = await verificarCanales(barridoFalso(), r.salud, ['c1'], { ahora: AHORA, todo: true });
  assert.equal(r.salud.canales.c1.fallos, 0);
  assert.equal(publicables(r.salud, ['c1']).length, 1);
});

test('resumenSalud cuenta los tres estados', () => {
  const salud = { canales: {
    a: reg('emite', 1), b: reg('no-emite', 1, 2), c: reg('desconocido', 1), d: {},
  } };
  assert.deepEqual(resumenSalud(salud), { canales: 4, emiten: 1, caidos: 1, nunca: 2 });
});
