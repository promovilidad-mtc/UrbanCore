'use strict';
/* ══════════════════════════════════════════════════════════════════
   NÚCLEO — DESCARGAR RED VIAL DE OPENSTREETMAP
   Para que un gobierno local empiece sin QGIS ni archivos:
   1) busca su ciudad (Nominatim, solo Perú) o mueve el mapa a la zona;
   2) se descargan las vías de la zona visible (Overpass API);
   3) la red se entrega a UC.proyecto.cargarRed() como si fuera un archivo
      GeoJSON elegido por el usuario → mismo filtro OSM, mismo corte en
      esquinas, misma confirmación al reemplazar. No cambia nada del resto.
   4) "Guardar red (.geojson)" deja el archivo para reimportarlo sin internet.
   Requiere internet solo para buscar y descargar.
   Datos © colaboradores de OpenStreetMap, licencia ODbL.
   ══════════════════════════════════════════════════════════════════ */
(function(){
  const el = UC.el, U = UC.util, map = UC.mapa.map;

  // Mismos tipos que excluye la preparación de red (nucleo/red.js → HIGHWAY_EXCLUIDOS),
  // así lo descargado es igual a una exportación de OSM cargada a mano.
  const EXCLUIDOS = 'footway|pedestrian|steps|service|path|cycleway|bridleway|corridor|elevator|platform|construction|proposed|abandoned|razed|disused|raceway|bus_stop';
  const SERVIDORES = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ];
  const KM2_AVISO = 500, KM2_MAX = 1500;     // zona grande: avisar / no permitir
  const ESPERA_MS = 180000;                  // máximo por servidor

  let lugar = '';            // nombre corto del último lugar buscado (para el nombre del archivo)
  let ultimaRed = null;      // FeatureCollection descargada (para "Guardar red")
  let descargando = false;

  /* ── Panel ── */
  const panel = document.createElement('div');
  panel.id = 'osm-panel';
  panel.innerHTML = `
    <div class="osm-cab">
      <i class="fa-solid fa-cloud-arrow-down"></i>
      <b>Descargar red vial de OpenStreetMap</b>
      <button class="osm-x" id="osm-cerrar" title="Cerrar"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="osm-paso"><span class="osm-n">1</span>Busca tu ciudad o mueve el mapa hasta la zona que necesitas.</div>
    <form class="osm-buscar" id="osm-form">
      <input type="text" id="osm-q" placeholder="Ciudad, distrito o lugar (ej. Huánuco)" autocomplete="off">
      <button class="btn" type="submit" title="Buscar"><i class="fa-solid fa-magnifying-glass"></i></button>
    </form>
    <div class="osm-resultados" id="osm-resultados"></div>
    <div class="osm-paso"><span class="osm-n">2</span>Se descargan las vías de la zona que ves en el mapa.</div>
    <div class="osm-zona" id="osm-zona"></div>
    <button class="btn primary osm-ir" id="osm-descargar"><i class="fa-solid fa-download"></i> Descargar red de esta zona</button>
    <div class="osm-ok" id="osm-ok" hidden>
      <div id="osm-ok-txt"></div>
      <button class="btn" id="osm-guardar"><i class="fa-solid fa-floppy-disk"></i> Guardar red (.geojson)</button>
      <span>Guárdala para volver a cargarla sin internet con el botón <b>Red vial</b>. También queda dentro del proyecto al guardarlo.</span>
    </div>
    <div class="osm-pie">Requiere internet. Una ciudad tarda entre 30 s y 2 min.<br>Datos © colaboradores de OpenStreetMap (ODbL).</div>`;
  document.body.appendChild(panel);

  const bienvenida = () => document.getElementById('bienvenida');
  function abrir(){
    panel.classList.add('show');
    const bv = bienvenida(); if(bv) bv.classList.add('oculta');   // libera el mapa para moverlo
    el('osm-ok').hidden = true;
    actualizarZona();
    setTimeout(() => el('osm-q').focus(), 50);
  }
  function cerrar(){
    if(descargando) return;
    panel.classList.remove('show');
    const bv = bienvenida(); if(bv && !UC.red.cargada()) bv.classList.remove('oculta');   // sin red: vuelve la portada
  }
  UC.osm = { abrir, cerrar };

  el('osm-cerrar').addEventListener('click', cerrar);
  document.addEventListener('keydown', e => { if(e.key === 'Escape' && panel.classList.contains('show')) cerrar(); });

  /* ── Tamaño de la zona visible ── */
  function zonaActual(){
    const b = map.getBounds();
    const s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
    const latM = (s + n) / 2 * Math.PI / 180;
    const anchoKm = Math.abs(e - w) * 111.32 * Math.cos(latM);
    const altoKm = Math.abs(n - s) * 110.57;
    return { s, w, n, e, anchoKm, altoKm, km2: anchoKm * altoKm };
  }
  const fmt1 = x => x.toLocaleString('es-PE', { maximumFractionDigits:1 });
  function actualizarZona(){
    if(!panel.classList.contains('show')) return;
    const z = zonaActual(), caja = el('osm-zona'), btn = el('osm-descargar');
    let estado = 'ok', txt = `Zona visible: ${fmt1(z.anchoKm)} × ${fmt1(z.altoKm)} km (≈ ${U.fmtNum(Math.round(z.km2))} km²)`;
    if(z.km2 > KM2_MAX){ estado = 'mal'; txt += ' — demasiado grande: acerca el mapa a la ciudad.'; }
    else if(z.km2 > KM2_AVISO){ estado = 'aviso'; txt += ' — zona grande: puede tardar varios minutos.'; }
    caja.textContent = txt; caja.dataset.estado = estado;
    btn.disabled = descargando || estado === 'mal';
  }
  map.on('moveend', actualizarZona);

  /* ── Buscar lugar (Nominatim, solo Perú; una consulta por clic, sin autocompletar) ── */
  el('osm-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const q = el('osm-q').value.trim(), cont = el('osm-resultados');
    if(!q) return;
    cont.innerHTML = '<div class="osm-msg">Buscando…</div>';
    try{
      const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=pe&accept-language=es&limit=6&q=' + encodeURIComponent(q);
      const r = await fetch(url, { headers:{ 'Accept':'application/json' } });
      if(!r.ok) throw new Error('HTTP ' + r.status);
      const lista = await r.json();
      cont.innerHTML = '';
      if(!lista.length){ cont.innerHTML = '<div class="osm-msg">No se encontró. Prueba con otro nombre o mueve el mapa a mano.</div>'; return; }
      // Ciudades y distritos primero: "Huánuco" devuelve región, provincia y ciudad con el mismo nombre
      lista.sort((x, y) => prioridad(x) - prioridad(y));
      lista.forEach(it => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'osm-res';
        const partes = String(it.display_name).split(',').map(t => t.trim());
        const t1 = document.createElement('b'); t1.textContent = partes[0];
        const tipo = document.createElement('em'); tipo.textContent = tipoLugar(it); t1.appendChild(tipo);
        const t2 = document.createElement('span'); t2.textContent = partes.slice(1, 4).join(', ');
        b.append(t1, t2);
        b.addEventListener('click', () => irA(it, partes[0]));
        cont.appendChild(b);
      });
    }catch(err){
      console.error(err);
      cont.innerHTML = '<div class="osm-msg">No se pudo buscar (¿hay internet?). Puedes mover el mapa a mano.</div>';
    }
  });

  const TIPOS = { city:'Ciudad', town:'Ciudad', village:'Pueblo', hamlet:'Caserío', municipality:'Distrito',
    suburb:'Sector', quarter:'Sector', neighbourhood:'Sector', province:'Provincia', county:'Provincia',
    state:'Región', region:'Provincia', road:'Vía' };
  const tipoLugar = it => TIPOS[it.addresstype] || TIPOS[it.type] || 'Lugar';
  const PRIORIDAD = { Ciudad:0, Distrito:1, Pueblo:2, Caserío:3, Sector:4, Lugar:5, Vía:6, Provincia:7, Región:8 };
  const prioridad = it => PRIORIDAD[tipoLugar(it)] ?? 5;

  function irA(it, nombre){
    lugar = nombre;
    el('osm-resultados').innerHTML = '';
    const bb = (it.boundingbox || []).map(Number);    // [sur, norte, oeste, este]
    const lat = +it.lat, lon = +it.lon;
    if(bb.length === 4 && bb.every(isFinite)){
      const latM = (bb[0] + bb[1]) / 2 * Math.PI / 180;
      const km2 = Math.abs(bb[3] - bb[2]) * 111.32 * Math.cos(latM) * Math.abs(bb[1] - bb[0]) * 110.57;
      // Si el límite oficial es enorme (provincia, región), se centra en el lugar a escala de ciudad
      if(km2 <= KM2_AVISO && km2 > 0.5) map.fitBounds([[bb[0], bb[2]], [bb[1], bb[3]]], { padding:[30, 30] });
      else map.setView([lat, lon], 14);
    }else map.setView([lat, lon], 14);
  }

  /* ── Descargar (Overpass) ── */
  async function consultar(z){
    const q = `[out:json][timeout:170];way["highway"]["highway"!~"^(${EXCLUIDOS})$"](${z.s.toFixed(6)},${z.w.toFixed(6)},${z.n.toFixed(6)},${z.e.toFixed(6)});out geom;`;
    let ultimoError = null;
    for(let i = 0; i < SERVIDORES.length; i++){
      UC.ui.loader(i === 0 ? 'Descargando la red de OpenStreetMap… (puede tardar hasta 2 minutos)'
                           : `Servidor ocupado, probando otro (${i + 1} de ${SERVIDORES.length})…`);
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ESPERA_MS);
      try{
        const r = await fetch(SERVIDORES[i], { method:'POST', body:'data=' + encodeURIComponent(q),
          headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, signal:ctl.signal });
        if(!r.ok) throw new Error('el servidor respondió ' + r.status);
        const d = await r.json();
        if(d.remark && /error/i.test(d.remark)) throw new Error(d.remark);
        return d;
      }catch(err){ ultimoError = err; console.warn('Overpass', SERVIDORES[i], err); }
      finally{ clearTimeout(t); }
    }
    throw new Error('No se pudo descargar de OpenStreetMap (' + (ultimoError && ultimoError.name === 'AbortError' ? 'tardó demasiado' : (ultimoError && ultimoError.message) || 'sin respuesta') + '). Revisa la conexión, prueba una zona más chica o inténtalo en unos minutos.');
  }

  function aGeoJSON(d){
    const features = [];
    (d.elements || []).forEach(x => {
      if(x.type !== 'way' || !Array.isArray(x.geometry)) return;
      const coords = x.geometry.filter(p => p && isFinite(p.lat) && isFinite(p.lon)).map(p => [p.lon, p.lat]);
      if(coords.length < 2) return;
      features.push({ type:'Feature', properties:Object.assign({ osm_id:'way/' + x.id }, x.tags || {}),
        geometry:{ type:'LineString', coordinates:coords } });
    });
    return { type:'FeatureCollection',
      attribution:'© colaboradores de OpenStreetMap (ODbL) — https://www.openstreetmap.org/copyright',
      descargado:new Date().toISOString(), features };
  }

  const slug = t => String(t || 'zona').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'zona';

  el('osm-descargar').addEventListener('click', async () => {
    const z = zonaActual();
    if(z.km2 > KM2_MAX) return;
    if(z.km2 > KM2_AVISO && !confirm(`La zona tiene ≈ ${U.fmtNum(Math.round(z.km2))} km² y puede tardar varios minutos.\n\n¿Descargar igual?`)) return;
    descargando = true; actualizarZona(); el('osm-ok').hidden = true;
    let fc = null;
    try{
      fc = aGeoJSON(await consultar(z));
    }catch(err){
      UC.ui.ocultarLoader(); descargando = false; actualizarZona();
      alert(err.message); return;
    }
    UC.ui.ocultarLoader(); descargando = false; actualizarZona();
    if(!fc.features.length){ alert('En esta zona no hay vías mapeadas en OpenStreetMap. Mueve el mapa a la ciudad e inténtalo de nuevo.'); return; }

    // Se entrega como un archivo GeoJSON normal: mismo camino que el botón "Red vial"
    const nombre = `red-osm-${slug(lugar)}.geojson`;
    const archivo = new File([JSON.stringify(fc)], nombre, { type:'application/geo+json' });
    await UC.proyecto.cargarRed(archivo);
    if(UC.red.cargada() && UC.red.nombreArchivo === nombre){
      ultimaRed = { nombre, fc };
      el('osm-ok-txt').innerHTML = `<i class="fa-solid fa-circle-check"></i> Red cargada: <b>${U.fmtNum(fc.features.length)}</b> vías de OSM → <b>${U.fmtNum(UC.red.segs.length)}</b> tramos.`;
      el('osm-ok').hidden = false;
    }
  });

  el('osm-guardar').addEventListener('click', () => {
    if(ultimaRed) UC.ui.descargarTexto(ultimaRed.nombre, JSON.stringify(ultimaRed.fc), 'application/geo+json');
  });

  /* ── Botones que abren el panel ── */
  const b1 = el('btn-osm'), b2 = el('bv-osm');
  if(b1) b1.addEventListener('click', () => panel.classList.contains('show') ? cerrar() : abrir());
  if(b2) b2.addEventListener('click', abrir);
})();
