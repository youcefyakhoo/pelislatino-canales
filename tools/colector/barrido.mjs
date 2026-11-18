/**
 * COLECTOR de Drama Live — el que hace que el catálogo NO dependa de una fuente ajena.
 *
 * QUÉ PROBLEMA RESUELVE
 * ---------------------
 * Hasta ahora el catálogo era una foto de `cesopppplop`/`belkafut`: si esa fuente
 * se caía, cambiaba de esquema o dejaba de actualizarse, la app se quedaba con los
 * canales de ayer. Y encima no había forma de saber qué canales siguen emitiendo.
 *
 * Esto barre la API propia (Render) y saca de ahí los canales nuevos, los títulos,
 * los logos y los grupos. La fuente de la verdad pasa a ser la API.
 *
 * EL PROBLEMA DE VERDAD: RENDER DUERME
 * ------------------------------------
 * El plan gratuito de Render apaga la instancia por inactividad. La primera petición
 * del día tarda en despertarla y puede devolver 502/503/504 mientras arranca. Un
 * barrido de 465 temas (`/temas` x2 + `/canales` x465) con reintentos tontos tarda
 * una eternidad o se queda a medias.
 *
 * Cómo se resuelve aquí:
 *   1. ANTES de barrer se DESPIERTA con `/salud` (barato, y su respuesta dice si está
 *      listo). Se insiste con espera creciente hasta `esperaMaxMs`.
 *   2. Cada petición se reintenta ante 5xx / red caída / respuesta truncada, con
 *      backoff y un tope corto. Un 404 NO se reintenta: es un tema que ya no existe.
 *   3. El barrido va con concurrencia ACOTADA (por defecto 4). No se disparan 465
 *      peticiones a la vez: eso es lo que tumba un plan gratuito (y lo que ya pasó
 *      en este repo con el Worker que parseaba en cada petición).
 *   4. Si un tema falla tras los reintentos, NO se pierde el catálogo: se sigue con
 *      los demás y se anota el fallo. Un barrido parcial es mejor que no publicar.
 *   5. El resultado se cachea en disco (`estado/barrido.json`) y se publica con su
 *      propia huella. La app solo baja si la huella cambió.
 *
 * QUIÉN LO EJECUTA
 * ----------------
 * Cloudflare NO sirve para esto: un Worker tiene límite de CPU y de subpeticiones,
 * y barrer 465 temas dura minutos. Esto se ejecuta en una GitHub Action
 * (`.github/workflows/colector.yml`), desde el repo, de madrugada, y publica por
 * commit. Cloudflare Pages solo sirve el resultado estático.
 *
 * Sin dependencias: solo `fetch` global (Node 18+ / Actions).
 */

/** Raíz de la API. Se puede cambiar por entorno (DRAMA_API). */
export const API_POR_DEFECTO = 'https://dramalive-api-08th.onrender.com';

/** Código FG de Drama que usa la app por defecto. */
export const CODIGO_POR_DEFECTO = '232425';

/**
 * Los catálogos del proveedor, y cuáles se publican POR DEFECTO.
 *
 * Solo TV. Medido en el barrido real: TV son 19.571 canales y radio 123.620, porque
 * el proveedor publica la MISMA emisora en decenas de países (es un listado por
 * país, no un catálogo). Meter la radio multiplicaría el repo por 7 para servir
 * emisoras repetidas, y el catálogo que la app venía mostrando era solo de TV
 * (0 grupos de radio en los 15.299 canales de hoy).
 *
 * La radio sigue disponible con `--tipos=tv,radio` para cuando se quiera.
 */
export const TIPOS = ['tv'];
export const TIPOS_DISPONIBLES = ['tv', 'radio'];

/** Ajustes por defecto. Todos se pueden pisar por entorno. */
export const AJUSTES = Object.freeze({
  /** Peticiones simultáneas contra Render. Más de 5 no ayuda y arriesga el plan free. */
  concurrencia: 4,
  /** Cuánto se espera a que Render despierte (una instancia dormida tarda ~40 s). */
  esperaMaxMs: 180_000,
  /** Tope por petición: Render, ya despierto, contesta en 0,4–1,8 s. */
  tiempoMs: 30_000,
  /** Reintentos por petición ante 5xx / red. */
  reintentos: 4,
  /** Etiqueta de la herramienta: va en el User-Agent. */
  agente: 'PelisLatino-colector/1.0 (+github-action)',
});

