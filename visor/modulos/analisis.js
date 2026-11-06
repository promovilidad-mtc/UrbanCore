'use strict';
/* ══════════════════════════════════════════════════════════════════
   MÓDULO ANÁLISIS — superposición y densidad de rutas por tramo (antes: AnálisisCore)
   Usa directamente las rutas del módulo Rutas: si trazas algo nuevo,
   el análisis se actualiza solo la próxima vez que lo abras.
   ══════════════════════════════════════════════════════════════════ */
(function(){
  const map = UC.mapa.map, el = UC.el, U = UC.util;

  let segRoutes = new Map(), sucio = true;     // segId → [{ri, v}]
  let rutas = [];                              // copia de trabajo: [{nombre, color, ida:Set, vuelta:Set}]
  let seleccion = new Set(), filtro = 'any', modo = 'sup', herramienta = 'click';
  let visibles = new Set(), soloRuta = null, resultado = [], activo = false;
  let denDirty = true, denMax = 0, denConteo = new Map();

  const selRenderer = UC.mapa.lienzo('selPane'), denRenderer = UC.mapa.lienzo('denPane'), rutasRenderer = UC.mapa.lienzo('rutasPane');
  const selLayer = L.layerGroup(), rutasLayer = L.layerGroup(), denLayer = L.layerGroup();

  /* ── Panel izquierdo ── */
  const panel = document.createElement('div');
  panel.innerHTML = `
    <div class="panel-section">
      <div class="mode-tabs" style="margin-bottom:14px">
        <button class="mode-tab active" data-mode="sup"><i class="fa-solid fa-layer-group"></i> Superposición</button>
        <button class="mode-tab" data-mode="den"><i class="fa-solid fa-fire"></i> Densidad</button>
      </div>
      <div id="an-pane-sup">
        <div class="tool-row">
          <button class="btn mode-active" id="an-click" title="Clic en un tramo para seleccionarlo o quitarlo"><i class="fa-solid fa-hand-pointer"></i> Clic</button>
          <button class="btn" id="an-area" title="Arrastra un rectángulo para sumar los tramos de una zona (también Shift + arrastre)"><i class="fa-regular fa-square"></i> Área</button>
          <button class="btn" id="an-clear" title="Limpiar selección (Esc)"><i class="fa-solid fa-eraser"></i> Limpiar</button>
        </div>
        <div class="field">
          <label>Rutas que pasan por…</label>
          <div class="seg-toggle" id="an-filtro">
            <button class="active" data-f="any">Cualquier tramo</button>
            <button data-f="all">Todos los tramos</button>
          </div>
        </div>
        <div class="hint"><b>Clic</b> selecciona o quita un tramo. <b>Área</b> (o Shift + arrastre) suma todos los tramos del rectángulo.<br>
          <b>Cualquier tramo</b>: rutas que tocan al menos uno. <b>Todos los tramos</b>: rutas que recorren el corredor completo seleccionado.</div>
      </div>
      <div id="an-pane-den" style="display:none">
        <div class="switch-row"><span>Mostrar densidad</span><label class="switch"><input type="checkbox" id="an-chk-den" checked><span class="track"></span></label></div>
        <div class="switch-row"><span>Considerar sentido</span><label class="switch"><input type="checkbox" id="an-chk-sentido"><span class="track"></span></label></div>
        <div class="hint" style="margin-top:6px">El color de cada tramo indica cuántas rutas pasan por él. Con <b>Considerar sentido</b>, ida y vuelta de una ruta cuentan por separado. Pasa el mouse por un tramo para ver cuáles son.</div>
      </div>
    </div>`;

  /* ── Panel derecho ── */
  const res = document.createElement('div');
  res.innerHTML = `
    <div id="an-res-sup" class="res-section">
      <h2>Superposición en la selección</h2>
      <div class="sel-stats">
        <div class="sel-stat"><div class="v" id="an-st-tramos">0</div><div class="l">Tramos</div></div>
        <div class="sel-stat"><div class="v" id="an-st-km">0.00</div><div class="l">Km</div></div>
        <div class="sel-stat"><div class="v" id="an-st-rutas">0</div><div class="l">Rutas</div></div>
      </div>
      <div id="an-vias" class="hint" style="margin:-2px 0 8px"></div>
      <div class="list-actions">
        <button class="btn" id="an-show-all"><i class="fa-solid fa-eye"></i> Ver todas</button>
        <button class="btn" id="an-hide-all"><i class="fa-solid fa-eye-slash"></i> Ocultar todas</button>
      </div>
      <div id="an-list"><div class="hint">Selecciona uno o más tramos en el mapa.</div></div>
    </div>
    <div id="an-res-den" class="res-section" style="display:none">
      <h2>Densidad de rutas</h2>
      <div class="summary-row"><span>Rutas</span><span class="v" id="an-den-rutas">—</span></div>
      <div class="summary-row"><span>Tramos con rutas</span><span class="v" id="an-den-tramos">—</span></div>
      <div class="summary-row"><span>Máx. rutas en un tramo</span><span class="v" id="an-den-max">—</span></div>
      <div class="density-legend" id="an-den-legend"></div>
    </div>`;

  /* ── Datos: cruce tramo ↔ rutas, rehecho solo cuando algo cambió ── */
  function prepararDatos(){
    if(!sucio) return;
    rutas = []; segRoutes = new Map();
    UC.rutas.lista().forEach(r => {
      const ri = rutas.length;
      const ruta = { nombre:r.nombre, color:r.color, ida:new Set(), vuelta:new Set() };
      ['ida','vuelta'].forEach(v => r[v].forEach(s => {
        if(!UC.red.porId.has(s.segId) || ruta[v].has(s.segId)) return;
        ruta[v].add(s.segId);
        let a = segRoutes.get(s.segId); if(!a){ a = []; segRoutes.set(s.segId, a); } a.push({ ri, v });
      }));
      rutas.push(ruta);
    });
    [...seleccion].forEach(id => { if(!UC.red.porId.has(id)) seleccion.delete(id); });
    visibles = new Set(); soloRuta = null;
    sucio = false; denDirty = true;
  }
  const marcarSucio = () => { sucio = true; if(activo){ prepararDatos(); refrescar(); } };
  UC.eventos.on('rutas:cambiadas', marcarSucio);
  UC.eventos.on('red:cambiada', marcarSucio);

  /* ══ Superposición ══ */
  function dibujarSeleccion(){
    selLayer.clearLayers();
    seleccion.forEach(id => { const si = UC.red.porId.get(id); if(si) L.polyline(si.latlngs, { renderer:selRenderer, interactive:false, color:'#06b6d4', weight:10, opacity:0.45, lineCap:'round' }).addTo(selLayer); });
  }
  function calcular(){
    const n = seleccion.size, porRuta = new Map();
    seleccion.forEach(id => (segRoutes.get(id) || []).forEach(({ ri, v }) => {
      let o = porRuta.get(ri); if(!o){ o = { ida:new Set(), vuelta:new Set(), union:new Set() }; porRuta.set(ri, o); }
      o[v].add(id); o.union.add(id);
    }));
    const out = [];
    porRuta.forEach((o, ri) => {
      if(filtro === 'all' && o.union.size < n) return;
      let km = 0; o.union.forEach(id => km += UC.red.porId.get(id).km);
      const sentido = o.ida.size && o.vuelta.size ? 'Ambas' : o.ida.size ? 'Ida' : 'Vuelta';
      out.push({ ri, nombre:rutas[ri].nombre, color:rutas[ri].color, tramos:o.union.size, ida:o.ida.size, vuelta:o.vuelta.size, sentido, km, pct:n ? o.union.size / n : 0 });
    });
    out.sort((a, b) => b.tramos - a.tramos || b.km - a.km || a.nombre.localeCompare(b.nombre, 'es', { numeric:true }));
    return out;
  }
  const kmSel = () => { let k = 0; seleccion.forEach(id => k += UC.red.porId.get(id).km); return k; };
  function viasSel(){
    const c = new Map();
    seleccion.forEach(id => { const si = UC.red.porId.get(id), nm = U.nombreVia(si.props); if(nm) c.set(nm, (c.get(nm) || 0) + si.km); });
    return [...c.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  }
  function actualizarSup(resetVisibles = true){
    resultado = calcular();
    if(resetVisibles){ visibles = new Set(resultado.map(r => r.ri)); soloRuta = null; }
    el('an-st-tramos').textContent = U.fmtNum(seleccion.size);
    el('an-st-km').textContent = kmSel().toFixed(2);
    el('an-st-rutas').textContent = resultado.length;
    const vias = viasSel();
    el('an-vias').textContent = vias.length ? 'Vías: ' + vias.slice(0, 4).join(' · ') + (vias.length > 4 ? ` · y ${vias.length - 4} más` : '') : '';
    renderLista(); dibujarRutas();
    UC.ui.instruccion(!seleccion.size ? 'Clic en un tramo para seleccionarlo · Área o Shift + arrastre para seleccionar una zona'
      : `${seleccion.size} tramo${seleccion.size > 1 ? 's' : ''} seleccionado${seleccion.size > 1 ? 's' : ''} · ${resultado.length} ruta${resultado.length !== 1 ? 's' : ''} ${filtro === 'all' ? 'recorren todos' : 'pasan por ellos'}`);
  }
  function renderLista(){
    const list = el('an-list'); list.innerHTML = '';
    const hint = t => { const h = document.createElement('div'); h.className = 'hint'; h.textContent = t; list.appendChild(h); };
    if(!seleccion.size){ hint('Selecciona uno o más tramos en el mapa.'); return; }
    if(!resultado.length){ hint(filtro === 'all' ? 'Ninguna ruta recorre todos los tramos seleccionados. Prueba con "Cualquier tramo".' : 'Ninguna ruta pasa por los tramos seleccionados.'); return; }
    resultado.forEach(r => {
      const row = document.createElement('div'); row.className = 'route-row' + (soloRuta === r.ri ? ' solo' : '');
      row.title = 'Clic para ver esta ruta sola (otro clic vuelve a todas)';
      const sw = document.createElement('div'); sw.className = 'route-sw'; sw.style.background = r.color;
      const nm = document.createElement('div'); nm.className = 'route-name'; nm.textContent = r.nombre;
      const bd = document.createElement('span'); bd.className = 'badge' + (r.sentido === 'Ambas' ? ' ambas' : ''); bd.textContent = r.sentido;
      const mt = document.createElement('span'); mt.className = 'route-meta'; mt.textContent = `${r.tramos}/${seleccion.size} · ${r.km.toFixed(2)} km`;
      const eye = document.createElement('button'); eye.className = 'eye' + (visibles.has(r.ri) ? ' on' : '');
      eye.innerHTML = visibles.has(r.ri) ? '<i class="fa-solid fa-eye"></i>' : '<i class="fa-solid fa-eye-slash"></i>';
      eye.addEventListener('click', ev => { ev.stopPropagation(); soloRuta = null; visibles.has(r.ri) ? visibles.delete(r.ri) : visibles.add(r.ri); renderLista(); dibujarRutas(); });
      row.addEventListener('click', () => {
        if(soloRuta === r.ri){ soloRuta = null; visibles = new Set(resultado.map(x => x.ri)); }
        else { soloRuta = r.ri; visibles = new Set([r.ri]); }
        renderLista(); dibujarRutas();
      });
      row.append(sw, nm, bd, mt, eye); list.appendChild(row);
    });
  }
  function dibujarRutas(){
    rutasLayer.clearLayers();
    if(modo !== 'sup') return;
    visibles.forEach(ri => {
      const r = rutas[ri]; if(!r) return;
      [['ida', r.color], ['vuelta', U.adjustColor(r.color, -40)]].forEach(([v, col]) => r[v].forEach(id => {
        const si = UC.red.porId.get(id); if(si) L.polyline(si.latlngs, { renderer:rutasRenderer, interactive:false, color:col, weight:3.5, opacity:0.9 }).addTo(rutasLayer);
      }));
    });
  }
  function toggleSeg(si){ seleccion.has(si.segId) ? seleccion.delete(si.segId) : seleccion.add(si.segId); dibujarSeleccion(); actualizarSup(); }
  function limpiarSel(){ seleccion = new Set(); selLayer.clearLayers(); actualizarSup(); }
  panel.querySelector('#an-clear').addEventListener('click', limpiarSel);
  panel.querySelectorAll('#an-filtro button').forEach(b => b.addEventListener('click', () => {
    filtro = b.dataset.f; panel.querySelectorAll('#an-filtro button').forEach(x => x.classList.toggle('active', x === b)); actualizarSup();
  }));
  res.querySelector('#an-show-all').addEventListener('click', () => { soloRuta = null; visibles = new Set(resultado.map(r => r.ri)); renderLista(); dibujarRutas(); });
  res.querySelector('#an-hide-all').addEventListener('click', () => { soloRuta = null; visibles = new Set(); renderLista(); dibujarRutas(); });
  function setHerramienta(h){
    herramienta = h;
    el('an-click').classList.toggle('mode-active', h === 'click');
    el('an-area').classList.toggle('mode-active', h === 'area');
    el('map').classList.toggle('cursor-area', activo && modo === 'sup' && h === 'area');
    el('map').classList.toggle('cursor-pick', activo && modo === 'sup' && h === 'click');
  }
  panel.querySelector('#an-click').addEventListener('click', () => setHerramienta('click'));
  panel.querySelector('#an-area').addEventListener('click', () => setHerramienta(herramienta === 'area' ? 'click' : 'area'));

  /* Rectángulo (herramienta Área o Shift + arrastre) */
  let rectIni = null, rect = null;
  const cont = map.getContainer();
  cont.addEventListener('mousedown', e => {
    if(!activo || modo !== 'sup' || e.button !== 0 || !(herramienta === 'area' || e.shiftKey)) return;
    if(e.target.closest('.leaflet-control') || (UC.regla && UC.regla.activa())) return;
    rectIni = map.mouseEventToLatLng(e); map.dragging.disable();
    e.preventDefault(); e.stopPropagation();
  }, true);
  document.addEventListener('mousemove', e => {
    if(!rectIni) return;
    const b = L.latLngBounds(rectIni, map.mouseEventToLatLng(e));
    if(!rect) rect = L.rectangle(b, { color:'#06b6d4', weight:1.5, dashArray:'5 4', fillOpacity:0.08, interactive:false }).addTo(map); else rect.setBounds(b);
  });
  document.addEventListener('mouseup', () => {
    if(!rectIni) return;
    const b = rect ? rect.getBounds() : null;
    if(rect){ map.removeLayer(rect); rect = null; }
    rectIni = null; map.dragging.enable();
    if(!b) return;
    UC.red.enRectangulo(b).forEach(si => seleccion.add(si.segId));
    dibujarSeleccion(); actualizarSup();
  });
  document.addEventListener('keydown', e => { if(activo && e.key === 'Escape' && modo === 'sup' && seleccion.size && e.target.tagName !== 'INPUT') limpiarSel(); });

  /* Globo al pasar el mouse: vía, km y qué rutas pasan */
  function textoTramo(si){
    const porRuta = new Map();
    (segRoutes.get(si.segId) || []).forEach(({ ri, v }) => { const s = porRuta.get(ri) || new Set(); s.add(v); porRuta.set(ri, s); });
    const nm = U.nombreVia(si.props);
    const cab = (nm ? `<b>${U.escapeHtml(nm)}</b><br>` : '') + `${porRuta.size} ruta${porRuta.size !== 1 ? 's' : ''} · ${si.km.toFixed(2)} km`;
    if(!porRuta.size) return cab;
    const items = [...porRuta.entries()].sort((a, b) => rutas[a[0]].nombre.localeCompare(rutas[b[0]].nombre, 'es', { numeric:true }))
      .slice(0, 12).map(([ri, s]) => `${U.escapeHtml(rutas[ri].nombre)}${s.size === 2 ? '' : ' (' + [...s][0] + ')'}`);
    return cab + '<br><span style="color:#666">' + items.join(', ') + (porRuta.size > 12 ? '…' : '') + '</span>';
  }

  /* ══ Densidad ══ */
  function densityColor(n, max){ if(max <= 1) return '#22c55e'; const t = (n - 1) / (max - 1); if(t <= 0.33) return '#22c55e'; if(t <= 0.5) return '#84cc16'; if(t <= 0.66) return '#eab308'; if(t <= 0.82) return '#f97316'; return '#ef4444'; }
  function densityWeight(n, max){ return max <= 1 ? 4 : 4 + Math.round((n - 1) / (max - 1) * 4); }
  function calcularDensidad(){
    const sentido = el('an-chk-sentido').checked;
    denConteo = new Map();
    segRoutes.forEach((arr, id) => { const n = sentido ? arr.length : new Set(arr.map(x => x.ri)).size; if(n) denConteo.set(id, n); });
    denMax = denConteo.size ? Math.max(...denConteo.values()) : 0;
    denDirty = false;
  }
  function dibujarDensidad(){
    denLayer.clearLayers();
    if(modo !== 'den' || !el('an-chk-den').checked) return;
    [...denConteo.entries()].sort((a, b) => a[1] - b[1]).forEach(([id, n]) => {   // los más cargados encima
      const si = UC.red.porId.get(id);
      if(si) L.polyline(si.latlngs, { renderer:denRenderer, interactive:false, color:densityColor(n, denMax), weight:densityWeight(n, denMax), opacity:0.9, lineCap:'round' }).addTo(denLayer);
    });
  }
  function renderDensidad(){
    el('an-den-rutas').textContent = rutas.length;
    el('an-den-tramos').textContent = U.fmtNum(denConteo.size);
    el('an-den-max').textContent = denMax || '—';
    const grupos = new Map();
    denConteo.forEach(n => { const c = densityColor(n, denMax); const g = grupos.get(c) || { min:n, max:n, tramos:0 }; g.min = Math.min(g.min, n); g.max = Math.max(g.max, n); g.tramos++; grupos.set(c, g); });
    const leg = el('an-den-legend'); leg.innerHTML = '';
    ['#22c55e','#84cc16','#eab308','#f97316','#ef4444'].forEach(c => {
      const g = grupos.get(c); if(!g) return;
      const row = document.createElement('div'); row.className = 'den-row';
      const sw = document.createElement('div'); sw.className = 'den-swatch'; sw.style.background = c;
      const tx = document.createElement('span'); tx.textContent = `${g.min === g.max ? g.min : g.min + '–' + g.max} ruta${g.max > 1 ? 's' : ''} · ${U.fmtNum(g.tramos)} tramos`;
      row.append(sw, tx); leg.appendChild(row);
    });
  }
  function actualizarDen(){ if(denDirty) calcularDensidad(); dibujarDensidad(); renderDensidad(); UC.ui.instruccion('Densidad de rutas — pasa el mouse por un tramo para ver qué rutas pasan'); }
  panel.querySelector('#an-chk-den').addEventListener('change', dibujarDensidad);
  panel.querySelector('#an-chk-sentido').addEventListener('change', () => { denDirty = true; actualizarDen(); });

  function setModo(m){
    modo = m;
    panel.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === m));
    el('an-pane-sup').style.display = m === 'sup' ? '' : 'none'; el('an-pane-den').style.display = m === 'den' ? '' : 'none';
    el('an-res-sup').style.display = m === 'sup' ? '' : 'none'; el('an-res-den').style.display = m === 'den' ? '' : 'none';
    if(m === 'sup'){ selLayer.addTo(map); denLayer.clearLayers(); actualizarSup(false); }
    else { map.removeLayer(selLayer); rutasLayer.clearLayers(); actualizarDen(); }
    setHerramienta(herramienta);
  }
  panel.querySelectorAll('.mode-tab').forEach(t => t.addEventListener('click', () => setModo(t.dataset.mode)));
  function refrescar(){ if(modo === 'sup'){ dibujarSeleccion(); actualizarSup(false); } else actualizarDen(); }

  /* ══ Exportar ══ */
  function textoResumen(){
    if(!seleccion.size) return '';
    const vias = viasSel(), l = [];
    l.push(`Tramos seleccionados: ${seleccion.size} (${kmSel().toFixed(2)} km)${vias.length ? ' — ' + vias.join(', ') : ''}`);
    l.push(`Criterio: ${filtro === 'all' ? 'rutas que recorren todos los tramos' : 'rutas que pasan por al menos un tramo'}`);
    l.push(`Rutas: ${resultado.length}`);
    resultado.forEach(r => l.push(`- ${r.nombre}: ${r.sentido.toLowerCase()} · ${r.tramos} de ${seleccion.size} tramos (${Math.round(r.pct * 100)}%) · ${r.km.toFixed(2)} km`));
    return l.join('\n');
  }
  function exportarExcel(){
    prepararDatos();
    if(!seleccion.size){ alert('Selecciona tramos en el módulo Análisis primero.'); return; }
    resultado = calcular();
    const wb = XLSX.utils.book_new();
    const h1 = [['Ruta','Sentido','Tramos en la selección','% de la selección','Tramos ida','Tramos vuelta','Km en la selección']];
    resultado.forEach(r => h1.push([r.nombre, r.sentido, r.tramos, Math.round(r.pct * 1000) / 10, r.ida, r.vuelta, Math.round(r.km * 1000) / 1000]));
    const ws1 = XLSX.utils.aoa_to_sheet(h1); ws1['!cols'] = [{wch:14},{wch:10},{wch:22},{wch:18},{wch:11},{wch:13},{wch:18}];
    XLSX.utils.book_append_sheet(wb, ws1, 'Rutas');
    const h2 = [['N°','Vía','Tipo','Km','N° rutas','Rutas','ID tramo']];
    [...seleccion].forEach((id, i) => {
      const si = UC.red.porId.get(id), arr = segRoutes.get(id) || [];
      const nombres = [...new Set(arr.map(x => rutas[x.ri].nombre))].sort((a, b) => a.localeCompare(b, 'es', { numeric:true }));
      h2.push([i + 1, U.nombreVia(si.props), si.props.highway || si.props.link_type || '', Math.round(si.km * 1000) / 1000, nombres.length, nombres.join(', '), id]);
    });
    const ws2 = XLSX.utils.aoa_to_sheet(h2); ws2['!cols'] = [{wch:5},{wch:28},{wch:12},{wch:8},{wch:9},{wch:50},{wch:40}];
    XLSX.utils.book_append_sheet(wb, ws2, 'Tramos');
    const ws3 = XLSX.utils.aoa_to_sheet(textoResumen().split('\n').map(x => [x])); ws3['!cols'] = [{wch:110}];
    XLSX.utils.book_append_sheet(wb, ws3, 'Resumen');
    XLSX.writeFile(wb, `superposicion-rutas-${U.fecha()}.xlsx`);
  }
  function exportarDensidad(){
    prepararDatos(); if(denDirty) calcularDensidad();
    const features = [];
    denConteo.forEach((n, id) => {
      const si = UC.red.porId.get(id), arr = segRoutes.get(id) || [];
      features.push({ type:'Feature', properties:{ ...si.props, n_rutas:n, rutas:[...new Set(arr.map(x => rutas[x.ri].nombre))].join(', ') }, geometry:{ type:'LineString', coordinates:si.latlngs.map(p => [p[1], p[0]]) } });
    });
    UC.ui.descargarTexto('densidad-rutas.geojson', JSON.stringify({ type:'FeatureCollection', features }), 'application/geo+json');
  }

  UC.modulos.registrar({
    id:'analisis', nombre:'Análisis', icono:'fa-magnifying-glass-chart', titulo:'Superposición y densidad de rutas (AnálisisCore)',
    panel, resultados:res,
    exportar:() => [
      { icono:'fa-file-excel', titulo:'Superposición en Excel', sub:'.xlsx — rutas y tramos seleccionados', accion:exportarExcel },
      { icono:'fa-copy', titulo:'Copiar resumen de superposición', sub:'texto para el informe', accion:() => { prepararDatos(); if(!seleccion.size){ alert('Selecciona tramos en el módulo Análisis primero.'); return; } resultado = calcular(); UC.ui.copiar(textoResumen()); UC.ui.instruccion('Resumen copiado al portapapeles'); } },
      { icono:'fa-fire', titulo:'Densidad GeoJSON', sub:'.geojson — tramos con conteo de rutas', accion:exportarDensidad }
    ],
    activar(){
      activo = true; prepararDatos();
      selLayer.addTo(map); rutasLayer.addTo(map); denLayer.addTo(map);
      setModo(modo);
      if(!UC.rutas.cantidad()) UC.ui.instruccion('No hay rutas en el proyecto: trázalas en el módulo Rutas o abre una sesión de RutaCore');
    },
    desactivar(){
      activo = false;
      map.removeLayer(selLayer); map.removeLayer(rutasLayer); map.removeLayer(denLayer);
      el('map').classList.remove('cursor-area', 'cursor-pick');
    },
    hoverTramos:true,
    alHover(si, ll){ UC.interaccion.resaltar(si, '#007aff', si ? textoTramo(si) : null, ll); },
    alClic(si){ if(modo === 'sup' && herramienta === 'click' && si) toggleSeg(si); },
    cargar(){ seleccion = new Set(); selLayer.clearLayers(); sucio = true; }
  });
})();
