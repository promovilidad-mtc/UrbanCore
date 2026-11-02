'use strict';
/* ══════════════════════════════════════════════════════════════════
   NÚCLEO — MÓDULOS
   Cada herramienta (Rutas, Red, Jerarquía, Análisis, Cobertura…) es un módulo
   que se registra con UC.modulos.registrar({...}). Contrato:

   id, nombre, icono (clase Font Awesome), titulo (texto largo para el tooltip)
   panel            → elemento del panel izquierdo
   resultados       → elemento del panel derecho (opcional)
   capas            → [{nombre, visible:()=>bool, cambiar:(bool)=>void}] para el panel de capas
   exportar         → () => [{icono, titulo, sub, accion}] para el menú Exportar
   activar() / desactivar()
   serializar()     → su parte del archivo de proyecto
   cargar(datos)    → leer su parte del proyecto
   usosDeTramo(id)  → textos de dónde se usa un tramo (para avisar antes de borrarlo)
   + ganchos de interacción (ver nucleo/interaccion.js)

   Solo un módulo está activo a la vez (es el que recibe los clics), pero las capas
   de todos pueden verse juntas desde el panel de capas.
   ══════════════════════════════════════════════════════════════════ */
(function(){
  const lista = [];
  let activo = null;

  function registrar(def){
    lista.push(def);
    // Botón en la barra de módulos
    const b = document.createElement('button');
    b.dataset.mod = def.id; b.disabled = true;
    b.title = def.titulo || def.nombre;
    b.innerHTML = `<i class="fa-solid ${def.icono}"></i>`;
    b.append(def.nombre);
    b.addEventListener('click', () => activar(def.id));
    UC.el('modulos-nav').appendChild(b);
    def._boton = b;
    // Paneles
    def.panel.classList.add('modulo-panel');
    UC.el('panel').appendChild(def.panel);
    if(def.resultados){ def.resultados.classList.add('modulo-res'); UC.el('results').appendChild(def.resultados); }
  }

  function activar(id){
    const m = lista.find(x => x.id === id);
    if(!m || m === activo) return;
    if(!UC.red.cargada()) return;
    if(UC.regla && UC.regla.activa()) UC.regla.apagar();
    if(UC.streetview) UC.streetview.apagar();
    if(activo){ activo.desactivar && activo.desactivar(); activo.panel.classList.remove('activo'); activo.resultados && activo.resultados.classList.remove('activo'); activo._boton.classList.remove('activo'); }
    UC.interaccion.limpiar();
    UC.el('map').className = '';
    activo = m;
    m._boton.classList.add('activo');
    m.panel.classList.add('activo');
    if(m.resultados){ m.resultados.classList.add('activo'); UC.el('results').classList.add('show'); }
    else UC.el('results').classList.remove('show');
    m.activar && m.activar();
    try{ history.replaceState(null, '', '?modulo=' + m.id); }catch(_){}
  }

  function habilitar(){ lista.forEach(m => m._boton.disabled = !UC.red.cargada()); }

  /* ── Panel de capas ── */
  function construirCapas(){
    const p = UC.el('capas-panel'); p.innerHTML = '';
    const grupos = [{ nombre:'Base', capas:[{ nombre:'Red vial', visible:() => UC.red.visible(), cambiar:v => UC.red.visible(v) }] }]
      .concat(lista.filter(m => m.capas && m.capas.length).map(m => ({ nombre:m.nombre, capas:m.capas })));
    grupos.forEach(g => {
      const d = document.createElement('div'); d.className = 'grupo';
      const h = document.createElement('h3'); h.textContent = g.nombre; d.appendChild(h);
      g.capas.forEach(c => {
        const row = document.createElement('div'); row.className = 'switch-row';
        const s = document.createElement('span'); s.textContent = c.nombre;
        const lab = document.createElement('label'); lab.className = 'switch';
        const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!c.visible();
        inp.addEventListener('change', () => c.cambiar(inp.checked));
        const tr = document.createElement('span'); tr.className = 'track';
        lab.append(inp, tr); row.append(s, lab); d.appendChild(row);
      });
      p.appendChild(d);
    });
  }
  UC.el('capas-btn').addEventListener('click', e => {
    e.stopPropagation();
    const p = UC.el('capas-panel');
    if(!p.classList.contains('show')) construirCapas();
    p.classList.toggle('show');
  });
  document.addEventListener('click', e => { if(!e.target.closest('#capas-panel') && !e.target.closest('#capas-btn')) UC.el('capas-panel').classList.remove('show'); });

  /* ── Menú Exportar: proyecto + lo que aporte cada módulo ── */
  function construirExportar(){
    const menu = UC.el('export-menu'); menu.innerHTML = '';
    const agregar = (it) => {
      const b = document.createElement('button');
      b.innerHTML = `<span><i class="fa-solid ${it.icono}"></i></span>`;
      b.firstChild.append(it.titulo);
      if(it.sub){ const s = document.createElement('span'); s.className = 'menu-sub'; s.textContent = it.sub; b.appendChild(s); }
      b.addEventListener('click', () => { menu.classList.remove('show'); it.accion(); });
      menu.appendChild(b);
    };
    const titulo = t => { const d = document.createElement('div'); d.className = 'menu-titulo'; d.textContent = t; menu.appendChild(d); };
    titulo('Proyecto');
    agregar({ icono:'fa-floppy-disk', titulo:'Guardar proyecto', sub:'.json — red y todo lo trabajado en los módulos', accion:() => UC.proyecto.guardar() });
    lista.forEach(m => {
      const items = m.exportar ? m.exportar() : [];
      if(!items.length) return;
      const div = document.createElement('div'); div.className = 'menu-divider'; menu.appendChild(div);
      titulo(m.nombre);
      items.forEach(agregar);
    });
  }
  UC.el('btn-export').addEventListener('click', e => {
    e.stopPropagation();
    const menu = UC.el('export-menu');
    if(!menu.classList.contains('show')) construirExportar();
    menu.classList.toggle('show');
  });
  document.addEventListener('click', e => { if(!e.target.closest('#btn-export') && !UC.el('export-menu').contains(e.target)) UC.el('export-menu').classList.remove('show'); });

  UC.modulos = {
    registrar, activar, habilitar,
    activo:() => activo,
    lista:() => lista.slice(),
    get:id => lista.find(m => m.id === id),
    // Dónde se usa un tramo, preguntando a todos los módulos
    usosDeTramo:id => lista.flatMap(m => m.usosDeTramo ? m.usosDeTramo(id) : [])
  };
})();
