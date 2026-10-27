import { fmt as fmtU } from './units.js';
// Same maths as the phone app's lib/analysis/length_check.dart.
export const COPPER = 0.0181; // ohm·mm²/m at 20 °C

export function defaultReturnSize(cableType, size) {
  if (!String(cableType).startsWith('T&E')) return null;
  return { 10: 1.0, 15: 1.0, 25: 1.5, 40: 1.5, 60: 2.5, 100: 4.0, 160: 6.0 }[Math.round(size * 10)] ?? null;
}

export function lengthFromLoop(loopOhms, size, returnSize) {
  if (!(loopOhms > 0) || !(size > 0)) return null;
  const r2 = returnSize || size;
  return loopOhms / (COPPER * (1 / size + 1 / r2));
}

export function polyLength(pts) {
  let t = 0;
  for (let i = 1; i < pts.length; i++) t += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
  return t;
}
export const wpLength = (w) => polyLength(w.map((p) => [p.x, p.y, p.z]));

export function checkLength(mapped, expected) {
  const m = (v) => fmtU(v, 1);
  if (!(expected > 0)) return { status: 'unknown', warn: false, message: 'No cable length to compare with.' };
  const tol = Math.max(0.5, 0.15 * expected), gap = expected - mapped;
  if (Math.abs(gap) <= tol) return { status: 'matches', warn: false, message: `Mapped ${m(mapped)}, cable is ${m(expected)}. Matches within AR accuracy.` };
  if (gap > 0) return { status: 'missing', warn: true, message: `Mapped ${m(mapped)}, cable is ${m(expected)}. About ${m(gap)} of the cable isn't on the map: you've probably missed a section (or a loop of slack).` };
  return { status: 'longer', warn: true, message: `Mapped ${m(mapped)} but the cable is only ${m(expected)}. Check for a doubled-back or wrongly placed point, or a wrong length reading.` };
}

export function positionAlong(w, d) {
  if (w.length < 2 || !(d >= 0)) return null;
  let run = 0;
  for (let i = 1; i < w.length; i++) {
    run += Math.hypot(w[i].x - w[i - 1].x, w[i].y - w[i - 1].y, w[i].z - w[i - 1].z);
    if (d <= run) return `between points ${i} and ${i + 1}`;
  }
  return `past the last mapped point (by ${fmtU(d - run, 1)})`;
}

/** Recorded waypoints (phone AR frame) -> the drawing's model frame, through the shared marker.
 *  Returns [[x,y,z]...] in metres, or null if the run or drawing has no marker. */
export function asBuiltPoints(waypoints, runMarker, drawing) {
  const mk = drawing.marker, ppm = drawing.pxPerM;
  if (!mk || !ppm || !runMarker || !waypoints.length) return null;
  const mx = mk.pos[0] / ppm, mz = mk.pos[1] / ppm, my = mk.heightM;
  const yawModel = Math.atan2(-mk.facing[0], mk.facing[1]);
  const d = runMarker.yaw - yawModel, c = Math.cos(-d), s = Math.sin(-d);
  return waypoints.map((w) => {
    const dx = w.x - runMarker.x, dy = w.y - runMarker.y, dz = w.z - runMarker.z;
    return [mx + dx * c - dz * s, my + dy, mz + dx * s + dz * c];
  });
}