// ─────────────────────────────── utilidades ───────────────────────────────

/** Espera `ms` milisegundos. */
export function dormir(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Huella corta y estable (FNV-1a 32 bits). Igual que la del repo canales. */
export function huella(texto) {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

/** Minúsculas, sin tildes y sin signos: clave de comparación de nombres. */
export function clave(t) {
  return String(t || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** «Most watched» -> «most-watched»: seguro para URL y nombre de fichero. */
export function slug(t) {
  return clave(t).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'en-vivo';
}

/**
 * Sacar el id de Drama de una URL de la app.
 *
 * En el catálogo el canal viaja como `dramalive://play?id_live=live_tv_x&u=1&a=…`.
 * Se acepta también la variante sin `://play` porque han convivido las dos.
 */
export function idLiveDe(url) {
  if (typeof url !== 'string') return null;
  const m = /[?&]id_live=([^&]+)/.exec(url);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/** La URL con la que la app abre un canal de Drama (el esquema que ya entiende). */
export function urlCanal(idLive, u = '1', a = 'all_streams_redirect') {
  return `dramalive://play?id_live=${encodeURIComponent(idLive)}&u=${encodeURIComponent(u)}&a=${encodeURIComponent(a)}`;
}

// ─────────────────────────────── barrido ───────────────────────────────

/**
 * Cliente del barrido: sabe despertar Render, reintentar y no tirar el trabajo
 * cuando una petición falla.
 */
export class Barrido {
  constructor(opciones = {}) {
    this.api = (opciones.api || process.env.DRAMA_API || API_POR_DEFECTO).replace(/\/+$/, '');
    this.codigo = opciones.codigo || process.env.DRAMA_CODIGO || CODIGO_POR_DEFECTO;
    this.ajustes = { ...AJUSTES, ...(opciones.ajustes || {}) };
    this.fetch = opciones.fetch || globalThis.fetch;
    this.reloj = opciones.reloj || (() => Date.now());
    this.dormir = opciones.dormir || dormir;
    this.log = opciones.log || (() => {});
    /** Última vez que una petición devolvió 5xx: indica que Render se durmió otra vez. */
    this.durmiendo = false;
  }

  /** GET + JSON con reintentos. Devuelve `{ ok, datos, estado, ms, error }`, nunca lanza. */
  async pedir(ruta, { tiempoMs, reintentos } = {}) {
    const url = this.api + ruta;
    const tope = tiempoMs ?? this.ajustes.tiempoMs;
    const max = reintentos ?? this.ajustes.reintentos;
    let ultimo = null;
    const t0 = this.reloj();

    for (let intento = 0; intento <= max; intento++) {
      const ctl = new AbortController();
      const relojCorte = setTimeout(() => ctl.abort(), tope);
      try {
        const r = await this.fetch(url, {
          signal: ctl.signal,
          headers: { Accept: 'application/json', 'User-Agent': this.ajustes.agente },
        });
        const texto = await r.text();
        if (r.ok) {
          let datos;
          try { datos = JSON.parse(texto); }
          catch { throw new Error('JSON truncado o ilegible (' + texto.length + ' B)'); }
          this.durmiendo = false;
          return { ok: true, datos, estado: r.status, ms: this.reloj() - t0, error: '' };
        }
        ultimo = 'HTTP ' + r.status;
        // 5xx = está despertando (Render) o se cayó. 429 = nos pasamos. Se reintenta.
        const temporal = r.status >= 500 || r.status === 429;
        if (!temporal) {
          // 404 y demás son respuestas de verdad: reintentar no las cambia.
          return { ok: false, datos: null, estado: r.status, ms: this.reloj() - t0, error: ultimo, temporal: false };
        }
        this.durmiendo = r.status >= 502;
        // 429 = nos estamos pasando. Se frena de verdad, no solo con el backoff normal:
        // seguir martilleando hace que Render marque mal canales que están bien.
        if (r.status === 429) {
          this.limitado = (this.limitado || 0) + 1;
          await this.dormir(Math.min(3_000 * this.limitado, 30_000));
        }
      } catch (e) {
        ultimo = e && e.name === 'AbortError' ? 'tiempo agotado (' + tope + ' ms)' : String(e && e.message || e);
        this.durmiendo = true;
      } finally {
        clearTimeout(relojCorte);
      }
      if (intento < max) {
        // 1 s, 2 s, 4 s, 8 s… con techo de 8 s. Un Render dormido tarda ~40 s, y para
        // eso está despertar(): aquí solo se aguanta un tropiezo puntual.
        await this.dormir(Math.min(1000 * 2 ** intento, 8000));
      }
    }
    // estado 0 = no hubo respuesta HTTP (red o tiempo agotado). Con 5xx, Render puede
    // ser que esté despertando: eso es TEMPORAL y merece otra vuelta al final.
    return { ok: false, datos: null, estado: 0, ms: this.reloj() - t0, error: ultimo || 'sin respuesta' };
  }

  /**
   * Despierta la instancia si está dormida.
   *
   * Lo hace con `/salud`, que es la ruta más barata y cuyo 200 significa «ya atiende».
   * Se insiste con espera creciente; en cuanto contesta se sale sin gastar nada más.
   * Si no despierta en `esperaMaxMs` se lanza un error CLARO: mejor fallar el barrido
   * con motivo que publicar un catálogo vacío.
   */
  async despertar() {
    if (process.env.SALTAR_DESPERTAR === '1') return { despierta: true, ms: 0, saltada: true };
    const t0 = this.reloj();
    let espera = 2_000;
    for (let intento = 0; this.reloj() - t0 < this.ajustes.esperaMaxMs; intento++) {
      const r = await this.pedir('/salud', { reintentos: 0, tiempoMs: 15_000 });
      if (r.ok) {
        const ms = this.reloj() - t0;
        this.log(`api despierta en ${ms} ms (intento ${intento + 1})`);
        return { despierta: true, ms };
      }
      // Un 5xx aquí es literalmente «estoy arrancando»: se espera y se vuelve.
      this.log(`api dormida (${r.error}); se vuelve a probar en ${espera / 1000} s`);
      await this.dormir(espera);
      espera = Math.min(espera * 2, 20_000);
    }
    throw new Error(
      `la API no despertó en ${Math.round(this.ajustes.esperaMaxMs / 1000)} s ` +
      `(${this.api}). No se publica nada: el catálogo anterior se queda como está.`,
    );
  }

  /** Los temas (países y categorías) de un tipo. Devuelve [] si no se pudo. */
  async temas(tipo) {
    const r = await this.pedir(`/temas/${encodeURIComponent(this.codigo)}?tipo=${tipo}`);
    if (!r.ok || !r.datos || !Array.isArray(r.datos.temas)) {
      return { ok: false, temas: [], error: r.error || 'respuesta sin temas' };
    }
    const temas = r.datos.temas
      .filter((t) => t && t.id_topic)
      .map((t) => ({
        id: String(t.id_topic),
        nombre: String(t.name_topic || t.display_name || t.id_topic).trim(),
        logo: String(t.img_url_topic || ''),
      }));
    return { ok: true, temas, error: '' };
  }

  /** Los canales de un tema. Devuelve [] si no se pudo. */
  async canales(tipo, tema) {
    const r = await this.pedir(
      `/canales/${encodeURIComponent(this.codigo)}/${encodeURIComponent(tema)}?tipo=${tipo}`,
    );
    if (!r.ok || !r.datos || !Array.isArray(r.datos.canales)) {
      // `temporal`: 5xx o sin respuesta (Render despertando). Un 404 no lo es.
      const temporal = r.estado === 0 || r.estado >= 500 || r.estado === 429;
      return { ok: false, canales: [], error: r.error || 'respuesta sin canales', ms: r.ms, temporal };
    }
    const canales = r.datos.canales
      .filter((c) => c && c.id_live)
      .map((c) => ({
        id: String(c.id_live),
        nombre: String(c.name || c.id_live).trim(),
        logo: String(c.img_url || ''),
        tema: String(c.id_topic || tema),
        tipo: String(c.type || tipo),
      }));
    return { ok: true, canales, error: '', ms: r.ms };
  }

  /**
   * ¿Este canal SIGUE emitiendo, aunque ya no aparezca en ningún tema?
   *
   * Es la guardia antes de borrar. Medido en el primer barrido real: de los 886
   * canales que desaparecían del barrido, varios contestaban `200` en `/p/…/0.m3u8`.
   * O sea que Drama los sigue sirviendo pero ya no los lista en ningún tema. Borrarlos
   * por no verlos sería quitarle al usuario canales que funcionan — exactamente lo que
   * no queremos.
   *
   * Un HEAD al proxy de la opción 0: barato y suficiente (el proxy solo da 2xx si
   * consigue el manifiesto). Un 5xx se reintenta una vez: Render también se duerme
   * aquí. Ante la duda se dice que SÍ: se conserva.
   */
  async sigueEmitiendo(idLive, { reintentos = 1 } = {}) {
    if (!idLive) return false;
    const url = `${this.api}/p/${encodeURIComponent(this.codigo)}/${encodeURIComponent(idLive)}/0.m3u8`;
    for (let i = 0; i <= reintentos; i++) {
      const ctl = new AbortController();
      const corte = setTimeout(() => ctl.abort(), 12_000);
      try {
        const r = await this.fetch(url, {
          method: 'HEAD',
          signal: ctl.signal,
          headers: { 'User-Agent': this.ajustes.agente, Accept: '*/*' },
        });
        if (r.status >= 200 && r.status < 400) return true;
        if (r.status < 500) return false;        // 404/403: de verdad no está
      } catch { /* red o tiempo: se reintenta, y si no, se conserva */ }
      finally { clearTimeout(corte); }
      if (i < reintentos) await this.dormir(1000);
    }
    return true;   // no se pudo comprobar: se conserva (mejor de más que de menos)
  }

  /**
   * ¿ESTE CANAL EMITE AHORA MISMO?
   *
   * Es la comprobación de verdad, la que decide si el canal se publica o no. Se apoya
   * en `/opciones` de la API, que no devuelve un cartel: descarga el manifiesto y
   * exige `#EXTM3U` (o contenido de audio/vídeo) antes de decir `emite: true`.
   * Ver `drama_client.py::probar_stream`.
   *
   * Por qué NO se usa el proxy (`HEAD /p/…/0.m3u8`), que sería más barato: medido
   * hoy, en ráfaga da 5xx en el 100 % de los casos y en suelto da 200 hasta en
   * canales que `/opciones` marca muertos. Dice «resolví», no «emite». No vale.
   *
   * @returns {{estado: 'emite'|'no-emite'|'desconocido', opciones: number, ms: number}}
   *   · 'emite'        alguna opción del canal trae manifiesto válido
   *   · 'no-emite'     la API contestó y ninguna opción emite (esto sí es un veredicto)
   *   · 'desconocido'  no hubo respuesta (5xx, timeout, red). NO se toca lo que se sabía.
   */
  async verificar(idLive) {
    // ── sonda rápida: /probar ──
    //
    // Resuelve la principal (y sus respaldos hasta dar con una que emita) y prueba
    // ESE stream. Medido: 1,2–2,3 s frente a 1,4–11,5 s de /opciones, y coincidió en
    // 10 de 10 canales que constaban como «emite». Es la que se usa primero.
    const rapida = await this.pedir(`/probar/${encodeURIComponent(this.codigo)}/${encodeURIComponent(idLive)}`, {
      tiempoMs: 30_000,
    });
    if (rapida.ok && rapida.datos && rapida.datos.emite === true) {
      return { estado: 'emite', opciones: 1, total: 1, ms: rapida.ms, motivo: '' };
    }
    if (!rapida.ok) {
      // 404 = el canal no existe. Lo demás (5xx, tiempo) no es veredicto.
      if (rapida.estado === 404) return { estado: 'no-emite', opciones: 0, ms: rapida.ms, motivo: '404' };
      return { estado: 'desconocido', opciones: 0, ms: rapida.ms, motivo: rapida.error };
    }
    // «sin URL resuelta» = Drama no da ni una opción: eso sí es un veredicto.
    const motivoRapido = String((rapida.datos && rapida.datos.motivo) || '');
    if (/sin URL resuelta/i.test(motivoRapido)) {
      return { estado: 'no-emite', opciones: 0, total: 0, ms: rapida.ms, motivo: 'sin opciones' };
    }

    // ── sonda completa: /opciones ──
    // La principal no emite, pero puede haber una alternativa que sí. Solo se paga
    // este segundo viaje cuando la rápida ha dicho que no.
    const r = await this.pedir(`/opciones/${encodeURIComponent(this.codigo)}/${encodeURIComponent(idLive)}`, {
      tiempoMs: 40_000,
    });
    if (!r.ok) {
      if (r.estado === 404) return { estado: 'no-emite', opciones: 0, ms: r.ms, motivo: '404' };
      return { estado: 'desconocido', opciones: 0, ms: r.ms, motivo: r.error };
    }
    const ops = Array.isArray(r.datos && r.datos.opciones) ? r.datos.opciones : [];
    const emiten = ops.filter((o) => o && o.emite).length;
    if (emiten > 0) {
      return { estado: 'emite', opciones: emiten, total: ops.length, ms: r.ms, motivo: '' };
    }

    // «no emite» tiene que ser un VEREDICTO, no un mal día.
    //
    // La API puede contestar 200 y aun así no haber podido comprobar nada: su sonda
    // pide el stream desde Render, y si Render está saturado el error es un 5xx, un
    // 429 o un tiempo agotado. Eso NO prueba que el canal esté muerto (medido: pasó
    // con canales que la pasada anterior daban «emite» con 4 opciones).
    //
    //   · «no such host», «connection refused», «Invalid URL», 403/404/410
    //       -> el canal (o su host) ya no está: VEREDICTO
    //   · 5xx, 429, «timed out», «max retries»
    //       -> puede ser congestión: NO es veredicto, se deja como estaba
    const error = String((ops[0] && ops[0].error) || '');
    const sinOpciones = ops.length === 0;
    const delCanal = /\b(403|404|410|408)\b|name or service not known|NameResolutionError|nodename nor servname|Connection refused|No route to host|Invalid URL|Caused by SSLError|SSL:/i.test(error);
    const congestion = /\b(429|5\d\d)\b|timed out|Timeout|ReadTimeout|ConnectTimeout|Max retries exceeded|temporar/i.test(error);
    const transitorio = !delCanal && congestion;
    return {
      estado: transitorio && !sinOpciones ? 'desconocido' : 'no-emite',
      opciones: 0,
      total: ops.length,
      ms: r.ms + rapida.ms,
      motivo: sinOpciones ? 'sin opciones' : (error || 'sin manifiesto'),
      detalle: error.length > 120 ? error.slice(0, 400) : '',
    };
  }

  /**
   * Ejecuta `trabajo` sobre `items` con concurrencia acotada, conservando el orden
   * de los resultados. No aborta si uno falla.
   */
  async enParalelo(items, trabajo, concurrencia = this.ajustes.concurrencia) {
    const salida = new Array(items.length);
    let siguiente = 0;
    const obreros = Array.from({ length: Math.min(concurrencia, items.length) }, async () => {
      for (;;) {
        const i = siguiente++;
        if (i >= items.length) return;
        salida[i] = await trabajo(items[i], i);
      }
    });
    await Promise.all(obreros);
    return salida;
  }

  /**
   * EL BARRIDO COMPLETO.
   *
   * @returns {{
   *   api: string, codigo: string, at: string,
   *   tipos: Record<string, { temas: number, canales: number, fallos: string[] }>,
   *   canales: Array<{id:string,nombre:string,logo:string,tema:string,tipo:string}>,
   *   grupos: Array<{id:string,nombre:string,logo:string,tipo:string,orden:number,canales:number}>,
   *   ms: number,
   * }}
   */
  async todo({ tipos = TIPOS, progreso } = {}) {
    const t0 = this.reloj();
    const despertar = await this.despertar();

    const canalesPorId = new Map();
    const grupos = [];
    /** Los dos tipos comparten algunos temas (hot_now); se pide una sola vez por tipo. */
    const tiposInfo = {};

    for (const tipo of tipos) {
      const rt = await this.temas(tipo);
      const info = { temas: rt.temas.length, canales: 0, fallos: [] };
      if (!rt.ok) {
        info.fallos.push(`temas(${tipo}): ${rt.error}`);
        tiposInfo[tipo] = info;
        continue;
      }
      this.log(`${tipo}: ${rt.temas.length} temas`);

      let hechos = 0;
      const resultados = await this.enParalelo(rt.temas, async (tema) => {
        // Si Render se durmió a mitad, se vuelve a esperar antes de seguir: si no, el
        // resto del barrido sería una cadena de timeouts.
        if (this.durmiendo) {
          this.durmiendo = false;
          try { await this.despertar(); } catch (e) { this.log('aviso: ' + e.message); }
        }
        const r = await this.canales(tipo, tema.id);
        hechos++;
        if (progreso && (hechos % 25 === 0 || hechos === rt.temas.length)) {
          progreso({ tipo, hechos, total: rt.temas.length });
        }
        return { tema, ...r };
      });

      // ── segunda vuelta ──
      // Si Render se durmió a mitad (o se cayó la red), los temas que fallaron por eso
      // NO se pierden: se despierta otra vez y se reintentan UNA vez, al final. Sin
      // esto, un bache de 30 s a mitad del barrido se comía cientos de canales hasta
      // el día siguiente.
      const pendientes = resultados
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => !r.ok && r.temporal);
      if (pendientes.length) {
        this.log(`${tipo}: ${pendientes.length} temas fallaron por 5xx/red — segunda vuelta`);
        try { await this.despertar(); } catch (e) { this.log('aviso: ' + e.message); }
        const otra = await this.enParalelo(pendientes, async ({ r, i }) => {
          const rr = await this.canales(tipo, r.tema.id);
          if (rr.ok) resultados[i] = { tema: r.tema, ...rr };
          return rr;
        });
        const rescatados = otra.filter((x) => x && x.ok).length;
        if (rescatados) this.log(`${tipo}: ${rescatados} temas recuperados en la segunda vuelta`);
      }

      for (const r of resultados) {
        if (!r.ok) {
          info.fallos.push(`canales(${tipo}/${r.tema.id}): ${r.error}`);
          continue;
        }
        let delTema = 0;
        for (const c of r.canales) {
          // Un mismo canal sale en varios temas (hot_now, su país, su categoría).
          // Se queda con el PRIMERO (el orden de temas del proveedor es el del
          // editor) y se le añaden los demás grupos como alias.
          const previo = canalesPorId.get(c.id);
          if (previo) {
            if (!previo.temas.includes(r.tema.nombre)) previo.temas.push(r.tema.nombre);
            continue;
          }
          canalesPorId.set(c.id, {
            id: c.id,
            nombre: c.nombre,
            logo: c.logo,
            tema: r.tema.nombre,
            temas: [r.tema.nombre],
            tipo: c.tipo || tipo,
          });
          delTema++;
        }
        info.canales += delTema;
        grupos.push({
          id: r.tema.id,
          nombre: r.tema.nombre,
          logo: r.tema.logo,
          tipo,
          orden: grupos.length,
          canales: delTema,
        });
      }
      tiposInfo[tipo] = info;
      this.log(`${tipo}: ${info.canales} canales nuevos · ${info.fallos.length} temas con fallo`);
    }

    return {
      api: this.api,
      codigo: this.codigo,
      at: new Date(this.reloj()).toISOString(),
      despertarMs: despertar.ms,
      tipos: tiposInfo,
      canales: [...canalesPorId.values()],
      grupos,
      ms: this.reloj() - t0,
    };
  }
}
