'use strict';
/* ══════════════════════════════════════════════════════════════════
   NÚCLEO — AUTOGUARDADO
   Cuando hay cambios, como mucho cada 20 s, el proyecto completo se guarda en este navegador
   (IndexedDB: aguanta redes grandes, a diferencia de localStorage). Si se cierra la pestaña
   sin guardar, la bienvenida ofrece recuperarlo.
   Es una red de seguridad: el .json de "Guardar proyecto" sigue siendo el respaldo para compartir.
   ══════════════════════════════════════════════════════════════════ */
(function(){
  const DB = 'urbancore-visor', STORE = 'autoguardado', CLAVE = 'ultimo', CADA_MS = 20000;
  let sucio = false, guardando = false;

  function abrirDB(){
    return new Promise((ok, mal) => {
      if(!window.indexedDB) return mal(new Error('El navegador no tiene IndexedDB'));
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => mal(r.error);
    });
  }
  async function operar(modo, fn){
    const db = await abrirDB();
    try{
      return await new Promise((ok, mal) => {
        const tx = db.transaction(STORE, modo), req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => ok(req.result);
        tx.onerror = tx.onabort = () => mal(tx.error);
      });
    }finally{ db.close(); }
  }

  async function guardar(){
    if(!sucio || guardando || !UC.red.cargada()) return;
    sucio = false; guardando = true;
    try{
      const datos = UC.proyecto.datos();
      await operar('readwrite', st => st.put({ datos, fecha:Date.now(), nombre:datos.nombre,
        tramos:UC.red.segs.length, rutas:UC.rutas ? UC.rutas.cantidad() : 0 }, CLAVE));
      const hora = new Date().toLocaleTimeString('es-PE', { hour:'2-digit', minute:'2-digit' });
      UC.el('status-pill').title = `Guardado automático en este navegador: ${hora}\nPara compartir o respaldar: Exportar → Guardar proyecto`;
    }catch(e){ console.warn('Autoguardado no disponible:', e); }   // sin espacio o modo privado: el visor sigue igual
    guardando = false;
  }

  // Cambios avisados por los módulos…
  const marcar = () => { if(UC.red.cargada()) sucio = true; };
  ['red:cargada', 'red:cambiada', 'rutas:cambiadas', 'jerarquia:cambiada', 'red:atributos', 'paraderos:cambiados', 'proyecto:abierto'].forEach(ev => UC.eventos.on(ev, marcar));
  // …y los que no tienen evento (color, visibilidad u orden de rutas, corredores…): cualquier edición en los paneles
  ['change', 'click'].forEach(t => document.addEventListener(t, e => {
    if(e.target.closest && e.target.closest('#panel,#results,#at-tabla-panel')) marcar();
  }, true));
  setInterval(guardar, CADA_MS);
  document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'hidden') guardar(); });

  UC.autoguardado = {
    leer:() => operar('readonly', st => st.get(CLAVE)).catch(() => null),
    borrar:() => operar('readwrite', st => st.delete(CLAVE)).catch(() => {}),
    // Recién abierto (ejemplo o recuperado): no hace falta volver a guardarlo hasta que se edite algo
    limpio(){ sucio = false; },
    guardarYa(){ sucio = UC.red.cargada(); return guardar(); }
  };
})();
