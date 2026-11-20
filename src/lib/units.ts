// 单位换算：领域内部统一 m³ / m² / m / mm / m³/s
import type { CurveVersion } from '../types';

export const WAN_M3_TO_M3 = 10_000;
export const KM2_TO_M2 = 1_000_000;

export function normalizeCurveY(curve: CurveVersion, y: number): number {
  if (curve.pointUnit === 'wan_m3') return y * WAN_M3_TO_M3;
  if (curve.pointUnit === 'km2') return y * KM2_TO_M2;
  return y; // m3 / m2
}

/** mm × m² => m³ */
export function depthAreaToVolume(depthMm: number, areaM2: number): number {
  return (depthMm * areaM2) / 1000;
}

export function formatM3(v: number | null, digits = 1): string {
  if (v === null || Number.isNaN(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(digits)} 亿m³`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(digits)} 万m³`;
  return `${v.toFixed(0)} m³`;
}

export function formatFlow(v: number | null, digits = 1): string {
  if (v === null || Number.isNaN(v)) return '—';
  return `${v.toFixed(digits)} m³/s`;
}

export function formatRangeM3(r: [number, number] | null): string {
  if (!r) return '—';
  return `[${formatM3(r[0])}, ${formatM3(r[1])}]`;
}

export function formatRangeFlow(r: [number | null, number | null] | null): string {
  if (!r) return '—';
  return `[${formatFlow(r[0])}, ${formatFlow(r[1])}]`;
}
