'use strict';
/* ══════════════════════════════════════════════════════════════════
   MÓDULO COBERTURA — superposición de rutas con corredores de proyecto
   y reportes de rutas (antes: modo Proyectos y Reporte de Cobertura rutas).
   Como las rutas ya están sobre la misma red, el cruce es exacto por tramo:
   no hace falta el motor de grafo de la app suelta.
   La densidad de rutas está en el módulo Análisis.
   Guarda en el proyecto: { corredores:[{nombre, ida:[segId], vuelta:[segId]}] }
   ══════════════════════════════════════════════════════════════════ */
(function(){
  const map = UC.mapa.map, el = UC.el, U = UC.util;
  const CORRIDOR_COLORS = ['#1d4ed8','#7c3aed','#0891b2','#059669','#d97706','#dc2626','#db2777'];
  let corredores = [];            // [{nombre, color, ida:Set, vuelta:Set, todos:Set, kmIda, kmVuelta, kmTotal}]
  let verProyecto = true, verSuperposicion = true, activo = false, sinCalzar = 0;

  const corrRenderer = UC.mapa.lienzo('corredorPane'), ovRenderer = UC.mapa.lienzo('overlapPane');
  const corrLayer = L.layerGroup(), ovLayer = L.layerGroup();

  const panel = document.createElement('div');
  panel.innerHTML = `
    <div class="panel-pad">
      <div class="modulo-titulo"><div class="ico"><i class="fa-solid fa-diagram-project"></i></div><span>Cobertura de proyectos</span></div>
      <input type="file" id="cb-file" accept=".geojson,.json" style="display:none">
      <button class="btn primary" id="cb-cargar" style="width:100%;justify-content:center;margin-bottom:8px"><i class="fa-solid fa-folder-open"></i> Cargar proyecto (RutaCore)</button>
      <div class="field">
        <label>…o usar una ruta del proyecto como corredor</label>
        <select id="cb-desde-ruta"><option value="">— Elegir ruta —</option></select>
      </div>
      <div id="cb-info" style="display:none">
        <div class="switch-row"><span>Mostrar corredor</span><label class="switch"><input type="checkbox" id="cb-chk-proy" checked><span class="track"></span></label></div>
        <div class="switch-row"><span>Mostrar superposición</span><label class="switch"><input type="checkbox" id="cb-chk-ov" checked><span class="track"></span></label></div>
        <div class="field" id="cb-sel-wrap" style="display:none;margin-top:8px">
          <label>Corredor</label>
          <select id="cb-sel"><option value="todos">Todos los corredores</option></select>
        </div>
        <button class="btn" id="cb-quitar" style="width:100%;justify-content:center;margin-top:8px"><i class="fa-solid fa-xmark"></i> Quitar corredores</button>
      </div>
      <div class="hint" style="margin-top:10px">El corredor es el proyecto (por ejemplo, un carril exclusivo) trazado en RutaCore y exportado como <b>Rutas GeoJSON</b>. Se calcula qué porcentaje del corredor recorre cada ruta existente.</div>
      <div class="list-actions" style="margin-top:12px">
        <button class="btn" id="cb-rep-rutas"><i class="fa-solid fa-clipboard-list"></i> Reporte de rutas</button>
      </div>
    </div>`;

  const res = document.createElement('div');
  res.innerHTML = `<div class="res-section">
      <h2>Análisis de proyecto</h2>
      <div id="cb-res"><div class="hint">Carga un proyecto o elige una ruta como corredor.</div></div>
      <button class="btn primary" id="cb-rep-proy" style="width:100%;justify-content:center;margin-top:10px;display:none"><i class="fa-solid fa-clipboard-list"></i> Reporte del proyecto</button>
    </div>`;

  /* ── Utilidades de conjuntos de tramos ── */
  const kmDe = set => { let k = 0; set.forEach(id => { const si = UC.red.porId.get(id); if(si) k += si.km; }); return k; };
  const inter = (a, b) => { const o = new Set(); a.forEach(x => { if(b.has(x)) o.add(x); }); return o; };
  function viasDe(set, max){
    const m = new Map();
    set.forEach(id => { const si = UC.red.porId.get(id); if(!si) return; const n = U.nombreVia(si.props); if(n) m.set(n, (m.get(n) || 0) + si.km); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, max);
  }
  function rutasSets(){
    return UC.rutas.lista().map(r => {
      const ida = new Set(r.ida.map(s => s.segId).filter(id => UC.red.porId.has(id)));
      const vuelta = new Set(r.vuelta.map(s => s.segId).filter(id => UC.red.porId.has(id)));
      return { cod:r.nombre, color:r.color, ida, vuelta, todos:new Set([...ida, ...vuelta]) };
    });
  }

  /* ── Líneas del proyecto → tramos de la red ──
     1) exacto por geometría (export de RutaCore sobre la misma red)
     2) si no calza, por punto medio con tolerancia de 20 m y verificación de alineación */
  function tramosDeLineas(lineas){
    const out = new Set();
    lineas.forEach(c => {
      if(!c || c.length < 2) return;
      const ll = c.map(p => [p[1], p[0]]);
      const exacto = UC.red.porId.get(UC.red.segIdFromLatLngs(ll));
      if(exacto){ out.add(exacto.segId); return; }
      sinCalzar++;
      for(let k = 0; k < ll.length - 1; k++){
        const a = ll[k], b = ll[k+1];
        const si = UC.red.cercanoMetros((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 20); if(!si) continue;
        const e1 = si.latlngs[0], e2 = si.latlngs[si.latlngs.length - 1];
        const ex = e2[1] - e1[1], ey = e2[0] - e1[0], sx = b[1] - a[1], sy = b[0] - a[0];
        const eL = Math.hypot(ex, ey) || 1e-9, sL = Math.hypot(sx, sy) || 1e-9;
        if(Math.abs((ex / eL) * (sx / sL) + (ey / eL) * (sy / sL)) > 0.5) out.add(si.segId);
      }
    });
    return out;
  }
  function completar(c, i){
    c.color = CORRIDOR_COLORS[i % CORRIDOR_COLORS.length];
    c.todos = new Set([...c.ida, ...c.vuelta]);
    c.kmIda = kmDe(c.ida); c.kmVuelta = kmDe(c.vuelta); c.kmTotal = kmDe(c.todos);
    return c;
  }

  async function cargarArchivo(file){
    UC.ui.loader('Leyendo proyecto…'); await UC.ui.esperarFrame();
    try{
      const gj = await UC.red.leerArchivoGeo(file);
      const feats = (gj.features || []).filter(f => f.geometry && (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString'));
      if(!feats.length) throw new Error('No se encontraron líneas en el archivo.');
      const s0 = feats[0].properties || {};
      if(!('ruta_id' in s0) || !('sentido' in s0)) throw new Error('El proyecto debe ser un export de rutas de RutaCore (con campos ruta_id y sentido).');
      const grupos = new Map();
      feats.forEach(f => {
        const p = f.properties || {}, key = p.ruta_id || p.nombre_ruta || '?';
        if(!grupos.has(key)) grupos.set(key, { nombre:p.nombre_ruta || key, ida:[], vuelta:[] });
        const cs = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
        grupos.get(key)[p.sentido === 'ida' ? 'ida' : 'vuelta'].push(...cs);
      });
      sinCalzar = 0;
      corredores = [...grupos.values()].map((g, i) => completar({ nombre:g.nombre, ida:tramosDeLineas(g.ida), vuelta:tramosDeLineas(g.vuelta) }, i));
      if(sinCalzar) UC.ui.instruccion(`${sinCalzar} líneas del proyecto no calzaron exacto con la red y se ubicaron por cercanía (20 m)`);
      despuesDeCargar();
    }catch(err){ alert('Error: ' + err.message); }
    UC.ui.ocultarLoader();
  }
  panel.querySelector('#cb-cargar').addEventListener('click', () => el('cb-file').click());
  panel.querySelector('#cb-file').addEventListener('change', e => { const f = e.target.files[0]; if(f) cargarArchivo(f); e.target.value = ''; });
  panel.querySelector('#cb-desde-ruta').addEventListener('change', e => {
    const r = UC.rutas.lista().find(x => x.id === e.target.value); if(!r) return;
    corredores.push(completar({ nombre:r.nombre, ida:new Set(r.ida.map(s => s.segId).filter(id => UC.red.porId.has(id))), vuelta:new Set(r.vuelta.map(s => s.segId).filter(id => UC.red.porId.has(id))) }, corredores.length));
    e.target.value = '';
    despuesDeCargar();
  });
  panel.querySelector('#cb-quitar').addEventListener('click', () => { corredores = []; despuesDeCargar(); });
  panel.querySelector('#cb-chk-proy').addEventListener('change', e => { verProyecto = e.target.checked; dibujar(); });
  panel.querySelector('#cb-chk-ov').addEventListener('change', e => { verSuperposicion = e.target.checked; dibujar(); });
  panel.querySelector('#cb-sel').addEventListener('change', () => { renderResultados(); dibujar(); });

  function despuesDeCargar(){
    const sel = el('cb-sel'); sel.innerHTML = '<option value="todos">Todos los corredores</option>';
    corredores.forEach((c, i) => { const o = document.createElement('option'); o.value = i; o.textContent = c.nombre; sel.appendChild(o); });
    el('cb-sel-wrap').style.display = corredores.length > 1 ? '' : 'none';
    el('cb-info').style.display = corredores.length ? '' : 'none';
    el('cb-rep-proy').style.display = corredores.length ? '' : 'none';
    renderResultados(); dibujar();
  }

  /* ── Cálculos (misma lógica que Cobertura rutas) ──
     % total  = superposición / km del corredor · ida y vuelta de cada ruta contra el corredor completo */
  function corredorActivo(){
    if(!corredores.length) return null;
    const v = el('cb-sel').value;
    if(v === 'todos'){
      const ida = new Set(corredores.flatMap(c => [...c.ida])), vuelta = new Set(corredores.flatMap(c => [...c.vuelta]));
      return completar({ nombre:corredores.length === 1 ? corredores[0].nombre : `${corredores.length} corredores`, ida, vuelta }, 0);
    }
    return corredores[+v];
  }
  function itemsDe(c){
    return rutasSets().map(r => {
      const ov = inter(r.todos, c.todos), kmOv = kmDe(ov), pct = c.kmTotal > 0 ? kmOv / c.kmTotal * 100 : 0;
      const oI = inter(r.ida, c.todos), oV = inter(r.vuelta, c.todos);
      return { cod:r.cod, color:r.color, pct, kmOverlap:kmOv, overlap:ov,
        idaDetail:{ km:kmDe(oI), pct:c.kmTotal > 0 ? kmDe(oI) / c.kmTotal * 100 : 0 },
        vueltaDetail:{ km:kmDe(oV), pct:c.kmTotal > 0 ? kmDe(oV) / c.kmTotal * 100 : 0 },
        vias:viasDe(ov, 8).map(v => v[0]) };
    }).sort((a, b) => b.pct - a.pct);
  }
  function totalDe(items, c){
    const u = new Set(); items.forEach(it => it.overlap.forEach(id => u.add(id)));
    const km = kmDe(inter(u, c.todos));
    return { km, pct:c.kmTotal > 0 ? km / c.kmTotal * 100 : 0 };
  }
  const colorPct = p => p >= 70 ? '#16a34a' : p >= 30 ? '#d97706' : '#dc2626';
  const esc = U.escapeHtml;

  function bloqueCorredor(c, items, dot){
    const con = items.filter(it => it.pct > 0), tot = totalDe(con, c);
    const rutasHtml = con.map(it => `<div class="proy-ruta" style="border-left-color:${colorPct(it.pct)};margin-left:8px">
        <div class="proy-ruta-nombre"><span style="width:8px;height:8px;border-radius:50%;background:${it.color};display:inline-block"></span><span>${esc(it.cod)}</span></div>
        <div class="proy-bar"><div class="proy-bar-fill" style="width:${Math.min(it.pct, 100)}%;background:${colorPct(it.pct)}"></div></div>
        <div class="proy-pct">${it.pct.toFixed(1)}% del corredor <span class="proy-km">(${it.kmOverlap.toFixed(2)} km)</span></div>
        <div class="proy-sentidos">↗ Ida: <b>${it.idaDetail.pct.toFixed(1)}%</b> (${it.idaDetail.km.toFixed(2)} km) &nbsp;·&nbsp; ↙ Vuelta: <b>${it.vueltaDetail.pct.toFixed(1)}%</b> (${it.vueltaDetail.km.toFixed(2)} km)</div>
        ${it.vias.length ? `<div class="proy-vias"><i class="fa-solid fa-location-dot"></i>${it.vias.map(esc).join(' · ')}</div>` : ''}
      </div>`).join('');
    return `<div style="margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:7px;margin-bottom:3px"><span style="width:12px;height:12px;border-radius:50%;background:${dot};display:inline-block"></span><span style="font-size:13px;font-weight:700">${esc(c.nombre)}</span></div>
      <div style="font-size:12px;color:var(--text-2);margin-bottom:2px;padding-left:19px">${c.kmTotal.toFixed(2)} km total${c.kmIda > 0 ? ` &nbsp;·&nbsp; ↗ Ida: ${c.kmIda.toFixed(2)} km &nbsp;·&nbsp; ↙ Vuelta: ${c.kmVuelta.toFixed(2)} km` : ''}</div>
      ${con.length ? rutasHtml : '<div style="font-size:12px;color:var(--text-2);padding:6px 0 4px">Ninguna ruta se superpone con este corredor.</div>'}
      ${con.length ? `<div style="font-size:11.5px;font-weight:600;color:${colorPct(tot.pct)};padding:4px 8px;background:rgba(255,255,255,.5);border-radius:6px;margin-top:4px">Cobertura total del corredor: ${tot.pct.toFixed(1)}% (${tot.km.toFixed(2)} km sin duplicar)</div>` : ''}
    </div>`;
  }
  function renderResultados(){
    const box = el('cb-res');
    if(!corredores.length){ box.innerHTML = '<div class="hint">Carga un proyecto o elige una ruta como corredor.</div>'; return; }
    if(!UC.rutas.cantidad()){ box.innerHTML = '<div class="hint">No hay rutas en el proyecto para comparar con el corredor.</div>'; return; }
    const v = el('cb-sel').value;
    box.innerHTML = (v === 'todos' ? corredores.map((c, i) => bloqueCorredor(c, itemsDe(c), c.color)) : [bloqueCorredor(corredores[+v], itemsDe(corredores[+v]), corredores[+v].color)]).join('');
    UC.ui.instruccion('Cobertura: porcentaje del corredor que recorre cada ruta existente');
  }

  /* ── Capas ── */
  function dibujar(){
    corrLayer.clearLayers(); ovLayer.clearLayers();
    if(!activo || !corredores.length) return;
    const v = el('cb-sel').value, lista = v === 'todos' ? corredores : [corredores[+v]];
    if(verProyecto) lista.forEach(c => c.todos.forEach(id => { const si = UC.red.porId.get(id); if(si) L.polyline(si.latlngs, { renderer:corrRenderer, interactive:false, color:c.color, weight:9, opacity:0.45 }).addTo(corrLayer); }));
    if(verSuperposicion && UC.rutas.cantidad()){
      const c = corredorActivo(), u = new Set();
      rutasSets().forEach(r => inter(r.todos, c.todos).forEach(id => u.add(id)));
      u.forEach(id => { const si = UC.red.porId.get(id); if(si) L.polyline(si.latlngs, { renderer:ovRenderer, interactive:false, color:'#f97316', weight:5, opacity:0.85 }).addTo(ovLayer); });
    }
  }

  /* ── Reportes (mismos textos que Cobertura rutas) ── */
  function reporteProyecto(){
    const c = corredorActivo(); if(!c) return;
    const v = el('cb-sel').value, lista = v === 'todos' ? corredores : [corredores[+v]];
    let html = `<div style="margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid rgba(0,0,0,.08)">
      <div style="font-size:13.5px;font-weight:700;margin-bottom:4px"><i class="fa-solid fa-diagram-project rep-ico"></i>${esc(c.nombre)}</div>
      <div style="font-size:12px;color:var(--text-2)">Longitud del corredor: <b>${c.kmTotal.toFixed(2)} km</b></div>
      <div style="font-size:12px;color:var(--text-2)">↗ Ida: ${c.kmIda.toFixed(2)} km &nbsp;·&nbsp; ↙ Vuelta: ${c.kmVuelta.toFixed(2)} km</div></div>`;
    let txt = `=== ${c.nombre} ===\nCorredor total: ${c.kmTotal.toFixed(2)} km\n  Ida: ${c.kmIda.toFixed(2)} km  |  Vuelta: ${c.kmVuelta.toFixed(2)} km\n\n--- Superposición por ruta ---\n`;
    lista.forEach(k => {
      const items = itemsDe(k).filter(it => it.pct > 0), tot = totalDe(items, k);
      html += `<div style="margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid rgba(0,0,0,.08)">
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:3px"><span style="width:11px;height:11px;border-radius:50%;background:${k.color};display:inline-block"></span><span style="font-size:13.5px;font-weight:700">${esc(k.nombre)}</span></div>
        <div style="font-size:12px;color:var(--text-2);margin-bottom:6px;padding-left:18px">${k.kmTotal.toFixed(2)} km total${k.kmIda > 0 ? ` · ↗ ${k.kmIda.toFixed(2)} km · ↙ ${k.kmVuelta.toFixed(2)} km` : ''}</div>`;
      txt += `\n=== ${k.nombre} (${k.kmTotal.toFixed(2)} km) ===\n` + (k.kmIda > 0 ? `  ↗ Ida: ${k.kmIda.toFixed(2)} km  |  ↙ Vuelta: ${k.kmVuelta.toFixed(2)} km\n` : '');
      items.forEach(it => {
        html += `<div style="margin-bottom:8px;padding:7px 10px;background:rgba(255,255,255,.5);border-radius:8px;border-left:3px solid ${colorPct(it.pct)};margin-left:8px">
          <div style="font-size:12.5px;font-weight:700">${esc(it.cod)}</div>
          <div style="font-size:12px;color:var(--brand);font-weight:600">${it.pct.toFixed(1)}% · ${it.kmOverlap.toFixed(2)} km</div>
          <div style="font-size:11.5px;margin-top:3px">↗ Ida: <b>${it.idaDetail.pct.toFixed(1)}%</b> (${it.idaDetail.km.toFixed(2)} km) · ↙ Vuelta: <b>${it.vueltaDetail.pct.toFixed(1)}%</b> (${it.vueltaDetail.km.toFixed(2)} km)</div>
          ${it.vias.length ? `<div style="font-size:11.5px;color:var(--text-2);margin-top:3px"><i class="fa-solid fa-location-dot rep-ico"></i>${it.vias.map(esc).join(' · ')}</div>` : ''}</div>`;
        txt += `  ${it.cod}: ${it.pct.toFixed(1)}% (${it.kmOverlap.toFixed(2)} km)\n    ↗ Ida: ${it.idaDetail.pct.toFixed(1)}% (${it.idaDetail.km.toFixed(2)} km)\n    ↙ Vuelta: ${it.vueltaDetail.pct.toFixed(1)}% (${it.vueltaDetail.km.toFixed(2)} km)\n` + (it.vias.length ? `    Vías: ${it.vias.join(', ')}\n` : '');
      });
      if(!items.length){ html += '<div style="font-size:12px;color:var(--text-2);padding:4px 8px">Sin superposición.</div>'; txt += '  (sin superposición)\n'; }
      html += `<div style="font-size:11.5px;font-weight:600;color:#d97706;margin-top:6px;padding-left:8px">Cobertura total: ${tot.pct.toFixed(1)}% · ${tot.km.toFixed(2)} km sin duplicar</div></div>`;
      txt += `  COBERTURA TOTAL: ${tot.pct.toFixed(1)}% (${tot.km.toFixed(2)} km sin duplicar)\n`;
    });
    UC.ui.reporte('Reporte — ' + c.nombre, html, [{ texto:'Copiar texto', icono:'fa-copy', primario:true, accion:b => UC.ui.copiar(txt, b) }]);
  }
  function resumenRuta(set){
    const vias = viasDe(set, 15), kmNom = viasDe(set, 1e9).reduce((a, v) => a + v[1], 0);
    return { km:kmDe(set), kmNombrado:kmNom, vias:vias.map(([name, km]) => ({ name, km })) };
  }
  function reporteRutas(){
    const rs = rutasSets();
    if(!rs.length){ alert('No hay rutas en el proyecto.'); return; }
    let txt = '';
    const html = rs.map(r => {
      const ida = resumenRuta(r.ida), vta = resumenRuta(r.vuelta);
      const bloque = (t, s) => `<div class="rr-sentido">${t}</div><div class="rr-km">Longitud: ${s.km.toFixed(2)} km <span style="font-weight:400;color:var(--text-2);font-size:11px">(${s.kmNombrado.toFixed(2)} km con nombre de vía)</span></div>
        <ul class="rr-vias">${s.vias.map(v => `<li>${esc(v.name)} <span style="color:var(--text-2)">(${v.km.toFixed(2)} km)</span></li>`).join('')}</ul>`;
      txt += `\n=== ${r.cod} ===\nIDA — ${ida.km.toFixed(2)} km\n${ida.vias.map(v => `  · ${v.name} (${v.km.toFixed(2)} km)`).join('\n')}\nVUELTA — ${vta.km.toFixed(2)} km\n${vta.vias.map(v => `  · ${v.name} (${v.km.toFixed(2)} km)`).join('\n')}\n`;
      return `<div class="rr-ruta"><div class="rr-nombre"><span class="rr-dot" style="background:${r.color}"></span>${esc(r.cod)}</div>${bloque('↗ Ida', ida)}<div style="margin-top:10px"></div>${bloque('↙ Vuelta', vta)}</div>`;
    }).join('');
    UC.ui.reporte('Reporte de rutas — con sentido', html, [
      { texto:'Copiar texto', icono:'fa-copy', primario:true, accion:b => UC.ui.copiar(txt, b) },
      { texto:'Exportar Excel', icono:'fa-file-excel', accion:excelRutas }
    ]);
  }
  function excelRutas(){
    const rs = rutasSets(), wb = XLSX.utils.book_new();
    const res = [['Ruta','Sentido','Longitud total (km)','Km con nombre de vía','Nº vías identificadas']], det = [['Ruta','Sentido','Nombre de vía','Longitud en ruta (km)']];
    rs.forEach(r => [['Ida', r.ida], ['Vuelta', r.vuelta]].forEach(([s, set]) => {
      const x = resumenRuta(set);
      res.push([r.cod, s, +x.km.toFixed(2), +x.kmNombrado.toFixed(2), x.vias.length]);
      x.vias.forEach(v => det.push([r.cod, s, v.name, +v.km.toFixed(2)]));
    }));
    const w1 = XLSX.utils.aoa_to_sheet(res); w1['!cols'] = [{wch:20},{wch:10},{wch:22},{wch:24},{wch:22}]; XLSX.utils.book_append_sheet(wb, w1, 'Resumen');
    const w2 = XLSX.utils.aoa_to_sheet(det); w2['!cols'] = [{wch:20},{wch:10},{wch:40},{wch:22}]; XLSX.utils.book_append_sheet(wb, w2, 'Detalle vías');
    XLSX.writeFile(wb, `reporte-rutas-${U.fecha()}.xlsx`);
  }
  panel.querySelector('#cb-rep-rutas').addEventListener('click', reporteRutas);
  res.querySelector('#cb-rep-proy').addEventListener('click', reporteProyecto);

  function llenarSelectorRutas(){
    const s = el('cb-desde-ruta'); if(!s) return;
    s.innerHTML = '<option value="">— Elegir ruta —</option>';
    UC.rutas.lista().forEach(r => { const o = document.createElement('option'); o.value = r.id; o.textContent = r.nombre; s.appendChild(o); });
  }
  UC.eventos.on('rutas:cambiadas', () => { llenarSelectorRutas(); if(activo){ renderResultados(); dibujar(); } });
  UC.eventos.on('red:cambiada', ({ eliminados }) => {
    corredores.forEach((c, i) => { eliminados.forEach(id => { c.ida.delete(id); c.vuelta.delete(id); }); completar(c, i); });
    if(activo){ renderResultados(); dibujar(); }
  });

  UC.modulos.registrar({
    id:'cobertura', nombre:'Cobertura', icono:'fa-diagram-project', titulo:'Superposición de rutas con corredores de proyecto y reportes (Cobertura rutas)',
    panel, resultados:res,
    exportar:() => [
      { icono:'fa-clipboard-list', titulo:'Reporte de rutas (Excel)', sub:'.xlsx — longitud y vías por ruta y sentido', accion:() => { if(!UC.rutas.cantidad()){ alert('No hay rutas en el proyecto.'); return; } excelRutas(); } },
      { icono:'fa-floppy-disk', titulo:'Escenario PlanCore', sub:'.json — para Análisis Global', accion:() => {
        const rs = rutasSets(), cnt = new Map(); rs.forEach(r => r.todos.forEach(id => cnt.set(id, (cnt.get(id) || 0) + 1)));
        UC.ui.descargarTexto('plancore-escenario-transporte.json', JSON.stringify({ tipo:'plancore-cobertura-transporte', version:1, exportadoEn:new Date().toISOString(),
          rutas:rs.map(r => ({ cod:r.cod, n_edges:r.todos.size })), densidad:{ n_tramos_con_rutas:cnt.size, max_rutas_en_tramo:cnt.size ? Math.max(...cnt.values()) : 0 } }, null, 2));
      } }
    ],
    activar(){ activo = true; corrLayer.addTo(map); ovLayer.addTo(map); llenarSelectorRutas(); renderResultados(); dibujar(); },
    desactivar(){ activo = false; map.removeLayer(corrLayer); map.removeLayer(ovLayer); },
    serializar:() => corredores.length ? { corredores:corredores.map(c => ({ nombre:c.nombre, atributos:c.atributos, ida:[...c.ida], vuelta:[...c.vuelta] })) } : null,
    cargar(d){
      corredores = (d && Array.isArray(d.corredores) ? d.corredores : []).map((c, i) => completar({ nombre:c.nombre, atributos:c.atributos,
        ida:new Set((c.ida || []).filter(id => UC.red.porId.has(id))), vuelta:new Set((c.vuelta || []).filter(id => UC.red.porId.has(id))) }, i));
      despuesDeCargar();
    },
    usosDeTramo(id){ return corredores.filter(c => c.todos.has(id)).map(c => `Corredor ${c.nombre}`); }
  });

  // API para Atributos: lista de corredores y refresco tras cambiar un nombre (sin perder el corredor elegido)
  UC.cobertura = {
    lista:() => corredores,
    refrescar(){
      const sel = el('cb-sel');
      corredores.forEach((c, i) => { const o = sel.querySelector(`option[value="${i}"]`); if(o) o.textContent = c.nombre; });
      if(activo) renderResultados();
    }
  };
})();
