// 雨量与蒸发：重叠按修订关系处理而非累加；分区权重匹配库面面积；缺失不补零
import type { RawReading, Reservoir } from '../types';
import { t } from './time';
import { depthAreaToVolume } from './units';

export interface DepthResult {
  /** 区间折算深度 mm；覆盖不足为 null */
  depthMm: number | null;
  covered: boolean;
  sourceReadingIds: string[];
  unknownRangeMm: [number, number];
  reasons: string[];
}

interface Clip {
  reading: RawReading;
  startMs: number;
  endMs: number;
}

/**
 * 计算某分区在 [t1,t2] 的面雨量深度（mm）。
 * 规则：
 *  - 被修订（supersededById）/作废读数不参与；修订替代而非累加；
 *  - 未建立修订关系的时间重叠按错误处理，绝不累加；
 *  - 显式缺失读数导致覆盖不足；
 *  - 读数区间按与目标区间的重叠秒数比例折算。
 */
export function zoneRainfallDepth(
  readings: RawReading[],
  zoneId: string,
  t1: string,
  t2: string,
): DepthResult {
  const reasons: string[] = [];
  const winStart = t(t1).valueOf();
  const winEnd = t(t2).valueOf();
  const winMs = winEnd - winStart;

  const all = readings.filter(
    (r) => r.kind === 'rainfall' && r.zoneId === zoneId && r.intervalStart !== undefined,
  );
  const active = all.filter((r) => !r.supersededById && r.quality !== 'rejected');

  const missingInWindow = active.filter(
    (r) =>
      (r.quality === 'missing' || r.value === null) &&
      t(r.intervalStart as string).valueOf() < winEnd &&
      t(r.sampledAt).valueOf() > winStart,
  );
  if (missingInWindow.length > 0) {
    reasons.push(`分区 ${zoneId} 存在显式缺失雨量 ${missingInWindow.length} 条，不以零补齐`);
  }

  const clips: Clip[] = [];
  for (const r of active) {
    if (r.value === null || r.quality === 'missing') continue;
    if (r.unit !== 'mm') {
      reasons.push(`雨量 ${r.id} 量纲不相容（期望 mm，实际 ${r.unit}）`);
      continue;
    }
    const rs = t(r.intervalStart as string).valueOf();
    const re = t(r.sampledAt).valueOf();
    const cs = Math.max(rs, winStart);
    const ce = Math.min(re, winEnd);
    if (ce <= cs) continue;
    clips.push({ reading: r, startMs: cs, endMs: ce });
  }

  // 未建立修订关系的重叠检测（同一分区，活动读数时间重叠）
  clips.sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < clips.length; i += 1) {
    if (clips[i].startMs < clips[i - 1].endMs - 1) {
      reasons.push(
        `分区 ${zoneId} 雨量记录 ${clips[i - 1].reading.id} 与 ${clips[i].reading.id} 时间重叠且无修订关系，禁止累加`,
      );
    }
  }

  let coveredMs = 0;
  let weightedDepth = 0;
  let uncertainty = 0;
  for (const c of clips) {
    const span = t(c.reading.sampledAt).valueOf() - t(c.reading.intervalStart as string).valueOf();
    const clipMs = c.endMs - c.startMs;
    if (span <= 0) continue;
    const frac = clipMs / span;
    weightedDepth += (c.reading.value as number) * frac;
    uncertainty += (c.reading.uncertainty ?? (c.reading.value as number) * 0.1) * frac;
    coveredMs += clipMs;
  }

  const coverage = winMs > 0 ? coveredMs / winMs : 0;
  if (coverage < 0.999) {
    reasons.push(`分区 ${zoneId} 雨量时间覆盖率 ${(coverage * 100).toFixed(1)}% 不足 100%`);
  }
  const overlapBad = reasons.some((x) => x.includes('重叠且无修订关系'));
  const covered = reasons.length === 0 && coverage >= 0.999;
  return {
    depthMm: covered ? weightedDepth : null,
    covered,
    sourceReadingIds: all.map((r) => r.id),
    unknownRangeMm: overlapBad ? [0, 0] : [-uncertainty, uncertainty],
    reasons,
  };
}

