/**
 * Tests de la fuente externa (los canales que NO son de Drama).
 * Sin red: `fetch` de mentira.
 *
 *   node --test tools/colector/
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canalesExternos, grupoDe, idExterno, insertarExternos, colocarExternos, probarExterno,
  agruparPorNombre, quitarRepetidos, PREFIJO,
} from './fuentes.mjs';

const json = { channels: [
  { name: 'HBO Signature', category: 'peliculas', imageUrl: 'hbo.png',
    servers: [{ url: 'http://45.228.234.30:16000/play/a05t/index.m3u8' }] },
  { name: 'CNN Español', category: 'Noticias',
    servers: [{ url: 'https://190.14.10.19/x.m3u8' }, { url: 'https://otro/x.m3u8' }] },
  // estos dos NO deben entrar
  { name: 'Duplicado de Drama', category: 'all',
    servers: [{ url: 'dramalive://play?id_live=live_tv_x&u=1&a=all_streams_redirect' }] },
  { name: 'Sin servidor', category: 'all', servers: [] },
] };

test('se extraen los http(s) y se descarta dramalive:// (eso ya lo trae Drama)', () => {
  const c = canalesExternos(json);
  assert.equal(c.length, 3);              // HBO + los 2 servidores de CNN
  assert.ok(c.every((x) => x.url.startsWith('http')));
  assert.ok(c.every((x) => x.id.startsWith(PREFIJO)));
  assert.ok(c.every((x) => x.externo === true));
});

test('un canal con dos servidores es UN canal con dos opciones', () => {
  const brutos = canalesExternos(json).filter((x) => x.nombre === 'CNN Español');
  assert.equal(brutos.length, 2);                       // dos URLs de entrada
  const agrupados = agruparPorNombre(brutos);
  assert.equal(agrupados.length, 1);                    // un canal
  assert.equal(agrupados[0].urls.length, 2);            // con sus dos servidores
});

test('el id va por NOMBRE: el mismo canal con otra URL es el mismo canal', () => {
  assert.equal(idExterno('America TV'), idExterno('america tv'));
  assert.equal(idExterno('America TV'), idExterno('AMÉRICA TV'));   // sin tildes
  assert.notEqual(idExterno('America TV'), idExterno('America TV 2'));
});

test('no se publica un externo cuyo nombre ya está en el catálogo de Drama', () => {
  const ext = [
    { id: 'a', nombre: 'America TV', urls: ['http://a'], tema: 'News' },
    { id: 'b', nombre: 'Canal Nuevo', urls: ['http://b'], tema: 'News' },
  ];
  const out = quitarRepetidos(ext, ['America TV (720p)', 'Otro']);
  assert.deepEqual(out.map((c) => c.nombre), ['Canal Nuevo']);
});

test('los grupos se traducen a los del catálogo, que están en INGLÉS', () => {
  // Si esto se rompe, los externos dejan de caer en su pestaña y se van todos al
  // principio del catálogo (pasó: 600 de 600 en el alcance corto).
  assert.equal(grupoDe('peliculas'), 'Movies');
  assert.equal(grupoDe('Películas'), 'Movies');
  assert.equal(grupoDe('Noticias'), 'News');
  assert.equal(grupoDe('general'), 'Sports');
  assert.equal(grupoDe('loquesea'), 'Entertainment');   // grupo que SÍ existe
});

test('los externos se meten AL FINAL de su grupo, no al final del catálogo', () => {
  const canales = [
    { title: 'Drama Deportes 1', image: '', category: 'Deportes', options: [{ url: 'dramalive://a' }] },
    { title: 'Drama Noticias 1', image: '', category: 'Noticias', options: [{ url: 'dramalive://b' }] },
    { title: 'Drama Deportes 2', image: '', category: 'Deportes', options: [{ url: 'dramalive://c' }] },
  ];
  const externos = [
    { id: 'e1', nombre: 'ESPN', logo: '', tema: 'Deportes', url: 'http://e1.m3u8' },
    { id: 'e2', nombre: 'CNN', logo: '', tema: 'Noticias', url: 'http://e2.m3u8' },
  ];
  const out = insertarExternos(canales, externos);
  // Los de Drama NO se reordenan entre sí (D1, N1, D2 siguen en ese orden); cada
  // externo entra justo detrás del ÚLTIMO de su grupo.
  assert.deepEqual(out.map((c) => c.title),
    ['Drama Deportes 1', 'Drama Noticias 1', 'CNN', 'Drama Deportes 2', 'ESPN']);
  const drama = out.filter((c) => c.d !== 'externo').map((c) => c.title);
  assert.deepEqual(drama, ['Drama Deportes 1', 'Drama Noticias 1', 'Drama Deportes 2']);
  const espn = out.find((c) => c.title === 'ESPN');
  assert.equal(espn.options[0].url, 'http://e1.m3u8');
  assert.equal(espn.d, 'externo');
});

test('si el grupo no existe, se crea al final', () => {
  const canales = [{ title: 'A', image: '', category: 'Sports', options: [{ url: 'dramalive://a' }] }];
  const out = insertarExternos(canales, [{ id: 'e', nombre: 'X', tema: 'Cultura', url: 'http://x' }]);
  assert.equal(out.length, 2);
  assert.equal(out[1].category, 'Cultura');
});

// ─────────────── la comprobación de un canal externo ───────────────

function fetchFalso(respuestas) {
  let i = 0;
  return async (url, op) => {
    const r = respuestas[Math.min(i++, respuestas.length - 1)];
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      method: op.method,
      text: async () => r.cuerpo || '',
    };
  };
}

test('un m3u8 que devuelve #EXTM3U emite', async () => {
  const r = await probarExterno('http://x/a.m3u8',
    { fetch: fetchFalso([{ status: 200, cuerpo: '#EXTM3U\n#EXTINF:10,\nseg.ts' }]) });
  assert.equal(r.estado, 'emite');
});

test('un 200 que NO es una lista (página de error) no emite', async () => {
  const r = await probarExterno('http://x/a.m3u8',
    { fetch: fetchFalso([{ status: 200, cuerpo: '<html>404 Not Found</html>' }]) });
  assert.equal(r.estado, 'no-emite');
  assert.match(r.motivo, /EXTM3U/);
});

test('403 y 404 son veredicto: no emite', async () => {
  assert.equal((await probarExterno('http://x/a.m3u8', { fetch: fetchFalso([{ status: 404 }]) })).estado, 'no-emite');
  assert.equal((await probarExterno('http://x/a.m3u8', { fetch: fetchFalso([{ status: 403 }]) })).estado, 'no-emite');
});

test('un 5xx o un tiempo agotado NO es veredicto', async () => {
  assert.equal((await probarExterno('http://x/a.m3u8', { fetch: fetchFalso([{ status: 503 }]) })).estado, 'desconocido');
  const rompe = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  assert.equal((await probarExterno('http://x/a.m3u8', { fetch: rompe })).estado, 'desconocido');
});

test('un DNS que no resuelve sí es veredicto', async () => {
  const rompe = async () => { throw new Error('getaddrinfo ENOTFOUND host'); };
  assert.equal((await probarExterno('http://x/a.m3u8', { fetch: rompe })).estado, 'no-emite');
});

// ─────────── la colocación en el catálogo publicado ───────────

test('los externos caen DENTRO del alcance corto (600), no detrás de 12.000', () => {
  // 12.000 de Drama en 6 grupos (2.000 cada uno) y 600 externos.
  const drama = Array.from({ length: 12000 }, (_, i) => ({
    title: 'D' + i, image: '', category: 'G' + (i % 6),
    options: [{ url: 'dramalive://x' + i }],
  }));
  const ext = Array.from({ length: 600 }, (_, i) => ({
    id: 'e' + i, nombre: 'E' + i, logo: '', tema: 'G' + (i % 6), url: 'http://e' + i,
  }));
  const out = colocarExternos(drama, ext, { tope: 12000 });
  const corto = out.slice(0, 600);
  const dentro = corto.filter((c) => c.d === 'externo').length;
  // Cuota del 10 %: ~60 externos de 600. Ni cero (antes no se veía ninguno) ni todos
  // (un intento anterior metió 600 y se comió el catálogo de Drama).
  assert.ok(dentro >= 50 && dentro <= 70, 'esperaba ~60 externos en el corto, hay ' + dentro);
  assert.ok(600 - dentro >= 530, 'Drama tiene que seguir siendo la mayoría del corto');
  // y no se pierde ninguno
  assert.equal(out.filter((c) => c.d === 'externo').length, 600);
});

test('los de Drama conservan su orden relativo', () => {
  const drama = Array.from({ length: 100 }, (_, i) => ({
    title: 'D' + i, image: '', category: 'G', options: [{ url: 'dramalive://x' + i }],
  }));
  const ext = [{ id: 'e', nombre: 'E', tema: 'G', url: 'http://e' }];
  const out = colocarExternos(drama, ext, { tope: 0 });
  const soloDrama = out.filter((c) => c.d !== 'externo').map((c) => c.title);
  assert.deepEqual(soloDrama, drama.map((c) => c.title));
});

test('una categoría que Drama NO tiene entra igual, pero intercalada', () => {
  const drama = Array.from({ length: 300 }, (_, i) => ({
    title: 'D' + i, image: '', category: 'G', options: [{ url: 'dramalive://x' + i }],
  }));
  // Proporción realista: 20 externos para 300 de Drama (como 388 para 12.000).
  const ext = Array.from({ length: 20 }, (_, i) => ({
    id: 'e' + i, nombre: 'Canal Cultura ' + i, tema: 'Cultura' + (i % 3), url: 'http://c' + i,
  }));
  const out = colocarExternos(drama, ext, { tope: 0 });
  // Entra pronto (primer hueco), pero NO en bloque delante de todo el catálogo: con
  // 388 externos, ponerlos delante dejaba el alcance corto sin un solo canal de Drama.
  const pos = out.findIndex((c) => c.d === 'externo');
  assert.ok(pos > 0 && pos < 40, 'esperaba el primer externo en el primer hueco, está en ' + pos);
  assert.equal(out.filter((c) => c.d === 'externo').length, 20, 'no se pierde ninguno');
});

test('cada externo cae en la pestaña de su grupo', () => {
  const drama = Array.from({ length: 100 }, (_, i) => ({
    title: 'D' + i, image: '', category: i < 50 ? 'Deportes' : 'Noticias',
    options: [{ url: 'dramalive://x' + i }],
  }));
  const ext = [
    { id: 'e1', nombre: 'ESPN', tema: 'Deportes', url: 'http://e1' },
    { id: 'e2', nombre: 'CNN', tema: 'Noticias', url: 'http://e2' },
  ];
  const out = colocarExternos(drama, ext, { tope: 0 });
  assert.equal(out.find((c) => c.title === 'ESPN').category, 'Deportes');
  assert.equal(out.find((c) => c.title === 'CNN').category, 'Noticias');
});
