// 流量积分：实际区间秒数的梯形积分 + 覆盖度检查；缺失不以 0 补齐
import type { RawReading } from '../types';
import { t } from './time';

export interface IntegralResult {
  /** 区间累计水量 m³；覆盖不足为 null */
  volumeM3: number | null;
  covered: boolean;
  sourceReadingIds: string[];
  /** 不确定度折算的未知范围 m³ */
  unknownRangeM3: [number, number];
  reasons: string[];
}

const EXPECTED_UNITS = new Map<string, string>([
  ['inflow', 'm3/s'],
  ['outflow', 'm3/s'],
  ['diversion_in', 'm3/s'],
  ['diversion_out', 'm3/s'],
]);

/**
 * 对 [t1,t2] 内某类流量读数做梯形积分。
 * 覆盖条件：
 *  1) 区间两端有读数（容差 60s）；
 *  2) 不存在显式缺失（value=null）/作废/量纲不相容记录；
 *  3) 相邻采样间隔不超过名义步长的 1.5 倍（断面故障缺口可被发现）。
 */
export function integrateFlow(
  readings: RawReading[],
  kind: RawReading['kind'],
  t1: string,
  t2: string,
  nominalStepSeconds: number,
): IntegralResult {
  const reasons: string[] = [];
  const inWindow = readings.filter(
    (r) =>
      r.kind === kind &&
      t(r.sampledAt).valueOf() >= t(t1).valueOf() - 60_000 &&
      t(r.sampledAt).valueOf() <= t(t2).valueOf() + 60_000,
  );
  const expectedUnit = EXPECTED_UNITS.get(kind);
  const unitBad = inWindow.filter((r) => r.unit !== expectedUnit);
  if (unitBad.length > 0) {
    reasons.push(`${kind} 存在量纲不相容记录（期望 ${expectedUnit}）：${unitBad.map((r) => r.id).join('、')}`);
  }
  const gapRecords = inWindow.filter((r) => r.quality === 'missing' || r.value === null || r.quality === 'rejected');
  if (gapRecords.length > 0) {
    reasons.push(`${kind} 区间内存在缺失/作废读数 ${gapRecords.length} 条，不以零补齐`);
  }

  const usable = inWindow
    .filter((r) => r.value !== null && r.quality !== 'missing' && r.quality !== 'rejected' && r.unit === expectedUnit)
    .sort((a, b) => t(a.sampledAt).valueOf() - t(b.sampledAt).valueOf());

  const boundaryTolMs = 60_000;
  const coversStart = usable.some((r) => Math.abs(t(r.sampledAt).diff(t(t1))) <= boundaryTolMs);
  const coversEnd = usable.some((r) => Math.abs(t(r.sampledAt).diff(t(t2))) <= boundaryTolMs);
  if (!coversStart) reasons.push(`${kind} 缺少区间起点 t1 附近读数`);
  if (!coversEnd) reasons.push(`${kind} 缺少区间终点 t2 附近读数`);

  let maxGap = 0;
  for (let i = 1; i < usable.length; i += 1) {
    maxGap = Math.max(maxGap, t(usable[i].sampledAt).diff(t(usable[i - 1].sampledAt), 'second'));
  }
  const gapLimit = nominalStepSeconds * 1.5;
  if (usable.length >= 2 && maxGap > gapLimit) {
    reasons.push(`${kind} 采样最大间隔 ${maxGap}s 超过 1.5×名义步长 ${gapLimit}s（疑似断面故障）`);
  }

  const covered = reasons.length === 0 && usable.length >= 2 && coversStart && coversEnd;
  if (!covered) {
    return { volumeM3: null, covered: false, sourceReadingIds: inWindow.map((r) => r.id), unknownRangeM3: [0, 0], reasons };
  }

  // 梯形积分，dt 使用相邻读数的实际秒数
  let volume = 0;
  let uncertaintyVolume = 0;
  for (let i = 1; i < usable.length; i += 1) {
    const dt = t(usable[i].sampledAt).diff(t(usable[i - 1].sampledAt), 'second', true);
    const vA = usable[i - 1].value as number;
    const vB = usable[i].value as number;
    volume += ((vA + vB) / 2) * dt;
    const uA = usable[i - 1].uncertainty ?? Math.abs(vA) * 0.1;
    const uB = usable[i].uncertainty ?? Math.abs(vB) * 0.1;
    uncertaintyVolume += ((uA + uB) / 2) * dt;
  }
  return {
    volumeM3: volume,
    covered: true,
    sourceReadingIds: usable.map((r) => r.id),
    unknownRangeM3: [-uncertaintyVolume, uncertaintyVolume],
    reasons: [],
  };
}
