'use strict';
/* ══════════════════════════════════════════════════════════════════
   MÓDULO JERARQUÍA — clasificación vial (antes: ClasificadorVial)
   Toda la red es Vía Local por defecto; solo se pintan expresas, arteriales y colectoras.
   Guarda en el proyecto: { clasificacionIds:[{id, tipo}] } (solo lo que no es local)
   ══════════════════════════════════════════════════════════════════ */
(function(){
  const map = UC.mapa.map, el = UC.el, U = UC.util;
  const TIPO_COLOR = { expresa:'#e2483d', arterial:'#f97316', colectora:'#eab308', local:'#22a55e' };
  const TIPO_WEIGHT = { expresa:4, arterial:3.5, colectora:3 };
  const RANGO = { expresa:{min:400,max:500}, arterial:{min:300,max:500}, colectora:{min:300,max:500}, local:{min:200,max:500} };
  const LABELS = { expresa:'Expresa', arterial:'Arterial', colectora:'Colectora', local:'Local' };
  const ESTILO_LOCAL = { color:TIPO_COLOR.local, weight:1.8, opacity:0.75 };
  const PICK_TOL = 14;

  let tipos = new Map();            // segId → 'expresa' | 'arterial' | 'colectora' (lo demás es local)
  let brushTipo = 'arterial', pintando = false, arrastrando = false, ultimoPt = null;
  let undoStack = [], lote = null, activo = false, capaVisible = true;
  let resaltados = [], nameIndex = new Map();

  const renderer = UC.mapa.lienzo('jerPane');
  const grupo = L.layerGroup().addTo(map);
  let lineas = new Map();           // segId → polyline de vía principal
  const selRenderer = UC.mapa.lienzo('selPane');
  const selGrupo = L.layerGroup().addTo(map);

  const panel = document.createElement('div');
  panel.innerHTML = `
    <div class="panel-section">
      <div class="panel-section-header">
        <div class="panel-section-icon blue"><i class="fa-solid fa-paintbrush"></i></div>
        <span class="panel-section-title">Pincel de clasificación</span>
      </div>
      <div class="tool-row">
        <button class="btn" id="jq-pincel" title="Activar pincel (P)"><i class="fa-solid fa-paintbrush"></i> Pincel</button>
        <button class="btn" id="jq-undo" disabled title="Deshacer último cambio (Ctrl+Z)"><i class="fa-solid fa-rotate-left"></i> Deshacer</button>
      </div>
      <div class="brush-grid">
        ${['expresa','arterial','colectora','local'].map(t => `
        <div class="brush-btn${t === 'arterial' ? ' active' : ''}" data-tipo="${t}">
          <div class="brush-swatch" style="background:var(--c-${t})"></div>
          <div class="brush-label"><span class="brush-name">Vía ${LABELS[t]}</span><span class="brush-range">${RANGO[t].min}–${RANGO[t].max} m${t === 'local' ? ' · por defecto' : ''}</span></div>
        </div>`).join('')}
      </div>
      <div class="kbd-hint">Toda la red arranca como Vía Local: solo pintá expresas, arteriales y colectoras. Para devolver un tramo a local, pintalo con Vía Local. Arrastrando desde una zona vacía movés el mapa.<br>Atajos: 1–4 jerarquía · P pincel · Ctrl+Z deshacer</div>
    </div>
    <div class="panel-section">
      <div class="panel-section-header">
        <div class="panel-section-icon purple"><i class="fa-solid fa-magnifying-glass"></i></div>
        <span class="panel-section-title">Buscar por nombre de vía</span>
      </div>
      <div class="search-box"><input type="text" id="jq-search" placeholder="Ej: Av. Grau…"></div>
      <div class="search-results" id="jq-results"><div class="hint">Escribí el nombre de una vía.</div></div>
      <button class="btn btn-clasificar-todos" id="jq-todos" disabled>Clasificar resaltados como: <span id="jq-lbl">Arterial</span></button>
    </div>
    <div class="panel-section">
      <div class="panel-section-header">
        <div class="panel-section-icon green"><i class="fa-solid fa-chart-simple"></i></div>
        <span class="panel-section-title">Resumen</span>
      </div>
      <div class="count-grid">
        ${['expresa','arterial','colectora','local'].map(t => `<div class="count-card ${t}"><div class="cv" id="jq-cnt-${t}">0</div><div class="cl">${LABELS[t]}</div></div>`).join('')}
      </div>
      <div class="count-total" id="jq-total">—</div>
    </div>`;

  /* ── Dibujo de las vías principales ── */
  function dibujar(segId){
    const t = tipos.get(segId), cur = lineas.get(segId);
    if(!t || !capaVisible){ if(cur){ grupo.removeLayer(cur); lineas.delete(segId); } return; }
    const st = { color:TIPO_COLOR[t], weight:TIPO_WEIGHT[t], opacity:0.9 };
    if(cur){ cur.setStyle(st); return; }
    const si = UC.red.porId.get(segId); if(!si) return;
    lineas.set(segId, L.polyline(si.latlngs, Object.assign({ renderer, interactive:false }, st)).addTo(grupo));
  }
  function redibujarTodo(){
    grupo.clearLayers(); lineas = new Map();
    if(capaVisible) tipos.forEach((t, id) => dibujar(id));
  }

  /* ── Conteos (una vez por cuadro) ── */
  let raf = 0;
  function contar(){ if(!raf) raf = requestAnimationFrame(() => { raf = 0; actualizarConteo(); }); }
  function actualizarConteo(){
    if(!el('jq-total')) return;
    const c = { expresa:0, arterial:0, colectora:0 };
    tipos.forEach(t => c[t]++);
    const principales = c.expresa + c.arterial + c.colectora;
    ['expresa','arterial','colectora'].forEach(t => el('jq-cnt-' + t).textContent = U.fmtNum(c[t]));
    el('jq-cnt-local').textContent = U.fmtNum(Math.max(0, UC.red.segs.length - principales));
    el('jq-total').textContent = UC.red.segs.length ? `${U.fmtNum(UC.red.segs.length)} segmentos · ${U.fmtNum(principales)} en vías principales` : '—';
  }

  /* ── Clasificar ── */
  function clasificar(segId, tipo){
    const nuevo = TIPO_COLOR[tipo] && tipo !== 'local' ? tipo : null;
    const antes = tipos.get(segId) || null;
    if(antes === nuevo) return;
    if(!lote){ lote = []; undoStack.push(lote); if(undoStack.length > 50) undoStack.shift(); }
    lote.push({ segId, antes });
    if(nuevo) tipos.set(segId, nuevo); else tipos.delete(segId);
    dibujar(segId);
    el('jq-undo').disabled = false;
    contar(); UC.eventos.emit('jerarquia:cambiada', {});
  }
  function deshacer(){
    if(!undoStack.length) return;
    undoStack.pop().slice().reverse().forEach(({ segId, antes }) => { if(antes) tipos.set(segId, antes); else tipos.delete(segId); dibujar(segId); });
    el('jq-undo').disabled = !undoStack.length;
    contar(); UC.eventos.emit('jerarquia:cambiada', {});
  }
  panel.querySelector('#jq-undo').addEventListener('click', deshacer);

  /* ── Pincel: clic, arrastre (con muestreo cada ~6 px) y paneo desde zona vacía ── */
  const cont = map.getContainer();
  cont.addEventListener('mousedown', e => {
    if(!activo || !pintando || e.button !== 0) return;
    if(e.target.closest('.leaflet-control') || (UC.regla && UC.regla.activa()) || (UC.streetview && UC.streetview.activa())) return;
    const p = map.mouseEventToContainerPoint(e);
    const si = UC.red.cercano(p, PICK_TOL);
    if(!si) return;                              // zona vacía → Leaflet mueve el mapa
    map.dragging.disable();
    arrastrando = true; ultimoPt = p; lote = null;
    clasificar(si.segId, brushTipo);
    e.preventDefault(); e.stopPropagation();
  }, true);
  document.addEventListener('mousemove', e => {
    if(!arrastrando) return;
    const p = map.mouseEventToContainerPoint(e);
    const n = Math.max(1, Math.ceil(ultimoPt.distanceTo(p) / 6));
    for(let i = 1; i <= n; i++){
      const q = L.point(ultimoPt.x + (p.x - ultimoPt.x) * i / n, ultimoPt.y + (p.y - ultimoPt.y) * i / n);
      const si = UC.red.cercano(q, PICK_TOL); if(si) clasificar(si.segId, brushTipo);
    }
    ultimoPt = p;
  });
  document.addEventListener('mouseup', () => { if(arrastrando){ arrastrando = false; map.dragging.enable(); lote = null; } });

  function setPincel(on){
    pintando = on;
    el('jq-pincel').classList.toggle('mode-active', on);
    el('map').classList.toggle('cursor-paint', on);
    if(!on){ UC.interaccion.limpiar(); arrastrando = false; map.dragging.enable(); }
    UC.ui.instruccion(on ? `Pincel activo (${LABELS[brushTipo]}) — clic o arrastre sobre la red para pintar · arrastre en vacío para mover el mapa` : 'Pincel desactivado — activalo para clasificar');
  }
  panel.querySelector('#jq-pincel').addEventListener('click', () => setPincel(!pintando));
  function setBrush(t){
    brushTipo = t;
    panel.querySelectorAll('.brush-btn').forEach(b => b.classList.toggle('active', b.dataset.tipo === t));
    el('jq-lbl').textContent = LABELS[t];
    if(pintando) setPincel(true);
  }
  panel.querySelectorAll('.brush-btn').forEach(b => b.addEventListener('click', () => setBrush(b.dataset.tipo)));

  document.addEventListener('keydown', e => {
    if(!activo || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z'){ e.preventDefault(); deshacer(); return; }
    if(e.ctrlKey || e.metaKey || e.altKey) return;
    const m = { '1':'expresa', '2':'arterial', '3':'colectora', '4':'local' };
    if(m[e.key]){ setBrush(m[e.key]); return; }
    if(e.key.toLowerCase() === 'p'){ setPincel(!pintando); return; }
    if(e.key === 'Escape' && pintando) setPincel(false);
  });

  /* ── Búsqueda por nombre ── */
  function construirNombres(){
    nameIndex = new Map();
    UC.red.segs.forEach(si => {
      const n = U.nombreVia(si.props).trim(); if(!n) return;
      const k = n.toLowerCase();
      if(!nameIndex.has(k)) nameIndex.set(k, { name:n, ids:[] });
      nameIndex.get(k).ids.push(si.segId);
    });
  }
  function limpiarResaltado(){
    resaltados = []; selGrupo.clearLayers();
    panel.querySelectorAll('.search-result-row.resaltado').forEach(r => r.classList.remove('resaltado'));
  }
  function buscar(q0){
    const q = q0.toLowerCase().trim(), box = el('jq-results');
    limpiarResaltado(); box.innerHTML = ''; el('jq-todos').disabled = true;
    const hint = t => { const d = document.createElement('div'); d.className = 'hint'; d.textContent = t; box.appendChild(d); };
    if(!q){ hint('Escribí el nombre de una vía.'); return; }
    const res = []; nameIndex.forEach((v, k) => { if(k.includes(q)) res.push(v); });
    res.sort((a, b) => a.name.localeCompare(b.name, 'es'));
    if(!res.length){ hint(`Sin resultados para "${q0}".`); return; }
    res.slice(0, 20).forEach(({ name, ids }) => {
      const row = document.createElement('div'); row.className = 'search-result-row';
      const n = document.createElement('span'); n.className = 'search-result-name'; n.textContent = name;
      const c = document.createElement('span'); c.className = 'search-result-count'; c.textContent = `${ids.length} tramo${ids.length > 1 ? 's' : ''}`;
      row.append(n, c);
      row.addEventListener('click', () => {
        limpiarResaltado(); resaltados = ids.slice(); row.classList.add('resaltado'); el('jq-todos').disabled = false;
        const b = L.latLngBounds([]);
        ids.forEach(id => { const si = UC.red.porId.get(id); if(!si) return; si.latlngs.forEach(p => b.extend(p));
          L.polyline(si.latlngs, { renderer:selRenderer, interactive:false, color:'#06b6d4', weight:6, opacity:0.9 }).addTo(selGrupo); });
        if(b.isValid()) map.fitBounds(b, { padding:[60, 60], maxZoom:17 });
      });
      box.appendChild(row);
    });
    if(res.length > 20) hint(`... y ${res.length - 20} más. Refiná la búsqueda.`);
  }
  let tBusca = 0;
  panel.querySelector('#jq-search').addEventListener('input', e => { clearTimeout(tBusca); const v = e.target.value; tBusca = setTimeout(() => buscar(v), 150); });
  panel.querySelector('#jq-todos').addEventListener('click', () => {
    if(!resaltados.length) return;
    const ids = resaltados.slice(); limpiarResaltado();
    lote = null; ids.forEach(id => clasificar(id, brushTipo)); lote = null;
    el('jq-todos').disabled = true;
  });

  /* ── La red cambió: los tramos que ya no existen se quitan; los nuevos entran como locales ── */
  UC.eventos.on('red:cambiada', ({ eliminados }) => {
    eliminados.forEach(id => tipos.delete(id));
    undoStack = []; if(el('jq-undo')) el('jq-undo').disabled = true;
    redibujarTodo(); construirNombres(); contar();
  });
  UC.eventos.on('red:cargada', () => { construirNombres(); contar(); });
  UC.eventos.on('red:atributos', () => construirNombres());   // pudo cambiar el nombre de una vía

  /* ── Proyecto / sesiones del Clasificador ── */
  function cargar(datos, op){
    op = op || {};
    tipos = new Map(); undoStack = []; lote = null; limpiarResaltado();
    if(datos){
      if(Array.isArray(datos.clasificacionIds)){
        let perdidos = 0;
        datos.clasificacionIds.forEach(({ id, tipo }) => {
          if(!TIPO_COLOR[tipo] || tipo === 'local') return;
          if(UC.red.porId.has(id)) tipos.set(id, tipo); else perdidos++;
        });
        if(perdidos && op.origen === 'clasificador') alert(`${perdidos} tramos clasificados no se encontraron en la red actual y no se trajeron.`);
      }else if(Array.isArray(datos.clasificacion) && op.mismaRed){
        // Sesiones viejas del Clasificador: por posición en su propia red
        datos.clasificacion.forEach(({ fi, tipo }) => {
          if(!TIPO_COLOR[tipo] || tipo === 'local') return;
          const si = UC.red.porFi.get(fi); if(si) tipos.set(si.segId, tipo);
        });
      }
    }
    if(el('jq-undo')) el('jq-undo').disabled = true;
    redibujarTodo(); construirNombres(); contar();
    UC.eventos.emit('jerarquia:cambiada', {});
  }

  function exportarClasificacion(){
    if(!UC.red.segs.length) return;
    const features = UC.red.segs.map(si => {
      const t = tipos.get(si.segId) || 'local';
      return { type:'Feature', properties:{ ...si.props, jerarquia:t, ...RANGO[t] }, geometry:{ type:'LineString', coordinates:si.latlngs.map(p => [p[1], p[0]]) } };
    });
    UC.ui.descargarTexto('plancore-clasificacion-vial.geojson', JSON.stringify({ type:'FeatureCollection',
      properties:{ tipo:'plancore-clasificacion-vial', version:1, exportadoEn:new Date().toISOString() }, features }, null, 2));
  }

  UC.modulos.registrar({
    id:'jerarquia', nombre:'Jerarquía', icono:'fa-layer-group', titulo:'Clasificación vial (ClasificadorVial)',
    panel, resultados:null,
    capas:[{ nombre:'Vías principales', visible:() => capaVisible, cambiar:v => { capaVisible = v; redibujarTodo(); } }],
    exportar:() => [
      { icono:'fa-layer-group', titulo:'Clasificación GeoJSON', sub:'.geojson — red clasificada para ParaderosCore', accion:exportarClasificacion }
    ],
    activar(){
      activo = true;
      UC.red.estiloBase(ESTILO_LOCAL);           // en este módulo la red se ve como vía local
      actualizarConteo(); setPincel(pintando);
    },
    desactivar(){
      activo = false; setPincel(false); limpiarResaltado();
      UC.red.estiloBase(UC.red.estiloPorDefecto);
    },
    hoverTramos:() => pintando && !arrastrando,
    colorHover:() => TIPO_COLOR[brushTipo],
    serializar:() => ({ clasificacionIds:[...tipos].map(([id, tipo]) => ({ id, tipo })) }),
    cargar,
    usosDeTramo(id){ const t = tipos.get(id); return t ? [`Jerarquía (vía ${LABELS[t].toLowerCase()})`] : []; }
  });

  UC.jerarquia = { tipo:id => tipos.get(id) || 'local', LABELS,
    // Clasificar desde otro módulo (Atributos). Varios ids = un solo paso de Deshacer
    asignar(ids, tipo){ lote = null; [].concat(ids).forEach(id => clasificar(id, tipo)); lote = null; } };
})();
