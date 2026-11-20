// 水量平衡运行：固定时间网格上逐区间物化“水库—时段平衡事实”
// R = S(t2)-S(t1) - [∫Q入dt - ∫Q出dt + P×A - 蒸发×A + 调入 - 调出]
import type {
  BalanceFact,
  BalanceTerm,
  DispatchRule,
  ID,
  RawReading,
  Reservoir,
  RunSnapshot,
  RunTolerance,
} from '../types';
import { buildGrid, diffSeconds, t } from './time';
import { CurveError, areaAtLevel, effectiveCurve, interpolate } from './curves';
import { integrateFlow } from './integrate';
import {
  depthToVolume,
  reservoirEvaporationDepth,
  reservoirRainfallDepth,
} from './rainfall';

export interface RunContext {
  snapshot: RunSnapshot;
  tolerance: RunTolerance;
  nominalStepSeconds: number;
  gridStart: string;
  gridEnd: string;
  gridStepSeconds: number;
}

function readingsOf(reservoirId: string, all: RawReading[]): RawReading[] {
  return all.filter((r) => r.reservoirId === reservoirId || r.kind === 'rainfall');
}

function levelAt(readings: RawReading[], reservoirId: string, at: string): {
  level: number | null;
  readingId?: ID;
  reason?: string;
} {
  const candidates = readings
    .filter(
      (r) =>
        r.kind === 'water_level' &&
        r.reservoirId === reservoirId &&
        !r.supersededById &&
        r.quality !== 'rejected' &&
        Math.abs(t(r.sampledAt).diff(t(at))) <= 60_000,
    )
    .sort((a, b) => t(a.sampledAt).valueOf() - t(b.sampledAt).valueOf());
  if (candidates.length === 0) return { level: null, reason: `时刻 ${at} 缺少水位读数` };
  const r = candidates[candidates.length - 1];
  if (r.value === null || r.quality === 'missing') return { level: null, readingId: r.id, reason: `水位读数 ${r.id} 显式缺失` };
  if (r.unit !== 'm') return { level: null, readingId: r.id, reason: `水位 ${r.id} 量纲不相容（期望 m，实际 ${r.unit}）` };
  return { level: r.value, readingId: r.id };
}

function makeTerm(
  key: BalanceTerm['key'],
  label: string,
  volume: number | null,
  covered: boolean,
  ids: ID[],
  unknownRange: [number, number],
  reasons: string[],
): BalanceTerm {
  return {
    key,
    label,
    valueM3: covered ? volume : null,
    covered,
    sourceReadingIds: ids,
    unknownRangeM3: unknownRange,
    detail: reasons.length > 0 ? reasons.join('；') : undefined,
  };
}

