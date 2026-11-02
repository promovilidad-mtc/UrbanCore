'use strict';
/* ══════════════════════════════════════════════════════════════════
   NÚCLEO — STREET VIEW
   Herramienta de la barra: con ella activa, un clic en el mapa abre Google Maps en la vista de calle
   (las fotos del carrito de Google) en otra pestaña, en ese punto. Usa las direcciones oficiales de
   Google Maps (sin clave ni costo); Google busca sola la foto más cercana.
   Si el clic cae cerca de un tramo, se usa el punto sobre la vía y la cámara mira a lo largo de ella.
   Los módulos la abren con UC.streetview.abrir(latlng, rumbo) — por ejemplo, Paraderos.
   ══════════════════════════════════════════════════════════════════ */
(function(){
  const map = UC.mapa.map, el = UC.el;
  let activa = false, marca = null;

  // rumbo: grados desde el norte hacia donde mira la cámara (opcional)
  function abrir(ll, rumbo){
    const lat = Array.isArray(ll) ? ll[0] : ll.lat, lng = Array.isArray(ll) ? ll[1] : ll.lng;
    let url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lng.toFixed(6)}`;
    if(rumbo !== null && rumbo !== undefined && isFinite(rumbo)) url += `&heading=${Math.round(((rumbo % 360) + 360) % 360)}`;
    window.open(url, '_blank', 'noopener');
    if(activa){
      if(marca) marca.setLatLng([lat, lng]);
      else marca = L.circleMarker([lat, lng], { radius:7, color:'#fff', weight:2.5, fillColor:'#f59e0b', fillOpacity:1, interactive:false, pane:'editPane' }).addTo(map);
    }
  }

  // Punto de la vía más cercano al clic y rumbo del tramo ahí
  function sobreVia(si, ll){
    const p = si.latlngs; let best = null;
    for(let i = 1; i < p.length; i++){
      const a = p[i-1], b = p[i], k = Math.cos(a[0] * Math.PI / 180);
      const ax = (a[1] - ll.lng) * k, ay = a[0] - ll.lat, dx = (b[1] - a[1]) * k, dy = b[0] - a[0], l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0, d = Math.hypot(ax + t * dx, ay + t * dy);
      if(!best || d < best.d) best = { d, ll:[a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], rumbo:Math.atan2(dx, dy) * 180 / Math.PI };
    }
    return best;
  }

  function encender(){
    if(UC.regla && UC.regla.activa()) UC.regla.apagar();
    activa = true;
    el('btn-sv').classList.add('mode-active'); el('map').classList.add('cursor-sv');
    UC.interaccion.limpiar();
    UC.ui.instruccion('Street View: clic en el mapa o en un paradero para ver la zona en Google Maps · Esc para salir');
  }
  function apagar(){
    if(!activa) return;
    activa = false;
    el('btn-sv').classList.remove('mode-active'); el('map').classList.remove('cursor-sv');
    if(marca){ map.removeLayer(marca); marca = null; }
    UC.ui.instruccion('Street View desactivado');
  }
  el('btn-sv').addEventListener('click', () => activa ? apagar() : encender());
  el('btn-ruler').addEventListener('click', () => apagar());   // Regla y Street View no van juntas
  document.addEventListener('keydown', e => { if(e.key === 'Escape') apagar(); });

  // Mientras está activa, el núcleo no pasa los clics a los módulos (ver nucleo/interaccion.js)
  map.on('click', e => {
    if(!activa) return;
    const si = UC.red.cargada() ? UC.red.cercano(e.containerPoint, 14) : null;
    const v = si && sobreVia(si, e.latlng);
    abrir(v ? v.ll : e.latlng, v ? v.rumbo : null);
  });

  UC.streetview = { activa:() => activa, abrir, apagar };
})();
