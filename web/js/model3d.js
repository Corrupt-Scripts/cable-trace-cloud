// 3D view: walls raised from the traced drawing, the drawing as a floor texture,
// and cable / pipe routes that you draw by clicking on walls, floor or ceiling.
// Model frame (metres): x = right on the drawing, y = up, z = down the page.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { fileUrl } from './api.js';
import { polyLength } from './lengths.js';

export const ROUTE_KINDS = {
  cable: { label: 'Cable', color: 0xffc400 },
  containment: { label: 'Containment', color: 0xb0b0b0 },
  water: { label: 'Water', color: 0x3fa7ff },
  waste: { label: 'Waste', color: 0xa0764a },
  gas: { label: 'Gas', color: 0xff8a3d },
};

export class Model3D {
  constructor(stage, drawing, { onChange, onSelect }) {
    this.drawing = drawing; this.onChange = onChange; this.onSelect = onSelect;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    stage.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x0e0d09);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const dl = new THREE.DirectionalLight(0xffffff, 1.2); dl.position.set(5, 10, 3); this.scene.add(dl);
    this.world = new THREE.Group(); this.scene.add(this.world);
    this.routeGroup = new THREE.Group(); this.scene.add(this.routeGroup);
    this.asBuilt = []; this.walls = []; this.selected = null; this.drawing_route = null; this.heightOverride = null;
    this.raycaster = new THREE.Raycaster(); this.stage = stage; this.alive = true;
    this.build(); this.buildRoutes(); this.frameAll();
    this.bind();
    new ResizeObserver(() => this.resize()).observe(stage); this.resize();
    const loop = () => { if (!this.alive) return; this.controls.update(); this.renderer.render(this.scene, this.camera); requestAnimationFrame(loop); };
    loop();
  }
  destroy() { this.alive = false; this.renderer.dispose(); this.renderer.domElement.remove(); }
  get ppm() { return this.drawing.pxPerM || 0; }
  get ceiling() { return Number(this.drawing.ceilingM) || 2.4; }
  m(p) { return [p[0] / this.ppm, p[1] / this.ppm]; }

  resize() {
    const r = this.stage.getBoundingClientRect();
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / Math.max(1, r.height); this.camera.updateProjectionMatrix();
  }

  clear(g) { while (g.children.length) { const o = g.children.pop(); o.traverse?.((c) => { c.geometry?.dispose(); c.material?.dispose?.(); }); } }

  build() {
    this.clear(this.world); this.walls = [];
    const d = this.drawing; if (!this.ppm) return;
    const H = this.ceiling, T = Number(d.wallThicknessM) || 0.1;
    // floor with the drawing as texture
    if (d.imgW) {
      const w = d.imgW / this.ppm, h = d.imgH / this.ppm;
      const tex = new THREE.TextureLoader().load(fileUrl(d.file)); tex.colorSpace = THREE.SRGBColorSpace;
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
      floor.rotation.x = -Math.PI / 2; floor.position.set(w / 2, -0.002, h / 2); this.world.add(floor);
    }
    const mat = new THREE.MeshStandardMaterial({ color: 0x8ab4c8, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x00d4ff });
    for (const w of d.walls) {
      const [ax, az] = this.m(w.a), [bx, bz] = this.m(w.b), L = Math.hypot(bx - ax, bz - az);
      if (L < 0.01) continue;
      const g = new THREE.Group(); g.position.set(ax, 0, az); g.rotation.y = -Math.atan2(bz - az, bx - ax);
      const ops = (d.openings || []).filter((o) => o.wall === w.id).map((o) => ({ ...o, s: Math.max(0, o.t * L - o.width / 2), e: Math.min(L, o.t * L + o.width / 2) })).sort((p, q) => p.s - q.s);
      const box = (s, e, y0, y1) => { if (e - s < 0.005 || y1 - y0 < 0.005) return;
        const m = new THREE.Mesh(new THREE.BoxGeometry(e - s, y1 - y0, T), mat); m.position.set((s + e) / 2, (y0 + y1) / 2, 0);
        m.userData.wall = true; g.add(m); this.walls.push(m);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), edgeMat); edges.position.copy(m.position); g.add(edges); };
      let cur = 0;
      for (const o of ops) { box(cur, o.s, 0, H); box(o.s, o.e, 0, Math.min(o.sill, H)); box(o.s, o.e, Math.min(o.head, H), H); cur = Math.max(cur, o.e); }
      box(cur, L, 0, H);
      this.world.add(g);
    }
    if (d.marker) {
      const mk = d.marker, [x, z] = this.m(mk.pos), s = mk.sizeM || 0.15;
      const q = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshBasicMaterial({ color: 0xff4de0, side: THREE.DoubleSide }));
      q.position.set(x + mk.facing[0] * 0.06, mk.heightM, z + mk.facing[1] * 0.06);
      q.rotation.y = Math.atan2(mk.facing[0], mk.facing[1]); // plane normal (+z) -> facing
      this.world.add(q);
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(mk.facing[0], 0, mk.facing[1]), q.position, 0.4, 0xff4de0); this.world.add(arrow);
    }
  }

  frameAll() {
    const d = this.drawing;
    const w = d.imgW && this.ppm ? d.imgW / this.ppm : 10, h = d.imgH && this.ppm ? d.imgH / this.ppm : 10;
    this.controls.target.set(w / 2, 0, h / 2);
    this.camera.position.set(w / 2 + w * 0.5, Math.max(w, h) * 0.75, h / 2 + h * 0.9); this.controls.update();
  }
  plan() { const t = this.controls.target, d = this.drawing, ext = d.imgW && this.ppm ? Math.max(d.imgW, d.imgH) / this.ppm : 10; this.camera.position.set(t.x, ext * 1.0, t.z + 0.001); this.controls.update(); }

  buildRoutes() {
    this.clear(this.routeGroup);
    // as-built runs recorded on site, placed through the marker
    for (const ab of this.asBuilt) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x00e5b0 });
      for (let i = 1; i < ab.points.length; i++) {
        const a = new THREE.Vector3(...ab.points[i - 1]), b = new THREE.Vector3(...ab.points[i]), len = a.distanceTo(b);
        if (len < 1e-4) continue;
        const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, len, 8), mat);
        cyl.position.copy(a).add(b).multiplyScalar(0.5);
        cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
        this.routeGroup.add(cyl);
      }
      ab.points.forEach((p) => { const s = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), mat); s.position.set(...p); this.routeGroup.add(s); });
    }
    for (const r of this.drawing.routes || []) {
      const col = (ROUTE_KINDS[r.kind] || ROUTE_KINDS.cable).color, sel = r.id === this.selected, rad = sel ? 0.035 : 0.025;
      const mat = new THREE.MeshBasicMaterial({ color: sel ? 0xffffff : col });
      for (let i = 1; i < r.points.length; i++) {
        const a = new THREE.Vector3(...r.points[i - 1]), b = new THREE.Vector3(...r.points[i]), len = a.distanceTo(b);
        if (len < 1e-4) continue;
        const cyl = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, len, 8), mat);
        cyl.position.copy(a).add(b).multiplyScalar(0.5);
        cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
        this.routeGroup.add(cyl);
      }
      r.points.forEach((p, i) => { const s = new THREE.Mesh(new THREE.SphereGeometry(rad * 2.4, 10, 8), new THREE.MeshBasicMaterial({ color: i === 0 ? 0x6fcf7a : col })); s.position.set(...p); this.routeGroup.add(s); });
    }
  }
  select(id) { this.selected = id; this.buildRoutes(); }

  /** World point under the pointer: wall surface, floor or ceiling, or a fixed-height plane if set. */
  pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const nd = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(nd, this.camera);
    const ray = this.raycaster.ray, hits = [];
    const plane = (y) => { const p = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), v = new THREE.Vector3(); return ray.intersectPlane(p, v) ? v : null; };
    if (this.heightOverride !== null && this.heightOverride !== '' && !Number.isNaN(Number(this.heightOverride))) {
      const v = plane(Number(this.heightOverride)); return v ? v.toArray() : null;
    }
    for (const h of this.raycaster.intersectObjects(this.walls, false)) {
      const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
      if (n.dot(ray.direction) > 0) n.negate(); // offset towards the camera side
      hits.push({ d: h.distance, p: h.point.clone().addScaledVector(n, 0.015) });
    }
    for (const y of [0, this.ceiling]) { const v = plane(y); if (v) hits.push({ d: v.distanceTo(ray.origin), p: v.clone().setY(y === 0 ? 0.015 : y - 0.015) }); }
    if (!hits.length) return null;
    hits.sort((a, b) => a.d - b.d);
    return hits[0].p.toArray();
  }

  bind() {
    const el = this.renderer.domElement; let down = null;
    el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) { down = null; return; }
      down = null;
      if (!this.drawing_route) return;
      const p = this.pick(e); if (!p) return;
      const route = (this.drawing.routes || []).find((r) => r.id === this.drawing_route); if (!route) return;
      route.points.push(p.map((v) => Math.round(v * 1000) / 1000));
      this.buildRoutes(); this.onChange();
    });
  }

  length(route) { return polyLength(route.points); }
}
