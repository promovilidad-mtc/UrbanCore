'use strict';
/* ══════════════════════════════════════════════════════════════════
   MÓDULO ATRIBUTOS — ver y editar los datos de cada capa (como la tabla de atributos de QGIS)
   - Red vial: clic en un tramo → su ficha. Los cambios van directo a las properties de la red,
     así se guardan con el proyecto y salen en el GeoJSON de la red. La jerarquía se edita como un campo más.
   - Rutas: clic en cualquier tramo elige la ruta completa (nombre, color y campos propios en r.atributos).
   - Corredores (de Cobertura): igual que las rutas (campos propios en c.atributos).
   La tabla de abajo muestra todos los elementos de la capa: filtrar, ordenar, editar en la celda,
   asignar un valor a todos los filtrados y exportar a Excel.
   Guarda en el proyecto: { campos:{ red:[...], rutas:[...], corredores:[...] } }
   (los campos agregados a mano; los valores viven en cada capa)
   ══════════════════════════════════════════════════════════════════ */
(function(){
  const map = UC.mapa.map, el = UC.el, U = UC.util;
  const POR_PAGINA = 100;
  const COLOR_SEL = '#06b6d4';

  let capa = 'red', sel = null, opciones = [], activo = false, propio = false;
  let extras = { red:[], rutas:[], corredores:[], paraderos:[] };
  let tablaAbierta = false, pagina = 0, filtro = '', orden = null, filas = [];
  let camposRedCache = null;

  const selRenderer = UC.mapa.lienzo('selPane');
  const selGrupo = L.layerGroup().addTo(map);
  const collator = new Intl.Collator('es', { numeric:true, sensitivity:'base' });

  /* ── Valores: lo que se escribe respeta el tipo que tenía el dato (número sigue siendo número) ── */
  function convertir(txt, antes){
    const t = String(txt).trim();
    if(t === '') return null;
    if(typeof antes === 'number'){ const n = Number(t.replace(',', '.')); if(!isNaN(n)) return n; }
    if(typeof antes === 'boolean' && /^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
    return t;
  }
  const mostrar = v => v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  const esObjeto = v => v !== null && typeof v === 'object';

  /* ── Capas: qué se lista, qué campos fijos tiene y cómo se avisa de un cambio ──
     datos(it) → campos propios para leer · props(it) → el mismo objeto para escribir (lo crea si falta) */
  const pasaPor = (r, si) => r.ida.some(s => s.segId === si.segId) || r.vuelta.some(s => s.segId === si.segId);
  const trazosDe = ids => ids.map(id => UC.red.porId.get(id)).filter(Boolean).map(si => si.latlngs);
  const CAPAS = {
    red:{
      nombre:'Red vial', plural:'tramos', ninguno:'',
      lista:() => UC.red.segs,
      titulo:si => U.nombreVia(si.props) || 'Tramo sin nombre',
      datos:si => si.props,
      // Si el feature no traía properties, se enlaza el objeto del tramo para que lo editado se guarde
      props(si){ const f = UC.red.features[si.fi]; if(f && !f.properties) f.properties = si.props; return si.props; },
      fijos:[
        { t:'Km', get:si => +si.km.toFixed(3) },
        { t:'Jerarquía', tipo:'jer', get:si => UC.jerarquia ? UC.jerarquia.tipo(si.segId) : 'local',
          set:(si, v) => UC.jerarquia.asignar(si.segId, v), sinAviso:true }
      ],
      trazos:si => [si.latlngs],
      desdeTramo:si => [si],
      avisar(){ UC.eventos.emit('red:atributos', {}); },
      ayuda:'Clic sobre un tramo para ver y editar sus datos. Lo editado se guarda con el proyecto y sale en <b>Exportar → Red vial GeoJSON</b>.',
      vacioCon:'Clic sobre un tramo del mapa para ver sus datos, o abrí la tabla.', vacioSin:''
    },
    rutas:{
      nombre:'Rutas', plural:'rutas', ninguno:'Ese tramo no es parte de ninguna ruta.',
      lista:() => UC.rutas ? UC.rutas.lista() : [],
      titulo:r => r.nombre,
      datos:r => r.atributos || {},
      props:r => r.atributos || (r.atributos = {}),
      fijos:[
        { t:'Nombre', tipo:'texto', get:r => r.nombre, set:(r, v) => { if(v) r.nombre = v; } },
        { t:'Color', tipo:'color', get:r => r.color, set:(r, v) => { r.color = v; } },
        { t:'Km ida', get:r => +UC.rutas.km(r, 'ida').toFixed(2) },
        { t:'Km vuelta', get:r => +UC.rutas.km(r, 'vuelta').toFixed(2) },
        { t:'Tramos', get:r => r.ida.length + r.vuelta.length }
      ],
      trazos:r => trazosDe([...r.ida, ...r.vuelta].map(s => s.segId)),
      desdeTramo:si => UC.rutas.lista().filter(r => pasaPor(r, si)),
      avisar(){ UC.rutas.refrescar(); propio = true; UC.eventos.emit('rutas:cambiadas', {}); propio = false; UC.actualizarEstado(); },
      ayuda:'Clic sobre cualquier tramo de una ruta la elige completa. Los campos propios salen en <b>Exportar → Rutas GeoJSON</b>.',
      vacioCon:'Clic sobre un tramo de una ruta para elegirla completa, o abrí la tabla.', vacioSin:'Todavía no hay rutas: crealas en el módulo Rutas.'
    },
    corredores:{
      nombre:'Corredores', plural:'corredores', ninguno:'Ese tramo no es parte de ningún corredor.',
      lista:() => UC.cobertura ? UC.cobertura.lista() : [],
      titulo:c => c.nombre,
      datos:c => c.atributos || {},
      props:c => c.atributos || (c.atributos = {}),
      fijos:[
        { t:'Nombre', tipo:'texto', get:c => c.nombre, set:(c, v) => { if(v) c.nombre = v; } },
        { t:'Km', get:c => +c.kmTotal.toFixed(2) },
        { t:'Km ida', get:c => +c.kmIda.toFixed(2) },
        { t:'Km vuelta', get:c => +c.kmVuelta.toFixed(2) },
        { t:'Tramos', get:c => c.todos.size }
      ],
      trazos:c => trazosDe([...c.todos]),
      desdeTramo:si => UC.cobertura.lista().filter(c => c.todos.has(si.segId)),
      avisar(){ UC.cobertura.refrescar(); },
      ayuda:'Corredores cargados en el módulo Cobertura. Clic sobre un tramo del corredor para elegirlo.',
      vacioCon:'Clic sobre un tramo de un corredor para elegirlo completo, o abrí la tabla.', vacioSin:'No hay corredores: cargalos en el módulo Cobertura.'
    },
    paraderos:{
      nombre:'Paraderos', plural:'paraderos', ninguno:'No hay paraderos en ese tramo.',
      lista:() => UC.paraderos ? UC.paraderos.lista() : [],
      titulo:p => UC.paraderos.titulo(p),
      // Existentes: sus datos originales del archivo · propuestos: campos propios
      datos:p => (p.tipo === 'existente' ? p.props : p.atributos) || {},
      props:p => p.tipo === 'existente' ? (p.props || (p.props = {})) : (p.atributos || (p.atributos = {})),
      fijos:[
        { t:'Tipo', get:p => p.tipo === 'existente' ? 'Existente' : 'Propuesto' },
        { t:'Nombre', tipo:'texto', get:p => p.nombre, set:(p, v) => { p.nombre = v; } },
        { t:'Estado', get:p => UC.paraderos.estadoTxt(p) },
        { t:'Jerarquía', get:p => UC.paraderos.jerarquiaTxt(p) },
        { t:'Sentido', get:p => UC.paraderos.sentidoTxt(p) },
        { t:'Rutas', get:p => UC.paraderos.rutasTxt(p) }
      ],
      trazos:p => [[UC.paraderos.posicion(p)]],
      desdeTramo:si => UC.paraderos.lista().filter(p => p.segId === si.segId),
      avisar(){ propio = true; UC.paraderos.refrescar(); propio = false; },
      ayuda:'Paraderos del módulo Paraderos: existentes (con los datos de su archivo) y propuestos. Clic sobre un tramo para ver los que tiene.',
      vacioCon:'Clic sobre un tramo con paraderos para verlos, o abrí la tabla.', vacioSin:'No hay paraderos: cargalos o proponelos en el módulo Paraderos.'
    }
  };

  // Campos propios de una capa: todos los que aparecen en algún elemento + los agregados a mano
  function campos(id){
    if(id === 'red' && camposRedCache) return camposRedCache;
    const C = CAPAS[id], s = new Set();
    C.lista().forEach(it => Object.keys(C.datos(it)).forEach(k => s.add(k)));
    extras[id].forEach(k => s.add(k));
    const out = [...s];
    if(id === 'red') camposRedCache = out;
    return out;
  }

  /* ── Panel izquierdo: elegir capa + ficha del elemento elegido ── */
  const panel = document.createElement('div');
  panel.innerHTML = `
    <div class="panel-pad">
      <div class="modulo-titulo"><div class="ico"><i class="fa-solid fa-table-list"></i></div><span>Atributos</span></div>
      <div class="seg-toggle" id="at-capa">
        <button data-capa="red" class="active">Red</button>
        <button data-capa="rutas">Rutas</button>
        <button data-capa="corredores">Corredores</button>
        <button data-capa="paraderos">Paraderos</button>
      </div>
      <button class="btn primary" id="at-tabla" style="width:100%;justify-content:center;margin-bottom:12px"><i class="fa-solid fa-table"></i> Abrir tabla</button>
      <div id="at-ficha"></div>
      <div class="hint" id="at-ayuda" style="margin-top:12px"></div>
    </div>`;

  /* ── Edición ── (desde: 'ficha' | 'tabla', para refrescar solo la otra vista y no perder el foco) */
  function trasEditar(it, desde){
    if(desde !== 'ficha' && it === sel) renderFicha();
    if(desde !== 'tabla' && tablaAbierta) renderPagina();
    if(desde === 'ficha' && it === sel){ const t = panel.querySelector('.at-ficha-titulo'); if(t) t.textContent = CAPAS[capa].titulo(it); }
  }
  function editar(it, k, txt, desde){
    const C = CAPAS[capa], p = C.props(it), antes = p[k], v = convertir(txt, antes);
    if(v === antes || (v === null && antes === undefined)) return;
    p[k] = v;
    C.avisar(); trasEditar(it, desde);
  }
  function editarFijo(it, f, v, desde){
    f.set(it, v);
    if(!f.sinAviso) CAPAS[capa].avisar();
    trasEditar(it, desde);
  }

  function control(it, f, desde){
    let inp;
    if(f.tipo === 'jer'){
      inp = document.createElement('select');
      Object.entries(UC.jerarquia.LABELS).forEach(([k, t]) => { const o = document.createElement('option'); o.value = k; o.textContent = t; inp.appendChild(o); });
      inp.value = f.get(it);
    }else{
      inp = document.createElement('input');
      inp.type = f.tipo === 'color' ? 'color' : 'text';
      inp.value = mostrar(f.get(it));
      if(!f.set){ inp.readOnly = true; inp.tabIndex = -1; }
    }
    inp.className = f.tipo === 'color' ? 'at-color' : 'at-input';
    if(f.set) inp.addEventListener('change', () => editarFijo(it, f, inp.value.trim(), desde));
    return inp;
  }
  function controlCampo(it, k, desde){
    const v = CAPAS[capa].datos(it)[k];
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'at-input'; inp.value = mostrar(v);
    if(esObjeto(v)){ inp.readOnly = true; inp.title = 'Dato compuesto: solo lectura'; }
    else inp.addEventListener('change', () => editar(it, k, inp.value, desde));
    return inp;
  }

  function agregarCampo(nombre){
    const k = String(nombre || '').trim(); if(!k) return false;
    if(campos(capa).includes(k)){ UC.ui.instruccion(`El campo "${k}" ya existe en ${CAPAS[capa].nombre}.`); return false; }
    extras[capa].push(k); camposRedCache = null;
    renderFicha(); if(tablaAbierta) renderTabla();
    UC.ui.instruccion(`Campo "${k}" agregado a ${CAPAS[capa].nombre}.`);
    return true;
  }
  function filaAgregar(){
    const d = document.createElement('div'); d.className = 'at-nuevo';
    const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'at-input'; inp.placeholder = 'Nuevo campo (ej: carriles)';
    const b = document.createElement('button'); b.className = 'btn'; b.innerHTML = '<i class="fa-solid fa-plus"></i> Campo';
    const ok = () => { if(agregarCampo(inp.value)) inp.value = ''; };
    b.addEventListener('click', ok);
    inp.addEventListener('keydown', e => { if(e.key === 'Enter') ok(); });
    d.append(inp, b);
    return d;
  }
  function fila(etiqueta, ctrl, fijo){
    const d = document.createElement('div'); d.className = 'at-campo' + (fijo ? ' fijo' : '');
    const l = document.createElement('label'); l.textContent = etiqueta; l.title = etiqueta;
    d.append(l, ctrl);
    return d;
  }

  function renderFicha(){
    const box = el('at-ficha'); box.innerHTML = '';
    const C = CAPAS[capa];
    el('at-ayuda').innerHTML = C.ayuda;
    if(opciones.length > 1){
      const d = document.createElement('div'); d.className = 'at-opciones';
      const h = document.createElement('div'); h.className = 'hint'; h.textContent = `Por este tramo pasan ${opciones.length} ${C.plural}:`;
      d.appendChild(h);
      opciones.forEach(it => {
        const b = document.createElement('button'); b.className = 'at-chip' + (it === sel ? ' activo' : '');
        b.textContent = C.titulo(it);
        b.addEventListener('click', () => seleccionar(it, false));
        d.appendChild(b);
      });
      box.appendChild(d);
    }
    if(!sel){
      const e = document.createElement('div'); e.className = 'empty-hint';
      e.innerHTML = '<span class="ico"><i class="fa-solid fa-hand-pointer"></i></span>';
      e.append(C.lista().length ? C.vacioCon : C.vacioSin);
      box.appendChild(e);
      return;
    }
    const tit = document.createElement('div'); tit.className = 'at-ficha-titulo'; tit.textContent = C.titulo(sel);
    box.appendChild(tit);
    C.fijos.forEach(f => box.appendChild(fila(f.t, control(sel, f, 'ficha'), true)));
    const ks = campos(capa);
    const sep = document.createElement('div'); sep.className = 'at-sep'; box.appendChild(sep);
    if(ks.length) ks.forEach(k => box.appendChild(fila(k, controlCampo(sel, k, 'ficha'))));
    else { const h = document.createElement('div'); h.className = 'hint'; h.textContent = 'Sin campos propios todavía. Agregá uno abajo.'; box.appendChild(h); }
    box.appendChild(filaAgregar());
    const acc = document.createElement('div'); acc.className = 'list-actions'; acc.style.marginTop = '12px';
    const bz = document.createElement('button'); bz.className = 'btn'; bz.innerHTML = '<i class="fa-solid fa-crosshairs"></i> Centrar';
    bz.addEventListener('click', () => dibujarSel(true));
    const bx = document.createElement('button'); bx.className = 'btn'; bx.innerHTML = '<i class="fa-solid fa-xmark"></i> Quitar selección';
    bx.addEventListener('click', () => { opciones = []; seleccionar(null); });
    acc.append(bz, bx); box.appendChild(acc);
  }

  /* ── Selección en el mapa ── */
  function dibujarSel(zoom){
    selGrupo.clearLayers();
    if(!sel || !activo) return;
    const b = L.latLngBounds([]);
    CAPAS[capa].trazos(sel).forEach(ll => {
      // Un solo punto (paradero): anillo alrededor; si no, la línea
      if(ll.length === 1) L.circleMarker(ll[0], { renderer:selRenderer, interactive:false, radius:17, color:COLOR_SEL, weight:3, fill:false }).addTo(selGrupo);
      else L.polyline(ll, { renderer:selRenderer, interactive:false, color:COLOR_SEL, weight:7, opacity:0.8 }).addTo(selGrupo);
      ll.forEach(p => b.extend(p));
    });
    if(zoom && b.isValid()) map.fitBounds(b, { paddingTopLeft:[320, 110], paddingBottomRight:[60, tablaAbierta ? tabla.offsetHeight + 40 : 60], maxZoom:17 });
  }
  function seleccionar(it, zoom){
    sel = it || null;
    if(!opciones.includes(sel)) opciones = [];
    dibujarSel(zoom); renderFicha();
    if(tablaAbierta) tabla.querySelectorAll('tbody tr').forEach(r => r.classList.toggle('sel', r._it === sel));
  }
  // Tras elegir en el mapa, la tabla salta a la página de ese elemento
  function irAFila(it){
    const i = filas.findIndex(x => x.it === it); if(i === -1) return;
    const p = Math.floor(i / POR_PAGINA);
    if(p !== pagina){ pagina = p; renderPagina(); }
    const r = [...tabla.querySelectorAll('tbody tr')].find(x => x._it === it);
    if(r) r.scrollIntoView({ block:'nearest' });
  }

  /* ── Tabla de atributos (abajo, a lo ancho) ── */
  const tabla = document.createElement('div'); tabla.id = 'at-tabla-panel';
  tabla.innerHTML = `
    <div class="at-t-hd">
      <div class="at-t-tit"><i class="fa-solid fa-table"></i><span id="at-t-nombre"></span><span class="at-t-cuenta" id="at-t-cuenta"></span></div>
      <div class="search-box"><input type="text" id="at-t-buscar" placeholder="Filtrar por cualquier dato…"></div>
      <button class="btn" id="at-t-masivo-btn" title="Poner el mismo valor a todos los elementos filtrados"><i class="fa-solid fa-pen-to-square"></i> Asignar a filtrados</button>
      <button class="btn" id="at-t-excel" title="Exportar lo filtrado a Excel"><i class="fa-solid fa-file-excel"></i> Excel</button>
      <div class="at-t-pag">
        <button class="btn" id="at-t-prev" title="Página anterior"><i class="fa-solid fa-chevron-left"></i></button>
        <span id="at-t-pagtxt"></span>
        <button class="btn" id="at-t-next" title="Página siguiente"><i class="fa-solid fa-chevron-right"></i></button>
      </div>
      <button class="btn" id="at-t-cerrar" title="Cerrar tabla"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="at-masivo" id="at-masivo" hidden>
      <span>Asignar a los <b id="at-m-n">0</b> filtrados:</span>
      <select id="at-m-campo" class="at-input"></select>
      <input type="text" id="at-m-valor" class="at-input" placeholder="Valor (vacío = borrar)">
      <select id="at-m-jer" class="at-input" hidden></select>
      <button class="btn primary" id="at-m-aplicar">Aplicar</button>
    </div>
    <div class="at-t-wrap"><table class="at-t"><thead></thead><tbody></tbody></table></div>`;
  document.body.appendChild(tabla);

  const colsDe = id => [{ id:'#', t:'#' }]
    .concat(CAPAS[id].fijos.map((f, i) => ({ id:'f' + i, t:f.t, f })), campos(id).map(k => ({ id:'c:' + k, t:k, k })));
  function valorCol(it, col){
    if(col.startsWith('f')) return CAPAS[capa].fijos[+col.slice(1)].get(it);
    return CAPAS[capa].datos(it)[col.slice(2)];
  }
  function cmp(a, b){
    a = mostrar(a); b = mostrar(b);
    if(a === '' || b === '') return a === b ? 0 : a === '' ? 1 : -1;   // vacíos al final
    const na = Number(a), nb = Number(b);
    if(!isNaN(na) && !isNaN(nb)) return na - nb;
    return collator.compare(a, b);
  }
  function filtrar(){
    const C = CAPAS[capa], q = filtro.toLowerCase().trim(), ks = campos(capa);
    let l = C.lista().map((it, i) => ({ it, i }));
    if(q){
      const tiene = v => mostrar(v).toLowerCase().includes(q);
      l = l.filter(({ it }) => tiene(C.titulo(it)) || C.fijos.some(f => tiene(f.tipo === 'jer' ? UC.jerarquia.LABELS[f.get(it)] : f.get(it))) || ks.some(k => tiene(C.datos(it)[k])));
    }
    if(orden) l.sort((a, b) => cmp(valorCol(a.it, orden.col), valorCol(b.it, orden.col)) * orden.dir);
    filas = l;
    pagina = Math.min(pagina, Math.max(0, Math.ceil(filas.length / POR_PAGINA) - 1));
  }
  function renderTabla(){ filtrar(); renderPagina(); llenarMasivo(); }
  function renderPagina(){
    const C = CAPAS[capa], cols = colsDe(capa), total = C.lista().length;
    el('at-t-nombre').textContent = C.nombre;
    el('at-t-cuenta').textContent = filas.length === total ? `${U.fmtNum(total)} ${C.plural}` : `${U.fmtNum(filas.length)} de ${U.fmtNum(total)} ${C.plural}`;
    const pags = Math.max(1, Math.ceil(filas.length / POR_PAGINA));
    el('at-t-pagtxt').textContent = `${pagina + 1} / ${pags}`;
    el('at-t-prev').disabled = pagina === 0; el('at-t-next').disabled = pagina >= pags - 1;
    el('at-m-n').textContent = U.fmtNum(filas.length);

    const thead = tabla.querySelector('thead'), tbody = tabla.querySelector('tbody');
    const hr = document.createElement('tr');
    cols.forEach(c => {
      const th = document.createElement('th');
      th.textContent = c.t + (orden && orden.col === c.id ? (orden.dir > 0 ? ' ▲' : ' ▼') : '');
      th.title = c.id === '#' ? 'Orden original' : 'Ordenar por ' + c.t;
      th.addEventListener('click', () => ordenar(c.id));
      hr.appendChild(th);
    });
    thead.innerHTML = ''; thead.appendChild(hr);

    tbody.innerHTML = '';
    if(!filas.length){
      const tr = document.createElement('tr'), td = document.createElement('td');
      td.colSpan = cols.length; td.className = 'at-t-vacio';
      td.textContent = total ? `Ningún elemento coincide con "${filtro}".` : `No hay ${C.plural} en esta capa.`;
      tr.appendChild(td); tbody.appendChild(tr);
      return;
    }
    const frag = document.createDocumentFragment();
    filas.slice(pagina * POR_PAGINA, (pagina + 1) * POR_PAGINA).forEach(({ it, i }) => {
      const tr = document.createElement('tr'); tr._it = it;
      if(it === sel) tr.className = 'sel';
      cols.forEach(c => {
        const td = document.createElement('td');
        if(c.id === '#'){ td.textContent = i + 1; td.title = 'Ver en el mapa'; }
        else td.appendChild(c.f ? control(it, c.f, 'tabla') : controlCampo(it, c.k, 'tabla'));
        tr.appendChild(td);
      });
      // Clic en la fila: la elige; clic en el número además centra el mapa
      tr.addEventListener('click', e => {
        const enCampo = e.target.closest('input,select');
        if(it !== sel || !enCampo){ opciones = []; seleccionar(it, !enCampo); }
      });
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }
  function ordenar(col){
    if(col === '#') orden = null;
    else if(orden && orden.col === col) orden = orden.dir > 0 ? { col, dir:-1 } : null;
    else orden = { col, dir:1 };
    pagina = 0; renderTabla();
  }
  function abrirTabla(on){
    tablaAbierta = on;
    tabla.classList.toggle('show', on && activo);
    document.body.classList.toggle('at-tabla-on', on && activo);
    el('at-tabla').innerHTML = `<i class="fa-solid fa-table"></i> ${on ? 'Cerrar tabla' : 'Abrir tabla'}`;
    if(on && activo){ renderTabla(); if(sel) irAFila(sel); }
    else el('at-masivo').hidden = true;
  }
  panel.querySelector('#at-tabla').addEventListener('click', () => abrirTabla(!tablaAbierta));
  tabla.querySelector('#at-t-cerrar').addEventListener('click', () => abrirTabla(false));
  tabla.querySelector('#at-t-prev').addEventListener('click', () => { if(pagina > 0){ pagina--; renderPagina(); } });
  tabla.querySelector('#at-t-next').addEventListener('click', () => { if((pagina + 1) * POR_PAGINA < filas.length){ pagina++; renderPagina(); } });
  let tFiltro = 0;
  tabla.querySelector('#at-t-buscar').addEventListener('input', e => {
    clearTimeout(tFiltro); const v = e.target.value;
    tFiltro = setTimeout(() => { filtro = v; pagina = 0; filtrar(); renderPagina(); }, 200);
  });
  tabla.querySelector('#at-t-excel').addEventListener('click', () => excel(capa, filas.map(x => x.it)));

  /* ── Asignar un valor a todos los filtrados ── */
  function llenarMasivo(){
    const s = el('at-m-campo'), antes = s.value; s.innerHTML = '';
    const opt = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; s.appendChild(o); };
    if(capa === 'red') opt('jer', 'Jerarquía');
    campos(capa).forEach(k => opt('c:' + k, k));
    if([...s.options].some(o => o.value === antes)) s.value = antes;
    const j = el('at-m-jer');
    if(!j.options.length) Object.entries(UC.jerarquia.LABELS).forEach(([k, t]) => { const o = document.createElement('option'); o.value = k; o.textContent = t; j.appendChild(o); });
    cambiarCampoMasivo();
  }
  function cambiarCampoMasivo(){
    const esJer = el('at-m-campo').value === 'jer';
    el('at-m-jer').hidden = !esJer; el('at-m-valor').hidden = esJer;
  }
  el('at-m-campo').addEventListener('change', cambiarCampoMasivo);
  tabla.querySelector('#at-t-masivo-btn').addEventListener('click', () => {
    const m = el('at-masivo'); m.hidden = !m.hidden;
    if(!m.hidden){ llenarMasivo(); if(!el('at-m-campo').options.length) UC.ui.instruccion('Agregá un campo primero (ficha de la izquierda).'); }
  });
  tabla.querySelector('#at-m-aplicar').addEventListener('click', () => {
    const C = CAPAS[capa], key = el('at-m-campo').value, items = filas.map(x => x.it);
    if(!key || !items.length) return;
    const esJer = key === 'jer', txt = esJer ? el('at-m-jer').value : el('at-m-valor').value;
    const campo = esJer ? 'Jerarquía' : key.slice(2);
    const valorTxt = esJer ? UC.jerarquia.LABELS[txt] : (txt.trim() || '(vacío)');
    if(!confirm(`Asignar "${valorTxt}" en el campo "${campo}" a ${U.fmtNum(items.length)} ${C.plural}${filtro ? ' filtrados' : ' (toda la capa)'}.\n\n¿Continuar?`)) return;
    if(esJer) UC.jerarquia.asignar(items.map(si => si.segId), txt);
    else {
      const k = key.slice(2);
      items.forEach(it => { const p = C.props(it), v = convertir(txt, p[k]); if(!(v === null && p[k] === undefined)) p[k] = v; });
      C.avisar();
    }
    renderTabla(); renderFicha(); dibujarSel(false);
    UC.ui.instruccion(`"${campo}" = ${valorTxt} en ${U.fmtNum(items.length)} ${C.plural}.`);
  });

  /* ── Excel ── */
  function excel(id, lista){
    const C = CAPAS[id], ks = campos(id);
    if(!lista.length){ alert(`No hay ${C.plural} para exportar.`); return; }
    const aoa = [C.fijos.map(f => f.t).concat(ks)];
    lista.forEach(it => aoa.push(
      C.fijos.map(f => { const v = f.get(it); return f.tipo === 'jer' ? UC.jerarquia.LABELS[v] : v; })
        .concat(ks.map(k => { const v = C.datos(it)[k]; return esObjeto(v) ? JSON.stringify(v) : (v === undefined ? null : v); }))));
    const wb = XLSX.utils.book_new(), ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = aoa[0].map(t => ({ wch:Math.max(10, String(t).length + 2) }));
    XLSX.utils.book_append_sheet(wb, ws, C.nombre);
    XLSX.writeFile(wb, `atributos-${id}-${U.fecha()}.xlsx`);
  }

  /* ── Elegir capa ── */
  function setCapa(id){
    capa = id; sel = null; opciones = [];
    filtro = ''; orden = null; pagina = 0; el('at-t-buscar').value = '';
    panel.querySelectorAll('#at-capa button').forEach(b => b.classList.toggle('active', b.dataset.capa === id));
    selGrupo.clearLayers(); renderFicha();
    if(tablaAbierta) renderTabla();
  }
  panel.querySelectorAll('#at-capa button').forEach(b => b.addEventListener('click', () => setCapa(b.dataset.capa)));

  /* ── Lo elegido puede haber dejado de existir (tramo borrado, ruta eliminada…) ── */
  function validar(){
    if(capa === 'red' && sel) sel = UC.red.porId.get(sel.segId) || null;
    else if(sel && !CAPAS[capa].lista().includes(sel)) sel = null;
    opciones = opciones.filter(it => CAPAS[capa].lista().includes(it));
  }
  function refrescar(){
    if(!activo) return;
    validar(); renderFicha(); dibujarSel(false);
    if(tablaAbierta) renderTabla();
  }
  UC.eventos.on('red:cambiada', () => { camposRedCache = null; refrescar(); });
  UC.eventos.on('red:cargada', () => { camposRedCache = null; refrescar(); });
  UC.eventos.on('rutas:cambiadas', () => { if(!propio && capa === 'rutas') refrescar(); });
  UC.eventos.on('paraderos:cambiados', () => { if(!propio && capa === 'paraderos') refrescar(); });
  UC.eventos.on('proyecto:abierto', () => { camposRedCache = null; sel = null; opciones = []; refrescar(); });

  UC.modulos.registrar({
    id:'atributos', nombre:'Atributos', icono:'fa-table-list', titulo:'Ver y editar los datos de la red, las rutas y los corredores',
    panel, resultados:null,
    exportar:() => [
      { icono:'fa-file-excel', titulo:'Atributos de la red (Excel)', sub:'.xlsx — un tramo por fila, con su jerarquía', accion:() => excel('red', UC.red.segs) }
    ].concat(UC.rutas && UC.rutas.cantidad() ? [{ icono:'fa-file-excel', titulo:'Atributos de rutas (Excel)', sub:'.xlsx — una ruta por fila', accion:() => excel('rutas', UC.rutas.lista()) }] : []),
    activar(){
      activo = true; validar(); renderFicha(); dibujarSel(false); abrirTabla(tablaAbierta);
      UC.ui.instruccion(`Atributos (${CAPAS[capa].nombre}): clic sobre el mapa para ver y editar · Abrir tabla para ver todo`);
    },
    desactivar(){
      activo = false; selGrupo.clearLayers();
      tabla.classList.remove('show'); document.body.classList.remove('at-tabla-on');
    },
    hoverTramos:true,
    alClic(si){
      if(!si) return;
      const ops = CAPAS[capa].desdeTramo(si);
      if(!ops.length){ UC.ui.instruccion(CAPAS[capa].ninguno); return; }
      opciones = ops.length > 1 ? ops : [];
      seleccionar(ops.includes(sel) && capa !== 'red' ? sel : ops[0], false);
      if(tablaAbierta) irAFila(sel);
    },
    serializar:() => Object.values(extras).some(a => a.length) ? { campos:extras } : null,
    cargar(d){
      const c = (d && d.campos) || {};
      extras = { red:[].concat(c.red || []), rutas:[].concat(c.rutas || []), corredores:[].concat(c.corredores || []), paraderos:[].concat(c.paraderos || []) };
      sel = null; opciones = []; camposRedCache = null; selGrupo.clearLayers();
    }
  });
})();
