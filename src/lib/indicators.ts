// 指标服务：同一运行的数值、范围与未闭合原因，向地图/图表/明细/简报发布一致结果
import type {
  BalanceFact,
  DispatchRule,
  ID,
  IndicatorStatus,
  ReservoirIndicator,
  RunSnapshot,
} from '../types';
import { t } from './time';

function effectiveRule(rules: DispatchRule[], reservoirId: string, at: string): {
  rule?: DispatchRule;
  issue?: string;
} {
  const matched = rules.filter(
    (r) =>
      r.reservoirId === reservoirId &&
      r.approvalStatus === 'approved' &&
      t(r.validFrom).valueOf() <= t(at).valueOf() &&
      (r.validTo === undefined || t(r.validTo).valueOf() > t(at).valueOf()),
  );
  if (matched.length === 0) return { issue: `时刻 ${at} 无有效已审批调度规则，指标待核` };
  if (matched.length > 1) {
    return { issue: `规则适用期重叠：${matched.map((r) => r.version).join('、')}，指标待核` };
  }
  return { rule: matched[0] };
}

export interface IndicatorOptions {
  runId: ID;
  asOf: string;
  pressureWindowSeconds: number;
  decisionHorizonSeconds: number;
}

export function computeIndicator(
  snapshot: RunSnapshot,
  facts: BalanceFact[],
  reservoirId: string,
  opts: IndicatorOptions,
): ReservoirIndicator {
  const mine = facts
    .filter((f) => f.reservoirId === reservoirId)
    .sort((a, b) => t(a.t1).valueOf() - t(b.t1).valueOf());
  const pendingReasons: string[] = [];
  const asOfMs = t(opts.asOf).valueOf();
  const windowStartMs = asOfMs - opts.pressureWindowSeconds * 1000;

  const windowFacts = mine.filter((f) => t(f.t1).valueOf() >= windowStartMs && t(f.t2).valueOf() <= asOfMs);
  for (const f of windowFacts) {
    for (const reason of f.unclosedReasons) pendingReasons.push(`[${f.t1}~${f.t2}] ${reason}`);
  }

  const lastFact = mine[mine.length - 1];
  const currentStorage = lastFact?.s2 ?? null;
  if (currentStorage === null) pendingReasons.push('当前蓄水量无法确认（水位/库容曲线缺失）');

  const { rule, issue: ruleIssue } = effectiveRule(snapshot.rules, reservoirId, opts.asOf);
  if (ruleIssue) pendingReasons.push(ruleIssue);

  // ---- 防洪余量 ----
  const floodMargin = rule && currentStorage !== null ? rule.floodLimitStorage - currentStorage : null;
  let marginStatus: IndicatorStatus = 'ok';
  if (floodMargin !== null && floodMargin <= 0) marginStatus = 'warn';
  if (pendingReasons.length > 0) marginStatus = 'pending';

  // ---- 近期来水压力：窗口内可确认净入库量及未知范围 ----
  const coveredWindowFacts = windowFacts.filter((f) => f.confirmedNet !== null);
  let netInflowConfirmed: number | null = null;
  let netInflowUnknownRange: [number, number] | null = null;
  if (coveredWindowFacts.length === windowFacts.length && windowFacts.length > 0) {
    netInflowConfirmed = coveredWindowFacts.reduce((s, f) => s + (f.confirmedNet as number), 0);
    let uLow = 0;
    let uHigh = 0;
    for (const f of coveredWindowFacts) {
      uLow += f.unknownRangeM3[0];
      uHigh += f.unknownRangeM3[1];
    }
    netInflowUnknownRange = [uLow, uHigh];
  } else if (windowFacts.some((f) => f.confirmedNet === null)) {
    pendingReasons.push('来水窗口内存在平衡项覆盖不足的区间，净入库量不可完整确认');
  }

  let pressureRatio: number | null = null;
  let pressureRatioRange: [number | null, number | null] = [null, null];
  if (netInflowConfirmed !== null && floodMargin !== null && floodMargin > 0) {
    pressureRatio = netInflowConfirmed / floodMargin;
    if (netInflowUnknownRange) {
      pressureRatioRange = [
        (netInflowConfirmed + netInflowUnknownRange[0]) / floodMargin,
        (netInflowConfirmed + netInflowUnknownRange[1]) / floodMargin,
      ].sort((a, b) => (a as number) - (b as number)) as [number, number];
    }
  } else if (floodMargin !== null && floodMargin <= 0) {
    pendingReasons.push('已达到或超过汛限库容，防洪余量为非正值，压力比不可按常规定义解释');
  }

  // ---- 泄洪空间：当前净入库范围延续至下一决策时点，回算所需出库流量 ----
  let releaseNeededRange: [number | null, number | null] | null = null;
  let downstreamAllowableRange: [number, number] | null = null;
  let releaseGapRange: [number | null, number | null] | null = null;
  if (rule && currentStorage !== null && netInflowConfirmed !== null && netInflowUnknownRange) {
    const H = opts.decisionHorizonSeconds;
    const W = opts.pressureWindowSeconds;
    const base = (currentStorage - rule.targetStorage) / H;
    const rateLow = (netInflowConfirmed + netInflowUnknownRange[0]) / W;
    const rateHigh = (netInflowConfirmed + netInflowUnknownRange[1]) / W;
    const r1 = base + rateLow;
    const r2 = base + rateHigh;
    releaseNeededRange = [Math.min(r1, r2), Math.max(r1, r2)];
    downstreamAllowableRange = [rule.downstreamMinRelease, rule.downstreamMaxRelease];
    // 差额：所需出库超出下游允许的部分
    releaseGapRange = [
      (releaseNeededRange[0] as number) - rule.downstreamMaxRelease,
      (releaseNeededRange[1] as number) - rule.downstreamMinRelease,
    ];
    if (releaseGapRange.some((g) => g !== null && g > 0)) {
      pendingReasons.push('所需出库流量范围与下游允许泄流范围存在正差额，泄洪空间不足');
    }
  } else {
    pendingReasons.push('泄洪空间所需的当前蓄水/净入库范围不完整，指标待核');
  }

  return {
    id: `${opts.runId}-ind-${reservoirId}`,
    runId: opts.runId,
    reservoirId,
    asOf: opts.asOf,
    currentStorage,
    floodLimitStorage: rule?.floodLimitStorage ?? null,
    ruleId: rule?.id,
    floodMargin,
    marginStatus,
    windowSeconds: opts.pressureWindowSeconds,
    netInflowConfirmed,
    netInflowUnknownRange,
    pressureRatio,
    pressureRatioRange,
    releaseNeededRange,
    downstreamAllowableRange,
    releaseGapRange,
    pending: pendingReasons.length > 0,
    pendingReasons: [...new Set(pendingReasons)],
    factIds: windowFacts.map((f) => f.id),
  };
}

export function computeAllIndicators(
  snapshot: RunSnapshot,
  facts: BalanceFact[],
  opts: IndicatorOptions,
): ReservoirIndicator[] {
  return snapshot.reservoirs.map((r) => computeIndicator(snapshot, facts, r.id, opts));
}
