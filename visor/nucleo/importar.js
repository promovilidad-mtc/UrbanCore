'use strict';
/* ══════════════════════════════════════════════════════════════════
   NÚCLEO — IMPORTAR LÍNEAS DE OTRA FUENTE (rutas existentes o corredores de proyecto)
   Acepta GeoJSON, Shapefile .zip, KML o KMZ (UTM se reproyecta solo) con cualquier campo:
   un cuadro pregunta qué campo es el nombre, si las líneas se juntan por nombre y qué
   campo/valores son ida o vuelta (o, si no hay sentido, a dónde van).
   Cada línea se ubica en los tramos de la red abierta:
   1) exacto por geometría (exports de RutaCore / del visor sobre la misma red);
   2) si no calza, se recorre la línea cada pocos metros y cada punto se pega al tramo más
      cercano que vaya en la misma dirección (tolerancia en metros). Un tramo entra si la
      línea lo recorre en al menos el 40 % de su largo; los tramitos cortos que quedan entre
      dos tramos ya ubicados se rellenan.
   No toca la red ni las rutas: devuelve grupos {nombre, color, atributos, ida:[segId], vuelta:[segId]}
   que el módulo Rutas (Importar rutas) o Cobertura (corredores) convierten a su formato.
   Los campos del archivo quedan como atributos (módulo Atributos), sin pisar los propios de la app.
   ══════════════════════════════════════════════════════════════════ */
