'use strict';
/* ══════════════════════════════════════════════════════════════════
   MÓDULO RED — edición de la red vial (antes: "Editar red" de RutaCore)
   Borrar tramos y dibujar tramos nuevos con enganche a nodos existentes.
   Cualquier cambio avisa a todos los módulos ('red:cambiada'): las rutas y la
   jerarquía se ajustan solas. La red se guarda en el proyecto desde el núcleo.
   ══════════════════════════════════════════════════════════════════ */
(function(){
  const map = UC.mapa.map, el = UC.el, U = UC.util;
  const SNAP_PX = 18;
  let herramienta = null;   // 'delete' | 'draw' | null
  let chain = [], chainLines = [], chainMarkers = [], pendientes = [], snapMarker = null;
  const editRenderer = UC.mapa.lienzo('editPane');

  const panel = document.createElement('div');
  panel.innerHTML = `
    <div class="panel-pad">
      <div class="modulo-titulo"><div class="ico"><i class="fa-solid fa-road"></i></div><span>Red vial</span></div>
      <div class="tool-row">
        <button class="btn" id="rd-delete" title="Eliminar un tramo existente de la red"><i class="fa-solid fa-scissors"></i> Borrar tramo</button>
        <button class="btn" id="rd-draw" title="Dibujar tramo nuevo (clic, clic… Esc o doble clic para terminar)"><i class="fa-solid fa-plus"></i> Dibujar tramo</button>
      </div>
      <button class="btn" id="rd-save" disabled style="width:100%;justify-content:center;margin-bottom:12px" title="Guardar el tramo dibujado y seguir dibujando"><i class="fa-solid fa-floppy-disk"></i> Guardar tramo</button>
      <div class="summary-row"><span>Tramos</span><span class="v" id="rd-tramos">—</span></div>
      <div class="summary-row"><span>Longitud total</span><span class="v" id="rd-km">—</span></div>
      <div class="summary-row"><span>Tramos dibujados a mano</span><span class="v" id="rd-manual">—</span></div>
      <div class="hint" id="rd-prep" style="margin-top:8px"></div>
      <div class="hint" style="margin-top:10px">
        <b>Borrar tramo</b>: clic sobre un tramo; si lo usa alguna ruta te avisa y se quita también de la ruta.<br>
        <b>Dibujar tramo</b>: clic para cada punto (engancha a los nodos existentes) · doble clic, Esc o <b>Guardar tramo</b> para terminar.
      </div>
    </div>`;

  function actualizarPanel(){
    el('rd-tramos').textContent = U.fmtNum(UC.red.segs.length);
    el('rd-km').textContent = U.fmtKm(UC.red.segs.reduce((a, s) => a + s.km, 0));
    el('rd-manual').textContent = U.fmtNum(UC.red.segs.filter(s => !Object.keys(s.props).length).length);
    const st = UC.red.stats;
    el('rd-prep').textContent = st ? `Al cargar: ${U.fmtNum(st.lineasOriginales)} líneas → ${U.fmtNum(st.tramos)} tramos` +
      (st.esquinas ? ` · ${U.fmtNum(st.esquinas)} esquinas cortadas` : '') + (st.quitados ? ` · ${U.fmtNum(st.quitados)} elementos que no son vías quitados` : '') : '';
  }

  /* ── Borrar tramo ── */
  function borrar(si){
    const usos = UC.modulos.usosDeTramo(si.segId);
    const msg = usos.length
      ? `Este tramo se usa en: ${usos.join(', ')}.\n\nSe eliminará de la red y también de esos lugares. ¿Confirmas?`
      : '¿Confirmas eliminar este tramo de la red?';
    if(!confirm(msg)) return;
    UC.interaccion.limpiar();
    UC.ui.loader('Eliminando tramo…');
    setTimeout(() => {
      UC.red.eliminar([si.segId]);
      actualizarPanel(); UC.ui.ocultarLoader();
      UC.ui.instruccion(usos.length ? `Tramo eliminado — actualizado en: ${usos.join(', ')}.` : 'Tramo eliminado de la red.');
    }, 30);
  }

  /* ── Dibujar tramo (encadenado, con enganche a nodos) ── */
  function snapEn(latlng){
    const mp = map.latLngToContainerPoint(latlng);
    let best = UC.red.nodoCercano(mp, SNAP_PX);
    let minD = best ? mp.distanceTo(map.latLngToContainerPoint(best)) : SNAP_PX;
    chain.forEach(p => { const d = mp.distanceTo(map.latLngToContainerPoint(p)); if(d < minD){ minD = d; best = [p.lat, p.lng]; } });
    return best;
  }
  function marcarSnap(n){
    if(snapMarker){ map.removeLayer(snapMarker); snapMarker = null; }
    if(n) snapMarker = L.circleMarker(n, { radius:9, color:'#16a34a', weight:3, fillColor:'#fff', fillOpacity:0.95, interactive:false, pane:'editPane' }).addTo(map);
  }
  function agregarPunto(ll){
    const p = L.latLng(ll[0], ll[1]);
    if(chain.length){
      const prev = chain[chain.length - 1];
      chainLines.push(L.polyline([prev, p], { renderer:editRenderer, color:'#16a34a', weight:3, dashArray:'5 4', interactive:false }).addTo(map));
      pendientes.push({ type:'Feature', properties:{}, geometry:{ type:'LineString', coordinates:[[prev.lng, prev.lat], [p.lng, p.lat]] } });
    }
    chainMarkers.push(L.circleMarker(p, { radius:4, color:'#16a34a', fillColor:'#fff', fillOpacity:1, weight:2, interactive:false, pane:'editPane' }).addTo(map));
    chain.push(p);
  }
  function limpiarCadena(){
    chainLines.forEach(l => map.removeLayer(l)); chainLines = [];
    chainMarkers.forEach(m => map.removeLayer(m)); chainMarkers = [];
  }
  function terminarCadena(){
    const nuevas = pendientes; pendientes = [];
    limpiarCadena(); chain = []; marcarSnap(null);
    if(!nuevas.length){ if(herramienta === 'draw') UC.ui.instruccion('Clic para agregar puntos · doble clic, Esc o Guardar tramo para terminar.'); return; }
    UC.ui.loader('Guardando tramo…');
    setTimeout(() => {
      UC.red.agregar(nuevas);
      actualizarPanel(); UC.ui.ocultarLoader();
      if(herramienta === 'draw') UC.ui.instruccion(`Tramo agregado (${nuevas.length} seg.). Clic para uno nuevo.`);
    }, 30);
  }
  map.on('dblclick', () => { if(UC.modulos.activo() && UC.modulos.activo().id === 'red' && herramienta === 'draw') terminarCadena(); });
  document.addEventListener('keydown', e => { if(e.key === 'Escape' && herramienta === 'draw' && UC.modulos.activo() && UC.modulos.activo().id === 'red') terminarCadena(); });

  function setHerramienta(h){
    if(herramienta === 'draw' && h !== 'draw') terminarCadena();
    herramienta = h;
    el('rd-delete').classList.toggle('mode-active', h === 'delete');
    el('rd-draw').classList.toggle('mode-active', h === 'draw');
    el('rd-save').disabled = h !== 'draw';
    el('map').classList.toggle('cursor-delete', h === 'delete');
    el('map').classList.toggle('cursor-draw', h === 'draw');
    if(h === 'draw') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
    UC.interaccion.limpiar();
    UC.ui.instruccion(h === 'delete' ? 'Clic sobre un tramo de la red para eliminarlo.'
      : h === 'draw' ? 'Clic para agregar puntos (engancha a nodos existentes) · usa Guardar tramo para confirmar sin salir.'
      : 'Elige Borrar tramo o Dibujar tramo.');
  }
  panel.querySelector('#rd-delete').addEventListener('click', () => setHerramienta(herramienta === 'delete' ? null : 'delete'));
  panel.querySelector('#rd-draw').addEventListener('click', () => setHerramienta(herramienta === 'draw' ? null : 'draw'));
  panel.querySelector('#rd-save').addEventListener('click', () => { if(herramienta === 'draw') terminarCadena(); });

  UC.eventos.on('red:cargada', () => el('rd-tramos') && actualizarPanel());
  UC.eventos.on('red:cambiada', () => el('rd-tramos') && actualizarPanel());

  UC.modulos.registrar({
    id:'red', nombre:'Red', icono:'fa-road', titulo:'Editar la red vial: borrar o dibujar tramos',
    panel, resultados:null,
    exportar:() => [{ icono:'fa-road', titulo:'Red vial GeoJSON', sub:'.geojson — red completa con tus ediciones (QGIS)', accion:() => {
      // Los tramos dibujados a mano no traen atributos: se marcan para identificarlos en QGIS
      // Cada tramo sale también con su clasificación vial (atributo "jerarquia")
      const features = UC.red.features.map((f, fi) => {
        const si = UC.red.porFi.get(fi);
        const props = f.properties && Object.keys(f.properties).length ? { ...f.properties } : { origen:'dibujado_rutacore' };
        if(si && UC.jerarquia) props.jerarquia = UC.jerarquia.tipo(si.segId);
        return { type:'Feature', properties:props, geometry:f.geometry };
      });
      UC.ui.descargarTexto('urbancore-red-vial.geojson', JSON.stringify({ type:'FeatureCollection', features }));
    } }],
    activar(){ actualizarPanel(); setHerramienta(herramienta); },
    desactivar(){ setHerramienta(null); },
    hoverTramos:() => herramienta === 'delete',
    colorHover:() => '#e2483d',
    alClic(si){ if(herramienta === 'delete' && si) borrar(si); },
    alClicMapa(e){ if(herramienta !== 'draw') return false; const s = snapEn(e.latlng); agregarPunto(s || [e.latlng.lat, e.latlng.lng]); marcarSnap(null); return true; },
    alMoverMapa(e){ if(herramienta === 'draw') marcarSnap(snapEn(e.latlng)); },
    cargar(){ if(herramienta) setHerramienta(null); }
  });
})();