/** 按水库面雨量分区权重加权得到库区面雨量深度 */
export function reservoirRainfallDepth(
  readings: RawReading[],
  reservoir: Reservoir,
  t1: string,
  t2: string,
): DepthResult {
  const reasons: string[] = [];
  const ids: string[] = [];
  let depth = 0;
  let uLow = 0;
  let uHigh = 0;
  let allCovered = true;
  for (const w of reservoir.rainWeights) {
    const z = zoneRainfallDepth(readings, w.zoneId, t1, t2);
    ids.push(...z.sourceReadingIds);
    reasons.push(...z.reasons);
    if (!z.covered || z.depthMm === null) {
      allCovered = false;
    } else {
      depth += z.depthMm * w.weight;
      uLow += z.unknownRangeMm[0] * w.weight;
      uHigh += z.unknownRangeMm[1] * w.weight;
    }
  }
  const weightSum = reservoir.rainWeights.reduce((s, w) => s + w.weight, 0);
  if (Math.abs(weightSum - 1) > 1e-6) {
    reasons.push(`水库 ${reservoir.id} 面雨量分区权重之和为 ${weightSum}，不等于 1`);
    allCovered = false;
  }
  return {
    depthMm: allCovered ? depth : null,
    covered: allCovered,
    sourceReadingIds: [...new Set(ids)],
    unknownRangeMm: [uLow, uHigh],
    reasons,
  };
}

/** 库区蒸发深度（mm，水库级区间累计读数） */
export function reservoirEvaporationDepth(
  readings: RawReading[],
  reservoirId: string,
  t1: string,
  t2: string,
): DepthResult {
  const reasons: string[] = [];
  const winStart = t(t1).valueOf();
  const winEnd = t(t2).valueOf();
  const winMs = winEnd - winStart;
  const all = readings.filter(
    (r) =>
      r.kind === 'evaporation' &&
      r.reservoirId === reservoirId &&
      r.intervalStart !== undefined &&
      !r.supersededById &&
      r.quality !== 'rejected',
  );
  let coveredMs = 0;
  let depth = 0;
  let uncertainty = 0;
  for (const r of all) {
    if (r.value === null || r.quality === 'missing') {
      reasons.push(`蒸发记录 ${r.id} 显式缺失，不以零补齐`);
      continue;
    }
    if (r.unit !== 'mm') {
      reasons.push(`蒸发 ${r.id} 量纲不相容（期望 mm，实际 ${r.unit}）`);
      continue;
    }
    const rs = t(r.intervalStart as string).valueOf();
    const re = t(r.sampledAt).valueOf();
    const cs = Math.max(rs, winStart);
    const ce = Math.min(re, winEnd);
    if (ce <= cs) continue;
    const span = re - rs;
    const frac = (ce - cs) / span;
    depth += (r.value as number) * frac;
    uncertainty += (r.uncertainty ?? (r.value as number) * 0.1) * frac;
    coveredMs += ce - cs;
  }
  const coverage = winMs > 0 ? coveredMs / winMs : 0;
  if (coverage < 0.999) reasons.push(`蒸发时间覆盖率 ${(coverage * 100).toFixed(1)}% 不足 100%`);
  const covered = reasons.length === 0;
  return {
    depthMm: covered ? depth : null,
    covered,
    sourceReadingIds: all.map((r) => r.id),
    unknownRangeMm: covered ? [-uncertainty, uncertainty] : [0, 0],
    reasons,
  };
}

/** mm 深度按库面面积 m² 折算水量 m³ */
export function depthToVolume(depth: DepthResult, areaM2: number): {
  valueM3: number | null;
  covered: boolean;
  unknownRangeM3: [number, number];
  reasons: string[];
  sourceReadingIds: string[];
} {
  return {
    valueM3: depth.covered && depth.depthMm !== null ? depthAreaToVolume(depth.depthMm, areaM2) : null,
    covered: depth.covered,
    unknownRangeM3: [
      depthAreaToVolume(depth.unknownRangeMm[0], areaM2),
      depthAreaToVolume(depth.unknownRangeMm[1], areaM2),
    ],
    reasons: depth.reasons,
    sourceReadingIds: depth.sourceReadingIds,
  };
}