(function(){
  const U = UC.util, esc = s => U.escapeHtml(s);
  // Campos que la app escribe al exportar rutas: no se copian como atributos (se generan de nuevo)
  const RESERVADOS = new Set(['nombre_ruta', 'sentido', 'color', 'ruta_id', 'seg_id']);
  const CAMPOS_NOMBRE = ['nombre_ruta', 'SHORT_NAME', 'short_name', 'route_short_name', 'ruta', 'RUTA', 'Ruta', 'codigo', 'CODIGO', 'Codigo',
    'cod', 'COD', 'nombre', 'NOMBRE', 'Nombre', 'name', 'NAME', 'Name', 'ROUTE_NAME', 'route_name', 'LONG_NAME', 'route_long_name'];
  const RX_SENTIDO = /^(sentido|direction|direction_id|direccion|dirección|dir|sense|sent)$/i;
  const RX_IDA = /^(ida|i|f|fw|fwd|forward|0|a|ab|go|outbound|out)$/i;
  const RX_VUELTA = /^(vuelta|v|b|r|bw|bwd|backward|back|reverse|1|ba|ret|retorno|regreso|inbound|in)$/i;
  const MAX_VALORES = 12;
  const OPC_SENTIDO = [['ida', 'Ida'], ['vuelta', 'Vuelta'], ['ambos', 'Ida y vuelta']];

  const claveValor = v => (v === null || v === undefined || v === '') ? '(vacío)' : String(v);
  function valores(feats, campo){
    const m = new Map();
    feats.forEach(f => { const k = claveValor((f.properties || {})[campo]); m.set(k, (m.get(k) || 0) + 1); });
    return m;
  }
  function textoNombre(p, campo){
    if(!campo) return null;
    const v = p[campo];
    return (v === null || v === undefined || String(v).trim() === '') ? null : String(v).trim();
  }
  function colorDe(p){
    const v = p.color ?? p.COLOR ?? p.colour ?? p.route_color ?? p.ROUTE_COLOR ?? p.stroke;
    if(typeof v !== 'string') return null;
    const m = v.trim().match(/^#?([0-9a-f]{6})$/i);
    return m ? '#' + m[1].toLowerCase() : null;
  }
  // Nombre que no choca con los ya usados: "C-20", "C-20 (2)", "C-20 (3)"…
  function nombreLibre(nombre, usados){
    let n = nombre, i = 2;
    while(usados.has(n)) n = `${nombre} (${i++})`;
    usados.add(n);
    return n;
  }

  /* ── 1) Leer el archivo ── */
  async function leer(file){
    const gj = await UC.red.leerArchivoGeo(file);
    const feats = (gj.features || []).filter(f => f && f.geometry && (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString'));
    if(!feats.length) throw new Error('No se encontraron líneas en el archivo.');
    const campos = [], vistos = new Set();
    feats.forEach(f => Object.keys(f.properties || {}).forEach(k => { if(!vistos.has(k)){ vistos.add(k); campos.push(k); } }));
    return { feats, campos, archivo:file.name };
  }

  /* ── 2) Sugerir la configuración según los campos ── */
  function sugerir(datos){
    const { feats, campos } = datos;
    const nombre = CAMPOS_NOMBRE.find(c => campos.includes(c))
      || campos.find(c => feats.some(f => typeof (f.properties || {})[c] === 'string')) || '';
    let sentido = campos.find(c => RX_SENTIDO.test(c)) || '';
    if(sentido && valores(feats, sentido).size > 6) sentido = '';
    const mapa = {};
    if(sentido) valores(feats, sentido).forEach((_, k) => { mapa[k] = RX_VUELTA.test(k) ? 'vuelta' : 'ida'; });
    // Se juntan por nombre si el nombre se repite mucho (ruta partida en varias líneas)
    // o si el sentido distingue ida y vuelta; si casi todos son distintos, cada línea es una ruta
    const nVals = nombre ? valores(feats, nombre).size : feats.length;
    const sentidoUtil = !!sentido && valores(feats, sentido).size > 1;
    const agrupar = nombre && nVals < feats.length && (nVals <= feats.length / 2 || sentidoUtil) ? 'nombre' : 'linea';
    return { campoNombre:nombre, agrupar, campoSentido:sentido, mapa, sinSentido:'ida', tol:20, reemplazar:false };
  }
  function contarGrupos(datos, campoNombre, agrupar){
    if(agrupar !== 'nombre' || !campoNombre) return datos.feats.length;
    const s = new Set(); let sueltos = 0;
    datos.feats.forEach(f => { const n = textoNombre(f.properties || {}, campoNombre); if(n === null) sueltos++; else s.add(n); });
    return s.size + sueltos;
  }

  /* ── 3) Cuadro de configuración (usa el modal de reportes) ──
     op: { destino:'rutas'|'corredores', hayRutas } → Promise<config> (no resuelve si se cierra) */
  function dialogo(datos, op){
    op = op || {};
    const cfg = sugerir(datos), esRutas = op.destino !== 'corredores';
    const plural = esRutas ? 'rutas' : 'corredores', singular = esRutas ? 'ruta' : 'corredor';
    const optsCampos = sel => datos.campos.map(c => `<option value="${esc(c)}"${c === sel ? ' selected' : ''}>${esc(c)}</option>`).join('');
    const html = `
      <div class="imp-info"><i class="fa-solid fa-file-lines"></i> <b>${esc(datos.archivo)}</b> · ${U.fmtNum(datos.feats.length)} líneas · ${datos.campos.length} campos</div>
      <div class="field"><label>Nombre de cada ${singular}</label>
        <select id="imp-nombre"><option value="">(sin nombre: numerar)</option>${optsCampos(cfg.campoNombre)}</select></div>
      <div class="field"><label>Líneas con el mismo nombre</label>
        <select id="imp-agrupar">
          <option value="nombre"${cfg.agrupar === 'nombre' ? ' selected' : ''}>Juntarlas en una sola ${singular}</option>
          <option value="linea"${cfg.agrupar === 'linea' ? ' selected' : ''}>Cada línea es una ${singular} aparte</option>
        </select></div>
      <div class="field"><label>Campo de sentido (ida / vuelta)</label>
        <select id="imp-sentido"><option value="">(el archivo no tiene sentido)</option>${optsCampos(cfg.campoSentido)}</select></div>
      <div id="imp-valores" class="imp-valores"></div>
      <div class="field"><label>Tolerancia para ubicar las líneas en la red (metros)</label>
        <input type="number" id="imp-tol" min="3" max="100" step="1" value="${cfg.tol}"></div>
      ${esRutas && op.hayRutas ? `<div class="switch-row"><span>Reemplazar las rutas actuales</span><label class="switch"><input type="checkbox" id="imp-reemplazar"><span class="track"></span></label></div>` : ''}
      <div class="imp-resumen" id="imp-resumen"></div>
      <div class="hint">Cada línea se ubica sobre los tramos de la red abierta (calce exacto o por cercanía y dirección). Los demás campos del archivo se guardan como <b>atributos</b> de cada ${singular} (módulo Atributos) y no cambian el funcionamiento de la app.${esRutas ? ' Las rutas importadas se pueden editar con Trazar / Quitar como cualquier otra.' : ''}</div>`;

    return new Promise(resolve => {
      UC.ui.reporte(esRutas ? 'Importar rutas' : 'Cargar corredores de proyecto', html, [
        { texto:esRutas ? 'Importar' : 'Cargar', icono:'fa-file-import', primario:true, accion:() => {
          leerCampos();
          const t = Number(UC.el('imp-tol').value);
          cfg.tol = isFinite(t) ? Math.max(3, Math.min(100, t)) : 20;
          const r = UC.el('imp-reemplazar'); cfg.reemplazar = !!(r && r.checked);
          UC.ui.cerrarReporte(); resolve(cfg);
        } }
      ]);
      const elNombre = UC.el('imp-nombre'), elAgrupar = UC.el('imp-agrupar'), elSentido = UC.el('imp-sentido');
      function leerCampos(){
        cfg.campoNombre = elNombre.value; cfg.agrupar = elAgrupar.value; cfg.campoSentido = elSentido.value;
        if(cfg.campoSentido) UC.el('imp-valores').querySelectorAll('select[data-val]').forEach(s => { cfg.mapa[s.dataset.val] = s.value; });
        else { const s = UC.el('imp-sin-sentido'); if(s) cfg.sinSentido = s.value; }
      }
      const optsSentido = sel => OPC_SENTIDO.map(([v, t]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${t}</option>`).join('');
      function pintarValores(){
        const box = UC.el('imp-valores');
        if(!cfg.campoSentido){
          box.innerHTML = `<div class="imp-val-row"><span>Las líneas van a</span><select id="imp-sin-sentido">
            <option value="ida"${cfg.sinSentido === 'ida' ? ' selected' : ''}>Ida (recorrido completo)</option>
            <option value="ambos"${cfg.sinSentido === 'ambos' ? ' selected' : ''}>Ida y vuelta (mismo recorrido)</option></select></div>`;
          return;
        }
        const vals = [...valores(datos.feats, cfg.campoSentido).entries()];
        vals.forEach(([k]) => { if(!cfg.mapa[k]) cfg.mapa[k] = RX_VUELTA.test(k) ? 'vuelta' : 'ida'; });
        box.innerHTML = vals.slice(0, MAX_VALORES).map(([k, n]) =>
          `<div class="imp-val-row"><span><b>${esc(k)}</b> <small>(${U.fmtNum(n)} líneas)</small></span><select data-val="${esc(k)}">${optsSentido(cfg.mapa[k])}</select></div>`).join('')
          + (vals.length > MAX_VALORES ? `<div class="hint">Este campo tiene ${vals.length} valores distintos: no parece un campo de sentido. Los valores que no aparecen arriba van a Ida.</div>` : '')
          + (vals.length === 1 ? `<div class="hint">Todas las líneas tienen el mismo valor de sentido.</div>` : '');
      }
      function pintarResumen(){
        leerCampos();
        const n = contarGrupos(datos, cfg.campoNombre, cfg.agrupar);
        UC.el('imp-resumen').innerHTML = `<i class="fa-solid fa-circle-info"></i> Se ${n === 1 ? 'creará' : 'crearán'} <b>${U.fmtNum(n)}</b> ${n === 1 ? singular : plural}`;
      }
      // Otro campo de sentido: los valores se vuelven a sugerir (no se arrastran los del campo anterior)
      elSentido.addEventListener('change', () => { cfg.campoSentido = elSentido.value; cfg.mapa = {}; pintarValores(); pintarResumen(); });
      elNombre.addEventListener('change', pintarResumen);
      elAgrupar.addEventListener('change', pintarResumen);
      pintarValores(); pintarResumen();
    });
  }

  /* ── 4) Ubicar las líneas en la red ── */
  const claveNodo = p => p[0].toFixed(7) + ',' + p[1].toFixed(7);
  // Sentido único de la vía (tags de OSM): 1 = en el sentido del dibujo, -1 = al revés, 0 = doble sentido o sin dato
  function sentidoUnico(si){
    const p = si.props || {}, o = String(p.oneway ?? '').toLowerCase();
    if(o === 'yes' || o === 'true' || o === '1') return 1;
    if(o === '-1' || o === 'reverse') return -1;
    if(o === '' && String(p.junction || '').toLowerCase() === 'roundabout') return 1;
    return 0;
  }
  // Grafo de la red (nodo → tramos que salen), para rellenar huecos por el camino más corto
  let grafo = null, grafoDe = null;
  function G(){
    if(grafoDe === UC.red.segs) return grafo;
    const ady = new Map(), add = (k, e) => { let a = ady.get(k); if(!a){ a = []; ady.set(k, a); } a.push(e); };
    UC.red.segs.forEach(si => { const ll = si.latlngs, a = claveNodo(ll[0]), b = claveNodo(ll[ll.length-1]); add(a, { si, n:b }); add(b, { si, n:a }); });
    grafo = { ady }; grafoDe = UC.red.segs;
    return grafo;
  }
  // Montículo mínimo chico para Dijkstra
  function monticulo(){
    const h = [];
    return {
      get size(){ return h.length; },
      push(x){ h.push(x); let i = h.length - 1; while(i > 0){ const p = (i - 1) >> 1; if(h[p][0] <= h[i][0]) break; [h[p], h[i]] = [h[i], h[p]]; i = p; } },
      pop(){ const top = h[0], last = h.pop(); if(h.length){ h[0] = last; let i = 0; for(;;){ const l = 2*i + 1, r = l + 1; let m = i;
        if(l < h.length && h[l][0] < h[m][0]) m = l; if(r < h.length && h[r][0] < h[m][0]) m = r; if(m === i) break; [h[m], h[i]] = [h[i], h[m]]; i = m; } } return top; }
    };
  }
  // Camino más corto (en metros) desde cualquier nodo de "desde" hasta cualquiera de "hasta", sin pasar de limiteM
  function caminoCorto(desde, hasta, limiteM){
    const g = G(), dist = new Map(), prev = new Map(), q = monticulo();
    desde.forEach(k => { dist.set(k, 0); q.push([0, k]); });
    while(q.size){
      const [d, k] = q.pop();
      if(d > dist.get(k)) continue;
      if(hasta.has(k)){ const segs = []; let x = k; while(prev.has(x)){ const pv = prev.get(x); segs.push(pv.si); x = pv.k; } return segs.reverse(); }
      for(const e of g.ady.get(k) || []){
        const nd = d + e.si.km * 1000;
        if(nd > limiteM) continue;
        if(!dist.has(e.n) || nd < dist.get(e.n)){ dist.set(e.n, nd); prev.set(e.n, { k, si:e.si }); q.push([nd, e.n]); }
      }
    }
    return null;
  }

  function calzarLineas(lineas, tol, op){
    op = op || {};
    const paso = Math.max(3, Math.min(10, tol / 2));   // metros entre puntos de muestreo
    const cubierto = new Map();                        // segId → {m: metros recorridos, orden}
    const cerca = new Map();                           // segId → distancia mínima (alineado) para rellenar huecos
    const CEL = 0.0005, muestras = new Map();          // puntos de la línea en celdas de ~55 m (para saber si un tramo va pegado a ella)
    const guardarMuestra = (lat, lng) => { const k = Math.floor(lng / CEL) * 1e6 + Math.floor(lat / CEL); let a = muestras.get(k); if(!a){ a = []; muestras.set(k, a); } a.push(lat, lng); };
    let orden = 0, mOrigen = 0, mUbicado = 0, exactos = 0;
    const marcar = (id, m) => { let e = cubierto.get(id); if(!e){ e = { m:0, orden:orden++ }; cubierto.set(id, e); } e.m += m; };

    lineas.forEach(c => {
      const ll = c.map(p => [p[1], p[0]]);
      const ex = UC.red.porId.get(UC.red.segIdFromLatLngs(ll));
      if(ex){ const m = ex.km * 1000; marcar(ex.segId, m); mOrigen += m; mUbicado += m; exactos++; ll.forEach(p => guardarMuestra(p[0], p[1])); return; }
      for(let k = 0; k < ll.length - 1; k++){
        const a = ll[k], b = ll[k+1];
        const kx = 111320 * Math.cos((a[0] + b[0]) / 2 * Math.PI / 180), ky = 110540;
        const sx = (b[1] - a[1]) * kx, sy = (b[0] - a[0]) * ky, L = Math.hypot(sx, sy);
        if(!(L > 0.01)) continue;
        mOrigen += L;
        const ux = sx / L, uy = sy / L, n = Math.max(1, Math.ceil(L / paso)), w = L / n;
        for(let j = 0; j < n; j++){
          const t = (j + 0.5) / n, lat = a[0] + (b[0] - a[0]) * t, lng = a[1] + (b[1] - a[1]) * t;
          guardarMuestra(lat, lng);
          const cands = UC.red.candidatosMetros(lat, lng, tol);
          let best = null, bestD = Infinity;
          for(const cd of cands){
            const dot = cd.ux * ux + cd.uy * uy;
            if(Math.abs(dot) < 0.7) continue;     // más de ~45° de diferencia: es una calle que cruza
            // Vía de sentido único recorrida a contramano: solo si no hay otra (doble calzada / pares viales)
            const su = op.conSentido ? sentidoUnico(cd.si) : 0;
            const dEf = su && dot * su < 0 ? cd.d + tol : cd.d;
            if(dEf < bestD){ best = cd; bestD = dEf; }
            const prev = cerca.get(cd.si.segId); if(prev === undefined || cd.d < prev) cerca.set(cd.si.segId, cd.d);
          }
          if(best){ marcar(best.si.segId, w); mUbicado += w; }
        }
      }
    });

    // Un tramo entra si la línea recorre al menos el 40 % de su largo (los muy cortos, con un solo punto basta)
    const ok = new Map();
    cubierto.forEach((e, id) => {
      const si = UC.red.porId.get(id); if(!si) return;
      const largo = si.km * 1000;
      if(e.m >= 0.4 * largo || (largo < 2 * paso && e.m > 0)) ok.set(id, e.orden);
    });
    // Rellenar tramitos cortos que quedaron entre dos tramos ya ubicados (dos pasadas: hasta dos seguidos)
    for(let pasada = 0; pasada < 2; pasada++){
      const nodos = new Map();
      ok.forEach((o, id) => { const ll = UC.red.porId.get(id).latlngs; [ll[0], ll[ll.length-1]].forEach(p => { const k = claveNodo(p), v = nodos.get(k); if(v === undefined || o < v) nodos.set(k, o); }); });
      const nuevos = [];
      cerca.forEach((d, id) => {
        if(ok.has(id) || d > tol / 2) return;
        const si = UC.red.porId.get(id); if(!si || si.km * 1000 > 3 * paso) return;
        const o1 = nodos.get(claveNodo(si.latlngs[0])), o2 = nodos.get(claveNodo(si.latlngs[si.latlngs.length-1]));
        if(o1 !== undefined && o2 !== undefined) nuevos.push([id, Math.min(o1, o2) + 0.5]);
      });
      if(!nuevos.length) break;
      nuevos.forEach(([id, o]) => ok.set(id, o));
    }
    // Huecos entre tramos seguidos que no se tocan (esquinas cortadas en diagonal, trazos simplificados):
    // se unen por el camino más corto de la red si es corto y va pegado a la línea dibujada
    const radio = Math.max(2 * tol, 40), r2 = radio * radio;
    const pegado = si => {
      const ll = si.latlngs, m = ll[Math.floor(ll.length / 2)], p = ll.length === 2 ? [(ll[0][0] + ll[1][0]) / 2, (ll[0][1] + ll[1][1]) / 2] : m;
      const kx = 111320 * Math.cos(p[0] * Math.PI / 180), ky = 110540, cx = Math.floor(p[1] / CEL), cy = Math.floor(p[0] / CEL);
      for(let x = cx - 1; x <= cx + 1; x++) for(let y = cy - 1; y <= cy + 1; y++){
        const a = muestras.get(x * 1e6 + y); if(!a) continue;
        for(let i = 0; i < a.length; i += 2){ const dy = (a[i] - p[0]) * ky, dx = (a[i+1] - p[1]) * kx; if(dx*dx + dy*dy <= r2) return true; }
      }
      return false;
    };
    const extremos = id => { const ll = UC.red.porId.get(id).latlngs; return [ll[0], ll[ll.length-1]]; };
    const lista = [...ok.entries()].sort((x, y) => x[1] - y[1]);
    for(let i = 0; i < lista.length - 1; i++){
      const [idA, oA] = lista[i], [idB, oB] = lista[i+1];
      const eA = extremos(idA), eB = extremos(idB);
      const kA = eA.map(claveNodo), kB = eB.map(claveNodo);
      if(kA.some(k => kB.includes(k))) continue;
      let gap = Infinity; eA.forEach(p => eB.forEach(q => { gap = Math.min(gap, U.haversineKm(p, q) * 1000); }));
      if(gap > 400) continue;
      const segs = caminoCorto(kA, new Set(kB), 2 * gap + 60);
      if(!segs || !segs.length || segs.length > 15 || !segs.every(pegado)) continue;
      segs.forEach((si, j) => { if(!ok.has(si.segId)) ok.set(si.segId, oA + (oB - oA) * (j + 1) / (segs.length + 1)); });
    }
    const ids = [...ok.entries()].sort((x, y) => x[1] - y[1]).map(x => x[0]);
    const kmCalzado = ids.reduce((s, id) => s + UC.red.porId.get(id).km, 0);
    return { ids, kmOrigen:mOrigen / 1000, kmUbicado:mUbicado / 1000, kmCalzado, exactos };
  }

  // datos + config → { grupos:[{nombre, color, atributos, ida, vuelta, kmOrigen, kmUbicado, kmIda, kmVuelta}], totales }
  async function calzar(datos, cfg, op){
    op = op || {};
    const etiqueta = op.etiqueta || 'Ruta';
    const grupos = new Map();
    datos.feats.forEach((f, i) => {
      const p = f.properties || {}, nom = textoNombre(p, cfg.campoNombre);
      const key = cfg.agrupar === 'nombre' && nom !== null ? 'n:' + nom : 'f:' + i;
      let g = grupos.get(key);
      if(!g){ g = { nombre:nom || `${etiqueta} ${grupos.size + 1}`, props:p, color:colorDe(p), ida:[], vuelta:[], ambos:false }; grupos.set(key, g); }
      const s = cfg.campoSentido ? (cfg.mapa[claveValor(p[cfg.campoSentido])] || 'ida') : (cfg.sinSentido || 'ida');
      const cs = (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]).filter(c => Array.isArray(c) && c.length >= 2);
      if(s === 'ambos') g.ambos = true;
      if(s === 'ida' || s === 'ambos') g.ida.push(...cs);
      if(s === 'vuelta' || s === 'ambos') g.vuelta.push(...cs);
    });

    const lista = [...grupos.values()], out = [];
    let tOrigen = 0, tUbicado = 0, tExactos = 0, ultimo = 0;
    UC.ui.loader('Ubicando las líneas en la red…'); await UC.ui.esperarFrame();
    try{
      for(let i = 0; i < lista.length; i++){
        if(Date.now() - ultimo > 250){ UC.ui.loader(`Ubicando las líneas en la red… ${i + 1} de ${lista.length}`); await UC.ui.esperarFrame(); ultimo = Date.now(); }
        const g = lista[i];
        // "Ida y vuelta" con la misma línea: no se sabe hacia dónde va, así que no se mira el sentido único de las vías
        const opC = { conSentido:!g.ambos };
        const rIda = calzarLineas(g.ida, cfg.tol, opC);
        // "Ida y vuelta" con las mismas líneas: no se calcula dos veces
        const mismas = g.vuelta.length === g.ida.length && g.vuelta.every((c, k) => c === g.ida[k]);
        const rVta = mismas ? { ...rIda, kmOrigen:0, kmUbicado:0, exactos:0 } : calzarLineas(g.vuelta, cfg.tol, opC);
        const atributos = {};
        Object.keys(g.props).forEach(k => { if(!RESERVADOS.has(k) && k !== cfg.campoSentido) atributos[k] = g.props[k]; });
        const kmOrigen = rIda.kmOrigen + rVta.kmOrigen, kmUbicado = rIda.kmUbicado + rVta.kmUbicado;
        tOrigen += kmOrigen; tUbicado += kmUbicado; tExactos += rIda.exactos + rVta.exactos;
        out.push({ nombre:g.nombre, color:g.color, atributos, ida:rIda.ids, vuelta:rVta.ids, kmOrigen, kmUbicado, kmIda:rIda.kmCalzado, kmVuelta:rVta.kmCalzado });
      }
    } finally { UC.ui.ocultarLoader(); }
    return { grupos:out, totales:{ kmOrigen:tOrigen, kmUbicado:tUbicado, exactos:tExactos, lineas:datos.feats.length } };
  }

  /* ── 5) Reporte de lo importado: cuánto de cada línea quedó sobre la red ── */
  function reporte(res, op){
    op = op || {};
    const singular = op.singular || 'ruta', plural = op.plural || 'rutas';
    const pctDe = g => g.kmOrigen > 0 ? g.kmUbicado / g.kmOrigen * 100 : 0;
    const color = p => p >= 90 ? '#16a34a' : p >= 70 ? '#d97706' : '#dc2626';
    const T = res.totales, pT = T.kmOrigen > 0 ? T.kmUbicado / T.kmOrigen * 100 : 0;
    const vacias = res.grupos.filter(g => !g.ida.length && !g.vuelta.length);
    const filas = [...res.grupos].sort((a, b) => pctDe(a) - pctDe(b)).map(g => {
      const p = pctDe(g);
      return `<tr><td><span class="imp-dot" style="background:${g.color || '#94a3b8'}"></span>${esc(g.nombre)}</td>
        <td>${g.kmIda.toFixed(2)}</td><td>${g.kmVuelta.toFixed(2)}</td>
        <td style="color:${color(p)};font-weight:600">${(!g.ida.length && !g.vuelta.length) ? 'no se ubicó' : p.toFixed(0) + ' %'}</td></tr>`;
    }).join('');
    const creadas = op.creadas ?? (res.grupos.length - vacias.length);
    const html = `
      <div class="imp-info"><b>${U.fmtNum(creadas)}</b> ${creadas === 1 ? singular : plural} sobre la red ·
        <span style="color:${color(pT)};font-weight:600">${pT.toFixed(0)} %</span> del largo de las líneas quedó ubicado en tramos
        (${T.kmUbicado.toFixed(1)} de ${T.kmOrigen.toFixed(1)} km)${T.exactos ? ` · ${U.fmtNum(T.exactos)} líneas calzaron exacto` : ''}</div>
      ${vacias.length ? `<div class="hint" style="color:#dc2626;margin-bottom:8px">${vacias.length} ${vacias.length === 1 ? singular : plural} no se ${vacias.length === 1 ? 'pudo' : 'pudieron'} ubicar y no se ${vacias.length === 1 ? 'agregó' : 'agregaron'}: ¿la red vial cubre esa zona? Prueba con más tolerancia.</div>` : ''}
      <table class="imp-tabla"><thead><tr><th>${singular.charAt(0).toUpperCase() + singular.slice(1)}</th><th>Ida km</th><th>Vuelta km</th><th>Ubicado</th></tr></thead><tbody>${filas}</tbody></table>
      <div class="hint" style="margin-top:8px">Ordenado de menor a mayor calce. Un porcentaje bajo indica que la línea pasa por calles que no están en la red o que fue dibujada lejos del eje (sube la tolerancia).${singular === 'ruta' ? ' Puedes completar o corregir cualquier ruta con Trazar / Quitar.' : ''}</div>`;
    UC.ui.reporte(op.titulo || 'Importación', html, []);
  }

  UC.importar = { leer, dialogo, calzar, reporte, nombreLibre };
})();
