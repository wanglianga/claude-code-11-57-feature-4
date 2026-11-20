// 曲线插值与版本选择：库容曲线、库面面积曲线，按当时有效版本换算
import type { CurveVersion, ISOTime } from '../types';
import { normalizeCurveY } from './units';
import { t } from './time';

export class CurveError extends Error {}

/** 取某时刻对某水库有效的已审批曲线；无效/缺失/重叠均抛错，由调用方转“待核” */
export function effectiveCurve(
  curves: CurveVersion[],
  reservoirId: string,
  kind: CurveVersion['kind'],
  at: ISOTime,
): CurveVersion {
  const matched = curves.filter(
    (c) =>
      c.reservoirId === reservoirId &&
      c.kind === kind &&
      t(c.validFrom).valueOf() <= t(at).valueOf() &&
      (c.validTo === undefined || t(c.validTo).valueOf() > t(at).valueOf()),
  );
  const approved = matched.filter((c) => c.approvalStatus === 'approved');
  if (approved.length === 0) {
    throw new CurveError(`无有效${kind === 'storage' ? '库容' : '面积'}曲线（${at}）`);
  }
  if (approved.length > 1) {
    throw new CurveError(`${kind}曲线适用期重叠：${approved.map((c) => c.version).join('、')}`);
  }
  return approved[0];
}

function sortedPoints(curve: CurveVersion) {
  return [...curve.points].sort((a, b) => a.x - b.x);
}

/** 线性插值；超出曲线范围抛错（不外推），保证可复算 */
export function interpolate(curve: CurveVersion, level: number): number {
  const pts = sortedPoints(curve);
  if (pts.length < 2) throw new CurveError(`曲线 ${curve.version} 点数不足`);
  if (level < pts[0].x || level > pts[pts.length - 1].x) {
    throw new CurveError(
      `水位 ${level.toFixed(3)}m 超出曲线 ${curve.version} 范围 [${pts[0].x}, ${pts[pts.length - 1].x}]`,
    );
  }
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    if (level >= a.x && level <= b.x) {
      if (b.x === a.x) return normalizeCurveY(curve, a.y);
      const ratio = (level - a.x) / (b.x - a.x);
      return normalizeCurveY(curve, a.y + ratio * (b.y - a.y));
    }
  }
  throw new CurveError('插值失败');
}

/** 水位 -> 蓄水量 m³ */
export function levelToStorage(curves: CurveVersion[], reservoirId: string, at: ISOTime, level: number): {
  storage: number;
  curve: CurveVersion;
} {
  const curve = effectiveCurve(curves, reservoirId, 'storage', at);
  return { storage: interpolate(curve, level), curve };
}

/** 按指定时刻的有效面积曲线与水位取库面面积 m² */
export function areaAtLevel(curves: CurveVersion[], reservoirId: string, at: ISOTime, level: number): {
  area: number;
  curve: CurveVersion;
} {
  const curve = effectiveCurve(curves, reservoirId, 'area', at);
  return { area: interpolate(curve, level), curve };
}
