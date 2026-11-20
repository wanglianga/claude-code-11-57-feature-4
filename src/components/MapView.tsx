import type { IndicatorStatus, Reservoir } from '../types';

const FILL: Record<IndicatorStatus, string> = {
  ok: '#15803d',
  warn: '#b91c1c',
  pending: '#7c3aed',
};

export default function MapView({
  reservoirs,
  statusOf,
  selectedId,
  onSelect,
}: {
  reservoirs: Reservoir[];
  statusOf: (id: string) => IndicatorStatus;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  if (reservoirs.length === 0) {
    return <div className="muted">无水库坐标</div>;
  }
  const lons = reservoirs.map((r) => r.lon);
  const lats = reservoirs.map((r) => r.lat);
  const minLon = Math.min(...lons) - 0.08;
  const maxLon = Math.max(...lons) + 0.08;
  const minLat = Math.min(...lats) - 0.08;
  const maxLat = Math.max(...lats) + 0.08;
  const W = 760;
  const H = 320;
  const x = (lon: number) => ((lon - minLon) / (maxLon - minLon)) * (W - 80) + 40;
  const y = (lat: number) => H - (((lat - minLat) / (maxLat - minLat)) * (H - 70) + 35);

  return (
    <svg className="map-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="水库分布示意图">
      <defs>
        <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#d6e3f2" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width={W} height={H} fill="url(#grid)" />
      <path d="M 60 260 C 200 200, 300 240, 420 170 S 640 120, 720 90" fill="none" stroke="#93c5fd" strokeWidth="14" strokeLinecap="round" opacity="0.7" />
      {reservoirs.map((r) => {
        const status = statusOf(r.id);
        return (
          <g key={r.id} className="map-dot" onClick={() => onSelect(r.id)}>
            <circle
              cx={x(r.lon)}
              cy={y(r.lat)}
              r={selectedId === r.id ? 13 : 10}
              fill={FILL[status]}
              className={selectedId === r.id ? 'selected' : ''}
            />
            <text x={x(r.lon)} y={y(r.lat) - 16} className="map-label">{r.name}</text>
          </g>
        );
      })}
      <g transform="translate(40,290)">
        {(['ok', 'warn', 'pending'] as IndicatorStatus[]).map((s, i) => (
          <g key={s} transform={`translate(${i * 120},0)`}>
            <circle cx="8" cy="0" r="7" fill={FILL[s]} />
            <text x="22" y="4" fontSize="12" fill="#0f2747">{s === 'ok' ? '正常' : s === 'warn' ? '告警' : '待核'}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}
