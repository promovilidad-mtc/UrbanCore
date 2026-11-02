'use strict';
/* ══════════════════════════════════════════════════════════════════
   NÚCLEO — ARRANQUE (se carga al final, después de los módulos)
   ══════════════════════════════════════════════════════════════════ */
(function(){
  const el = UC.el, U = UC.util;

  // Píldora de estado del header
  UC.actualizarEstado = function(){
    const pill = el('status-pill');
    if(!UC.red.cargada()){ pill.textContent = 'Sin red vial'; pill.classList.remove('ok'); return; }
    const nr = UC.rutas ? UC.rutas.cantidad() : 0;
    pill.textContent = `${U.fmtNum(UC.red.segs.length)} tramos` + (nr ? ` · ${nr} ruta${nr > 1 ? 's' : ''}` : '');
    pill.classList.add('ok');
    const b = el('btn-load-red');
    b.classList.remove('primary'); b.classList.add('loaded');
    b.innerHTML = '<i class="fa-solid fa-check"></i> Red vial';
    el('btn-export').disabled = false;
    el('btn-ruler').disabled = false;
    el('btn-sv').disabled = false;
  };

  // Módulo inicial: el que venga en la dirección (?modulo=rutas) o Rutas
  UC.arrancarModulo = function(){
    const pedido = new URLSearchParams(location.search).get('modulo');
    UC.modulos.activar(UC.modulos.get(pedido) ? pedido : 'rutas');
  };

  /* ── Botones del header ── */
  el('btn-load-red').addEventListener('click', () => el('file-red').click());
  el('file-red').addEventListener('change', e => { const f = e.target.files[0]; if(f) UC.proyecto.cargarRed(f); e.target.value = ''; });
  el('btn-open').addEventListener('click', () => el('file-open').click());
  el('file-open').addEventListener('change', e => { const f = e.target.files[0]; if(f) UC.proyecto.abrir(f); e.target.value = ''; });

  /* ── Modal de reportes: cerrar con clic afuera o Esc ── */
  el('report-close').addEventListener('click', () => UC.ui.cerrarReporte());
  el('report-bg').addEventListener('click', e => { if(e.target === el('report-bg')) UC.ui.cerrarReporte(); });
  document.addEventListener('keydown', e => { if(e.key === 'Escape') UC.ui.cerrarReporte(); });

  /* ── Arrastrar y soltar archivos sobre el visor ── */
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer.files[0]; if(!f) return;
    if(/\.json$/i.test(f.name)){
      // .json puede ser proyecto/sesión o una red en GeoJSON: se mira el contenido
      f.text().then(t => { let s = null; try{ s = JSON.parse(t); }catch(_){}
        (s && (s.tipo || s.redFeatures)) ? UC.proyecto.abrir(f) : UC.proyecto.cargarRed(f); });
    }else UC.proyecto.cargarRed(f);
  });

  UC.actualizarEstado();
  el('info-bar').classList.add('oculto');
  UC.ui.instruccion('Cargá una red vial o abrí un proyecto / sesión para comenzar');
})();
