'use strict';
/* ══════════════════════════════════════════════════════════════════
   NÚCLEO — BIENVENIDA
   Portada mientras no hay red: los 3 pasos, Cargar red / Abrir proyecto, proyecto de ejemplo
   y recuperar el autoguardado. Se va sola al cargar una red o abrir un proyecto.
   Proyecto de ejemplo: visor/demo/proyecto-demo.json (proyecto de UrbanCore o sesión de RutaCore).
   Solo aparece servido desde la web (GitHub Pages o localhost), no con doble clic (file://).
   index.html?demo=1 lo abre directo, sin pasar por la portada (para grabar presentaciones).
   ══════════════════════════════════════════════════════════════════ */
(function(){
  const el = UC.el, U = UC.util;
  const DEMO = 'demo/proyecto-demo.json';
  const pideDemo = new URLSearchParams(location.search).get('demo') === '1';

  const caja = document.createElement('div'); caja.id = 'bienvenida';
  caja.innerHTML = `
    <div class="bv-card">
      <div class="bv-logo">UrbanCore <span>Visor</span></div>
      <div class="bv-sub">Planificación de rutas de transporte sobre la red vial · PROMOVILIDAD / MTC</div>
      <div class="bv-pasos">
        <div class="bv-paso"><div class="bv-num">1</div><i class="fa-solid fa-map"></i><b>Carga la red vial</b><span>Shapefile .zip, GeoJSON, KML o KMZ, o descárgala de OpenStreetMap. Se corta sola en las esquinas.</span></div>
        <div class="bv-paso"><div class="bv-num">2</div><i class="fa-solid fa-route"></i><b>Traza y clasifica</b><span>Rutas tramo a tramo, edición de la red y jerarquía vial.</span></div>
        <div class="bv-paso"><div class="bv-num">3</div><i class="fa-solid fa-magnifying-glass-chart"></i><b>Analiza y exporta</b><span>Superposición, cobertura, paraderos, atributos, Excel y GeoJSON.</span></div>
      </div>
      <div class="bv-recuperar" id="bv-recuperar" hidden>
        <i class="fa-solid fa-clock-rotate-left"></i>
        <div class="bv-rec-txt"><b>Retomar el último trabajo</b><span id="bv-rec-info"></span></div>
        <button class="btn primary" id="bv-rec-si">Recuperar</button>
        <button class="btn" id="bv-rec-no" title="Borrar el autoguardado de este navegador">Descartar</button>
      </div>
      <div class="bv-acciones">
        <button class="btn primary" id="bv-red"><i class="fa-solid fa-map"></i> Cargar red vial</button>
        <button class="btn" id="bv-osm" title="Descargar la red vial de tu ciudad desde OpenStreetMap (requiere internet)"><i class="fa-solid fa-cloud-arrow-down"></i> Descargar de OSM</button>
        <button class="btn" id="bv-abrir"><i class="fa-solid fa-folder-open"></i> Abrir proyecto</button>
        <button class="btn" id="bv-demo" hidden><i class="fa-solid fa-play"></i> Ver proyecto de ejemplo</button>
      </div>
      <div class="bv-pie">También puedes arrastrar un archivo a cualquier parte de la ventana.</div>
    </div>`;
  document.body.appendChild(caja);

  const mostrar = v => caja.classList.toggle('oculta', !v);
  UC.eventos.on('red:cargada', () => mostrar(false));
  UC.eventos.on('proyecto:abierto', () => mostrar(false));
  if(pideDemo) mostrar(false);

  el('bv-red').addEventListener('click', () => el('file-red').click());
  el('bv-abrir').addEventListener('click', () => el('file-open').click());

  // Ejemplo y recuperado se abren como cualquier proyecto (misma lógica que el botón Abrir)
  async function abrirTexto(texto, nombre){
    await UC.proyecto.abrir(new File([texto], nombre, { type:'application/json' }));
    if(UC.autoguardado) UC.autoguardado.limpio();
  }

  /* ── Proyecto de ejemplo ── */
  async function cargarDemo(){
    UC.ui.loader('Abriendo proyecto de ejemplo…');
    try{
      const r = await fetch(DEMO, { cache:'no-cache' });
      if(!r.ok) throw new Error(`no se encontró visor/${DEMO}`);
      await abrirTexto(await r.text(), 'proyecto-demo.json');
    }catch(e){
      UC.ui.ocultarLoader(); mostrar(!UC.red.cargada());
      alert('No se pudo abrir el proyecto de ejemplo: ' + e.message + (location.protocol === 'file:' ? '\n\nAbre el visor desde la web (GitHub Pages o localhost), no con doble clic.' : ''));
    }
  }
  el('bv-demo').addEventListener('click', cargarDemo);
  // Con doble clic (file://) el navegador bloquea la consulta: ni se intenta
  if(location.protocol !== 'file:') fetch(DEMO, { method:'HEAD', cache:'no-cache' }).then(r => { if(r.ok) el('bv-demo').hidden = false; }).catch(() => {});
  if(pideDemo) cargarDemo();

  /* ── Recuperar el autoguardado ── */
  if(UC.autoguardado && !pideDemo) UC.autoguardado.leer().then(a => {
    if(!a || !a.datos || UC.red.cargada()) return;
    const f = new Date(a.fecha);
    el('bv-rec-info').textContent = `${a.nombre} · ${U.fmtNum(a.tramos)} tramos` + (a.rutas ? ` · ${a.rutas} ruta${a.rutas > 1 ? 's' : ''}` : '') +
      ` · guardado el ${f.toLocaleDateString('es-PE')} a las ${f.toLocaleTimeString('es-PE', { hour:'2-digit', minute:'2-digit' })}`;
    el('bv-recuperar').hidden = false;
  });
  el('bv-rec-si').addEventListener('click', async () => {
    const a = await UC.autoguardado.leer(); if(!a) return;
    await abrirTexto(JSON.stringify(a.datos), (a.nombre || 'recuperado') + '-proyecto.json');
  });
  el('bv-rec-no').addEventListener('click', async () => {
    if(!confirm('¿Descartar el trabajo guardado automáticamente? No se puede deshacer.')) return;
    await UC.autoguardado.borrar();
    el('bv-recuperar').hidden = true;
  });
})();
