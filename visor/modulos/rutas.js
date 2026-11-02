'use strict';
/* ══════════════════════════════════════════════════════════════════
   MÓDULO RUTAS — trazado de rutas sobre la red (antes: RutaCore)
   Guarda en el proyecto: { routes:[{id, nombre, color, vis, visIda, visVuelta, ida:[{segId}], vuelta:[{segId}]}] }
   (mismo formato que las sesiones de RutaCore)
   ══════════════════════════════════════════════════════════════════ */
(function(){
  const map = UC.mapa.map, el = UC.el, U = UC.util;
  const PALETTE = ['#7c3aed','#e2483d','#0891b2','#16a34a','#d97706','#db2777','#0066cc','#9d174d'];
  const MAX_UNDO = 50;

  let routes = [], activeRouteId = null, activeVariant = 'ida';
  let traceMode = false, deleteMode = false, undoStack = [], redoStack = [], paletteIdx = 0;
  let capaVisible = true;

  /* ── Capa de rutas: su propio lienzo, encima de la red ── */
  const renderer = UC.mapa.lienzo('rutasPane');
  const grupo = L.layerGroup().addTo(map);
  let lineas = new Map();   // segId → {layer, k}

  /* ── Panel ── */
  const panel = document.createElement('div');
  panel.innerHTML = `
    <div class="panel-pad rt-toolbar" style="padding-bottom:4px">
      <div class="tool-row">
        <button class="btn" id="rt-trace" title="Trazar ruta sobre la red"><i class="fa-solid fa-pen"></i> Trazar</button>
        <button class="btn" id="rt-delete" disabled title="Quitar segmentos de la ruta activa"><i class="fa-solid fa-scissors"></i> Quitar</button>
        <button class="btn" id="rt-undo" disabled title="Deshacer" style="flex:0 0 38px"><i class="fa-solid fa-rotate-left"></i></button>
        <button class="btn" id="rt-redo" disabled title="Rehacer" style="flex:0 0 38px"><i class="fa-solid fa-rotate-right"></i></button>
        <button class="btn" id="rt-hideall" disabled title="Ocultar todas las rutas" style="flex:0 0 38px"><i class="fa-solid fa-eye"></i></button>
      </div>
    </div>
    <div class="panel-top">
      <div class="panel-top-header">
        <div class="panel-section-icon"><i class="fa-solid fa-bus"></i></div>
        <span class="panel-top-title">Gestión de rutas</span>
      </div>
      <div class="new-route-row">
        <input type="text" id="new-route-name" placeholder="Nombre de ruta…">
        <input type="color" id="new-route-color" class="color-swatch" value="#7c3aed" title="Color de ruta">
        <button class="btn primary btn-add-route" id="btn-add-route">+</button>
      </div>
    </div>
    <div class="panel-routes"><div id="routes-list"></div></div>`;

  /* ── Estilo de cada tramo según las rutas que lo usan (lógica de RutaCore) ── */
  function candidato(r, v){
    const vis = r.vis !== false && (v === 'ida' ? r.visIda !== false : r.visVuelta !== false);
    return { vis, color:v === 'ida' ? r.color : U.adjustColor(r.color, -40), isActive:r.id === activeRouteId && activeVariant === v };
  }
  // Prioridad: 1) variante activa visible, 2) cualquier visible; si ninguna, el tramo no se dibuja
  function estiloDe(cands){
    if(!cands || !cands.length) return null;
    const c = cands.find(x => x.isActive && x.vis) || cands.find(x => x.vis);
    return c ? { color:c.color, weight:3.5, opacity:0.9 } : null;
  }
  function aplicar(segId, st){
    const cur = lineas.get(segId);
    if(!st || !capaVisible){ if(cur){ grupo.removeLayer(cur.layer); lineas.delete(segId); } return; }
    const k = st.color + '|' + st.weight + '|' + st.opacity;
    if(cur){ if(cur.k !== k){ cur.layer.setStyle(st); cur.k = k; } return; }
    const si = UC.red.porId.get(segId); if(!si) return;
    const layer = L.polyline(si.latlngs, Object.assign({ renderer, interactive:false }, st)).addTo(grupo);
    lineas.set(segId, { layer, k });
  }
  function refreshSeg(segId){
    const cands = [];
    routes.forEach(r => ['ida','vuelta'].forEach(v => { if(r[v].find(s => s.segId === segId)) cands.push(candidato(r, v)); }));
    aplicar(segId, estiloDe(cands));
  }
  function refreshAll(){
    const porSeg = new Map();
    routes.forEach(r => ['ida','vuelta'].forEach(v => {
      const c = candidato(r, v);
      r[v].forEach(s => { const a = porSeg.get(s.segId) || []; a.push(c); porSeg.set(s.segId, a); });
    }));
    [...lineas.keys()].forEach(id => { if(!porSeg.has(id)) aplicar(id, null); });
    porSeg.forEach((c, id) => aplicar(id, estiloDe(c)));
  }

  /* ── Utilidades de km ── */
  function variantKm(r, v){ return r[v].reduce((a, s) => { const si = UC.red.porId.get(s.segId); return a + (si ? si.km : 0); }, 0); }
  const cambio = () => { UC.eventos.emit('rutas:cambiadas', {}); UC.actualizarEstado(); };

  /* ── Clic en segmento (trazar / quitar) ── */
  function handleSegmentClick(segId){
    if(!traceMode) return;
    if(!activeRouteId){ alert('Seleccioná una ruta en el panel izquierdo.'); return; }
    const r = routes.find(x => x.id === activeRouteId); if(!r) return;
    const arr = r[activeVariant];
    if(deleteMode){
      const idx = arr.findIndex(s => s.segId === segId);
      if(idx === -1){ UC.ui.instruccion('Ese segmento no está en la variante activa.'); return; }
      arr.splice(idx, 1);
      pushUndo({ routeId:activeRouteId, variant:activeVariant, segId, action:'delete' });
      refreshSeg(segId); updateInfoBar(); renderRoutesPanel(); cambio();
      UC.ui.instruccion('Segmento quitado. Podés deshacer con el botón de la barra.');
      return;
    }
    if(arr.find(s => s.segId === segId)){ UC.ui.instruccion('Segmento ya está en esta variante.'); return; }
    arr.push({ segId });
    pushUndo({ routeId:activeRouteId, variant:activeVariant, segId, action:'add' });
    refreshSeg(segId); updateInfoBar(); renderRoutesPanel(); cambio();
    UC.ui.instruccion(`Agregado a "${r.nombre}" — ${activeVariant}. (${arr.length} segs)`);
  }
  function pushUndo(e){
    if(undoStack.length >= MAX_UNDO) undoStack.shift();
    undoStack.push(e); redoStack = [];
    el('rt-undo').disabled = false; el('rt-redo').disabled = true;
  }
  panel.querySelector('#rt-undo').addEventListener('click', () => {
    if(!traceMode || !undoStack.length) return;
    const e = undoStack.pop();
    const r = routes.find(x => x.id === e.routeId); if(!r) return;
    if(e.action === 'add') r[e.variant] = r[e.variant].filter(s => s.segId !== e.segId);
    else r[e.variant].push({ segId:e.segId });
    redoStack.push(e);
    el('rt-redo').disabled = false; if(!undoStack.length) el('rt-undo').disabled = true;
    refreshSeg(e.segId); updateInfoBar(); renderRoutesPanel(); cambio();
    UC.ui.instruccion('Deshacer aplicado.');
  });
  panel.querySelector('#rt-redo').addEventListener('click', () => {
    if(!traceMode || !redoStack.length) return;
    const e = redoStack.pop();
    const r = routes.find(x => x.id === e.routeId); if(!r) return;
    if(e.action === 'add'){ if(!r[e.variant].find(s => s.segId === e.segId)) r[e.variant].push({ segId:e.segId }); }
    else r[e.variant] = r[e.variant].filter(s => s.segId !== e.segId);
    undoStack.push(e);
    el('rt-undo').disabled = false; if(!redoStack.length) el('rt-redo').disabled = true;
    refreshSeg(e.segId); updateInfoBar(); renderRoutesPanel(); cambio();
    UC.ui.instruccion('Rehacer aplicado.');
  });

  /* ── Modos ── */
  function enableTrace(){
    traceMode = true; deleteMode = false;
    el('rt-trace').classList.add('mode-active'); el('rt-delete').classList.remove('mode-active');
    el('map').classList.add('cursor-trace'); el('map').classList.remove('cursor-delete');
    el('trace-mode-badge').classList.add('show');
    el('rt-delete').disabled = false;
    el('rt-undo').disabled = !undoStack.length; el('rt-redo').disabled = !redoStack.length;
    updateInfoBar();
    UC.ui.instruccion('Clic sobre segmentos para trazar · arrastrá para navegar');
  }
  function disableTrace(){
    traceMode = false; deleteMode = false;
    el('rt-trace').classList.remove('mode-active'); el('rt-delete').classList.remove('mode-active');
    el('map').classList.remove('cursor-trace', 'cursor-delete');
    el('trace-mode-badge').classList.remove('show');
    el('rt-delete').disabled = true; el('rt-undo').disabled = true; el('rt-redo').disabled = true;
    UC.interaccion.limpiar();
  }
  panel.querySelector('#rt-trace').addEventListener('click', () => { traceMode ? disableTrace() : enableTrace(); });
  panel.querySelector('#rt-delete').addEventListener('click', () => {
    if(!traceMode) return;
    deleteMode = !deleteMode;
    el('rt-delete').classList.toggle('mode-active', deleteMode);
    el('map').classList.toggle('cursor-delete', deleteMode); el('map').classList.toggle('cursor-trace', !deleteMode);
    UC.ui.instruccion(deleteMode ? 'Clic sobre un segmento de la variante activa para quitarlo' : 'Clic sobre segmentos para trazar');
  });

  /* ── Ocultar / mostrar todas las rutas del mapa (solo visibilidad; las rutas no se tocan) ── */
  function actualizarBtnOcultar(){
    const b = panel.querySelector('#rt-hideall'); if(!b) return;
    const todasOcultas = routes.length > 0 && routes.every(r => r.vis === false);
    b.disabled = !routes.length;
    b.title = todasOcultas ? 'Mostrar todas las rutas' : 'Ocultar todas las rutas';
    b.innerHTML = '<i class="fa-solid ' + (todasOcultas ? 'fa-eye-slash' : 'fa-eye') + '"></i>';
  }
  panel.querySelector('#rt-hideall').addEventListener('click', () => {
    if(!routes.length) return;
    const ocultar = routes.some(r => r.vis !== false);
    routes.forEach(r => { r.vis = !ocultar; });
    refreshAll(); renderRoutesPanel();
  });

  /* ── Panel de rutas (igual que RutaCore) ── */
  function renderRoutesPanel(){
    actualizarBtnOcultar();
    const list = el('routes-list');
    if(!routes.length){
      list.innerHTML = '<div class="empty-hint"><span class="ico"><i class="fa-solid fa-pen"></i></span>Agregá una ruta arriba para empezar a trazar.</div>';
      return;
    }
    list.innerHTML = '';
    routes.forEach((r, idx) => {
      const isActive = r.id === activeRouteId;
      const idaKm = variantKm(r, 'ida'), vueltaKm = variantKm(r, 'vuelta');
      const rVis = r.vis !== false, idaVis = rVis && r.visIda !== false, vueltaVis = rVis && r.visVuelta !== false;
      const item = document.createElement('div');
      item.className = 'route-item' + (isActive ? ' selected' : '');
      item.innerHTML = `
        <div class="route-header" data-rid="${r.id}">
          <div class="route-color-bar" style="background:${r.color};opacity:${rVis ? 1 : .3}"></div>
          <div class="route-name-wrap">
            <input class="route-name-input" type="text" data-rid="${r.id}">
            <div class="route-km">${U.fmtKm(idaKm + vueltaKm)} · ${r.ida.length}+${r.vuelta.length} segs</div>
          </div>
          <div class="route-order">
            <button class="route-move-up" data-rid="${r.id}" title="Subir en la lista"${idx === 0 ? ' disabled' : ''}><i class="fa-solid fa-chevron-up"></i></button>
            <button class="route-move-down" data-rid="${r.id}" title="Bajar en la lista"${idx === routes.length - 1 ? ' disabled' : ''}><i class="fa-solid fa-chevron-down"></i></button>
          </div>
          <button class="route-vis" data-rid="${r.id}" title="${rVis ? 'Ocultar' : 'Mostrar'} ruta"><i class="fa-solid ${rVis ? 'fa-eye' : 'fa-eye-slash'}"></i></button>
          <button class="route-del" data-rid="${r.id}" title="Eliminar ruta"><i class="fa-solid fa-trash"></i></button>
        </div>
        <div class="variant-btns">
          <button class="var-btn${(isActive && activeVariant === 'ida') ? ' active-var' : ''}${!idaVis ? ' hidden-var' : ''}" data-rid="${r.id}" data-var="ida">
            <span class="var-left"><i class="fa-solid fa-arrow-right"></i> Ida<span class="var-km">${U.fmtKm(idaKm)}</span></span>
            <span class="eye-btn" data-rid="${r.id}" data-vistoggle="ida"><i class="fa-solid ${idaVis ? 'fa-eye' : 'fa-eye-slash'}"></i></span>
          </button>
          <button class="var-btn${(isActive && activeVariant === 'vuelta') ? ' active-var' : ''}${!vueltaVis ? ' hidden-var' : ''}" data-rid="${r.id}" data-var="vuelta">
            <span class="var-left"><i class="fa-solid fa-arrow-left"></i> Vuelta<span class="var-km">${U.fmtKm(vueltaKm)}</span></span>
            <span class="eye-btn" data-rid="${r.id}" data-vistoggle="vuelta"><i class="fa-solid ${vueltaVis ? 'fa-eye' : 'fa-eye-slash'}"></i></span>
          </button>
        </div>`;
      item.querySelector('.route-name-input').value = r.nombre;   // sin interpretar HTML del nombre
      list.appendChild(item);
    });
    list.querySelectorAll('.route-header[data-rid]').forEach(h => h.addEventListener('click', e => {
      if(e.target.closest('.route-del,.route-vis,.route-name-input,.route-move-up,.route-move-down')) return;
      selectRoute(h.dataset.rid, activeVariant);
    }));
    list.querySelectorAll('.route-name-input').forEach(inp => {
      inp.addEventListener('change', () => { const r = routes.find(x => x.id === inp.dataset.rid); if(r){ r.nombre = inp.value.trim() || r.nombre; renderRoutesPanel(); updateInfoBar(); cambio(); } });
      inp.addEventListener('click', e => e.stopPropagation());
    });
    list.querySelectorAll('.route-move-up').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation(); const i = routes.findIndex(x => x.id === b.dataset.rid); if(i <= 0) return;
      [routes[i-1], routes[i]] = [routes[i], routes[i-1]]; renderRoutesPanel();
    }));
    list.querySelectorAll('.route-move-down').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation(); const i = routes.findIndex(x => x.id === b.dataset.rid); if(i === -1 || i >= routes.length - 1) return;
      [routes[i], routes[i+1]] = [routes[i+1], routes[i]]; renderRoutesPanel();
    }));
    list.querySelectorAll('.route-del').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const r = routes.find(x => x.id === b.dataset.rid); if(!r) return;
      if(!confirm(`¿Eliminar "${r.nombre}" y todos sus segmentos?`)) return;
      routes = routes.filter(x => x.id !== r.id);
      if(activeRouteId === r.id) activeRouteId = routes.length ? routes[routes.length - 1].id : null;
      refreshAll(); renderRoutesPanel(); updateInfoBar(); cambio();
    }));
    list.querySelectorAll('.route-vis').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation(); const r = routes.find(x => x.id === b.dataset.rid); if(!r) return;
      r.vis = (r.vis === false); refreshAll(); renderRoutesPanel();
    }));
    list.querySelectorAll('.eye-btn[data-vistoggle]').forEach(s => s.addEventListener('click', e => {
      e.stopPropagation(); const r = routes.find(x => x.id === s.dataset.rid); if(!r) return;
      const vk = 'vis' + s.dataset.vistoggle.charAt(0).toUpperCase() + s.dataset.vistoggle.slice(1);
      r[vk] = (r[vk] === false); refreshAll(); renderRoutesPanel();
    }));
    list.querySelectorAll('.var-btn').forEach(b => b.addEventListener('click', e => {
      if(e.target.closest('.eye-btn')) return; e.stopPropagation(); selectRoute(b.dataset.rid, b.dataset.var);
    }));
  }
  function selectRoute(rid, variant){
    activeRouteId = rid; activeVariant = variant || 'ida';
    refreshAll(); renderRoutesPanel(); updateInfoBar();
  }

  /* ── Barra inferior de información ── */
  function updateInfoBar(){
    const r = routes.find(x => x.id === activeRouteId);
    el('info-ruta').textContent = r ? r.nombre : '—';
    el('info-variante').textContent = activeRouteId ? activeVariant : '—';
    if(r){
      el('info-km').textContent = U.fmtKm(variantKm(r, activeVariant));
      el('info-segs').textContent = r[activeVariant].length;
      if(traceMode) el('trace-badge-text').textContent = `Trazando: ${r.nombre} — ${activeVariant}`;
    }else{ el('info-km').textContent = '0.00 km'; el('info-segs').textContent = '0'; el('trace-badge-text').textContent = 'Trazando'; }
  }

  /* ── Nueva ruta ── */
  panel.querySelector('#btn-add-route').addEventListener('click', () => {
    const nombre = el('new-route-name').value.trim() || `Ruta ${routes.length + 1}`;
    const color = el('new-route-color').value;
    const id = 'r' + Date.now();
    routes.push({ id, nombre, color, vis:true, visIda:true, visVuelta:true, ida:[], vuelta:[] });
    el('new-route-name').value = '';
    paletteIdx = (paletteIdx + 1) % PALETTE.length;
    el('new-route-color').value = PALETTE[paletteIdx];
    selectRoute(id, 'ida'); cambio();
    UC.ui.instruccion(`Ruta "${nombre}" creada — activá Trazar para empezar`);
  });
  panel.querySelector('#new-route-name').addEventListener('keydown', e => { if(e.key === 'Enter') el('btn-add-route').click(); });

  /* ── La red cambió: quitar de las rutas los tramos que ya no existen ── */
  UC.eventos.on('red:cambiada', ({ eliminados }) => {
    let quitados = 0;
    routes.forEach(r => ['ida','vuelta'].forEach(v => {
      const antes = r[v].length;
      r[v] = r[v].filter(s => !eliminados.has(s.segId));
      quitados += antes - r[v].length;
    }));
    undoStack = []; redoStack = [];
    if(el('rt-undo')){ el('rt-undo').disabled = true; el('rt-redo').disabled = true; }
    lineas.forEach(x => grupo.removeLayer(x.layer)); lineas = new Map();
    refreshAll(); renderRoutesPanel(); updateInfoBar();
    if(quitados) UC.eventos.emit('rutas:cambiadas', {});
  });

  /* ── Proyecto ── */
  function cargar(datos, op){
    op = op || {};
    lineas.forEach(x => grupo.removeLayer(x.layer)); lineas = new Map();
    routes = []; activeRouteId = null; undoStack = []; redoStack = [];
    if(traceMode) disableTrace();
    if(datos && Array.isArray(datos.routes)){
      // Sesiones muy viejas de RutaCore usaban IDs numéricos: se traducen con la red de esa sesión
      const oldMap = new Map();
      if(op.redSesion){
        let n = 0;
        op.redSesion.forEach(f => {
          const id = ++n; const g = f && f.geometry; if(!g) return;
          const coords = g.type === 'LineString' ? g.coordinates : g.type === 'MultiLineString' ? (g.coordinates[0] || []) : [];
          const s = UC.red.segIdFromLatLngs(coords.map(c => [c[1], c[0]]));
          if(s !== null) oldMap.set(id, s);
        });
      }
      const esViejo = id => typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id));
      let antes = 0, perdidos = 0;
      routes = datos.routes.map(r => {
        const fix = arr => (arr || []).map(s => esViejo(s.segId) ? { segId:oldMap.get(Number(s.segId)) || null } : { segId:s.segId }).filter(s => s.segId !== null);
        const ida0 = fix(r.ida), vta0 = fix(r.vuelta);
        antes += (r.ida || []).length + (r.vuelta || []).length;
        const ida = ida0.filter(s => UC.red.porId.has(s.segId)), vuelta = vta0.filter(s => UC.red.porId.has(s.segId));
        perdidos += (ida0.length - ida.length) + (vta0.length - vuelta.length);
        return { ...r, id:r.id || ('r' + Math.random().toString(36).slice(2)), vis:r.vis !== false, visIda:r.visIda !== false, visVuelta:r.visVuelta !== false, ida, vuelta };
      });
      if(perdidos > 0) alert(`Atención: ${perdidos} de ${antes} segmentos trazados no se pudieron ubicar en la red actual (probablemente la red cambió). El resto se abrió con normalidad.`);
      if(routes.length) activeRouteId = routes[0].id;
    }
    refreshAll(); renderRoutesPanel(); updateInfoBar();
    UC.eventos.emit('rutas:cambiadas', {});
  }

  function exportarRutas(){
    const features = [];
    routes.forEach(r => ['ida','vuelta'].forEach(v => r[v].forEach(s => {
      const si = UC.red.porId.get(s.segId); if(!si) return;
      // Los campos propios de la ruta (módulo Atributos) van primero: los del formato RutaCore no se pisan
      features.push({ type:'Feature', properties:{ ...(r.atributos || {}), nombre_ruta:r.nombre, sentido:v, color:r.color, ruta_id:r.id, seg_id:s.segId },
                      geometry:{ type:'LineString', coordinates:si.latlngs.map(ll => [ll[1], ll[0]]) } });
    })));
    if(!features.length){ alert('Las rutas no tienen segmentos trazados.'); return; }
    UC.ui.descargarTexto('rutacore-export.geojson', JSON.stringify({ type:'FeatureCollection', properties:{ tipo:'rutacore-export', exportadoEn:new Date().toISOString() }, features }, null, 2));
  }

  UC.modulos.registrar({
    id:'rutas', nombre:'Rutas', icono:'fa-route', titulo:'Trazar rutas sobre la red (RutaCore)',
    panel, resultados:null,
    capas:[{ nombre:'Rutas', visible:() => capaVisible, cambiar:v => { capaVisible = v; refreshAll(); } }],
    exportar:() => [
      { icono:'fa-route', titulo:'Rutas GeoJSON', sub:'.geojson — formato RutaCore (Cobertura, QGIS)', accion:exportarRutas }
    ],
    activar(){
      el('info-bar').classList.remove('oculto');
      renderRoutesPanel(); updateInfoBar();
      if(traceMode) enableTrace(); else UC.ui.instruccion(routes.length ? 'Seleccioná una ruta y activá Trazar' : 'Creá una ruta en el panel y activá Trazar');
    },
    desactivar(){ if(traceMode) disableTrace(); el('info-bar').classList.add('oculto'); },
    hoverTramos:() => traceMode,
    alClic(si){ if(si) handleSegmentClick(si.segId); },
    serializar:() => ({ routes }),
    cargar,
    usosDeTramo(segId){
      const out = [];
      routes.forEach(r => { if(r.ida.find(s => s.segId === segId)) out.push(`${r.nombre} (ida)`); if(r.vuelta.find(s => s.segId === segId)) out.push(`${r.nombre} (vuelta)`); });
      return out;
    }
  });

  // API para los otros módulos (Análisis, Cobertura, Atributos)
  UC.rutas = { lista:() => routes, cantidad:() => routes.length, km:variantKm,
    // Atributos cambió nombre o color de una ruta desde afuera: redibujar mapa y panel
    refrescar(){ refreshAll(); renderRoutesPanel(); updateInfoBar(); } };
})();
