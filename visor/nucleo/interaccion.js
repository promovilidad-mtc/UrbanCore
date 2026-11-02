'use strict';
/* ══════════════════════════════════════════════════════════════════
   NÚCLEO — CLIC Y HOVER SOBRE LA RED
   El núcleo detecta qué tramo hay bajo el mouse (con el índice espacial)
   y se lo pasa al módulo activo. Ningún módulo repite esta lógica.
   Ganchos que un módulo puede definir:
     hoverTramos: true | () => bool   → si quiere resaltado de tramos al pasar el mouse
     colorHover: () => '#color'        → color del resaltado (por defecto azul)
     alHover(si, latlng)               → manejo propio del hover (por ej. con globo de info)
     alClic(si, evento)                → clic sobre un tramo (si = null si no hay tramo cerca)
     alClicMapa(evento) → true         → clic "crudo" en el mapa (modo dibujo); true = ya lo manejó
     alMoverMapa(evento)               → movimiento "crudo" del mouse (enganche de nodos, etc.)
   ══════════════════════════════════════════════════════════════════ */
(function(){
  const map = UC.mapa.map;
  const HIT_PX = 8;   // tolerancia de clic/hover sobre un tramo, en píxeles

  const hoverRenderer = UC.mapa.lienzo('hoverPane');
  const hoverLine = L.polyline([], { renderer:hoverRenderer, interactive:false, color:'#007aff', weight:5, opacity:0.9 });
  const hoverTip = L.tooltip({ direction:'top', offset:[0, -10], opacity:0.95 });
  let hoverSi = null, raf = 0, ultimoEvento = null;

  let colorActual = null;
  function resaltar(si, color, tooltipHtml, latlng){
    color = color || '#007aff';
    // Mismo tramo y mismo color: no se redibuja nada (solo se mueve el globo, si hay)
    if(si && si === hoverSi && color === colorActual){
      if(tooltipHtml && latlng && map.hasLayer(hoverTip)) hoverTip.setLatLng(latlng);
      return;
    }
    if(!si && !hoverSi) return;
    hoverSi = si; colorActual = si ? color : null;
    if(!si){
      if(map.hasLayer(hoverLine)) map.removeLayer(hoverLine);
      map.closeTooltip(hoverTip);
      return;
    }
    hoverLine.setLatLngs(si.latlngs);
    hoverLine.setStyle({ color });
    if(!map.hasLayer(hoverLine)) hoverLine.addTo(map);
    if(tooltipHtml && latlng){
      hoverTip.setLatLng(latlng).setContent(tooltipHtml);
      if(!map.hasLayer(hoverTip)) hoverTip.addTo(map);
    }else map.closeTooltip(hoverTip);
  }
  const quiereHover = m => typeof m.hoverTramos === 'function' ? m.hoverTramos() : !!m.hoverTramos;
  // Regla o Street View activas: los clics son de la herramienta, no del módulo
  const herramienta = () => (UC.regla && UC.regla.activa()) || (UC.streetview && UC.streetview.activa());

  map.on('mousemove', e => {
    const m = UC.modulos && UC.modulos.activo();
    if(!m || !UC.red.cargada() || herramienta()){ if(hoverSi) resaltar(null); return; }
    if(m.alMoverMapa) m.alMoverMapa(e);
    ultimoEvento = e;
    if(!raf) raf = requestAnimationFrame(() => {
      raf = 0;
      const mod = UC.modulos.activo(), ev = ultimoEvento;
      if(!mod || !quiereHover(mod)){ if(hoverSi) resaltar(null); return; }
      const si = UC.red.cercano(ev.containerPoint, HIT_PX);
      if(mod.alHover) mod.alHover(si, ev.latlng);
      else resaltar(si, mod.colorHover ? mod.colorHover() : '#007aff');
    });
  });
  map.getContainer().addEventListener('mouseleave', () => resaltar(null));

  map.on('click', e => {
    const m = UC.modulos && UC.modulos.activo();
    if(!m || !UC.red.cargada() || herramienta()) return;
    if(m.alClicMapa && m.alClicMapa(e)) return;
    if(m.alClic) m.alClic(UC.red.cercano(e.containerPoint, HIT_PX), e);
  });

  UC.interaccion = { resaltar, limpiar:() => resaltar(null), HIT_PX };
})();