/** 单个水库在整个网格上的平衡事实序列 */
export function computeFactsForReservoir(
  ctx: RunContext,
  reservoir: Reservoir,
  grid: string[],
): BalanceFact[] {
  const { snapshot, tolerance, nominalStepSeconds } = ctx;
  const own = readingsOf(reservoir.id, snapshot.readings);
  const facts: BalanceFact[] = [];

  for (let i = 0; i < grid.length - 1; i += 1) {
    const t1 = grid[i];
    const t2 = grid[i + 1];
    const durationSeconds = diffSeconds(t1, t2);
    const reasons: string[] = [];
    const sourceIds = new Set<ID>();
    const termReasons: Record<string, string[]> = {};

    // ---- 1. 水位 -> 蓄水量（按当时有效库容曲线；区间内换版则记录曲线切换）----
    const lv1 = levelAt(own, reservoir.id, t1);
    const lv2 = levelAt(own, reservoir.id, t2);
    if (lv1.reason) reasons.push(lv1.reason);
    if (lv2.reason) reasons.push(lv2.reason);
    if (lv1.readingId) sourceIds.add(lv1.readingId);
    if (lv2.readingId) sourceIds.add(lv2.readingId);

    let s1: number | null = null;
    let s2: number | null = null;
    let curveId1: ID | undefined;
    let curveId2: ID | undefined;
    let curveSwitched = false;
    if (lv1.level !== null) {
      try {
        const c1 = effectiveCurve(snapshot.curves, reservoir.id, 'storage', t1);
        s1 = interpolate(c1, lv1.level);
        curveId1 = c1.id;
      } catch (e) {
        reasons.push(e instanceof CurveError ? e.message : String(e));
      }
    }
    if (lv2.level !== null) {
      try {
        const c2 = effectiveCurve(snapshot.curves, reservoir.id, 'storage', t2);
        s2 = interpolate(c2, lv2.level);
        curveId2 = c2.id;
      } catch (e) {
        reasons.push(e instanceof CurveError ? e.message : String(e));
      }
    }
    if (curveId1 && curveId2 && curveId1 !== curveId2) curveSwitched = true;

    // ---- 2. 库面面积：取区间中点时刻有效面积曲线、中点水位 ----
    const midTime = t(t1).add(durationSeconds / 2, 'second').toISOString();
    const midLevel = lv1.level !== null && lv2.level !== null ? (lv1.level + lv2.level) / 2 : lv1.level ?? lv2.level;
    let areaM2: number | null = null;
    let areaCurveId: ID | undefined;
    if (midLevel !== null) {
      try {
        const a = areaAtLevel(snapshot.curves, reservoir.id, midTime, midLevel);
        areaM2 = a.area;
        areaCurveId = a.curve.id;
      } catch (e) {
        reasons.push(e instanceof CurveError ? e.message : String(e));
      }
    } else {
      reasons.push('区间两端水位缺失，无法确定库面面积');
    }

    // ---- 3. 各平衡项 ----
    const inflow = integrateFlow(own, 'inflow', t1, t2, nominalStepSeconds);
    const outflow = integrateFlow(own, 'outflow', t1, t2, nominalStepSeconds);
    // 跨库调水：该水库在整个快照内从无此类读数时视为“本项不适用”，按 0 计且闭合；
    // 一旦存在调水业务，某时段缺测仍按覆盖不足处理，绝不以零补齐缺口。
    const hasTransferInKind = own.some((r) => r.kind === 'diversion_in');
    const hasTransferOutKind = own.some((r) => r.kind === 'diversion_out');
    const transferIn = hasTransferInKind
      ? integrateFlow(own, 'diversion_in', t1, t2, nominalStepSeconds)
      : { volumeM3: 0, covered: true, sourceReadingIds: [] as ID[], unknownRangeM3: [0, 0] as [number, number], reasons: [] as string[] };
    const transferOut = hasTransferOutKind
      ? integrateFlow(own, 'diversion_out', t1, t2, nominalStepSeconds)
      : { volumeM3: 0, covered: true, sourceReadingIds: [] as ID[], unknownRangeM3: [0, 0] as [number, number], reasons: [] as string[] };
    termReasons.inflow = inflow.reasons;
    termReasons.outflow = outflow.reasons;
    termReasons.transferIn = transferIn.reasons;
    termReasons.transferOut = transferOut.reasons;
    [...inflow.sourceReadingIds, ...outflow.sourceReadingIds, ...transferIn.sourceReadingIds, ...transferOut.sourceReadingIds]
      .forEach((id) => sourceIds.add(id));

    const rainDepth = reservoirRainfallDepth(snapshot.readings, reservoir, t1, t2);
    const evapDepth = reservoirEvaporationDepth(own, reservoir.id, t1, t2);
    termReasons.rainfall = rainDepth.reasons;
    termReasons.evaporation = evapDepth.reasons;
    [...rainDepth.sourceReadingIds, ...evapDepth.sourceReadingIds].forEach((id) => sourceIds.add(id));

    let rainVol: ReturnType<typeof depthToVolume> | null = null;
    let evapVol: ReturnType<typeof depthToVolume> | null = null;
    if (areaM2 !== null) {
      rainVol = depthToVolume(rainDepth, areaM2);
      evapVol = depthToVolume(evapDepth, areaM2);
      termReasons.rainfall = [...rainDepth.reasons];
      termReasons.evaporation = [...evapDepth.reasons];
    } else {
      reasons.push('面积曲线无效，雨量/蒸发无法折算水量');
    }

    const terms: BalanceTerm[] = [
      makeTerm('inflow', '∫入库流量dt', inflow.volumeM3, inflow.covered, inflow.sourceReadingIds, inflow.unknownRangeM3, inflow.reasons),
      makeTerm('outflow', '∫出库流量dt', outflow.volumeM3, outflow.covered, outflow.sourceReadingIds, outflow.unknownRangeM3, outflow.reasons),
      makeTerm(
        'rainfall',
        'P×A 面雨量入库',
        rainVol?.valueM3 ?? null,
        rainVol?.covered ?? false,
        rainDepth.sourceReadingIds,
        rainVol?.unknownRangeM3 ?? [0, 0],
        areaM2 === null ? ['面积曲线无效'] : rainDepth.reasons,
      ),
      makeTerm(
        'evaporation',
        '蒸发×A（损失）',
        evapVol?.valueM3 ?? null,
        evapVol?.covered ?? false,
        evapDepth.sourceReadingIds,
        evapVol?.unknownRangeM3 ?? [0, 0],
        areaM2 === null ? ['面积曲线无效'] : evapDepth.reasons,
      ),
      makeTerm('transferIn', '跨库调入', transferIn.volumeM3, transferIn.covered, transferIn.sourceReadingIds, transferIn.unknownRangeM3, transferIn.reasons),
      makeTerm('transferOut', '跨库调出', transferOut.volumeM3, transferOut.covered, transferOut.sourceReadingIds, transferOut.unknownRangeM3, transferOut.reasons),
    ];

    // 未知范围按方程符号合成：入项 +未知，出项 -未知
    let uLow = 0;
    let uHigh = 0;
    const addSym = (term: BalanceTerm, positive: boolean) => {
      const [lo, hi] = term.unknownRangeM3;
      if (positive) {
        uLow += lo;
        uHigh += hi;
      } else {
        uLow += -hi;
        uHigh += -lo;
      }
    };
    addSym(terms[0], true); // inflow
    addSym(terms[1], false); // outflow
    addSym(terms[2], true); // rain
    addSym(terms[3], false); // evap
    addSym(terms[4], true); // transfer in
    addSym(terms[5], false); // transfer out
    // 蓄水量换算不确定度（曲线无显式误差模型，取 0，由水位读数 uncertainty 体现时在此预留）
    const unknownRangeM3: [number, number] = [uLow, uHigh];

    // ---- 4. ΔS 与可确认净项 ----
    const deltaS = s1 !== null && s2 !== null ? s2 - s1 : null;
    const allCovered = terms.every((x) => x.covered) && deltaS !== null;
    let confirmedNet: number | null = null;
    if (terms.every((x) => x.covered)) {
      confirmedNet =
        (terms[0].valueM3 as number) -
        (terms[1].valueM3 as number) +
        (terms[2].valueM3 as number) -
        (terms[3].valueM3 as number) +
        (terms[4].valueM3 as number) -
        (terms[5].valueM3 as number);
    }

    // ---- 5. 残差与闭合判定：超差列出未闭合来源，不塞“损耗” ----
    let residual: number | null = null;
    let closed = false;
    const unclosedReasons = [...reasons];
    for (const tr of Object.values(termReasons)) unclosedReasons.push(...tr);
    if (allCovered && deltaS !== null && confirmedNet !== null) {
      residual = deltaS - confirmedNet;
      const scale =
        Math.abs(deltaS) +
        terms.reduce((s, x) => s + Math.abs(x.valueM3 as number), 0) / Math.max(terms.length, 1);
      const tol = Math.max(tolerance.absM3, scale * tolerance.relFraction);
      closed = Math.abs(residual) <= tol;
      if (!closed) {
        unclosedReasons.push(
          `残差 ${residual.toFixed(0)} m³ 超出测量容差 ${tol.toFixed(0)} m³（绝对 ${tolerance.absM3} / 相对 ${(tolerance.relFraction * 100).toFixed(2)}%），需核查未闭合来源`,
        );
      }
    } else {
      unclosedReasons.push('平衡项覆盖不足，残差不可计算，相关指标保持待核');
    }

    facts.push({
      id: `${snapshot.runId}-${reservoir.id}-${i}`,
      runId: snapshot.runId,
      reservoirId: reservoir.id,
      t1,
      t2,
      durationSeconds,
      s1,
      s2,
      storageCurveIdAtT1: curveId1,
      storageCurveIdAtT2: curveId2,
      areaCurveId,
      curveSwitched,
      terms,
      deltaS,
      confirmedNet,
      residual,
      closed,
      toleranceM3: tolerance.absM3,
      unclosedReasons: [...new Set(unclosedReasons)],
      unknownRangeM3,
    });
  }
  return facts;
}

