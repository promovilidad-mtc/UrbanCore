'use strict';
/* ══════════════════════════════════════════════════════════════════
   NÚCLEO — PROYECTO
   Un solo archivo por ciudad con la red y la parte de cada módulo:
   {
     tipo:'urbancore-proyecto', version:1, nombre, guardadoEn,
     red:{ features:[...] },
     modulos:{ rutas:{...}, jerarquia:{...}, cobertura:{...}, ... }
   }
   También abre los archivos de las apps sueltas:
   - sesión de RutaCore        (tipo 'rutacore-session')         → red + rutas
   - sesión de ClasificadorVial (tipo 'plancore-sesion-clasificador') → red + jerarquía
   ══════════════════════════════════════════════════════════════════ */
(function(){
  const P = { nombre:'' };

  function nombreDesdeArchivo(n){ return n.replace(/\.[^.]+$/, '').replace(/[-_](proyecto|sesion|sesión)$/i, ''); }

  // El proyecto completo como objeto (lo usan Guardar y el autoguardado)
  P.datos = function(){
    const modulos = {};
    UC.modulos.lista().forEach(m => { if(m.serializar){ const d = m.serializar(); if(d) modulos[m.id] = d; } });
    return { tipo:'urbancore-proyecto', version:1, nombre:P.nombre || 'Proyecto', guardadoEn:new Date().toISOString(),
             red:{ features:UC.red.features }, modulos };
  };

  P.guardar = function(){
    if(!UC.red.cargada()){ alert('Carga una red vial primero.'); return; }
    const base = (P.nombre || 'urbancore').replace(/[^\wáéíóúñÁÉÍÓÚÑ-]+/g, '_');
    UC.ui.descargarTexto(`${base}-proyecto.json`, JSON.stringify(P.datos()));
    UC.ui.instruccion('Proyecto guardado');
  };

  // Deja todos los módulos vacíos y abre la red nueva sin avisos (los módulos cargan su parte después)
  function nuevoConRed(features){
    UC.red.establecer(features, { emitir:false });
    UC.modulos.lista().forEach(m => m.cargar && m.cargar(null));
  }

  P.abrir = async function(file){
    UC.ui.loader('Leyendo archivo…'); await UC.ui.esperarFrame();
    try{
      const s = JSON.parse(await file.text());
      const hayDatos = UC.red.cargada();
      UC.ui.loader('Armando la red…'); await UC.ui.esperarFrame();

      if(s.tipo === 'urbancore-proyecto'){
        if(!s.red || !Array.isArray(s.red.features)) throw new Error('El proyecto no tiene red vial.');
        nuevoConRed(s.red.features);
        const mods = s.modulos || {};
        UC.modulos.lista().forEach(m => { if(m.cargar && mods[m.id]) m.cargar(mods[m.id], { origen:'proyecto' }); });
        P.nombre = s.nombre || nombreDesdeArchivo(file.name);
      }
      else if(s.tipo === 'rutacore-session' || (Array.isArray(s.redFeatures) && Array.isArray(s.routes))){
        // Con una red ya abierta se puede traer solo las rutas (sin cambiar la red)
        const soloRutas = hayDatos && !confirm('Abrir sesión de RutaCore\n\nAceptar → abrir como proyecto nuevo (red y rutas de la sesión).\nCancelar → traer solo las rutas a la red actual.');
        if(!soloRutas){ nuevoConRed(s.redFeatures || []); P.nombre = nombreDesdeArchivo(file.name); }
        UC.modulos.get('rutas').cargar({ routes:s.routes || [] }, { origen:'rutacore', redSesion:s.redFeatures || [] });
      }
      else if(typeof s.tipo === 'string' && s.tipo.includes('clasificador')){
        const soloClas = hayDatos && !confirm('Abrir sesión de ClasificadorVial\n\nAceptar → abrir como proyecto nuevo (red y clasificación de la sesión).\nCancelar → traer solo la clasificación a la red actual.');
        if(!soloClas){ nuevoConRed(s.redFeatures || []); P.nombre = nombreDesdeArchivo(file.name); }
        UC.modulos.get('jerarquia').cargar(s, { origen:'clasificador', mismaRed:!soloClas });
      }
      else throw new Error('No se reconoce el archivo. Se aceptan proyectos de UrbanCore y sesiones de RutaCore o ClasificadorVial.');

      UC.modulos.habilitar();
      UC.actualizarEstado();
      UC.eventos.emit('proyecto:abierto', {});
      const act = UC.modulos.activo();
      if(act){ act.desactivar && act.desactivar(); act.activar && act.activar(); }
      else UC.arrancarModulo();
    }catch(err){ alert('Error al abrir: ' + err.message); console.error(err); }
    UC.ui.ocultarLoader();
  };

  /* Cargar una red vial desde archivo (shapefile, GeoJSON, KML, KMZ) */
  P.cargarRed = async function(file){
    UC.ui.loader('Leyendo red vial…'); await UC.ui.esperarFrame();
    try{
      const { features, stats } = await UC.red.leerArchivo(file);
      if(UC.red.cargada() && !confirm('Reemplazar la red vial\n\nLas rutas y la clasificación se conservan en los tramos que coincidan con la red nueva; los demás se quitan.\n\n¿Continuar?')){ UC.ui.ocultarLoader(); return; }
      UC.ui.loader('Cortando la red en las intersecciones…'); await UC.ui.esperarFrame();
      const primera = !UC.red.cargada();
      UC.red.stats = stats;
      UC.red.nombreArchivo = file.name;
      UC.red.establecer(features);
      if(primera){ P.nombre = nombreDesdeArchivo(file.name); UC.modulos.habilitar(); UC.arrancarModulo(); }
      const partes = [];
      if(stats.esquinas) partes.push(`${UC.util.fmtNum(stats.esquinas)} esquinas cortadas`);
      if(stats.quitados) partes.push(`${UC.util.fmtNum(stats.quitados)} elementos que no son vías quitados`);
      UC.ui.instruccion(partes.length
        ? `Red preparada: ${UC.util.fmtNum(stats.lineasOriginales)} líneas → ${UC.util.fmtNum(stats.tramos)} tramos (${partes.join(' · ')})`
        : `Red cargada: ${UC.util.fmtNum(UC.red.segs.length)} tramos`);
    }catch(err){ alert('Error: ' + err.message); console.error(err); }
    UC.ui.ocultarLoader();
  };

  UC.proyecto = P;
})();
