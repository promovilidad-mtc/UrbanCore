'use strict';
/* ══════════════════════════════════════════════════════════════════
   MÓDULO PARADEROS — evaluación de paraderos propuestos (antes: Evaluador de ParaderosCore)
   Un paradero = un punto sobre un tramo de la red + su sentido de circulación:
     sentido  1 → circula A→B (en el orden de los vértices del tramo)
     sentido -1 → circula B→A          sentido 0 → sin definir (existente que cae sobre el eje)
   En Perú se circula por la derecha: un punto a la derecha del eje (A→B) sirve al sentido A→B.
   - Rutas que atiende: todas las variantes (ida/vuelta) que pasan por su tramo en su mismo sentido.
     Por eso un paradero de la ida y uno de la vuelta frente a frente no se molestan.
   - Espaciamiento: distancia al paradero anterior y al siguiente sobre el recorrido de cada ruta
     (si por el tramo no pasa ninguna, a lo largo de la vía en su sentido). Rango según la jerarquía
     del tramo; el estado del paradero es el peor caso entre sus rutas.
   - Existentes: referencia (y, si se elige, también cuentan para el espaciamiento).
   - Cobertura caminando por la red (300 / 500 m) y equipamientos urbanos cerca de un paradero.
   Guarda en el proyecto: { rangos, opciones, existentes, propuestos, categorias }
   ══════════════════════════════════════════════════════════════════ */
