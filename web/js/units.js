// Length units (metric / feet) and drawing scales. All stored data stays in metres.
const FT = 0.3048, IN = 0.0254;
const KEY = 'ct_unit';
let unit = 'm';
try { if (typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === 'ft') unit = 'ft'; } catch {}

export const getUnit = () => unit;
export function setUnit(u) {
  unit = u === 'ft' ? 'ft' : 'm';
  try { localStorage.setItem(KEY, unit); } catch {}
}
export const toggleUnit = () => setUnit(unit === 'm' ? 'ft' : 'm');

/** metres -> number in the current unit */
export const toUnit = (m) => (unit === 'ft' ? m / FT : m);
/** number in the current unit -> metres */
export const fromUnit = (v) => (unit === 'ft' ? v * FT : v);

/** "4.20 m" or "13.78 ft" */
export function fmt(m, dp = 2) {
  if (m == null || Number.isNaN(m)) return '';
  return `${toUnit(m).toFixed(dp)} ${unit}`;
}
/** A plain number in the current unit, for editable fields. */
export const num = (m, dp = 3) => (m == null ? '' : String(+toUnit(m).toFixed(dp)));

/** Feet and inches, e.g. 4.2 m -> 13' 9". */
export function ftIn(m) {
  let inches = Math.round(m / IN);
  const ft = Math.floor(inches / 12); inches -= ft * 12;
  return `${ft}' ${inches}"`;
}

/**
 * Reads a typed length and returns metres, or NaN. Understands "12", "3.5m", "1250mm", "40cm",
 * "12ft", "12'", "12'6", "12' 6\"", "12 ft 6 in", "6in". A bare number uses [bare] ('m'|'ft'|'mm'|'in'),
 * which defaults to the current unit.
 */
export function parseLen(text, bare = unit) {
  const s = String(text ?? '').trim().toLowerCase().replace(/[,]/g, '.');
  if (!s) return NaN;
  const f = { m: 1, ft: FT, mm: 0.001, cm: 0.01, in: IN };
  // feet and inches: 12'6", 12 ft 6 in, 12'
  let m = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)?)?$/);
  if (m) return Number(m[1]) * FT + (m[2] ? Number(m[2]) * IN : 0);
  m = s.match(/^(-?\d+(?:\.\d+)?)\s*(mm|cm|m|in|inch|inches|")?$/);
  if (m) {
    const u = m[2] === 'inch' || m[2] === 'inches' || m[2] === '"' ? 'in' : (m[2] || bare);
    return Number(m[1]) * (f[u] ?? 1);
  }
  return NaN;
}

// ---- drawing scales (paper : real) ----
export const SCALES = [
  { label: '1:5', n: 5 }, { label: '1:10', n: 10 }, { label: '1:20', n: 20 },
  { label: '1:24  (1/2" = 1\')', n: 24 }, { label: '1:25', n: 25 }, { label: '1:50', n: 50 },
  { label: '1:100', n: 100 }, { label: '1:200', n: 200 }, { label: '1:500', n: 500 },
  { label: '1/8" = 1\'  (1:96)', n: 96 }, { label: '3/16" = 1\'  (1:64)', n: 64 },
  { label: '1/4" = 1\'  (1:48)', n: 48 }, { label: '3/8" = 1\'  (1:32)', n: 32 },
  { label: '3/4" = 1\'  (1:16)', n: 16 }, { label: '1" = 1\'  (1:12)', n: 12 },
];
export const scaleByLabel = (label) => SCALES.find((s) => s.label === label);

/** Paper sheets (long edge, mm) so you can tap both ends of the sheet instead of measuring. */
export const SHEETS = { 'A4 long edge (297 mm)': 297, 'A3 long edge (420 mm)': 420, 'A2 long edge (594 mm)': 594,
  'A1 long edge (841 mm)': 841, 'A0 long edge (1189 mm)': 1189, 'Letter long edge (11 in)': 279.4, 'Tabloid long edge (17 in)': 431.8 };

/** A round length for the on-screen scale bar: biggest "nice" length that fits maxPx. */
export function niceBar(pxPerM, maxPx) {
  const steps = unit === 'ft'
    ? [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500].map((v) => ({ v, m: v * FT }))
    : [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100].map((v) => ({ v, m: v }));
  let best = steps[0];
  for (const s of steps) if (s.m * pxPerM <= maxPx) best = s;
  return { ...best, label: `${best.v} ${unit}`, px: best.m * pxPerM };
}
