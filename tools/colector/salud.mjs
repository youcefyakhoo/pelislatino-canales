/**
 * SALUD DE LOS CANALES — memoria de lo que se comprobó y cuándo.
 *
 * POR QUÉ EXISTE
 * --------------
 * El catálogo tiene que ser «los canales que funcionan», no «los que el proveedor
 * lista». Pero comprobar 19.567 canales uno a uno cuesta ~2,8 s cada uno contra la
 * API (medido): 15 horas de trabajo. Inviable cada día, y además tumbaría Render.
 *
 * La solución no es verificar todo cada vez: es NO OLVIDAR lo verificado.
 *
 *   · cada canal guarda cuándo se miró, qué se vio y cuántos fallos seguidos lleva
 *   · cada pasada comprueba solo los que toca: los NUNCA mirados, los que toca
 *     refrescar (hace más de `horasVigencia`) y los que llevan poco tiempo caídos
 *   · un canal caído no se tira a la primera: se le dan `fallosParaRetirar`
 *     oportunidades en pasadas distintas (un canal puede caerse por un corte de 30 s)
 *
 * Con esto, la primera pasada tarda lo que tarde (y se puede partir en varias) y a
 * partir de ahí cada pasada es corta: solo lo que caduca.
 *
 * ESTADOS
 *   emite       el manifiesto se descargó y trae #EXTM3U
 *   no-emite    la API contestó y ninguna opción emite
 *   desconocido no hubo respuesta: NO cambia el estado anterior (ni bueno ni malo)
 *
 * Este fichero es la única fuente de verdad de qué se publica. Vive en
 * `estado/salud.json` y va en el commit, así que sobrevive entre pasadas.
 */

/** Horas que se considera buena una comprobación de un canal que emite. */
export const HORAS_VIGENCIA = 36;

/** Fallos seguidos (en pasadas distintas) para retirar un canal. */
export const FALLOS_PARA_RETIRAR = 2;

/**
 * Cada cuánto se le vuelve a mirar a un canal YA retirado.
 *
 * No se tira para siempre: un canal caído puede volver (cambia de CDN, acaba el
 * partido…). Se le da una oportunidad a la semana, con la prioridad más baja.
 */
export const HORAS_REINTENTO_CAIDO = 24 * 7;

/** Lo que se publica: solo lo que emite. Ni «desconocido» ni «no-emite». */
export const PUBLICABLE = 'emite';

/** El registro vacío. */
export function saludVacia() {
  return { version: 1, at: null, canales: {} };
}

/** Lee un `estado/salud.json` y devuelve algo usable aunque venga roto o vacío. */
export function leerSalud(json) {
  if (!json || typeof json !== 'object' || typeof json.canales !== 'object' || !json.canales) {
    return saludVacia();
  }
  return { version: 1, at: json.at || null, canales: json.canales };
}

/**
 * ¿Este registro dice que el canal emite?
 * Solo `emite`. Un canal que nunca se comprobó no es publicable todavía: no se
 * presenta como bueno lo que no se ha verificado.
 */
export function emite(registro) {
  return !!registro && registro.estado === PUBLICABLE;
}

/** ¿Está caducada la comprobación de este registro? */
export function caducado(registro, ahoraMs, horasVigencia = HORAS_VIGENCIA) {
  if (!registro || !registro.at) return true;
  const t = Date.parse(registro.at);
  if (!Number.isFinite(t)) return true;
  return ahoraMs - t > horasVigencia * 3600_000;
}

/**
 * ¿A este canal le toca comprobarse en esta pasada?
 *
 *   · nunca visto                  -> sí
 *   · emite y su dato caducó       -> sí
 *   · no-emite con pocos fallos    -> sí (se le da otra oportunidad)
 *   · no-emite con fallos suficientes -> no: ya está retirado, no gasta tiempo
 */
export function tocaComprobar(registro, ahoraMs, opciones = {}) {
  const horas = opciones.horasVigencia ?? HORAS_VIGENCIA;
  const fallos = opciones.fallosParaRetirar ?? FALLOS_PARA_RETIRAR;
  const horasCaido = opciones.horasReintentoCaido ?? HORAS_REINTENTO_CAIDO;
  if (!registro) return true;
  if (registro.estado === 'no-emite' && (registro.fallos || 0) >= fallos) {
    // Retirado: solo se revisa de vez en cuando, por si volvió.
    return caducado(registro, ahoraMs, horasCaido);
  }
  if (registro.estado === 'no-emite') return true;         // aún con oportunidades
  return caducado(registro, ahoraMs, horas);               // emite / desconocido
}

/**
 * ¿Se publica este canal?
 *
 *   · verificado y emite            -> sí, siempre
 *   · verificado y no emite         -> no
 *   · nunca verificado              -> solo si ya estaba en el catálogo de ayer
 *                                      (abuelo): no se presenta como bueno lo que no se
 *                                      ha comprobado, pero no se vacía la app de golpe
 *                                      mientras la primera pasada avanza
 *   · verificado como desconocido   -> igual que «nunca verificado»
 */
export function publicable(registro, estabaEnCatalogo) {
  if (!registro) return !!estabaEnCatalogo;
  if (registro.estado === 'emite') return true;
  if (registro.estado === 'no-emite') return false;
  return !!estabaEnCatalogo;
}

/**
 * Anota el resultado de una comprobación y devuelve el registro nuevo.
 *
 * `desconocido` (Render no contestó) NO penaliza: se conserva el estado y la fecha
 * anteriores. Un bache de red no debe retirar canales.
 */