/** 一次运行：所有水库 × 全网格，产出平衡事实 */
export function executeRun(ctx: RunContext): BalanceFact[] {
  const grid = buildGrid(ctx.gridStart, ctx.gridEnd, ctx.gridStepSeconds);
  const out: BalanceFact[] = [];
  for (const reservoir of ctx.snapshot.reservoirs) {
    out.push(...computeFactsForReservoir(ctx, reservoir, grid));
  }
  return out;
}

/** 规则适用期重叠检查（同水库、同有效期内多条已审批规则） */
export function ruleOverlapIssues(rules: DispatchRule[], reservoirs: Reservoir[]): string[] {
  const issues: string[] = [];
  for (const r of reservoirs) {
    const mine = rules.filter((x) => x.reservoirId === r.id && x.approvalStatus === 'approved');
    for (let i = 0; i < mine.length; i += 1) {
      for (let j = i + 1; j < mine.length; j += 1) {
        const a = mine[i];
        const b = mine[j];
        const aEnd = a.validTo ? t(a.validTo).valueOf() : Number.POSITIVE_INFINITY;
        const bEnd = b.validTo ? t(b.validTo).valueOf() : Number.POSITIVE_INFINITY;
        if (t(a.validFrom).valueOf() < bEnd && t(b.validFrom).valueOf() < aEnd) {
          issues.push(`水库 ${r.name} 规则 ${a.version} 与 ${b.version} 适用期重叠`);
        }
      }
    }
  }
  return issues;
}