(function(){
  const map = UC.mapa.map, el = UC.el, U = UC.util, esc = U.escapeHtml;
  const RANGOS_DEF = { expresa:{ min:400, max:500 }, arterial:{ min:300, max:500 }, local:{ min:200, max:500 } };
  const ESTADO = {
    ok:   { txt:'Rango OK',   color:'#16a34a' },
    cerca:{ txt:'Muy cerca',  color:'#dc2626' },
    lejos:{ txt:'Muy lejos',  color:'#d97706' },
    unico:{ txt:'Sin vecino', color:'#6366f1' }   // no hay otro paradero en su sentido a menos de 2 × el máximo
  };
  const PRIORIDAD = { cerca:3, lejos:2, ok:1, unico:0 };
  const CATEGORIAS_DEF = [
    { id:'salud', nombre:'Salud', color:'#e2483d' },
    { id:'educacion', nombre:'Educación', color:'#2563eb' },
    { id:'mercados', nombre:'Mercados', color:'#d97706' }
  ];
  const COLORES_EXTRA = ['#0891b2', '#7c3aed', '#db2777', '#16a34a', '#64748b', '#a16207'];
  const COLOR_EXIST = '#3b82f6', COLOR_ACEPTADO = '#15803d';
  const SNAP_EXIST_M = 60, SNAP_EQUIP_M = 150, SNAP_MOVER_M = 40, SIN_LADO_M = 1.5, OFFSET_PX = 10;
  const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  const clonar = o => JSON.parse(JSON.stringify(o));
  const fmtM = m => m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
  const largo = segId => { const si = UC.red.porId.get(segId); return si ? si.km * 1000 : 0; };

  let existentes = [], propuestos = [], categorias = [], rangos = clonar(RANGOS_DEF);
  let opc = { verExistentes:true, verPropuestos:true, considerarExistentes:true, verEquip:true, verCobertura:false };
  let agregando = false, activo = false, selId = null, rutaVista = '', undo = [];
  let porSeg = new Map(), cob = null;

  /* ══ Geometría ══ */
  // Proyección de un punto sobre un tramo: posición desde A (m), distancia al eje y lado (+1 = derecha de A→B)
  function proyectar(si, lat, lng){
    const ll = si.latlngs, kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
    let best = null, acum = 0;
    for(let i = 1; i < ll.length; i++){
      const ax = (ll[i-1][1] - lng) * kx, ay = (ll[i-1][0] - lat) * ky, bx = (ll[i][1] - lng) * kx, by = (ll[i][0] - lat) * ky;
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      const t = len === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (len * len)));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if(!best || d < best.d) best = { d, s:acum + t * len, lado:(dx * -ay - dy * -ax) < 0 ? 1 : -1 };
      acum += len;
    }
    best.s = acum > 0 ? best.s / acum * si.km * 1000 : 0;   // misma escala que si.km
    return best;
  }
  // Punto a s metros de A y rumbo del tramo ahí (grados, 0 = norte), en sentido A→B
  function puntoEn(si, s){
    const ll = si.latlngs, partes = []; let tot = 0;
    for(let i = 1; i < ll.length; i++){ const d = U.haversineKm(ll[i-1], ll[i]) * 1000; partes.push(d); tot += d; }
    let obj = tot > 0 ? Math.max(0, s) / (si.km * 1000) * tot : 0, i = 0;
    while(i < partes.length - 1 && obj > partes[i]){ obj -= partes[i]; i++; }
    const a = ll[i], b = ll[i+1], t = partes[i] ? Math.min(1, obj / partes[i]) : 0;
    const lat = a[0] + (b[0] - a[0]) * t, lng = a[1] + (b[1] - a[1]) * t;
    return { ll:[lat, lng], rumbo:Math.atan2((b[1] - a[1]) * Math.cos(lat * Math.PI / 180), b[0] - a[0]) * 180 / Math.PI };
  }
  // Parte de un tramo entre d0 y d1 metros desde A (para dibujar la cobertura)
  function subLinea(si, d0, d1){
    const ll = si.latlngs, L = si.km * 1000, out = [];
    const partes = []; let tot = 0;
    for(let i = 1; i < ll.length; i++){ const d = U.haversineKm(ll[i-1], ll[i]) * 1000; partes.push(d); tot += d; }
    const f = tot ? L / tot : 1; let acum = 0;
    for(let i = 1; i < ll.length; i++){
      const a = ll[i-1], b = ll[i], l = partes[i-1] * f, s0 = acum, s1 = acum + l;
      if(s1 >= d0 && s0 <= d1 && l > 0){
        const t0 = Math.max(0, (d0 - s0) / l), t1 = Math.min(1, (d1 - s0) / l);
        if(!out.length) out.push([a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0]);
        out.push([a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1]);
      }
      acum = s1;
    }
    return out;
  }
  const vector = (a, b) => [(b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180), b[0] - a[0]];
  function angulo(u, w){
    const c = (u[0] * w[0] + u[1] * w[1]) / ((Math.hypot(u[0], u[1]) * Math.hypot(w[0], w[1])) || 1);
    return Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
  }

  /* ══ Grafo de la red (nodos = extremos de tramos) — se arma una vez por red ══ */
  let grafo = null;
  function G(){
    if(grafo) return grafo;
    const nodo = new Map(), ady = [], coord = [], extremos = new Map();
    const id = p => { const k = p[0].toFixed(6) + ',' + p[1].toFixed(6); let i = nodo.get(k); if(i === undefined){ i = ady.length; nodo.set(k, i); ady.push([]); coord.push(p); } return i; };
    UC.red.segs.forEach(si => {
      const a = id(si.latlngs[0]), b = id(si.latlngs[si.latlngs.length - 1]), L = si.km * 1000;
      extremos.set(si.segId, [a, b]);
      ady[a].push({ si, otro:b, L, sale:1 });    // saliendo por A se recorre A→B
      ady[b].push({ si, otro:a, L, sale:-1 });
    });
    return (grafo = { ady, coord, extremos, n:ady.length });
  }
  // Montículo binario para Dijkstra
  function Heap(){ this.k = []; this.v = []; }
  Heap.prototype.push = function(k, x){
    const K = this.k, V = this.v; let i = K.length; K.push(k); V.push(x);
    while(i > 0){ const p = (i - 1) >> 1; if(K[p] <= k) break; K[i] = K[p]; V[i] = V[p]; i = p; }
    K[i] = k; V[i] = x;
  };
  Heap.prototype.pop = function(){
    const K = this.k, V = this.v, k0 = K[0], x0 = V[0], k = K.pop(), x = V.pop(), n = K.length;
    if(n){ let i = 0; for(;;){ let c = 2 * i + 1; if(c >= n) break; if(c + 1 < n && K[c + 1] < K[c]) c++; if(K[c] >= k) break; K[i] = K[c]; V[i] = V[c]; i = c; } K[i] = k; V[i] = x; }
    this.top = k0; return x0;
  };
  // Distancia caminando desde varios paraderos a cada nodo, hasta R metros
  function dijkstra(fuentes, R){
    const g = G(), dist = new Float64Array(g.n).fill(Infinity), h = new Heap();
    const sembrar = (n, d) => { if(d <= R && d < dist[n]){ dist[n] = d; h.push(d, n); } };
    fuentes.forEach(p => { const [a, b] = g.extremos.get(p.segId); sembrar(a, p.s); sembrar(b, largo(p.segId) - p.s); });
    while(h.k.length){
      const u = h.pop(), du = h.top; if(du > dist[u]) continue;
      for(const e of g.ady[u]){ const nd = du + e.L; if(nd <= R && nd < dist[e.otro]){ dist[e.otro] = nd; h.push(nd, e.otro); } }
    }
    return dist;
  }
  function distEn(dist, fporSeg, segId, s){
    const [a, b] = G().extremos.get(segId);
    let m = Math.min(dist[a] + s, dist[b] + largo(segId) - s);
    (fporSeg.get(segId) || []).forEach(q => { m = Math.min(m, Math.abs(q.s - s)); });
    return m;
  }
  function indexar(lista){
    const m = new Map();
    lista.forEach(p => { if(!p.segId) return; let a = m.get(p.segId); if(!a){ a = []; m.set(p.segId, a); } a.push(p); });
    return m;
  }

  /* ══ Rutas: cada variante en orden de recorrido, con el sentido en que cruza cada tramo ══
     Los tramos se guardan en el orden en que se clicaron: se reordenan siguiendo la conexión entre ellos. */
  let variantes = null;
  function ordenarVariante(ids){
    const g = G(), sis = ids.map(id => UC.red.porId.get(id)).filter(Boolean);
    const libres = new Set(sis.map((_, i) => i)), porNodo = new Map(), orden = [];
    sis.forEach((si, i) => g.extremos.get(si.segId).forEach(n => { let a = porNodo.get(n); if(!a){ a = []; porNodo.set(n, a); } a.push(i); }));
    const toca = (n, excepto) => (porNodo.get(n) || []).some(i => i !== excepto);
    let salida = null;
    while(libres.size){
      let sig = -1, entrada = null;
      if(salida !== null) (porNodo.get(salida) || []).forEach(i => { if(libres.has(i) && (sig === -1 || i < sig)){ sig = i; entrada = salida; } });
      if(sig === -1){
        sig = Math.min(...libres);
        const [a, b] = g.extremos.get(sis[sig].segId);
        if(salida === null){
          // primer tramo: se entra por el extremo que no sigue hacia el segundo tramo de la ruta
          const seg2 = sis[1] ? g.extremos.get(sis[1].segId) : [];
          entrada = seg2.includes(b) ? a : seg2.includes(a) ? b : (toca(b, sig) && !toca(a, sig)) ? a : (toca(a, sig) && !toca(b, sig)) ? b : a;
        }else{
          // hueco en la ruta: se entra por el extremo más cercano a donde quedó
          const p = g.coord[salida];
          entrada = U.haversineKm(p, g.coord[a]) <= U.haversineKm(p, g.coord[b]) ? a : b;
        }
      }
      const [a, b] = g.extremos.get(sis[sig].segId), dir = entrada === b && entrada !== a ? -1 : 1;
      libres.delete(sig); orden.push({ si:sis[sig], dir }); salida = dir === 1 ? b : a;
    }
    return orden;
  }
  function VARS(){
    if(variantes) return variantes;
    variantes = [];
    if(UC.rutas) UC.rutas.lista().forEach(r => ['ida', 'vuelta'].forEach(v => {
      if(!r[v].length) return;
      const orden = ordenarVariante(r[v].map(s => s.segId)), pos = new Map(); let km = 0;
      orden.forEach(o => { const L = o.si.km * 1000; pos.set(o.si.segId, { dir:o.dir, desde:km, L }); km += L; });
      variantes.push({ r, v, clave:r.id + '|' + v, nombre:`${r.nombre} — ${v}`, color:r.color, orden, pos, largo:km, lista:[] });
    }));
    return variantes;
  }
  // Sentidos en que las rutas recorren un tramo (para sugerir el sentido al ubicar un paradero)
  function sentidosRutas(segId){ const s = new Set(); VARS().forEach(V => { const o = V.pos.get(segId); if(o) s.add(o.dir); }); return s; }

  /* ══ Evaluación ══ */
  function rangoDe(p){
    const t = UC.jerarquia ? UC.jerarquia.tipo(p.segId) : 'local';
    return t === 'expresa' ? rangos.expresa : t === 'local' ? rangos.local : rangos.arterial;
  }
  const cuenta = (p, q) => p.tipo === 'existente' || opc.considerarExistentes || q.tipo === 'propuesto';

  // Siguiente (rel = 1) o anterior (rel = −1) paradero en el mismo sentido, a lo largo de la vía
  function caminar(p, rel, lim){
    const g = G(), sentido = p.sentido || 1, si0 = UC.red.porId.get(p.segId);
    let d = sentido * rel, mejor = null;
    (porSeg.get(p.segId) || []).forEach(q => {
      if(q === p || !cuenta(p, q) || !(q.sentido === sentido || q.sentido === 0)) return;
      const dist = d === 1 ? q.s - p.s : p.s - q.s;
      if(dist >= 0 && (!mejor || dist < mejor.d)) mejor = { p:q, d:dist };
    });
    if(mejor) return mejor.d <= lim ? mejor : null;
    let acum = d === 1 ? si0.km * 1000 - p.s : p.s, nodo = g.extremos.get(p.segId)[d === 1 ? 1 : 0], previo = si0;
    for(let vueltas = 0; acum < lim && vueltas < 200; vueltas++){
      const sig = continuar(previo, nodo, d); if(!sig) return null;
      const t = sig.si, L = t.km * 1000;
      let m = null;
      (porSeg.get(t.segId) || []).forEach(q => {
        if(!cuenta(p, q) || !(q.sentido === sig.dir * rel || q.sentido === 0)) return;
        const dq = sig.dir === 1 ? q.s : L - q.s;
        if(!m || dq < m.d) m = { p:q, d:dq };
      });
      if(m) return acum + m.d <= lim ? { p:m.p, d:acum + m.d } : null;
      acum += L; nodo = g.extremos.get(t.segId)[sig.dir === 1 ? 1 : 0]; previo = t; d = sig.dir;
    }
    return null;
  }
  // En una esquina, la vía sigue por el tramo con el mismo nombre (sin giros bruscos) o por el más recto
  function continuar(prev, nodo, d){
    const ll = prev.latlngs, n = ll.length;
    const ent = d === 1 ? vector(ll[n-2], ll[n-1]) : vector(ll[1], ll[0]);
    const nombre = U.nombreVia(prev.props).trim().toLowerCase();
    let conNombre = null, recto = null;
    G().ady[nodo].forEach(e => {
      if(e.si === prev) return;
      const l2 = e.si.latlngs, m = l2.length;
      const ang = angulo(ent, e.sale === 1 ? vector(l2[0], l2[1]) : vector(l2[m-1], l2[m-2]));
      if(nombre && ang < 80 && U.nombreVia(e.si.props).trim().toLowerCase() === nombre && (!conNombre || ang < conNombre.ang)) conNombre = { e, ang };
      if(!recto || ang < recto.ang) recto = { e, ang };
    });
    const x = conNombre || (recto && recto.ang < 35 ? recto : null);
    return x ? { si:x.e.si, dir:x.e.sale } : null;
  }

  function evaluar(){
    const todos = existentes.concat(propuestos).filter(p => p.segId);
    porSeg = indexar(todos);
    todos.forEach(p => { p.rutas = []; p.via = null; p.est = null; });
    // 1) Por cada variante: los paraderos que atiende, en orden de recorrido
    VARS().forEach(V => {
      V.lista = [];
      V.orden.forEach(o => (porSeg.get(o.si.segId) || []).forEach(p => {
        if(p.sentido === o.dir || p.sentido === 0) V.lista.push({ p, pos:V.pos.get(o.si.segId).desde + (o.dir === 1 ? p.s : o.si.km * 1000 - p.s) });
      }));
      V.lista.sort((a, b) => a.pos - b.pos);
      V.lista.forEach((x, i) => {
        let ant = null, sig = null;
        for(let j = i - 1; j >= 0; j--) if(cuenta(x.p, V.lista[j].p)){ ant = V.lista[j]; break; }
        for(let j = i + 1; j < V.lista.length; j++) if(cuenta(x.p, V.lista[j].p)){ sig = V.lista[j]; break; }
        x.p.rutas.push({ V, ant:ant && { p:ant.p, d:x.pos - ant.pos }, sig:sig && { p:sig.p, d:sig.pos - x.pos } });
      });
    });
    // 2) Sin rutas: a lo largo de la vía · 3) Estado = peor caso
    todos.forEach(p => {
      const r = rangoDe(p);
      if(!p.rutas.length){ const lim = r.max * 2; p.via = { ant:caminar(p, -1, lim), sig:caminar(p, 1, lim) }; }
      (p.rutas.length ? p.rutas : [p.via]).forEach(t => {
        const ds = [t.ant, t.sig].filter(Boolean).map(x => x.d);
        t.estado = !ds.length ? 'unico' : ds.some(d => d < r.min) ? 'cerca' : ds.some(d => d > r.max) ? 'lejos' : 'ok';
        if(!p.est || PRIORIDAD[t.estado] > PRIORIDAD[p.est]) p.est = t.estado;
      });
      p.rango = r;
    });
  }

  /* ══ Cobertura caminando (un solo Dijkstra para todos los paraderos) ══ */
  const fuentesCob = () => propuestos.concat(opc.considerarExistentes ? existentes : []).filter(p => p.segId);
  function intervalos(si, dist, fporSeg, R){
    const [a, b] = G().extremos.get(si.segId), L = si.km * 1000, iv = [];
    if(dist[a] < R) iv.push([0, R - dist[a]]);
    if(dist[b] < R) iv.push([L - (R - dist[b]), L]);
    (fporSeg.get(si.segId) || []).forEach(q => iv.push([q.s - R, q.s + R]));
    if(!iv.length) return iv;
    iv.forEach(x => { x[0] = Math.max(0, x[0]); x[1] = Math.min(L, x[1]); });
    iv.sort((x, y) => x[0] - y[0]);
    const out = [iv[0].slice()];
    for(let i = 1; i < iv.length; i++){ const u = out[out.length - 1]; if(iv[i][0] <= u[1]) u[1] = Math.max(u[1], iv[i][1]); else out.push(iv[i].slice()); }
    return out.filter(x => x[1] > x[0]);
  }
  const sumar = iv => iv.reduce((a, x) => a + x[1] - x[0], 0);
  function calcularCobertura(){
    const fuentes = fuentesCob();
    if(!fuentes.length || !UC.red.cargada()){ cob = null; return; }
    const dist = dijkstra(fuentes, 500), fporSeg = indexar(fuentes);
    let m300 = 0, m500 = 0, total = 0;
    const tramos = [];
    UC.red.segs.forEach(si => {
      total += si.km * 1000;
      const i5 = intervalos(si, dist, fporSeg, 500); if(!i5.length) return;
      const i3 = intervalos(si, dist, fporSeg, 300);
      m500 += sumar(i5); m300 += sumar(i3); tramos.push({ si, i3, i5 });
    });
    const equip = categorias.map(c => {
      let a300 = 0, a500 = 0, n = 0;
      c.puntos.forEach(q => { if(!q.segId) return; n++; const d = distEn(dist, fporSeg, q.segId, q.s) + q.off; if(d <= 300) a300++; if(d <= 500) a500++; });
      return { c, n, a300, a500 };
    });
    cob = { p300:total ? m300 / total * 100 : 0, p500:total ? m500 / total * 100 : 0, tramos, equip };
  }
  // Equipamientos a ≤300 / ≤500 m caminando de un paradero, con el más cercano de cada categoría
  function equipCerca(p){
    const dist = dijkstra([p], 500), f = indexar([p]);
    return categorias.filter(c => c.puntos.length).map(c => {
      let a300 = 0, a500 = 0, cerca = null;
      c.puntos.forEach(q => {
        if(!q.segId) return;
        const d = distEn(dist, f, q.segId, q.s) + q.off;
        if(d <= 300) a300++; if(d <= 500) a500++;
        if(d <= 500 && (!cerca || d < cerca.d)) cerca = { q, d };
      });
      return { c, a300, a500, cerca };
    });
  }

  /* ══ Ubicar paraderos sobre la red ══ */
  function ubicarExistente(e){
    const si = UC.red.cercanoMetros(e.lat, e.lng, SNAP_EXIST_M);
    if(!si){ e.segId = null; e.sentido = 0; return; }
    const pr = proyectar(si, e.lat, e.lng);
    if(!(e.sentidoManual && e.segId === si.segId)){ e.sentidoManual = false; e.sentido = pr.d < SIN_LADO_M ? 0 : pr.lado; }
    e.segId = si.segId; e.s = pr.s; e.dEje = pr.d;
  }
  function ubicarEquip(q){
    const si = UC.red.cercanoMetros(q.lat, q.lng, SNAP_EQUIP_M);
    if(!si){ q.segId = null; return; }
    const pr = proyectar(si, q.lat, q.lng);
    q.segId = si.segId; q.s = pr.s; q.off = pr.d;   // off: lo que se camina del equipamiento a la vía
  }
  // Rumbo de circulación de un paradero (grados, 0 = norte)
  function rumboDe(p){
    const si = p.segId && UC.red.porId.get(p.segId); if(!si) return null;
    const r = puntoEn(si, p.s).rumbo;
    return p.sentido === -1 ? r + 180 : r;
  }
  function sentidoTxt(p){
    if(!p.segId) return 'Fuera de la red';
    if(!p.sentido) return 'Sin definir';
    const r = ((rumboDe(p) % 360) + 360) % 360;
    return 'Hacia el ' + DIRS[Math.round(r / 45) % 8];
  }
  // Sentido sugerido: el de las rutas si todas van para el mismo lado; si no, el lado donde se clicó
  function sentidoSugerido(segId, lado){ const s = sentidosRutas(segId); return s.size === 1 ? [...s][0] : (lado || 1); }
  function posicion(p){
    if(p.tipo === 'existente' || !p.segId) return [p.lat, p.lng];
    const si = UC.red.porId.get(p.segId);
    return si ? puntoEn(si, p.s).ll : [p.lat, p.lng];
  }

  /* ══ Capas del mapa ══ */
  const capaExist = L.layerGroup().addTo(map), capaProp = L.layerGroup().addTo(map);
  const capaEquip = L.layerGroup().addTo(map), capaCob = L.layerGroup(), capaSel = L.layerGroup().addTo(map);
  const cobRenderer = UC.mapa.lienzo('pdCobPane'), equipRenderer = UC.mapa.lienzo('equipPane'), selRenderer = UC.mapa.lienzo('selPane');
  const marcas = new Map();
  const buscar = id => propuestos.find(p => p.id === id) || existentes.find(p => p.id === id) || null;
  const numero = p => propuestos.indexOf(p) + 1;
  const jerTxt = p => p.segId && UC.jerarquia ? UC.jerarquia.LABELS[UC.jerarquia.tipo(p.segId)] : '—';
  const tituloDe = p => p.tipo === 'existente' ? (p.nombre || 'Existente') : `Propuesto ${numero(p)}${p.nombre ? ' · ' + p.nombre : ''}`;
  const colorDe = p => p.tipo === 'existente' ? (p.segId ? COLOR_EXIST : '#9ca3af') : p.aceptado ? COLOR_ACEPTADO : ESTADO[p.est || 'unico'].color;

  function icono(p){
    const r = p.sentido ? rumboDe(p) : null, color = colorDe(p), sel = p.id === selId ? ' sel' : '';
    const fl = r === null ? '' : `<b class="pd-fl" style="transform:rotate(${r.toFixed(0)}deg);color:${color}"></b>`;
    if(p.tipo === 'existente')
      return L.divIcon({ className:'pd-marker', iconSize:[14, 14], iconAnchor:[7, 7], html:`<div class="pd-ic pd-ex${sel}" style="background:${color}">${fl}</div>` });
    // El propuesto se dibuja sobre el eje, corrido unos px hacia el lado por donde circula (como en la vereda)
    const th = ((r === null ? 0 : r) + 90) * Math.PI / 180, dx = r === null ? 0 : OFFSET_PX * Math.sin(th), dy = r === null ? 0 : -OFFSET_PX * Math.cos(th);
    return L.divIcon({ className:'pd-marker', iconSize:[24, 24], iconAnchor:[12, 12],
      html:`<div class="pd-ic pd-pr${sel}" style="background:${color};transform:translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px)">${p.aceptado ? '<i class="fa-solid fa-check"></i>' : numero(p)}${fl}</div>` });
  }
  const claveIcono = p => [p.tipo, colorDe(p), p.aceptado, numero(p), p.sentido, p.segId, p.s, p.id === selId].join('|');

  function distTxt(t){ return `${t.ant ? fmtM(t.ant.d) + ' ←' : '— ←'} ● ${t.sig ? '→ ' + fmtM(t.sig.d) : '→ —'}`; }
  function tooltipDe(id){
    const p = buscar(id); if(!p) return '';
    if(!p.segId) return `<b>${esc(tituloDe(p))}</b><br>Fuera de la red (a más de ${SNAP_EXIST_M} m de una vía)`;
    const est = p.est ? ` · <span style="color:${ESTADO[p.est].color};font-weight:600">${ESTADO[p.est].txt}</span>` : '';
    const out = [`<b>${esc(tituloDe(p))}</b> · ${jerTxt(p)}${p.tipo === 'propuesto' ? est : ''}`, `${esc(U.nombreVia(UC.red.porId.get(p.segId).props) || 'Vía sin nombre')} · ${sentidoTxt(p)}`];
    if(p.rutas && p.rutas.length){
      p.rutas.slice(0, 6).forEach(t => out.push(`${esc(t.V.nombre)}: ${distTxt(t)}`));
      if(p.rutas.length > 6) out.push(`y ${p.rutas.length - 6} variantes más`);
    }else if(p.via) out.push(`Sin rutas · por la vía: ${distTxt(p.via)}`);
    return out.join('<br>');
  }

  function dibujarParaderos(){
    const vivos = new Set();
    existentes.concat(propuestos).forEach(p => {
      if(p.tipo === 'existente' ? !opc.verExistentes : (!opc.verPropuestos || !p.segId)) return;
      vivos.add(p.id);
      const pos = posicion(p);
      if(p.tipo === 'propuesto'){ p.lat = pos[0]; p.lng = pos[1]; }
      let m = marcas.get(p.id);
      if(!m){
        const id = p.id;
        m = L.marker(pos, { icon:icono(p), draggable:p.tipo === 'propuesto', keyboard:false, riseOnHover:true });
        m._k = claveIcono(p);
        m.bindTooltip(() => tooltipDe(id), { direction:'top', offset:[0, -12], opacity:0.96 });
        m.on('click', e => {
          L.DomEvent.stopPropagation(e);
          if(UC.streetview && UC.streetview.activa()){ verCalle(buscar(id)); return; }
          if(!activo || (UC.regla && UC.regla.activa())) return;
          seleccionar(id, false);
        });
        if(p.tipo === 'propuesto'){ m.on('dragstart', () => m.closeTooltip()); m.on('dragend', () => soltar(id, m.getLatLng())); }
        m.addTo(p.tipo === 'existente' ? capaExist : capaProp);
        marcas.set(p.id, m);
      }else{
        const ll = m.getLatLng(); if(ll.lat !== pos[0] || ll.lng !== pos[1]) m.setLatLng(pos);
        const k = claveIcono(p); if(m._k !== k){ m.setIcon(icono(p)); m._k = k; }
      }
    });
    marcas.forEach((m, id) => { if(!vivos.has(id)){ m.remove(); marcas.delete(id); } });
  }
  function dibujarEquip(){
    capaEquip.clearLayers();
    if(!opc.verEquip) return;
    categorias.forEach(c => c.puntos.forEach(q => L.circleMarker([q.lat, q.lng], { renderer:equipRenderer, interactive:false,
      radius:5, color:'#fff', weight:1.5, fillColor:c.color, fillOpacity:0.95 }).addTo(capaEquip)));
  }
  function dibujarCobertura(){
    capaCob.clearLayers();
    if(!activo || !opc.verCobertura || !cob){ map.removeLayer(capaCob); return; }
    cob.tramos.forEach(({ si, i3, i5 }) => {
      i5.forEach(([a, b]) => { const ll = subLinea(si, a, b); if(ll.length > 1) L.polyline(ll, { renderer:cobRenderer, interactive:false, color:'#facc15', weight:7, opacity:0.55 }).addTo(capaCob); });
      i3.forEach(([a, b]) => { const ll = subLinea(si, a, b); if(ll.length > 1) L.polyline(ll, { renderer:cobRenderer, interactive:false, color:'#22c55e', weight:7, opacity:0.6 }).addTo(capaCob); });
    });
    capaCob.addTo(map);
  }
  function dibujarRutaVista(){
    capaSel.clearLayers();
    const V = activo && rutaVista && VARS().find(x => x.clave === rutaVista);
    if(!V) return;
    V.orden.forEach(o => L.polyline(o.si.latlngs, { renderer:selRenderer, interactive:false, color:V.color, weight:8, opacity:0.3 }).addTo(capaSel));
  }

  /* ══ Recalcular todo (una vez por cuadro, aunque se pida varias veces) ══ */
  let raf = 0;
  function recalcular(){
    if(raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if(!UC.red.cargada()) return;
      evaluar(); calcularCobertura();
      dibujarParaderos(); dibujarCobertura();
      if(activo){ renderResultados(); dibujarRutaVista(); }
    });
  }
  const cambio = () => { recalcular(); UC.eventos.emit('paraderos:cambiados', {}); };

  /* ══ Edición de propuestos ══ */
  const foto = () => JSON.stringify(propuestos.map(p => ({ id:p.id, segId:p.segId, s:p.s, sentido:p.sentido, aceptado:p.aceptado, nombre:p.nombre, atributos:p.atributos })));
  function guardarUndo(){ undo.push(foto()); if(undo.length > 50) undo.shift(); el('pd-undo').disabled = false; }
  function deshacer(){
    if(!undo.length) return;
    propuestos = JSON.parse(undo.pop()).map(p => ({ tipo:'propuesto', ...p }));
    el('pd-undo').disabled = !undo.length;
    if(selId && !buscar(selId)) selId = null;
    cambio(); UC.ui.instruccion('Deshacer aplicado.');
  }
  const nuevoId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  function agregar(si, latlng){
    const pr = proyectar(si, latlng.lat, latlng.lng);
    const p = { id:nuevoId(), tipo:'propuesto', segId:si.segId, s:pr.s, sentido:sentidoSugerido(si.segId, pr.lado), aceptado:false, nombre:'', atributos:{} };
    guardarUndo(); propuestos.push(p); selId = p.id;
    cambio();
    UC.ui.instruccion(`Propuesto ${propuestos.length} agregado (${sentidoTxt(p).toLowerCase()}) · arrástralo para moverlo · clic en la flecha de la ficha para invertir el sentido`);
  }
  // Soltar tras arrastrar: se reubica en la vía más cercana conservando hacia dónde circulaba
  function soltar(id, ll){
    const p = buscar(id); if(!p) return;
    const si = UC.red.cercanoMetros(ll.lat, ll.lng, SNAP_MOVER_M);
    if(!si){ UC.ui.instruccion('No hay una vía cerca: el paradero vuelve a su lugar.'); marcas.get(id).setLatLng(posicion(p)); return; }
    const rumboAntes = rumboDe(p), pr = proyectar(si, ll.lat, ll.lng);
    guardarUndo();
    p.segId = si.segId; p.s = pr.s;
    const forzado = sentidosRutas(si.segId);
    if(forzado.size === 1) p.sentido = [...forzado][0];
    else if(rumboAntes !== null){ p.sentido = 1; const r = rumboDe(p), dif = Math.abs((((r - rumboAntes) % 360) + 540) % 360 - 180); if(dif > 90) p.sentido = -1; }
    selId = id; cambio();
  }
  function invertir(p){
    if(p.tipo === 'propuesto') guardarUndo();
    p.sentido = p.sentido === 1 ? -1 : 1;
    if(p.tipo === 'existente') p.sentidoManual = true;
    cambio();
  }
  function eliminar(p){
    guardarUndo(); propuestos = propuestos.filter(x => x !== p);
    if(selId === p.id) selId = null;
    cambio(); UC.ui.instruccion('Propuesto eliminado · puedes deshacer con Ctrl+Z.');
  }
  function aceptar(p){ guardarUndo(); p.aceptado = !p.aceptado; cambio(); }
  // Street View en el paradero, mirando hacia su vereda (a la derecha del sentido en que circula)
  function verCalle(p){
    if(!p || !UC.streetview) return;
    const r = p.sentido ? rumboDe(p) : null;
    UC.streetview.abrir(posicion(p), r === null ? null : r + 90);
  }
  function seleccionar(id, volar){
    selId = id;
    const p = buscar(id);
    if(p && volar) map.flyTo(posicion(p), Math.max(map.getZoom(), 17), { duration:0.6 });
    dibujarParaderos(); if(activo) renderResultados();
  }

  /* ══ Panel izquierdo ══ */
  const panel = document.createElement('div');
  panel.innerHTML = `
    <div class="panel-pad" style="padding-bottom:6px">
      <div class="modulo-titulo"><div class="ico"><i class="fa-solid fa-bus-simple"></i></div><span>Paraderos</span></div>
      <div class="tool-row">
        <button class="btn" id="pd-agregar" title="Clic sobre una vía para ubicar un paradero propuesto"><i class="fa-solid fa-plus"></i> Agregar propuesto</button>
        <button class="btn" id="pd-undo" disabled style="flex:0 0 38px" title="Deshacer (Ctrl+Z)"><i class="fa-solid fa-rotate-left"></i></button>
      </div>
      <div class="hint">Clic sobre la vía, del lado por donde circula el bus. El sentido se toma de las rutas del tramo o del lado donde hiciste clic. Arrastra un propuesto para moverlo.</div>
    </div>
    <div class="panel-section">
      <div class="panel-section-header"><div class="panel-section-icon blue"><i class="fa-solid fa-location-dot"></i></div><span class="panel-section-title">Paraderos existentes</span></div>
      <input type="file" id="pd-file-ex" accept=".zip,.geojson,.json,.kml,.kmz" hidden>
      <div class="pd-capa"><span class="pd-dot" style="background:${COLOR_EXIST}"></span><span class="pd-capa-n" id="pd-ex-info">Sin cargar</span>
        <button class="btn" id="pd-ex-cargar">Cargar</button><button class="pd-x" id="pd-ex-quitar" title="Quitar existentes" hidden><i class="fa-solid fa-xmark"></i></button></div>
      <div class="switch-row"><span>Mostrar en el mapa</span><label class="switch"><input type="checkbox" id="pd-ex-ver" checked><span class="track"></span></label></div>
      <div class="switch-row"><span>Considerar en la evaluación</span><label class="switch"><input type="checkbox" id="pd-ex-eval" checked><span class="track"></span></label></div>
    </div>
    <div class="panel-section">
      <div class="panel-section-header"><div class="panel-section-icon purple"><i class="fa-solid fa-building"></i></div><span class="panel-section-title">Equipamientos urbanos</span></div>
      <input type="file" id="pd-file-eq" accept=".zip,.geojson,.json,.kml,.kmz" hidden>
      <div id="pd-cats"></div>
      <div class="at-nuevo"><input type="text" class="at-input" id="pd-cat-nombre" placeholder="Otra categoría (ej: parques)"><button class="btn" id="pd-cat-add"><i class="fa-solid fa-plus"></i> Categoría</button></div>
      <div class="switch-row" style="margin-top:6px"><span>Mostrar en el mapa</span><label class="switch"><input type="checkbox" id="pd-eq-ver" checked><span class="track"></span></label></div>
    </div>
    <div class="panel-section">
      <div class="panel-section-header"><div class="panel-section-icon green"><i class="fa-solid fa-ruler-horizontal"></i></div><span class="panel-section-title">Espaciamiento (m)</span></div>
      <div class="field"><label>Expresa — mín / máx</label><div class="row3"><input type="number" id="pd-r-expresa-min" step="10"><input type="number" id="pd-r-expresa-max" step="10"></div></div>
      <div class="field"><label>Arterial y colectora — mín / máx</label><div class="row3"><input type="number" id="pd-r-arterial-min" step="10"><input type="number" id="pd-r-arterial-max" step="10"></div></div>
      <div class="field"><label>Local — mín / máx</label><div class="row3"><input type="number" id="pd-r-local-min" step="10"><input type="number" id="pd-r-local-max" step="10"></div></div>
    </div>
    <div class="panel-section">
      <div class="panel-section-header"><div class="panel-section-icon blue"><i class="fa-solid fa-person-walking"></i></div><span class="panel-section-title">Cobertura caminando</span></div>
      <div class="switch-row"><span>Mostrar en el mapa</span><label class="switch"><input type="checkbox" id="pd-cob-ver"><span class="track"></span></label></div>
      <div class="pd-leyenda"><span><i style="background:#22c55e"></i>hasta 300 m</span><span><i style="background:#facc15"></i>300 – 500 m</span></div>
    </div>`;

  function llenarRangos(){ ['expresa', 'arterial', 'local'].forEach(k => ['min', 'max'].forEach(m => { panel.querySelector(`#pd-r-${k}-${m}`).value = rangos[k][m]; })); }
  ['expresa', 'arterial', 'local'].forEach(k => ['min', 'max'].forEach(m => panel.querySelector(`#pd-r-${k}-${m}`).addEventListener('change', e => {
    const v = +e.target.value; if(v > 0) rangos[k][m] = v; else e.target.value = rangos[k][m];
    cambio();
  })));

  function renderCategorias(){
    const box = el('pd-cats'); box.innerHTML = '';
    categorias.forEach(c => {
      const d = document.createElement('div'); d.className = 'pd-capa';
      const fuera = c.puntos.filter(q => !q.segId).length;
      d.innerHTML = `<span class="pd-dot" style="background:${c.color}"></span><span class="pd-capa-n"></span>
        <button class="btn">${c.puntos.length ? 'Cambiar' : 'Cargar'}</button>${c.puntos.length || !CATEGORIAS_DEF.some(x => x.id === c.id) ? '<button class="pd-x" title="Quitar"><i class="fa-solid fa-xmark"></i></button>' : ''}`;
      d.querySelector('.pd-capa-n').textContent = c.nombre + (c.puntos.length ? ` · ${U.fmtNum(c.puntos.length)}` : '') + (fuera ? ` (${fuera} lejos de la red)` : '');
      d.querySelector('.btn').addEventListener('click', () => { catCargando = c.id; el('pd-file-eq').click(); });
      const x = d.querySelector('.pd-x');
      if(x) x.addEventListener('click', () => {
        if(c.puntos.length) c.puntos = []; else categorias = categorias.filter(k => k !== c);
        renderCategorias(); dibujarEquip(); cambio();
      });
      box.appendChild(d);
    });
  }
  let catCargando = null;
  panel.querySelector('#pd-cat-add').addEventListener('click', () => {
    const inp = el('pd-cat-nombre'), n = inp.value.trim(); if(!n) return;
    categorias.push({ id:'c' + Date.now().toString(36), nombre:n, color:COLORES_EXTRA[categorias.length % COLORES_EXTRA.length], puntos:[] });
    inp.value = ''; renderCategorias();
  });
  panel.querySelector('#pd-cat-nombre').addEventListener('keydown', e => { if(e.key === 'Enter') el('pd-cat-add').click(); });

  // Puntos de un archivo (Point, MultiPoint; de polígonos se toma el centro)
  function puntosDe(gj){
    const out = [];
    const centro = ring => { let x = 0, y = 0; ring.forEach(c => { x += c[0]; y += c[1]; }); return [x / ring.length, y / ring.length]; };
    (gj.features || []).forEach(f => {
      const g = f && f.geometry; if(!g) return;
      const add = c => { if(Array.isArray(c) && isFinite(c[0]) && isFinite(c[1])) out.push({ lng:+c[0], lat:+c[1], props:f.properties || {} }); };
      if(g.type === 'Point') add(g.coordinates);
      else if(g.type === 'MultiPoint') g.coordinates.forEach(add);
      else if(g.type === 'Polygon' && g.coordinates[0] && g.coordinates[0].length) add(centro(g.coordinates[0]));
      else if(g.type === 'MultiPolygon' && g.coordinates[0] && g.coordinates[0][0]) add(centro(g.coordinates[0][0]));
    });
    return out;
  }
  const nombreDe = (props, def) => String((props && (props.nombre || props.name || props.NOMBRE || props.Name || props.NOM || props.nom)) || '').trim() || def;

  async function leerPuntos(file, que){
    UC.ui.loader(`Leyendo ${que}…`); await UC.ui.esperarFrame();
    try{
      const pts = puntosDe(await UC.red.leerArchivoGeo(file));
      if(!pts.length) throw new Error('El archivo no tiene puntos.');
      return pts;
    }catch(err){ alert('Error: ' + err.message); return null; }
    finally{ UC.ui.ocultarLoader(); }
  }
  panel.querySelector('#pd-ex-cargar').addEventListener('click', () => el('pd-file-ex').click());
  panel.querySelector('#pd-file-ex').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if(!f) return;
    const pts = await leerPuntos(f, 'paraderos existentes'); if(!pts) return;
    marcas.forEach((m, id) => { if(id[0] === 'e'){ m.remove(); marcas.delete(id); } });
    existentes = pts.map((q, i) => { const e2 = { id:'e' + i, tipo:'existente', lat:q.lat, lng:q.lng, nombre:nombreDe(q.props, `Existente ${i + 1}`), props:q.props }; ubicarExistente(e2); return e2; });
    actualizarInfoExist(); cambio();
    const fuera = existentes.filter(x => !x.segId).length, sinS = existentes.filter(x => x.segId && !x.sentido).length;
    UC.ui.instruccion(`${U.fmtNum(existentes.length)} paraderos existentes` + (sinS ? ` · ${sinS} sin sentido (caen sobre el eje)` : '') + (fuera ? ` · ${fuera} lejos de la red` : ''));
    const b = L.latLngBounds(existentes.map(x => [x.lat, x.lng])); if(b.isValid()) map.fitBounds(b, { padding:[60, 60] });
  });
  panel.querySelector('#pd-ex-quitar').addEventListener('click', () => {
    if(!confirm('¿Quitar los paraderos existentes?')) return;
    existentes = []; actualizarInfoExist(); cambio();
  });
  panel.querySelector('#pd-file-eq').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; const c = categorias.find(k => k.id === catCargando); if(!f || !c) return;
    const pts = await leerPuntos(f, c.nombre.toLowerCase()); if(!pts) return;
    const vistos = new Set();
    c.puntos = pts.filter(q => { const k = q.lat.toFixed(6) + ',' + q.lng.toFixed(6); if(vistos.has(k)) return false; vistos.add(k); return true; })
      .map(q => { const x = { lat:q.lat, lng:q.lng, nombre:nombreDe(q.props, c.nombre) }; ubicarEquip(x); return x; });
    renderCategorias(); dibujarEquip(); cambio();
    UC.ui.instruccion(`${c.nombre}: ${U.fmtNum(c.puntos.length)} equipamientos cargados`);
  });
  function actualizarInfoExist(){
    const n = existentes.length, sinS = existentes.filter(x => x.segId && !x.sentido).length;
    el('pd-ex-info').textContent = n ? `${U.fmtNum(n)} cargados${sinS ? ` · ${sinS} sin sentido` : ''}` : 'Sin cargar';
    el('pd-ex-quitar').hidden = !n;
    el('pd-ex-cargar').textContent = n ? 'Cambiar' : 'Cargar';
  }
  const sw = (id, k, fn) => panel.querySelector(id).addEventListener('change', e => { opc[k] = e.target.checked; fn ? fn() : null; cambio(); });
  sw('#pd-ex-ver', 'verExistentes');
  sw('#pd-ex-eval', 'considerarExistentes');
  sw('#pd-eq-ver', 'verEquip', dibujarEquip);
  sw('#pd-cob-ver', 'verCobertura');
  function llenarSwitches(){
    el('pd-ex-ver').checked = opc.verExistentes; el('pd-ex-eval').checked = opc.considerarExistentes;
    el('pd-eq-ver').checked = opc.verEquip; el('pd-cob-ver').checked = opc.verCobertura;
  }

  function setAgregar(on){
    agregando = on;
    el('pd-agregar').classList.toggle('mode-active', on);
    el('map').classList.toggle('cursor-area', on);
    if(!on) UC.interaccion.limpiar();
    UC.ui.instruccion(on ? 'Clic sobre una vía para ubicar un paradero propuesto · Esc para terminar' : 'Clic en un paradero para ver su detalle · Agregar propuesto para ubicar nuevos');
  }
  panel.querySelector('#pd-agregar').addEventListener('click', () => setAgregar(!agregando));
  panel.querySelector('#pd-undo').addEventListener('click', deshacer);
  document.addEventListener('keydown', e => {
    if(!activo || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z'){ e.preventDefault(); deshacer(); return; }
    if(e.key === 'Escape' && agregando) setAgregar(false);
    if((e.key === 'Delete' || e.key === 'Supr') && selId){ const p = buscar(selId); if(p && p.tipo === 'propuesto') eliminar(p); }
  });

  /* ══ Panel derecho: resumen, ficha, lista y vista por ruta ══ */
  const res = document.createElement('div');
  res.innerHTML = `
    <div class="res-section"><h2>Resumen</h2><div id="pd-resumen"></div></div>
    <div class="res-section" id="pd-ficha-wrap" hidden><h2>Paradero seleccionado</h2><div id="pd-ficha"></div></div>
    <div class="res-section"><h2>Propuestos</h2><div id="pd-lista"></div></div>
    <div class="res-section"><h2>Paraderos por ruta</h2>
      <div class="field"><select id="pd-ruta"></select></div>
      <div id="pd-ruta-lista"><div class="hint">Elige una ruta para ver sus paraderos en orden y el espaciamiento entre ellos.</div></div>
    </div>`;

  const fila = (k, v, color) => `<div class="summary-row"><span${color ? ` style="color:${color}"` : ''}>${k}</span><span class="v"${color ? ` style="color:${color}"` : ''}>${v}</span></div>`;
  function renderResultados(){
    // Resumen
    const ev = propuestos.filter(p => p.segId), cnt = k => ev.filter(p => !p.aceptado && p.est === k).length;
    let h = fila('Propuestos', U.fmtNum(propuestos.length)) + fila('Aceptados', ev.filter(p => p.aceptado).length, COLOR_ACEPTADO);
    ['ok', 'cerca', 'lejos', 'unico'].forEach(k => { h += fila(ESTADO[k].txt, cnt(k), ESTADO[k].color); });
    if(existentes.length) h += fila('Existentes', U.fmtNum(existentes.length) + (opc.considerarExistentes ? '' : ' (solo referencia)'));
    if(cob){
      h += `<div class="pd-sub">Cobertura caminando${opc.considerarExistentes && existentes.length ? ' (existentes + propuestos)' : ''}</div>`;
      h += fila('Red a ≤ 300 m', cob.p300.toFixed(1) + ' %') + fila('Red a ≤ 500 m', cob.p500.toFixed(1) + ' %');
      cob.equip.filter(x => x.n).forEach(x => { h += fila(`<span class="pd-dot" style="background:${x.c.color}"></span> ${esc(x.c.nombre)}`, `${x.a300} / ${x.a500} de ${x.n}`); });
      if(cob.equip.some(x => x.n)) h += '<div class="hint">Equipamientos con paradero a ≤ 300 / ≤ 500 m caminando.</div>';
    }
    el('pd-resumen').innerHTML = h;
    renderFicha(); renderLista(); renderRuta();
  }

  function renderFicha(){
    const p = buscar(selId), wrap = el('pd-ficha-wrap'), box = el('pd-ficha');
    if(!p){ wrap.hidden = true; return; }
    wrap.hidden = false;
    const si = p.segId && UC.red.porId.get(p.segId);
    if(si && !p.rango) evaluar();   // recién agregado: todavía no pasó por recalcular()
    let h = `<div class="pd-f-tit"><span class="pd-badge" style="background:${colorDe(p)}">${p.tipo === 'existente' ? '<i class="fa-solid fa-location-dot"></i>' : p.aceptado ? '<i class="fa-solid fa-check"></i>' : numero(p)}</span><b></b></div>`;
    if(p.tipo === 'propuesto') h += `<div class="field" style="margin:8px 0"><input type="text" class="at-input" id="pd-f-nombre" placeholder="Nombre (opcional)"></div>`;
    if(!si){ box.innerHTML = h + '<div class="hint">Está a más de ' + SNAP_EXIST_M + ' m de una vía: no entra en la evaluación.</div>'; box.querySelector('.pd-f-tit b').textContent = tituloDe(p); return; }
    h += fila('Vía', esc(U.nombreVia(si.props) || 'Sin nombre')) + fila('Jerarquía', jerTxt(p));
    h += `<div class="summary-row"><span>Sentido</span><span class="v">${sentidoTxt(p)} <button class="pd-mini" id="pd-f-inv" title="Invertir sentido"><i class="fa-solid fa-right-left"></i></button></span></div>`;
    if(p.tipo === 'propuesto') h += fila('Estado', p.aceptado ? 'Aceptado' : ESTADO[p.est || 'unico'].txt, p.aceptado ? COLOR_ACEPTADO : ESTADO[p.est || 'unico'].color);
    h += fila('Rango', `${p.rango.min} – ${p.rango.max} m`);
    h += '<div class="pd-sub">Espaciamiento (anterior ← ● → siguiente)</div>';
    if(p.rutas.length) h += p.rutas.map(t => `<div class="pd-ruta-fila"><span class="pd-dot" style="background:${t.V.color}"></span><span class="pd-rf-n">${esc(t.V.nombre)}</span><span style="color:${ESTADO[t.estado].color}">${distTxt(t)}</span></div>`).join('');
    else h += `<div class="pd-ruta-fila"><span class="pd-rf-n">Sin rutas · por la vía</span><span style="color:${ESTADO[p.via.estado].color}">${distTxt(p.via)}</span></div>`;
    if(categorias.some(c => c.puntos.length)){
      h += '<div class="pd-sub">Equipamientos caminando</div>';
      equipCerca(p).forEach(x => { h += `<div class="pd-ruta-fila"><span class="pd-dot" style="background:${x.c.color}"></span><span class="pd-rf-n">${esc(x.c.nombre)}: ${x.a300} a ≤300 m · ${x.a500} a ≤500 m</span></div>` +
        (x.cerca ? `<div class="hint" style="padding-left:16px">Más cercano: ${esc(x.cerca.q.nombre)} (${fmtM(x.cerca.d)})</div>` : ''); });
    }
    h += '<div class="list-actions" style="margin-top:12px;flex-wrap:wrap">' +
      (p.tipo === 'propuesto' ? `<button class="btn" id="pd-f-acep"><i class="fa-solid ${p.aceptado ? 'fa-rotate-left' : 'fa-check'}"></i> ${p.aceptado ? 'Revertir' : 'Aceptar'}</button>` : '') +
      '<button class="btn" id="pd-f-ir"><i class="fa-solid fa-crosshairs"></i> Centrar</button>' +
      '<button class="btn" id="pd-f-sv" title="Ver la zona en Google Maps (Street View), mirando hacia la vereda"><i class="fa-solid fa-street-view"></i> Street View</button>' +
      (p.tipo === 'propuesto' ? '<button class="btn" id="pd-f-del"><i class="fa-solid fa-trash"></i> Eliminar</button>' : '') + '</div>';
    box.innerHTML = h;
    box.querySelector('.pd-f-tit b').textContent = tituloDe(p);
    const nom = box.querySelector('#pd-f-nombre');
    if(nom){ nom.value = p.nombre || ''; nom.addEventListener('change', () => { p.nombre = nom.value.trim(); cambio(); }); }
    box.querySelector('#pd-f-inv').addEventListener('click', () => invertir(p));
    box.querySelector('#pd-f-ir').addEventListener('click', () => seleccionar(p.id, true));
    box.querySelector('#pd-f-sv').addEventListener('click', () => verCalle(p));
    const a = box.querySelector('#pd-f-acep'); if(a) a.addEventListener('click', () => aceptar(p));
    const d = box.querySelector('#pd-f-del'); if(d) d.addEventListener('click', () => eliminar(p));
  }

  function renderLista(){
    const box = el('pd-lista');
    if(!propuestos.length){ box.innerHTML = '<div class="hint">Activa <b>Agregar propuesto</b> y haz clic sobre una vía.</div>'; return; }
    box.innerHTML = '';
    propuestos.forEach(p => {
      const d = document.createElement('div'); d.className = 'pd-item' + (p.id === selId ? ' sel' : '');
      const est = p.aceptado ? { txt:'Aceptado', color:COLOR_ACEPTADO } : ESTADO[p.est || 'unico'];
      const n = p.rutas ? p.rutas.length : 0;
      d.innerHTML = `<span class="pd-badge" style="background:${colorDe(p)}">${p.aceptado ? '<i class="fa-solid fa-check"></i>' : numero(p)}</span>
        <div class="pd-item-t"><div class="pd-item-n"></div><div class="pd-item-s"><span style="color:${est.color}">${est.txt}</span> · ${jerTxt(p)} · ${n ? `${n} variante${n > 1 ? 's' : ''}` : 'sin rutas'}</div></div>`;
      d.querySelector('.pd-item-n').textContent = p.nombre || (p.segId ? U.nombreVia(UC.red.porId.get(p.segId).props) || 'Vía sin nombre' : '—');
      d.addEventListener('click', () => seleccionar(p.id, true));
      box.appendChild(d);
    });
  }

  function renderRuta(){
    const s = el('pd-ruta'), vs = VARS();
    if(s.options.length !== vs.length + 1 || [...s.options].slice(1).some((o, i) => o.value !== vs[i].clave || o.textContent !== vs[i].nombre)){
      s.innerHTML = '<option value="">— Elegir ruta —</option>';
      vs.forEach(V => { const o = document.createElement('option'); o.value = V.clave; o.textContent = V.nombre; s.appendChild(o); });
    }
    if(!vs.some(V => V.clave === rutaVista)) rutaVista = '';
    s.value = rutaVista;
    const box = el('pd-ruta-lista'), V = vs.find(x => x.clave === rutaVista);
    if(!V){ box.innerHTML = `<div class="hint">${vs.length ? 'Elige una ruta para ver sus paraderos en orden y el espaciamiento entre ellos.' : 'No hay rutas trazadas: los paraderos se evalúan a lo largo de la vía.'}</div>`; return; }
    const L2 = V.lista;
    if(!L2.length){ box.innerHTML = '<div class="hint">Esta ruta todavía no tiene paraderos en su sentido.</div>'; return; }
    let huecos = 0, suma = 0;
    const filas = L2.map((x, i) => {
      const p = x.p, sig = L2[i + 1];
      let gap = '';
      if(sig){
        const d = sig.pos - x.pos, r = p.rango; suma += d;
        const c = d < r.min ? ESTADO.cerca.color : d > r.max ? ESTADO.lejos.color : ESTADO.ok.color;
        if(d > r.max) huecos++;
        gap = `<div class="pd-gap" style="color:${c}"><i class="fa-solid fa-arrow-down"></i> ${fmtM(d)}${d > r.max ? ' · falta un paradero' : d < r.min ? ' · muy cerca' : ''}</div>`;
      }
      return `<div class="pd-rl" data-id="${p.id}"><span class="pd-badge sm" style="background:${colorDe(p)}">${p.tipo === 'existente' ? 'E' : numero(p)}</span><span class="pd-rl-n"></span></div>${gap}`;
    }).join('');
    box.innerHTML = `<div class="hint" style="margin-bottom:8px">${L2.length} paraderos · ${U.fmtKm(V.largo / 1000)} · promedio ${L2.length > 1 ? fmtM(suma / (L2.length - 1)) : '—'}${huecos ? ` · <b style="color:${ESTADO.lejos.color}">${huecos} hueco${huecos > 1 ? 's' : ''}</b>` : ''}</div>` + filas;
    box.querySelectorAll('.pd-rl').forEach((d, i) => {
      d.querySelector('.pd-rl-n').textContent = tituloDe(L2[i].p);
      d.addEventListener('click', () => seleccionar(d.dataset.id, true));
    });
  }
  res.querySelector('#pd-ruta').addEventListener('change', e => {
    rutaVista = e.target.value; renderRuta(); dibujarRutaVista();
    const V = VARS().find(x => x.clave === rutaVista);
    if(V){ const b = L.latLngBounds([]); V.orden.forEach(o => o.si.latlngs.forEach(q => b.extend(q))); if(b.isValid()) map.fitBounds(b, { padding:[60, 60] }); }
  });

  /* ══ Globo sobre equipamientos (sin capas interactivas: búsqueda propia por cercanía) ══ */
  const tipEquip = L.tooltip({ direction:'top', offset:[0, -6], opacity:0.95 });
  let rafEq = 0, ultimoEq = null;
  function hoverEquip(e){
    ultimoEq = e;
    if(rafEq) return;
    rafEq = requestAnimationFrame(() => {
      rafEq = 0;
      if(!opc.verEquip || map.getZoom() < 14 || !categorias.some(c => c.puntos.length)){ tipEquip.remove(); return; }
      const pt = ultimoEq.containerPoint, b = map.getBounds(); let mejor = null;
      categorias.forEach(c => c.puntos.forEach(q => {
        if(!b.contains([q.lat, q.lng])) return;
        const d = pt.distanceTo(map.latLngToContainerPoint([q.lat, q.lng]));
        if(d < 9 && (!mejor || d < mejor.d)) mejor = { d, q, c };
      }));
      if(!mejor){ tipEquip.remove(); return; }
      tipEquip.setLatLng([mejor.q.lat, mejor.q.lng]).setContent(`<b>${esc(mejor.c.nombre)}</b><br>${esc(mejor.q.nombre)}`);
      if(!map.hasLayer(tipEquip)) tipEquip.addTo(map);
    });
  }

  /* ══ Exportar ══ */
  function propiedades(p){
    const est = p.tipo === 'propuesto' ? (p.aceptado ? 'aceptado' : p.est) : null;
    const dist = t => t ? Math.round(t.d) : null;
    const tramos = p.rutas && p.rutas.length ? p.rutas : p.via ? [p.via] : [];
    const ant = tramos.map(t => t.ant).filter(Boolean), sig = tramos.map(t => t.sig).filter(Boolean);
    return { ...(p.tipo === 'existente' ? p.props : p.atributos), tipo:p.tipo, nombre:tituloDe(p), estado:est, jerarquia:p.segId ? UC.jerarquia.tipo(p.segId) : null,
      via:p.segId ? U.nombreVia(UC.red.porId.get(p.segId).props) || null : null, sentido:sentidoTxt(p),
      rutas:(p.rutas || []).map(t => t.V.nombre).join(', ') || null, n_rutas:(p.rutas || []).length,
      dist_anterior_m:ant.length ? dist(ant.reduce((a, x) => x.d < a.d ? x : a)) : null, dist_siguiente_m:sig.length ? dist(sig.reduce((a, x) => x.d < a.d ? x : a)) : null };
  }
  function exportarGeojson(){
    const lista = propuestos.concat(existentes);
    if(!lista.length){ alert('No hay paraderos para exportar.'); return; }
    const features = lista.map(p => { const pos = posicion(p); return { type:'Feature', properties:propiedades(p), geometry:{ type:'Point', coordinates:[pos[1], pos[0]] } }; });
    UC.ui.descargarTexto('urbancore-paraderos.geojson', JSON.stringify({ type:'FeatureCollection', features }, null, 1));
  }
  function exportarExcel(){
    const lista = propuestos.concat(existentes);
    if(!lista.length){ alert('No hay paraderos para exportar.'); return; }
    const wb = XLSX.utils.book_new();
    const cols = ['tipo', 'nombre', 'estado', 'jerarquia', 'via', 'sentido', 'n_rutas', 'rutas', 'dist_anterior_m', 'dist_siguiente_m'];
    const hoja1 = [['Tipo', 'Nombre', 'Estado', 'Jerarquía', 'Vía', 'Sentido', 'Nº rutas', 'Rutas', 'Dist. anterior (m)', 'Dist. siguiente (m)', 'Latitud', 'Longitud']];
    lista.forEach(p => { const pr = propiedades(p), pos = posicion(p); hoja1.push(cols.map(k => pr[k]).concat([+pos[0].toFixed(6), +pos[1].toFixed(6)])); });
    const w1 = XLSX.utils.aoa_to_sheet(hoja1); w1['!cols'] = [10, 26, 11, 11, 30, 14, 9, 40, 16, 16, 11, 11].map(wch => ({ wch })); XLSX.utils.book_append_sheet(wb, w1, 'Paraderos');
    const hoja2 = [['Ruta', 'Orden', 'Paradero', 'Tipo', 'Distancia al siguiente (m)', 'Evaluación del tramo']];
    VARS().forEach(V => V.lista.forEach((x, i) => {
      const s = V.lista[i + 1], d = s ? s.pos - x.pos : null, r = x.p.rango;
      hoja2.push([V.nombre, i + 1, tituloDe(x.p), x.p.tipo, d === null ? null : Math.round(d), d === null ? 'fin de ruta' : d < r.min ? 'muy cerca' : d > r.max ? 'falta paradero' : 'ok']);
    }));
    const w2 = XLSX.utils.aoa_to_sheet(hoja2); w2['!cols'] = [26, 7, 30, 10, 22, 18].map(wch => ({ wch })); XLSX.utils.book_append_sheet(wb, w2, 'Por ruta');
    if(cob){
      const hoja3 = [['Categoría', 'Total', 'Con paradero a ≤300 m', 'Con paradero a ≤500 m', '% a ≤500 m']];
      cob.equip.filter(x => x.n).forEach(x => hoja3.push([x.c.nombre, x.n, x.a300, x.a500, +(x.a500 / x.n * 100).toFixed(1)]));
      hoja3.push([], ['Red vial cubierta a ≤300 m (%)', +cob.p300.toFixed(1)], ['Red vial cubierta a ≤500 m (%)', +cob.p500.toFixed(1)]);
      const w3 = XLSX.utils.aoa_to_sheet(hoja3); w3['!cols'] = [30, 8, 22, 22, 12].map(wch => ({ wch })); XLSX.utils.book_append_sheet(wb, w3, 'Cobertura');
    }
    XLSX.writeFile(wb, `paraderos-${U.fecha()}.xlsx`);
  }

  /* ══ La red, las rutas o la jerarquía cambiaron ══ */
  function reubicarTodo(){
    grafo = null; variantes = null;
    let perdidos = 0;
    propuestos = propuestos.filter(p => {
      if(p.segId && UC.red.porId.has(p.segId)){ p.s = Math.min(p.s, largo(p.segId)); return true; }
      const si = UC.red.cercanoMetros(p.lat, p.lng, SNAP_MOVER_M);
      if(!si){ perdidos++; return false; }
      const pr = proyectar(si, p.lat, p.lng); p.segId = si.segId; p.s = pr.s; return true;
    });
    existentes.forEach(ubicarExistente);
    categorias.forEach(c => c.puntos.forEach(ubicarEquip));
    if(perdidos) UC.ui.instruccion(`${perdidos} paradero(s) propuesto(s) quedaron sin vía cercana y se quitaron.`);
  }
  UC.eventos.on('red:cambiada', () => { reubicarTodo(); recalcular(); });
  UC.eventos.on('red:cargada', () => { grafo = null; variantes = null; recalcular(); });
  UC.eventos.on('rutas:cambiadas', () => { variantes = null; recalcular(); });
  UC.eventos.on('jerarquia:cambiada', () => recalcular());

  /* ══ Proyecto ══ */
  function serializar(){
    if(!existentes.length && !propuestos.length && !categorias.some(c => c.puntos.length)) return null;
    return {
      version:1, rangos, opciones:opc,
      existentes:existentes.map(e => ({ lat:e.lat, lng:e.lng, nombre:e.nombre, props:e.props, segId:e.segId, sentido:e.sentido, sentidoManual:!!e.sentidoManual })),
      propuestos:propuestos.map(p => ({ id:p.id, segId:p.segId, s:p.s, sentido:p.sentido, aceptado:!!p.aceptado, nombre:p.nombre || '', atributos:p.atributos || {}, lat:p.lat, lng:p.lng })),
      categorias:categorias.map(c => ({ id:c.id, nombre:c.nombre, color:c.color, puntos:c.puntos.map(q => ({ lat:q.lat, lng:q.lng, nombre:q.nombre })) }))
    };
  }
  function cargar(d){
    marcas.forEach(m => m.remove()); marcas.clear();
    grafo = null; variantes = null; undo = []; selId = null; rutaVista = ''; cob = null;
    rangos = clonar(RANGOS_DEF); opc = { ...opc, verCobertura:false };
    existentes = []; propuestos = [];
    categorias = CATEGORIAS_DEF.map(c => ({ ...c, puntos:[] }));
    if(d){
      if(d.rangos) ['expresa', 'arterial', 'local'].forEach(k => { if(d.rangos[k]) rangos[k] = { min:+d.rangos[k].min || RANGOS_DEF[k].min, max:+d.rangos[k].max || RANGOS_DEF[k].max }; });
      if(d.opciones) opc = { ...opc, ...d.opciones };
      existentes = (d.existentes || []).map((e, i) => { const x = { id:'e' + i, tipo:'existente', ...e }; ubicarExistente(x); return x; });
      propuestos = (d.propuestos || []).map(p => ({ tipo:'propuesto', atributos:{}, ...p, id:p.id || nuevoId() }));
      if(Array.isArray(d.categorias)) categorias = d.categorias.map(c => ({ ...c, puntos:(c.puntos || []).map(q => { const x = { ...q }; ubicarEquip(x); return x; }) }));
      reubicarTodo();
    }
    if(el('pd-undo')){ el('pd-undo').disabled = true; llenarRangos(); llenarSwitches(); actualizarInfoExist(); renderCategorias(); }
    capaSel.clearLayers(); capaCob.clearLayers(); dibujarEquip();
    recalcular();
  }

  UC.modulos.registrar({
    id:'paraderos', nombre:'Paraderos', icono:'fa-bus-simple', titulo:'Evaluar paraderos propuestos: espaciamiento por ruta y sentido, cobertura y equipamientos',
    panel, resultados:res,
    capas:[
      { nombre:'Paraderos existentes', visible:() => opc.verExistentes, cambiar:v => { opc.verExistentes = v; el('pd-ex-ver').checked = v; dibujarParaderos(); } },
      { nombre:'Paraderos propuestos', visible:() => opc.verPropuestos, cambiar:v => { opc.verPropuestos = v; dibujarParaderos(); } },
      { nombre:'Equipamientos urbanos', visible:() => opc.verEquip, cambiar:v => { opc.verEquip = v; el('pd-eq-ver').checked = v; dibujarEquip(); } }
    ],
    exportar:() => [
      { icono:'fa-bus-simple', titulo:'Paraderos GeoJSON', sub:'.geojson — existentes y propuestos con estado, sentido y rutas (QGIS)', accion:exportarGeojson },
      { icono:'fa-file-excel', titulo:'Reporte de paraderos (Excel)', sub:'.xlsx — paraderos, espaciamiento por ruta y cobertura', accion:exportarExcel }
    ],
    activar(){
      activo = true; document.body.classList.add('pd-on');
      llenarRangos(); llenarSwitches(); actualizarInfoExist(); renderCategorias();
      recalcular(); setAgregar(agregando);
    },
    desactivar(){
      activo = false; document.body.classList.remove('pd-on');
      if(agregando) setAgregar(false);
      tipEquip.remove(); capaSel.clearLayers(); map.removeLayer(capaCob);
    },
    hoverTramos:() => agregando,
    colorHover:() => '#7c3aed',
    alClic(si, e){ if(agregando && si) agregar(si, e.latlng); },
    alMoverMapa:hoverEquip,
    serializar, cargar,
    usosDeTramo(id){ const n = propuestos.filter(p => p.segId === id).length; return n ? [`${n} paradero(s) propuesto(s)`] : []; }
  });
  cargar(null);

  // API para Atributos
  UC.paraderos = {
    lista:() => existentes.concat(propuestos),
    titulo:tituloDe, posicion, sentidoTxt, jerarquiaTxt:jerTxt,
    estadoTxt:p => p.tipo === 'existente' ? '—' : p.aceptado ? 'Aceptado' : p.est ? ESTADO[p.est].txt : '—',
    rutasTxt:p => (p.rutas || []).map(t => t.V.nombre).join(', '),
    refrescar:cambio
  };
})();