export function anotar(registro, resultado, ahoraMs) {
  const at = new Date(ahoraMs).toISOString();
  const previo = registro || { estado: 'desconocido', fallos: 0, ok: 0, visto: null };

  if (resultado.estado === 'desconocido') {
    // Se deja como estaba, pero se recuerda que se intentó (para poder depurar).
    return { ...previo, intento: at, motivo: String(resultado.motivo || '').slice(0, 120) };
  }

  if (resultado.estado === 'emite') {
    return {
      estado: 'emite',
      at,
      visto: previo.visto || at,          // la primera vez que se le vio emitir
      fallos: 0,                          // un solo éxito limpia el historial
      ok: (previo.ok || 0) + 1,
      opciones: resultado.opciones || 0,
      ms: resultado.ms || 0,
    };
  }

  // no-emite
  return {
    estado: 'no-emite',
    at,
    visto: previo.visto || null,
    fallos: (previo.fallos || 0) + 1,
    ok: previo.ok || 0,
    opciones: 0,
    ms: resultado.ms || 0,
    motivo: String(resultado.motivo || 'sin opciones').slice(0, 120),
  };
}

/**
 * Comprueba los canales que tocan, con concurrencia acotada y presupuesto de tiempo.
 *
 * El presupuesto es lo que evita que una pasada se coma la madrugada: cuando se
 * agota, los que faltan se quedan como estaban y la siguiente pasada sigue por ahí
 * (siempre se empieza por los más viejos, que están los primeros de la cola).
 *
 * @param {object} barrido  instancia de Barrido (sabe despertar y reintentar)
 * @param {object} salud    registro actual
 * @param {Array<string>} ids  canales candidatos, en orden de prioridad
 * @returns {Promise<{salud: object, comprobados: number, emiten: number, noEmiten: number,
 *                    desconocidos: number, agotado: boolean, ms: number}>}
 */
export async function verificarCanales(barrido, salud, ids, opciones = {}) {
  const ahora = opciones.ahora ?? Date.now();
  const concurrencia = opciones.concurrencia ?? 4;
  const presupuestoMs = opciones.presupuestoMs ?? 45 * 60_000;
  const horasVigencia = opciones.horasVigencia ?? HORAS_VIGENCIA;
  const fallosParaRetirar = opciones.fallosParaRetirar ?? FALLOS_PARA_RETIRAR;
  const progreso = opciones.progreso || (() => {});
  const log = opciones.log || (() => {});

  const canales = { ...salud.canales };
  const t0 = Date.now();
  const guardarCada = opciones.guardarCada ?? 0;   // 0 = no guardar a media pasada
  const guardar = opciones.guardar || null;

  // La cola: solo los que tocan, ordenados por lo que hace más tiempo que no se miran.
  const cola = ids.filter((id) => tocaComprobar(canales[id], ahora, { horasVigencia, fallosParaRetirar }));
  cola.sort((a, b) => {
    const ta = canales[a] && canales[a].at ? Date.parse(canales[a].at) : 0;
    const tb = canales[b] && canales[b].at ? Date.parse(canales[b].at) : 0;
    return ta - tb;   // los nunca vistos (0) primero
  });

  const cuenta = { comprobados: 0, emiten: 0, noEmiten: 0, desconocidos: 0 };
  let agotado = false;
  let siguiente = 0;

  const obreros = Array.from({ length: Math.min(concurrencia, cola.length) }, async () => {
    for (;;) {
      if (Date.now() - t0 > presupuestoMs) { agotado = true; return; }
      const i = siguiente++;
      if (i >= cola.length) return;
      const id = cola[i];

      // Si Render se durmió, se espera antes de seguir: si no, toda la cola sería
      // una cadena de timeouts y se marcaría «desconocido» sin motivo.
      if (barrido.durmiendo) {
        barrido.durmiendo = false;
        try { await barrido.despertar(); } catch (e) { log('aviso: ' + e.message); }
      }

      const r = await barrido.verificar(id);
      canales[id] = anotar(canales[id], r, Date.now());
      cuenta.comprobados++;
      if (r.estado === 'emite') cuenta.emiten++;
      else if (r.estado === 'no-emite') cuenta.noEmiten++;
      else cuenta.desconocidos++;

      if (cuenta.comprobados % 200 === 0) {
        progreso({ ...cuenta, pendientes: cola.length - cuenta.comprobados });
      }
      // Checkpoint: una pasada de horas no puede perderlo todo si se corta. Se guarda
      // el estado completo, no un delta, así el fichero siempre es válido.
      if (guardar && guardarCada && cuenta.comprobados % guardarCada === 0) {
        try { await guardar({ version: 1, at: new Date(ahora).toISOString(), canales }); }
        catch (e) { log('aviso: no se pudo guardar el checkpoint: ' + e.message); }
      }
    }
  });
  await Promise.all(obreros);

  return {
    salud: { version: 1, at: new Date(ahora).toISOString(), canales },
    cola: cola.length,
    agotado,
    ms: Date.now() - t0,
    ...cuenta,
  };
}

/** Los ids publicables, en el orden que se les pase. */
export function publicables(salud, ids, estabanEnCatalogo = null) {
  const ayer = estabanEnCatalogo ? new Set(estabanEnCatalogo) : null;
  return ids.filter((id) => publicable(salud.canales[id], ayer ? ayer.has(id) : true));
}

/** Resumen para el log y para `estado/barrido.json`. */
export function resumenSalud(salud) {
  let emiten = 0, caidos = 0, nunca = 0;
  for (const r of Object.values(salud.canales)) {
    if (r.estado === 'emite') emiten++;
    else if (r.estado === 'no-emite') caidos++;
    else nunca++;
  }
  return { canales: Object.keys(salud.canales).length, emiten, caidos, nunca };
}
