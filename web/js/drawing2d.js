// 2D drawing tracer: calibrate scale from printed dimensions, trace walls, add openings and a marker.
// Everything is stored in IMAGE PIXELS so re-calibrating rescales the model, not the tracing.
import { uid, fileUrl } from './api.js';
import { fmt, num, parseLen, getUnit, toUnit, SCALES, scaleByLabel, SHEETS, niceBar } from './units.js';

const SNAP_PX = 12;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export class Tracer {
  constructor(stage, drawing, { onChange, ask }) {
    this.drawing = drawing; this.onChange = onChange; this.ask = ask;
    this.canvas = document.createElement('canvas');
    stage.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.tool = 'pan'; this.view = { s: 1, ox: 0, oy: 0 };
    this.chain = null;      // last point of the wall being drawn
    this.pending = null;    // first point of calibration / check / measure
    this.measured = null;   // last measurement {a,b}
    this.mouse = [0, 0];
    this.img = new Image();
    this.img.onload = () => { this.fit(); this.draw(); };
    this.img.src = fileUrl(drawing.file);
    this.bind();
    new ResizeObserver(() => { this.resize(); this.draw(); }).observe(stage);
  }

  zoomBy(f, cx, cy) {
    const v = this.view, w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    const mx = cx ?? w / 2, my = cy ?? h / 2, ns = Math.max(0.02, Math.min(60, v.s * f));
    v.ox = mx - (mx - v.ox) * ns / v.s; v.oy = my - (my - v.oy) * ns / v.s; v.s = ns; this.draw();
  }
  get ppm() { return this.drawing.pxPerM || 0; }
  setTool(t) { this.tool = t; this.chain = null; this.pending = null; this.draw(); }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const d = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, r.width * d); this.canvas.height = Math.max(1, r.height * d);
    this.dpr = d;
  }
  fit() {
    this.resize();
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    const s = Math.min(w / this.img.width, h / this.img.height) * 0.95 || 1;
    this.view = { s, ox: (w - this.img.width * s) / 2, oy: (h - this.img.height * s) / 2 };
  }
  toImg(e) {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left - this.view.ox) / this.view.s, (e.clientY - r.top - this.view.oy) / this.view.s];
  }
  toScr(p) { return [p[0] * this.view.s + this.view.ox, p[1] * this.view.s + this.view.oy]; }

  // ---- geometry helpers ----
  snapPoint(p, from, free) {
    // snap to existing wall ends first
    let best = null, bd = SNAP_PX / this.view.s;
    for (const w of this.drawing.walls) for (const q of [w.a, w.b]) {
      const d = dist(p, q); if (d < bd) { bd = d; best = q; }
    }
    if (best) return [best[0], best[1]];
    if (from && !free) { // ortho snap within 6 degrees
      const dx = p[0] - from[0], dy = p[1] - from[1], ang = Math.atan2(dy, dx) * 180 / Math.PI;
      const near = Math.round(ang / 90) * 90;
      if (Math.abs(ang - near) < 6) {
        const len = Math.hypot(dx, dy), rad = near * Math.PI / 180;
        return [from[0] + Math.cos(rad) * len, from[1] + Math.sin(rad) * len];
      }
    }
    return p;
  }
  nearestWall(p, maxPx = 14) {
    let best = null, bd = maxPx / this.view.s;
    for (const w of this.drawing.walls) {
      const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1], l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - w.a[0]) * dx + (p[1] - w.a[1]) * dy) / l2));
      const q = [w.a[0] + dx * t, w.a[1] + dy * t], d = dist(p, q);
      if (d < bd) { bd = d; best = { wall: w, t, point: q }; }
    }
    return best;
  }

  // ---- events ----
  bind() {
    const c = this.canvas;
    let drag = null;
    const ptrs = new Map();   // active pointers, for two-finger pinch zoom and pan
    let pinch = null;
    const centre = () => { const [p1, p2] = [...ptrs.values()]; return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2, d: Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1 }; };
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 2) { const m = centre(); pinch = { d: m.d, x: m.x, y: m.y }; drag = null; return; }
      drag = { x: e.clientX, y: e.clientY, ox: this.view.ox, oy: this.view.oy, moved: false, pan: this.tool === 'pan' || e.button === 1 || e.button === 2 };
    });
    c.addEventListener('pointermove', (e) => {
      this.mouse = this.toImg(e);
      if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && ptrs.size >= 2) {
        const m = centre(), r = c.getBoundingClientRect();
        this.view.ox += m.x - pinch.x; this.view.oy += m.y - pinch.y;
        this.zoomBy(m.d / pinch.d, m.x - r.left, m.y - r.top);
        pinch = { d: m.d, x: m.x, y: m.y };
        return;
      }
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.hypot(dx, dy) > 4) drag.moved = true;
        if (drag.pan && drag.moved) { this.view.ox = drag.ox + dx; this.view.oy = drag.oy + dy; }
      }
      this.draw();
    });
    const up = (e) => {
      ptrs.delete(e.pointerId);
      if (pinch) { if (ptrs.size < 2) pinch = null; drag = null; return; }
      const d = drag; drag = null;
      if (d && !d.moved && !d.pan && e.type === 'pointerup') this.click(this.toImg(e), e);
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('dblclick', () => { this.chain = null; this.draw(); });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      const f = Math.exp(-e.deltaY * 0.0015), v = this.view;
      const ns = Math.max(0.02, Math.min(40, v.s * f));
      v.ox = mx - (mx - v.ox) * ns / v.s; v.oy = my - (my - v.oy) * ns / v.s; v.s = ns;
      this.draw();
    }, { passive: false });
    this.keyHandler = async (e) => {
      if (e.target.closest && e.target.closest('input,textarea,select,dialog')) return;
      if (e.key === 'Escape') { this.chain = null; this.pending = null; this.measured = null; this.draw(); }
      if (e.key === 'Enter' && this.tool === 'wall' && this.chain) { e.preventDefault(); await this.typedLength(); }
    };
    window.addEventListener('keydown', this.keyHandler);
  }
  destroy() { window.removeEventListener('keydown', this.keyHandler); }

  async typedLength() {
    if (!this.ppm) return;
    const a = this.chain, p = this.snapPoint(this.mouse, a, false);
    const r = await this.ask('Wall length', [{ name: 'm', label: `Length (${getUnit()}), in the direction of the cursor. You can type 12'6", 3.2m or 1250mm`, type: 'text', value: '' }]);
    const m = r && parseLen(r.m);
    if (!(m > 0)) return;
    const ang = Math.atan2(p[1] - a[1], p[0] - a[0]);
    const b = [a[0] + Math.cos(ang) * m * this.ppm, a[1] + Math.sin(ang) * m * this.ppm];
    this.addWall(a, b); this.chain = b; this.draw();
  }

  addWall(a, b) {
    if (dist(a, b) < 2) return;
    this.drawing.walls.push({ id: uid().slice(0, 8), a: [...a], b: [...b] });
    this.onChange();
  }

  async click(p, e) {
    const d = this.drawing;
    switch (this.tool) {
      case 'calib': case 'check': {
        if (!this.pending) { this.pending = p; break; }
        const a = this.pending; this.pending = null;
        const px = dist(a, p);
        const r = await this.ask(this.tool === 'calib' ? 'Set scale' : 'Check a second dimension',
          [{ name: 'm', label: `Real distance between the two points (${getUnit()}), as printed on the drawing. You can type 12'6", 3.2m or 1250mm`, type: 'text', value: '' }]);
        const m = r && parseLen(r.m);
        if (!(m > 0) || px < 3) break;
        if (this.tool === 'calib') {
          d.calib = { a, b: p, meters: m }; d.pxPerM = px / m; d.scaleRatio = null;
          // keep any check consistent with the new scale
          if (d.check) d.check.errPct = ((dist(d.check.a, d.check.b) / d.pxPerM) - d.check.meters) / d.check.meters * 100;
        } else {
          d.check = { a, b: p, meters: m, errPct: this.ppm ? ((px / this.ppm) - m) / m * 100 : null };
        }
        this.onChange(); break;
      }
      case 'ratio': {
        // Scale from the drawing's printed ratio (1:24, 1/4" = 1' ...) and a length measured on the paper.
        if (!this.pending) { this.pending = p; break; }
        const a = this.pending; this.pending = null;
        const px = dist(a, p);
        const imp = getUnit() === 'ft';
        const r = await this.ask('Set scale from drawing ratio', [
          { name: 'scale', label: 'Scale printed on the drawing', type: 'select', options: SCALES.map((x) => x.label), value: SCALES.find((x) => x.n === (imp ? 48 : 50)).label },
          { name: 'custom', label: 'Or a custom ratio (for example 1:75). Leave blank to use the list', type: 'text', value: '' },
          { name: 'sheet', label: 'How long are those two points on the paper?', type: 'select', options: ['I measured it (type below)', ...Object.keys(SHEETS)], value: 'I measured it (type below)' },
          { name: 'paper', label: `Length on the paper (${imp ? 'inches' : 'mm'}), measured with a ruler on the printout`, type: 'text', value: '' }],
          'Tap both ends of something you can measure on the paper, such as a printed line or the edge of the sheet.');
        if (!r || px < 3) break;
        let n = scaleByLabel(r.scale)?.n;
        const cm = String(r.custom || '').trim().match(/^1\s*[:/]\s*(\d+(?:\.\d+)?)$/);
        if (r.custom && String(r.custom).trim()) { if (!cm) { await this.ask('Scale not understood', [], 'Type a ratio like 1:75.'); break; } n = Number(cm[1]); }
        const paperM = SHEETS[r.sheet] != null ? SHEETS[r.sheet] / 1000 : parseLen(r.paper, imp ? 'in' : 'mm');
        if (!(paperM > 0) || !(n > 0)) { await this.ask('Missing length', [], 'Enter the length on the paper, or choose the sheet size.'); break; }
        const meters = paperM * n;
        d.calib = { a, b: p, meters, ratio: n }; d.pxPerM = px / meters; d.scaleRatio = n;
        if (d.check) d.check.errPct = ((dist(d.check.a, d.check.b) / d.pxPerM) - d.check.meters) / d.check.meters * 100;
        this.onChange(); break;
      }
      case 'measure': {
        if (!this.ppm) { await this.ask('Set the scale first', [], 'Set the scale before measuring.'); break; }
        if (!this.pending) { this.pending = p; this.measured = null; break; }
        this.measured = { a: this.pending, b: p }; this.pending = null; break;
      }
      case 'wall': {
        if (!this.ppm) { await this.ask('Set the scale first', [], 'Use "Set scale" and tap the two ends of a printed dimension before tracing walls.'); break; }
        const q = this.snapPoint(p, this.chain, e.altKey);
        if (this.chain) this.addWall(this.chain, q);
        this.chain = q; break;
      }
      case 'opening': {
        const n = this.nearestWall(p); if (!n) break;
        const r = await this.ask('Door or window', [
          { name: 'kind', label: 'Type', type: 'select', options: ['door', 'window'], value: 'door' },
          { name: 'width', label: `Width (${getUnit()})`, type: 'text', value: num(0.9, 2) },
          { name: 'sill', label: `Sill height (${getUnit()})`, type: 'text', value: num(0, 2) },
          { name: 'head', label: `Head height (${getUnit()})`, type: 'text', value: num(2.04, 2) }]);
        if (!r) break;
        const w = parseLen(r.width), sill = parseLen(r.sill), head = parseLen(r.head);
        if (!(w > 0) || !(sill >= 0) || !(head > sill)) { await this.ask('Check the sizes', [], 'Width, sill and head heights need to be sensible numbers.'); break; }
        d.openings.push({ id: uid().slice(0, 8), wall: n.wall.id, t: n.t, kind: r.kind, width: w, sill, head });
        this.onChange(); break;
      }
      case 'marker': {
        const n = this.nearestWall(p, 30);
        const r = await this.ask('Marker', [
          { name: 'h', label: `Height of marker centre above floor (${getUnit()})`, type: 'text', value: num(1.5, 2) },
          { name: 'size', label: `Printed size (${getUnit()}, edge to edge)`, type: 'text', value: num(0.15, 3) },
          ...(n ? [] : [{ name: 'yaw', label: 'Facing direction (degrees: 0 = right on the drawing, 90 = down the page)', type: 'number', value: '90', step: 'any' }])]);
        if (!r) break;
        let pos = p, facing;
        if (n) {
          pos = n.point;
          const dx = n.wall.b[0] - n.wall.a[0], dy = n.wall.b[1] - n.wall.a[1], l = Math.hypot(dx, dy) || 1;
          let nx = -dy / l, ny = dx / l;
          if ((p[0] - pos[0]) * nx + (p[1] - pos[1]) * ny < 0) { nx = -nx; ny = -ny; } // face the side you clicked
          facing = [nx, ny];
        } else { const a = Number(r.yaw) * Math.PI / 180; facing = [Math.cos(a), Math.sin(a)]; }
        const hm = parseLen(r.h), sm = parseLen(r.size);
        if (!(hm >= 0) || !(sm > 0)) { await this.ask('Check the sizes', [], 'Height and printed size need to be numbers.'); break; }
        d.marker = { pos, facing, heightM: hm, sizeM: sm };
        this.onChange(); break;
      }
      case 'erase': {
        const o = d.openings.findIndex((op) => { const w = d.walls.find((x) => x.id === op.wall); if (!w) return false;
          const q = [w.a[0] + (w.b[0] - w.a[0]) * op.t, w.a[1] + (w.b[1] - w.a[1]) * op.t]; return dist(p, q) < 14 / this.view.s; });
        if (o >= 0) { d.openings.splice(o, 1); this.onChange(); break; }
        if (d.marker && dist(p, d.marker.pos) < 16 / this.view.s) { d.marker = null; this.onChange(); break; }
        const n = this.nearestWall(p);
        if (n) { d.walls = d.walls.filter((w) => w.id !== n.wall.id); d.openings = d.openings.filter((o2) => o2.wall !== n.wall.id); this.onChange(); }
        break;
      }
    }
    this.draw();
  }

  // ---- drawing ----
  draw() {
    const { ctx, canvas, view: v } = this;
    if (!canvas.width) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save(); ctx.translate(v.ox, v.oy); ctx.scale(v.s, v.s);
    if (this.img.complete && this.img.naturalWidth) ctx.drawImage(this.img, 0, 0);
    const lw = (n) => n / v.s, d = this.drawing;
    ctx.lineCap = 'round';
    const line = (a, b, col, w, dash) => { ctx.beginPath(); ctx.setLineDash(dash ? dash.map(lw) : []); ctx.strokeStyle = col; ctx.lineWidth = lw(w);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.setLineDash([]); };
    const dot = (p, col, r = 4) => { ctx.beginPath(); ctx.fillStyle = col; ctx.arc(p[0], p[1], lw(r), 0, 7); ctx.fill(); };
    for (const w of d.walls) { line(w.a, w.b, '#00d4ff', 3); dot(w.a, '#00d4ff', 3); dot(w.b, '#00d4ff', 3); }
    for (const o of d.openings) {
      const w = d.walls.find((x) => x.id === o.wall); if (!w) continue;
      const L = dist(w.a, w.b), ux = (w.b[0] - w.a[0]) / L, uy = (w.b[1] - w.a[1]) / L;
      const c = [w.a[0] + (w.b[0] - w.a[0]) * o.t, w.a[1] + (w.b[1] - w.a[1]) * o.t], h = (o.width * this.ppm) / 2;
      line([c[0] - ux * h, c[1] - uy * h], [c[0] + ux * h, c[1] + uy * h], o.kind === 'door' ? '#6fcf7a' : '#5aa9ff', 6);
    }
    if (d.calib) { line(d.calib.a, d.calib.b, '#ffc400', 3); dot(d.calib.a, '#ffc400'); dot(d.calib.b, '#ffc400'); }
    if (d.check) { line(d.check.a, d.check.b, '#ff9f43', 3, [8, 6]); dot(d.check.a, '#ff9f43'); dot(d.check.b, '#ff9f43'); }
    if (d.marker) {
      const m = d.marker, s = Math.max(10, (m.sizeM || 0.15) * this.ppm);
      ctx.fillStyle = '#ff4de0'; ctx.fillRect(m.pos[0] - lw(7), m.pos[1] - lw(7), lw(14), lw(14));
      line(m.pos, [m.pos[0] + m.facing[0] * Math.max(s, 24 / v.s), m.pos[1] + m.facing[1] * Math.max(s, 24 / v.s)], '#ff4de0', 3);
    }
    for (const r of d.routes || []) {
      ctx.beginPath(); ctx.strokeStyle = '#ffc40099'; ctx.lineWidth = lw(2); ctx.setLineDash([lw(6), lw(5)]);
      r.points.forEach((p, i) => { const q = [p[0] * this.ppm, p[2] * this.ppm]; i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
      ctx.stroke(); ctx.setLineDash([]);
    }
    // live feedback
    if (this.pending) { line(this.pending, this.mouse, '#ffc400', 2, [5, 4]); dot(this.pending, '#ffc400'); }
    if (this.tool === 'wall' && this.chain) {
      const q = this.snapPoint(this.mouse, this.chain, false);
      line(this.chain, q, '#ffffff', 2, [6, 4]);
      if (this.ppm) { ctx.fillStyle = '#fff'; ctx.font = `${lw(14)}px sans-serif`;
        ctx.fillText(fmt(dist(this.chain, q) / this.ppm), q[0] + lw(10), q[1] - lw(10)); }
    }
    // measure tool
    const ms = this.measured || (this.tool === 'measure' && this.pending ? { a: this.pending, b: this.mouse } : null);
    if (ms && this.ppm) {
      line(ms.a, ms.b, '#7CFC00', 2); dot(ms.a, '#7CFC00'); dot(ms.b, '#7CFC00');
      ctx.fillStyle = '#7CFC00'; ctx.font = `bold ${lw(15)}px sans-serif`;
      ctx.fillText(fmt(dist(ms.a, ms.b) / this.ppm), (ms.a[0] + ms.b[0]) / 2 + lw(8), (ms.a[1] + ms.b[1]) / 2 - lw(8));
    }
    ctx.restore();
    this.drawScaleBar();
  }

  /** Scale ruler fixed to the bottom-left of the view, in the current unit. */
  drawScaleBar() {
    if (!this.ppm) return;
    const { ctx } = this, w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    const bar = niceBar(this.ppm * this.view.s, Math.min(220, w * 0.4));
    const x = 16, y = h - 22, n = bar.v >= 1 ? Math.min(5, Math.round(bar.v)) || 1 : 2;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x - 8, y - 38, bar.px + 74, 54);
    ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + bar.px, y); ctx.stroke();
    for (let i = 0; i <= n; i++) { const tx = x + (bar.px * i) / n; ctx.beginPath(); ctx.moveTo(tx, y); ctx.lineTo(tx, y - (i % n === 0 ? 10 : 6)); ctx.stroke(); }
    ctx.font = '13px sans-serif'; ctx.fillText(bar.label, x + bar.px + 8, y - 2);
    if (this.drawing.scaleRatio) ctx.fillText(`Drawn at 1:${this.drawing.scaleRatio}`, x, y - 22);
  }
}
