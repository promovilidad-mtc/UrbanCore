'use strict';
/* ══════════════════════════════════════════════════════════════════
   NÚCLEO — RED VIAL COMPARTIDA
   Una sola red en memoria para todos los módulos:
   - lectura de archivos (shapefile .zip, GeoJSON, KML, KMZ) con reproyección UTM → WGS84
   - preparación de redes crudas de OSM (corte en esquinas + filtro de lo que no es vía)
   - ID estable de cada tramo por geometría (idéntico a RutaCore y ClasificadorVial)
   - índice espacial para clic, hover, rectángulos y enganche de nodos
   - un solo lienzo para dibujarla, con caché de estilos
   ══════════════════════════════════════════════════════════════════ */
(function(){
  const map = UC.mapa.map;

  /* ── Reproyección UTM → WGS84 (igual que RutaCore) ── */
  proj4.defs('EPSG:32717','+proj=utm +zone=17 +south +datum=WGS84 +units=m +no_defs');
  proj4.defs('EPSG:32718','+proj=utm +zone=18 +south +datum=WGS84 +units=m +no_defs');
  proj4.defs('EPSG:32719','+proj=utm +zone=19 +south +datum=WGS84 +units=m +no_defs');
  function findFirstCoord(geom){ if(!geom) return null; let c = geom.coordinates; while(Array.isArray(c) && Array.isArray(c[0])) c = c[0]; return (Array.isArray(c) && typeof c[0] === 'number') ? c : null; }
  function transformCoords(coords, fn){ if(typeof coords[0] === 'number') return fn(coords); return coords.map(c => transformCoords(c, fn)); }
  function reprojectGeoJSON(gj, fromEPSG){
    const fn = xy => proj4(fromEPSG, 'EPSG:4326', xy);
    function walk(g){ if(!g) return; if(g.type === 'GeometryCollection'){ g.geometries.forEach(walk); return; } if(g.coordinates) g.coordinates = transformCoords(g.coordinates, fn); }
    if(gj.features) gj.features.forEach(f => walk(f.geometry)); else if(gj.geometry) walk(gj.geometry);
    return gj;
  }
  function detectCRS(gj){ const name = gj && gj.crs && gj.crs.properties && gj.crs.properties.name; if(!name) return null; const m = String(name).match(/EPSG:{1,2}(\d+)/i); return m ? 'EPSG:' + m[1] : null; }
  const PERU_BBOX = { lonMin:-82, lonMax:-68, latMin:-19.5, latMax:1 };
  function detectUTM(xy){ for(const e of ['EPSG:32717','EPSG:32718','EPSG:32719']){ try{ const [lon, lat] = proj4(e, 'EPSG:4326', xy); if(lon >= PERU_BBOX.lonMin && lon <= PERU_BBOX.lonMax && lat >= PERU_BBOX.latMin && lat <= PERU_BBOX.latMax) return e; }catch(_){} } return null; }

  async function leerArchivoGeo(file){
    const name = file.name.toLowerCase();
    let gj = null;
    if(name.endsWith('.zip')){
      gj = await shp(await file.arrayBuffer());
      if(!gj) throw new Error('No se pudo leer el ZIP/Shapefile.');
      if(Array.isArray(gj)) gj = { type:'FeatureCollection', features:gj.flatMap(g => g.features || []) };
    }else if(name.endsWith('.kmz')){
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const kml = Object.values(zip.files).find(f => f.name.toLowerCase().endsWith('.kml'));
      if(!kml) throw new Error('No se encontró KML dentro del KMZ.');
      gj = toGeoJSON.kml(new DOMParser().parseFromString(await kml.async('text'), 'text/xml'));
    }else if(name.endsWith('.kml')){
      gj = toGeoJSON.kml(new DOMParser().parseFromString(await file.text(), 'text/xml'));
    }else{
      gj = JSON.parse(await file.text());
    }
    if(!gj) throw new Error('Formato no reconocido.');
    if(!gj.features) gj = { type:'FeatureCollection', features:[gj] };
    let crs = detectCRS(gj);
    if(!crs){
      const sample = gj.features.find(f => f.geometry);
      if(sample){ const xy = findFirstCoord(sample.geometry); if(xy && (Math.abs(xy[0]) > 360 || Math.abs(xy[1]) > 90)) crs = detectUTM(xy); }
    }
    if(crs && crs !== 'EPSG:4326') gj = reprojectGeoJSON(gj, crs);
    return gj;
  }

  /* ── Preparar red vial (exportaciones crudas de OSM) — igual que RutaCore ──
     1) MultiLineString → líneas simples.
     2) Si es exportación cruda de OSM (trae "highway"), se quita lo que no es vía vehicular.
     3) Cada línea se corta en los vértices que comparte con otra calle (esquinas reales).
        Puentes y pasos a desnivel no comparten nodo, así que no se cortan.
     Una red ya cortada (de un modelo) queda igual. */
  const HIGHWAY_EXCLUIDOS = new Set(['footway','pedestrian','steps','service','path','cycleway','bridleway',
    'corridor','elevator','platform','construction','proposed','abandoned','razed','disused','raceway','bus_stop']);
  function lineLengthM(c){
    let m = 0;
    for(let i = 1; i < c.length; i++){
      const [lon1, lat1] = c[i-1], [lon2, lat2] = c[i];
      const dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
      const h = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
      m += 2*6371008.8*Math.asin(Math.min(1, Math.sqrt(h)));
    }
    return m;
  }
  function prepararRedVial(feats){
    const stats = { lineasOriginales:feats.length, quitados:0, esquinas:0, tramos:0, filtroOSM:false };
    let lineas = [];
    feats.forEach(f => {
      const g = f.geometry, props = f.properties || {};
      const partes = g.type === 'MultiLineString' ? g.coordinates : [g.coordinates];
      partes.forEach(c => { if(c && c.length >= 2) lineas.push({ props, coords:c }); });
    });
    const conClave = lineas.filter(l => 'highway' in l.props).length;
    if(conClave >= lineas.length * 0.5){
      stats.filtroOSM = true;
      const antes = lineas.length;
      lineas = lineas.filter(l => { const h = l.props.highway; return h && !HIGHWAY_EXCLUIDOS.has(String(h).toLowerCase()); });
      stats.quitados = antes - lineas.length;
    }
    const K = c => c[0].toFixed(7) + ',' + c[1].toFixed(7);
    const uso = new Map();
    lineas.forEach((l, i) => l.coords.forEach(c => { const k = K(c), u = uso.get(k); if(u === undefined) uso.set(k, i); else if(u !== i && u !== -1) uso.set(k, -1); }));
    const out = [];
    lineas.forEach(l => {
      const c = l.coords, cortes = [0];
      for(let k = 1; k < c.length - 1; k++) if(uso.get(K(c[k])) === -1) cortes.push(k);
      cortes.push(c.length - 1);
      stats.esquinas += cortes.length - 2;
      const dist = +l.props.distance;
      const largoTotal = cortes.length > 2 && dist > 0 ? lineLengthM(c) : 0;
      for(let k = 0; k < cortes.length - 1; k++){
        const tramo = c.slice(cortes[k], cortes[k+1] + 1);
        const props = { ...l.props };
        if(largoTotal > 0) props.distance = dist * lineLengthM(tramo) / largoTotal;
        out.push({ type:'Feature', properties:props, geometry:{ type:'LineString', coordinates:tramo } });
      }
    });
    stats.tramos = out.length;
    return { features:out, stats };
  }

  /* ── ID estable por geometría (idéntico a RutaCore) ── */
  function segIdFromLatLngs(latlngs){
    if(!latlngs || latlngs.length < 2) return null;
    const r = n => n.toFixed(6);
    const a = latlngs[0], b = latlngs[latlngs.length-1], m = latlngs[Math.floor(latlngs.length/2)];
    return `${r(a[0])},${r(a[1])}|${r(m[0])},${r(m[1])}|${r(b[0])},${r(b[1])}`;
  }

  /* ── Estado de la red ── */
  const ESTILO_BASE = { color:'#8e8e93', weight:2, opacity:0.5 };
  const renderer = UC.mapa.lienzo();          // un solo lienzo para la red, reutilizado siempre
  let capa = null, visible = true, estiloActual = ESTILO_BASE;
  const R = {
    features:[],        // features GeoJSON de la red (lo que se guarda en el proyecto)
    segs:[],            // [{fi, segId, latlngs, km, props, layer, _sk}]
    porId:new Map(),
    porFi:new Map(),
    bounds:null,
    stats:null,         // estadísticas de la última preparación de red
    nombreArchivo:''
  };

  /* ── Índice espacial ── */
  const GRID = 0.0015;               // celdas de ~165 m
  const gridKey = (x, y) => x * 100000 + y;
  let segGrid = new Map(), nodeGrid = new Map();
  function gridAdd(g, k, v){ let a = g.get(k); if(!a){ a = []; g.set(k, a); } if(a[a.length-1] !== v) a.push(v); }
  function construirIndice(){
    segGrid = new Map(); nodeGrid = new Map();
    let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
    R.segs.forEach(si => {
      const ll = si.latlngs;
      for(let i = 0; i < ll.length; i++){
        const p = ll[i];
        if(p[0] < minLat) minLat = p[0]; if(p[0] > maxLat) maxLat = p[0]; if(p[1] < minLng) minLng = p[1]; if(p[1] > maxLng) maxLng = p[1];
        if(i === ll.length - 1) break;
        const q = ll[i+1];
        const x0 = Math.floor(Math.min(p[1], q[1]) / GRID), x1 = Math.floor(Math.max(p[1], q[1]) / GRID);
        const y0 = Math.floor(Math.min(p[0], q[0]) / GRID), y1 = Math.floor(Math.max(p[0], q[0]) / GRID);
        for(let x = x0; x <= x1; x++) for(let y = y0; y <= y1; y++) gridAdd(segGrid, gridKey(x, y), si);
      }
      [ll[0], ll[ll.length-1]].forEach(n => gridAdd(nodeGrid, gridKey(Math.floor(n[1] / GRID), Math.floor(n[0] / GRID)), n));
    });
    R.bounds = R.segs.length ? L.latLngBounds([minLat, minLng], [maxLat, maxLng]) : null;
  }
  function celdasAlrededor(pt, tol){
    const c1 = map.containerPointToLatLng([pt.x - tol, pt.y - tol]), c2 = map.containerPointToLatLng([pt.x + tol, pt.y + tol]);
    const x0 = Math.floor(Math.min(c1.lng, c2.lng) / GRID), x1 = Math.floor(Math.max(c1.lng, c2.lng) / GRID);
    const y0 = Math.floor(Math.min(c1.lat, c2.lat) / GRID), y1 = Math.floor(Math.max(c1.lat, c2.lat) / GRID);
    if((x1 - x0 + 1) * (y1 - y0 + 1) > 900) return null; // zoom muy alejado para elegir un tramo
    const keys = []; for(let x = x0; x <= x1; x++) for(let y = y0; y <= y1; y++) keys.push(gridKey(x, y));
    return keys;
  }
  // Tramo más cercano a un punto de pantalla (tolerancia en píxeles)
  R.cercano = function(pt, tol){
    const keys = celdasAlrededor(pt, tol); if(!keys) return null;
    const vistos = new Set(); let best = null, minD = tol;
    keys.forEach(k => {
      const arr = segGrid.get(k); if(!arr) return;
      for(const si of arr){
        if(vistos.has(si)) continue; vistos.add(si);
        const ll = si.latlngs; let a = map.latLngToContainerPoint(ll[0]);
        for(let i = 1; i < ll.length; i++){
          const b = map.latLngToContainerPoint(ll[i]);
          const dx = b.x - a.x, dy = b.y - a.y, len2 = dx*dx + dy*dy;
          const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt.x - a.x)*dx + (pt.y - a.y)*dy) / len2));
          const d = Math.hypot(pt.x - a.x - t*dx, pt.y - a.y - t*dy);
          if(d < minD){ minD = d; best = si; }
          a = b;
        }
      }
    });
    return best;
  };
  // Nodo (extremo de tramo) más cercano, para el enganche del modo Dibujar tramo
  R.nodoCercano = function(pt, tol){
    const keys = celdasAlrededor(pt, tol); if(!keys) return null;
    let best = null, minD = tol;
    keys.forEach(k => { const arr = nodeGrid.get(k); if(!arr) return; arr.forEach(n => { const np = map.latLngToContainerPoint(n); const d = Math.hypot(pt.x - np.x, pt.y - np.y); if(d < minD){ minD = d; best = n; } }); });
    return best;
  };
  // Tramos dentro de un rectángulo (algún vértice o punto medio adentro)
  R.enRectangulo = function(bounds){
    const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
    const inside = p => p[0] >= sw.lat && p[0] <= ne.lat && p[1] >= sw.lng && p[1] <= ne.lng;
    const out = new Set();
    for(let x = Math.floor(sw.lng / GRID); x <= Math.floor(ne.lng / GRID); x++)
      for(let y = Math.floor(sw.lat / GRID); y <= Math.floor(ne.lat / GRID); y++){
        const arr = segGrid.get(gridKey(x, y)); if(!arr) continue;
        for(const si of arr){
          if(out.has(si)) continue;
          const ll = si.latlngs;
          for(let i = 0; i < ll.length; i++){
            if(inside(ll[i])){ out.add(si); break; }
            if(i < ll.length - 1 && inside([(ll[i][0] + ll[i+1][0]) / 2, (ll[i][1] + ll[i+1][1]) / 2])){ out.add(si); break; }
          }
        }
      }
    return out;
  };
  // Tramo más cercano a una coordenada, con distancia máxima en metros (para líneas que no calzan exacto)
  R.cercanoMetros = function(lat, lng, maxM){
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
    const ring = Math.max(1, Math.ceil(maxM / (GRID * kx)));
    const cx = Math.floor(lng / GRID), cy = Math.floor(lat / GRID);
    const vistos = new Set(); let best = null, minD = maxM;
    for(let x = cx - ring; x <= cx + ring; x++) for(let y = cy - ring; y <= cy + ring; y++){
      const arr = segGrid.get(gridKey(x, y)); if(!arr) continue;
      for(const si of arr){
        if(vistos.has(si)) continue; vistos.add(si);
        const ll = si.latlngs;
        for(let i = 1; i < ll.length; i++){
          const ax = (ll[i-1][1] - lng) * kx, ay = (ll[i-1][0] - lat) * ky, bx = (ll[i][1] - lng) * kx, by = (ll[i][0] - lat) * ky;
          const dx = bx - ax, dy = by - ay, len2 = dx*dx + dy*dy;
          const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax*dx + ay*dy) / len2));
          const d = Math.hypot(ax + t*dx, ay + t*dy);
          if(d < minD){ minD = d; best = si; }
        }
      }
    }
    return best;
  };
  // Todos los tramos a menos de maxM metros de una coordenada, con la distancia y la dirección
  // (vector unitario en metros: ux este, uy norte) del pedazo más cercano. Lo usa Importar para
  // pegar líneas de otra fuente solo a calles que vayan en la misma dirección.
  R.candidatosMetros = function(lat, lng, maxM){
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
    const x0 = Math.floor((lng - maxM / kx) / GRID), x1 = Math.floor((lng + maxM / kx) / GRID);
    const y0 = Math.floor((lat - maxM / ky) / GRID), y1 = Math.floor((lat + maxM / ky) / GRID);
    const vistos = new Set(), out = [];
    for(let x = x0; x <= x1; x++) for(let y = y0; y <= y1; y++){
      const arr = segGrid.get(gridKey(x, y)); if(!arr) continue;
      for(const si of arr){
        if(vistos.has(si)) continue; vistos.add(si);
        const ll = si.latlngs; let minD = maxM, ux = 0, uy = 0;
        for(let i = 1; i < ll.length; i++){
          const ax = (ll[i-1][1] - lng) * kx, ay = (ll[i-1][0] - lat) * ky, bx = (ll[i][1] - lng) * kx, by = (ll[i][0] - lat) * ky;
          const dx = bx - ax, dy = by - ay, len2 = dx*dx + dy*dy;
          const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax*dx + ay*dy) / len2));
          const d = Math.hypot(ax + t*dx, ay + t*dy);
          if(d < minD && len2 > 0){ minD = d; const L = Math.sqrt(len2); ux = dx / L; uy = dy / L; }
        }
        if(minD < maxM) out.push({ si, d:minD, ux, uy });
      }
    }
    return out;
  };

  /* ── Estilo de la red base (con caché: solo se redibuja lo que cambia) ── */
  R.estiloTramo = function(si, st){
    const k = st.color + '|' + st.weight + '|' + st.opacity;
    if(si._sk === k) return;
    si._sk = k; si.layer.setStyle(st);
  };
  R.estiloBase = function(st){ estiloActual = st || ESTILO_BASE; R.segs.forEach(si => R.estiloTramo(si, estiloActual)); };
  R.estiloPorDefecto = ESTILO_BASE;
  R.visible = function(v){
    if(v === undefined) return visible;
    visible = v;
    if(capa){ if(v) capa.addTo(map); else map.removeLayer(capa); }
  };

  /* ── Construir la red a partir de features GeoJSON ──
     opciones.emitir: false al abrir un proyecto (los módulos cargan su parte después). */
  R.establecer = function(features, opciones){
    const op = Object.assign({ emitir:true, encuadrar:true }, opciones || {});
    const idsPrevios = new Set(R.porId.keys());
    const previos = R.porId;   // tramos de la red anterior: se reutilizan los que no cambiaron
    const habiaRed = R.segs.length > 0;
    if(capa){ map.removeLayer(capa); capa = null; }
    R.features = features;
    R.segs = []; R.porId = new Map(); R.porFi = new Map();
    capa = L.layerGroup();
    const usados = new Map();
    const k0 = estiloActual.color + '|' + estiloActual.weight + '|' + estiloActual.opacity;
    // Mismo recorrido que RutaCore: mismo orden, primera parte de MultiLineString y "#n" en colisiones
    features.forEach((f, fi) => {
      const g = f && f.geometry; if(!g) return;
      let coords = [];
      if(g.type === 'LineString') coords = g.coordinates;
      else if(g.type === 'MultiLineString') coords = g.coordinates[0] || [];
      else return;
      const latlngs = coords.map(c => [c[1], c[0]]);
      if(!latlngs.length) return;
      let segId = segIdFromLatLngs(latlngs);
      if(segId === null) return;
      if(usados.has(segId)){ const n = usados.get(segId) + 1; usados.set(segId, n); segId += '#' + n; } else usados.set(segId, 0);
      // Borrar o dibujar un tramo ya no recrea toda la red: si el tramo es el mismo, se reutiliza su polilínea
      const prev = previos.get(segId);
      if(prev && prev.latlngs.length === latlngs.length){
        prev.fi = fi; prev.latlngs = latlngs; prev.props = f.properties || {};
        capa.addLayer(prev.layer);
        R.segs.push(prev); R.porId.set(segId, prev); R.porFi.set(fi, prev);
        return;
      }
      const layer = L.polyline(latlngs, Object.assign({ renderer, interactive:false }, estiloActual));
      layer.addTo(capa);
      const si = { fi, segId, latlngs, km:UC.util.lineKm(latlngs), props:f.properties || {}, layer, _sk:k0 };
      R.segs.push(si); R.porId.set(segId, si); R.porFi.set(fi, si);
    });
    if(visible) capa.addTo(map);
    construirIndice();
    if(op.encuadrar && R.bounds) map.fitBounds(R.bounds, { padding:[30, 30] });
    UC.actualizarEstado && UC.actualizarEstado();
    if(!op.emitir) return;
    if(habiaRed){
      const eliminados = new Set([...idsPrevios].filter(id => !R.porId.has(id)));
      const agregados = new Set([...R.porId.keys()].filter(id => !idsPrevios.has(id)));
      UC.eventos.emit('red:cambiada', { eliminados, agregados });
    }else UC.eventos.emit('red:cargada', {});
  };

  /* Leer un archivo de red y prepararlo (corte en esquinas + filtro OSM) */
  R.leerArchivo = async function(file){
    const gj = await leerArchivoGeo(file);
    const lineas = (gj.features || []).filter(f => f.geometry && (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString'));
    if(!lineas.length) throw new Error('No se encontraron líneas en el archivo.');
    const { features, stats } = prepararRedVial(lineas);
    if(!features.length) throw new Error('No quedaron vías después de filtrar el archivo.');
    return { features, stats };
  };
  R.leerArchivoGeo = leerArchivoGeo;

  /* Edición: quitar tramos y agregar tramos nuevos (rehace la red y avisa a todos los módulos) */
  R.eliminar = function(segIds){
    const fis = new Set([...segIds].map(id => R.porId.get(id)).filter(Boolean).map(si => si.fi));
    R.establecer(R.features.filter((f, i) => !fis.has(i)), { encuadrar:false });
  };
  R.agregar = function(nuevas){ R.establecer(R.features.concat(nuevas), { encuadrar:false }); };

  R.segIdFromLatLngs = segIdFromLatLngs;
  R.cargada = () => R.segs.length > 0;
  UC.red = R;
})();
