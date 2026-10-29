/**
 * PelisLatino — catálogo de canales en el borde (Cloudflare Pages Function).
 */

const PEQUENIA = 'https://raw.githubusercontent.com/belkaperu/belkafut/refs/heads/main/data_unificado.json';
const GRANDE = 'https://raw.githubusercontent.com/youcefyakhoo/cesopppplop/refs/heads/main/canales-compacto.json';

function clave(t) {
  return String(t || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim();
}

function esUrl(u) {
  return typeof u === 'string' && (/^https?:\/\//i.test(u) || /^(rtmp|rtp|dramalive):/i.test(u));
}

function mapaGrupos(cats) {
  const m = new Map();
  for (const c of (cats || [])) {
    const name = c && c.name;
    if (!name) continue;
    const rotulo = (c.display_name && c.display_name.trim()) || name;
    const k = clave(name);
    if (!m.has(k)) m.set(k, rotulo);
  }
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

function deUnificado(json) {
  const grupos = mapaGrupos(json.categories);
  const salida = [];
  for (const c of (json.channels || [])) {
    const ops = opciones(c.servers, c.options);
    if (!ops.length) continue;
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

function etiquetar(canales) {
  for (const c of canales) {
    const vistas = new Set();
    c.options = c.options.map((o, i) => {
      let base = (o.label || '').trim();
      if (base && vistas.has(base)) base = base + ' ' + (i + 1);
      if (base) vistas.add(base);
      return base ? { label: base, url: o.url } : { url: o.url };
    });
  }
  return canales;
}

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

async function traer(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'PelisLatino-canales/1.0 (+cloudflare-pages)' },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
  return r.json();
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const solo = (url.searchParams.get('solo') || '').toLowerCase();

  const pequenia = context.env.FUENTE_PEQUENIA || PEQUENIA;
  const grande = context.env.FUENTE_GRANDE || GRANDE;

  try {
    const [uni, com] = await Promise.all([
      (solo === 'grande') ? null : traer(pequenia).then(deUnificado).catch(e => { console.warn(e.message); return []; }),
      (solo === 'pequena') ? null : traer(grande).then(deCompacto).catch(e => { console.warn(e.message); return []; }),
    ]);

    const partes = [uni, com].filter(Boolean);
    if (!partes.length) {
      return new Response(JSON.stringify({ error: 'ninguna fuente responde' }), {
        status: 502, headers: { 'content-type': 'application/json' },
      });
    }

    const canales = etiquetar(dedupe(partes.flat()));
    const cuerpo = JSON.stringify({ total: canales.length, canales });

    return new Response(cuerpo, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=300, stale-while-revalidate=600',
        'access-control-allow-origin': '*',
        'x-canales': String(canales.length),
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e && e.message || e) }), {
      status: 502, headers: { 'content-type': 'application/json' },
    });
  }
}
