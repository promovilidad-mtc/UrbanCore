'use strict';
/* ══════════════════════════════════════════════════════════════════
   UrbanCore Visor — NÚCLEO: utilidades comunes y avisos entre módulos
   Todo el visor vive bajo el objeto global UC (sin módulos ES, para que
   funcione igual abriendo el archivo local o desde GitHub Pages).
   ══════════════════════════════════════════════════════════════════ */
window.UC = window.UC || {};
UC.version = '1.0';
UC.el = id => document.getElementById(id);

/* ── Interfaz: cargador, instrucciones, descargas ── */
UC.ui = {
  loader(t){ UC.el('loader-text').textContent = t || 'Procesando…'; UC.el('loader').classList.add('show'); },
  ocultarLoader(){ UC.el('loader').classList.remove('show'); },
  // Deja que el cargador se pinte antes de un proceso pesado
  esperarFrame(){ return new Promise(r => setTimeout(r, 30)); },
  instruccion(t){ UC.el('instruction-text').textContent = t; },
  descargarBlob(nombre, blob){
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: nombre });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
  descargarTexto(nombre, texto, tipo){ UC.ui.descargarBlob(nombre, new Blob([texto], { type: tipo || 'application/json' })); },

  /* Modal de reporte (mismo diseño que Cobertura). acciones: [{texto, icono, primario, accion}] */
  reporte(titulo, html, acciones){
    UC.el('report-title').textContent = titulo;
    UC.el('report-bd').innerHTML = html;
    const cont = UC.el('report-actions'); cont.innerHTML = '';
    (acciones || []).concat([{ texto: 'Cerrar', accion: () => UC.ui.cerrarReporte() }]).forEach(a => {
      const b = document.createElement('button');
      b.className = 'btn' + (a.primario ? ' primary' : '');
      b.innerHTML = (a.icono ? `<i class="fa-solid ${a.icono}"></i> ` : '');
      b.append(a.texto);
      b.addEventListener('click', () => a.accion(b));
      cont.appendChild(b);
    });
    UC.el('report-bg').classList.add('show');
  },
  cerrarReporte(){ UC.el('report-bg').classList.remove('show'); },
  async copiar(texto, boton){
    try { await navigator.clipboard.writeText(texto); }
    catch (_) { prompt('Copiá el texto:', texto); return; }
    if (boton) { const o = boton.innerHTML; boton.innerHTML = '<i class="fa-solid fa-check"></i> Copiado'; setTimeout(() => boton.innerHTML = o, 1800); }
  }
};

/* ── Cálculos y formato ── */
UC.util = {
  haversineKm(a, b){
    const R = 6371.0088, la = a[0] * Math.PI / 180, lb = b[0] * Math.PI / 180;
    const dLat = lb - la, dLon = (b[1] - a[1]) * Math.PI / 180;
    return R * 2 * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2));
  },
  lineKm(ll){ let d = 0; for (let i = 1; i < ll.length; i++) d += UC.util.haversineKm(ll[i - 1], ll[i]); return d; },
  fmtKm(km){ return km.toFixed(2) + ' km'; },
  fmtNum(n){ return Number(n).toLocaleString('es-PE'); },
  // Igual que RutaCore: la vuelta se dibuja con el color de la ruta más oscuro
  adjustColor(hex, amt){
    const c = parseInt(hex.slice(1), 16);
    const r = Math.max(0, Math.min(255, ((c >> 16) & 0xff) + amt));
    const g = Math.max(0, Math.min(255, ((c >> 8) & 0xff) + amt));
    const b = Math.max(0, Math.min(255, (c & 0xff) + amt));
    return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
  },
  escapeHtml(t){ return String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  nombreVia(props){ const p = props || {}; return p.name || p.nombre || p.NAME || ''; },
  fecha(){ return new Date().toISOString().slice(0, 10); }
};

/* ── Avisos entre módulos ──
   Eventos usados en v1.0:
   'red:cargada'     → la red se cargó por primera vez (o se reemplazó sin datos previos)
   'red:cambiada'    → {eliminados:Set, agregados:Set}: se borraron, dibujaron o reemplazaron tramos
   'rutas:cambiadas' → cambió alguna ruta (tramos, nombre, color o se creó/borró)
   'jerarquia:cambiada' → cambió la clasificación vial
   'red:atributos'   → se editaron datos (properties) de tramos desde el módulo Atributos
   'paraderos:cambiados' → se agregó, movió, aceptó o borró un paradero, o cambió una capa de Paraderos
   'proyecto:abierto' → se terminó de abrir un proyecto o sesión */
UC.eventos = {
  _h: {},
  on(ev, fn){ (this._h[ev] = this._h[ev] || []).push(fn); },
  emit(ev, data){ (this._h[ev] || []).forEach(fn => { try { fn(data); } catch (e) { console.error('Error en aviso', ev, e); } }); }
};
