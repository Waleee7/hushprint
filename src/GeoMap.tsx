import { useMemo } from 'react';
import { LAND_DIMS, haversineKm, landGrid, project, formatDistance, type LatLon } from './engine/geo.ts';

const CELL = 5;

/** A hand-drawn loop around (cx, cy), the way an editor circles a frame on a contact sheet. Overshoots where it closes. */
const loop = (cx: number, cy: number, r: number) =>
  `M${cx - r * 0.15} ${cy - r * 1.05} C${cx + r * 0.95} ${cy - r * 1.25} ${cx + r * 1.3} ${cy + r * 0.5} ${cx + r * 0.2} ${cy + r * 1.08} C${cx - r * 1.1} ${cy + r * 1.3} ${cx - r * 1.35} ${cy - r * 0.6} ${cx + r * 0.3} ${cy - r * 1.18} C${cx + r * 0.6} ${cy - r * 1.25} ${cx + r * 0.9} ${cy - r * 1.1} ${cx + r * 1.05} ${cy - r * 0.8}`;

/** Offline dot-matrix world map. No tiles, no requests: the land mask is baked into the bundle. */
export function WorldMap({ point, label }: { point: LatLon; label?: string }) {
  const d = useMemo(() => {
    const g = landGrid();
    let s = '';
    g.forEach((row, y) => row.forEach((on, x) => { if (on) s += `M${x * CELL + CELL / 2} ${y * CELL + CELL / 2}h0`; }));
    return s;
  }, []);
  const { x, y } = project(point);
  const px = Math.min(Math.max(x, 0), LAND_DIMS.w) * CELL, py = Math.min(Math.max(y, 0), LAND_DIMS.h) * CELL;
  const flip = px > LAND_DIMS.w * CELL * 0.62;
  return (
    <svg className="worldmap" viewBox={`0 0 ${LAND_DIMS.w * CELL} ${LAND_DIMS.h * CELL}`} role="img" aria-label={`World map with a marker at ${point.lat.toFixed(3)}, ${point.lon.toFixed(3)}`}>
      <path d={d} className="land" />
      <line x1={px} x2={px} y1={0} y2={LAND_DIMS.h * CELL} className="cross" />
      <line y1={py} y2={py} x1={0} x2={LAND_DIMS.w * CELL} className="cross" />
      <path d={loop(px, py, 34)} className="ring" pathLength={1} />
      <circle cx={px} cy={py} r={9} className="pin" />
      {label && (
        <g transform={`translate(${flip ? px - 44 : px + 44} ${py - 30})`}>
          <text className="pinlabel" textAnchor={flip ? 'end' : 'start'}>{label}</text>
        </g>
      )}
    </svg>
  );
}

/** Radar-style local view: the photo's position and the nearest cities, to scale. */
export function Radar({ point, cities }: { point: LatLon; cities: { name: string; lat: number; lon: number }[] }) {
  const R = 130;
  const dists = cities.map((c) => haversineKm(point, c));
  const maxKm = niceCeil(Math.max(1, ...dists) * 1.15);
  const k = Math.cos((point.lat * Math.PI) / 180);
  const place = (c: { lat: number; lon: number }) => {
    const dx = (c.lon - point.lon) * 111.32 * k, dy = (c.lat - point.lat) * 110.57;
    return { x: (dx / maxKm) * R, y: (-dy / maxKm) * R };
  };
  return (
    <svg className="radar" viewBox="-150 -150 300 300" role="img" aria-label={`Local view: nearest cities ${cities.map((c, i) => `${c.name} ${formatDistance(dists[i])}`).join(', ')}`}>
      {[1, 2, 3].map((i) => <circle key={i} r={(R * i) / 3} className="rr" />)}
      <line x1={-R} x2={R} className="rr" /><line y1={-R} y2={R} className="rr" />
      {[1, 2, 3].map((i) => <text key={i} x={4} y={-(R * i) / 3 - 3} className="rt">{formatDistance((maxKm * i) / 3)}</text>)}
      {cities.map((c, i) => { const p = place(c); const left = p.x > 40; return (
        <g key={c.name}>
          <line x1={0} y1={0} x2={p.x} y2={p.y} className="spoke" />
          <rect x={p.x - 3} y={p.y - 3} width={6} height={6} className="city" />
          <text x={left ? p.x - 8 : p.x + 8} y={p.y + 4} textAnchor={left ? 'end' : 'start'} className="ct">{c.name}</text>
          <text x={left ? p.x - 8 : p.x + 8} y={p.y + 16} textAnchor={left ? 'end' : 'start'} className="rt">{formatDistance(dists[i])}</text>
        </g>); })}
      <path d={loop(0, 0, 16)} className="ring" pathLength={1} /><circle r={5} className="pin" />
    </svg>
  );
}

const niceCeil = (v: number) => { const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };
