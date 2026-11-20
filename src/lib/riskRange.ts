// 断面风险范围推导引擎（纯函数，可复算，不依赖长历史在线训练）
//
// 两类区间来源：
//  A. 工程批准传播（engineering_propagation）：依据经审批的传播时差窗口与允许
//     衰减/增幅界，把邻近断面观测向故障断面做“区间传播”，叠加支流贡献界与
//     回水/校准放宽；规则可解释，复杂回水条件下范围较宽。
//  B. 条件关系拟合（conditional_fit）：用历史“双站同步完好”时段拟合
//     target = slope×ref + intercept 并以残差分位给预测带；日常更紧凑，
//     但当前水文超出训练环境包络（罕见暴雨/结构变化）时判失配并回退工程界。
//
// 铁律：故障断面只输出风险“时间段”与可能范围，绝不产出单一替代水位/流量；
// 所有非实测结果 inferred=true。参考站同时支撑多断面时标记为非独立证据，
// 多参考站取区间并集而非平均。
import type {
  CalibrationStatus,
  ConditionalRelation,
  HydrologicRelation,
  ID,
  RangeSource,
  RelationSample,
  RiskClass,
  RiskEvidence,
  RiverSection,
  SectionRiskSegment,
  StationHealthRecord,
  TributaryCondition,
  RawReading,
  RunSnapshot,
} from '../types';
import { buildGrid, t } from './time';

export interface RiskEngineContext {
  snapshot: RunSnapshot;
  runId: ID;
  gridStart: string;
  gridEnd: string;
  gridStepSeconds: number;
}

/** 条件关系最小训练样本数；低于此数认为历史覆盖不足，不采用拟合来源 */
export const MIN_FIT_SAMPLES = 8;
const BOUNDARY_TOL_MS = 60_000;
const GATE_REGULATED_MAX = 2; // 闸门开度 ≤2m 且 >0 记为 regulated

// ---------------------------------------------------------------------------
// 条件关系拟合：OLS 线性回归 + 残差 90 分位预测带 + 训练环境包络
// ---------------------------------------------------------------------------

export interface FitInput {
  id: ID;
  targetSectionId: ID;
  referenceSectionId: ID;
  samples: RelationSample[];
  environment: ConditionalRelation['environment'];
  /** 工程批准的包络覆盖（如雨季放宽雨强上限）；缺省由训练样本极值给出 */
  envelopeOverrides?: Partial<ConditionalRelation['envelope']>;
  note?: string;
}

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sortedAsc[base + 1] ?? sortedAsc[base];
  return sortedAsc[base] + rest * (next - sortedAsc[base]);
}

/** 由历史同步完好样本拟合条件关系；样本不足时返回 null（调用方改用工程界） */
export function fitConditionalRelation(input: FitInput): ConditionalRelation | null {
  const samples = [...input.samples].sort((a, b) => a.at.localeCompare(b.at));
  if (samples.length < MIN_FIT_SAMPLES) return null;
  const n = samples.length;
  const meanX = samples.reduce((s, d) => s + d.referenceValue, 0) / n;
  const meanY = samples.reduce((s, d) => s + d.targetValue, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (const d of samples) {
    cov += (d.referenceValue - meanX) * (d.targetValue - meanY);
    varX += (d.referenceValue - meanX) ** 2;
    varY += (d.targetValue - meanY) ** 2;
  }
  if (varX <= 0) return null;
  const slope = cov / varX;
  const intercept = meanY - slope * meanX;
  const absResid = samples
    .map((d) => Math.abs(d.targetValue - (slope * d.referenceValue + intercept)))
    .sort((a, b) => a - b);
  const residualBand = quantile(absResid, 0.9);
  const r2 = varY > 0 ? (cov * cov) / (varX * varY) : 0;
  const refVals = samples.map((d) => d.referenceValue);
  const rainVals = samples.map((d) => d.rainIntensity);
  const baseEnvelope: ConditionalRelation['envelope'] = {
    referenceRange: [Math.min(...refVals), Math.max(...refVals)],
    rainRange: [Math.min(...rainVals), Math.max(...rainVals)],
    gateStates: [...new Set(samples.map((d) => d.gateState))],
    monthRange: input.environment.monthRange,
  };
  return {
    id: input.id,
    targetSectionId: input.targetSectionId,
    referenceSectionId: input.referenceSectionId,
    fittedFrom: samples[0].at,
    fittedTo: samples[n - 1].at,
    slope,
    intercept,
    residualBand,
    envelope: { ...baseEnvelope, ...input.envelopeOverrides },
    sampleCount: n,
    r2: Number(r2.toFixed(4)),
    environment: input.environment,
    note: input.note,
  };
}

// ---------------------------------------------------------------------------
// 读数与环境辅助
// ---------------------------------------------------------------------------

function kindOf(section: RiverSection): RawReading['kind'] {
  return section.metric === 'water_level' ? 'water_level' : 'inflow';
}

function usableReadings(snapshot: RunSnapshot, section: RiverSection): RawReading[] {
  const kind = kindOf(section);
  return snapshot.readings
    .filter(
      (r) =>
        r.stationId === section.id &&
        r.kind === kind &&
        !r.supersededById &&
        r.quality !== 'rejected' &&
        r.quality !== 'missing' &&
        r.value !== null &&
        r.unit === section.unit,
    )
    .sort((a, b) => a.sampledAt.localeCompare(b.sampledAt));
}

function valueAt(readings: RawReading[], at: string): RawReading | null {
  const atMs = t(at).valueOf();
  const hits = readings
    .filter((r) => Math.abs(t(r.sampledAt).valueOf() - atMs) <= BOUNDARY_TOL_MS)
    .sort((a, b) => b.sampledAt.localeCompare(a.sampledAt));
  return hits[0] ?? null;
}

function valuesBetween(readings: RawReading[], from: string, to: string): RawReading[] {
  const a = t(from).valueOf();
  const b = t(to).valueOf();
  return readings.filter((r) => {
    const ms = t(r.sampledAt).valueOf();
    return ms >= a - BOUNDARY_TOL_MS && ms <= b + BOUNDARY_TOL_MS;
  });
}

/** 目标断面 t 时刻附近的面雨强 mm/h：取快照内各雨量分区小时区间深度均值 */
function rainIntensityAt(snapshot: RunSnapshot, at: string): number {
  const atMs = t(at).valueOf();
  const rains = snapshot.readings.filter(
    (r) =>
      r.kind === 'rainfall' &&
      r.value !== null &&
      r.intervalStart !== undefined &&
      t(r.sampledAt).valueOf() <= atMs + BOUNDARY_TOL_MS &&
      t(r.sampledAt).valueOf() > atMs - 3600_000 - BOUNDARY_TOL_MS,
  );
  if (rains.length === 0) return 0;
  return rains.reduce((s, r) => s + (r.value as number), 0) / rains.length;
}

function gateStateAt(snapshot: RunSnapshot, sectionId: ID, at: string): string {
  const gates = snapshot.readings
    .filter((r) => r.kind === 'gate_opening' && r.stationId === sectionId && r.value !== null)
    .sort((a, b) => b.sampledAt.localeCompare(a.sampledAt));
  const atMs = t(at).valueOf();
  const nearest = gates.find((r) => Math.abs(t(r.sampledAt).valueOf() - atMs) <= 3600_000);
  if (!nearest || nearest.value === null) return 'unknown';
  if (nearest.value === 0) return 'closed';
  if (nearest.value <= GATE_REGULATED_MAX) return 'regulated';
  return 'open';
}

function inMonthRange(iso: string, range: [number, number]): boolean {
  const m = t(iso).month() + 1; // dayjs month 0-based
  return m >= range[0] && m <= range[1];
}

/** 条件关系在目标时刻是否处于训练环境包络内（雨势/闸门/季节/参考值量级） */
function withinEnvelope(
  model: ConditionalRelation,
  refValue: number,
  rain: number,
  gateState: string,
  at: string,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const e = model.envelope;
  if (refValue < e.referenceRange[0] || refValue > e.referenceRange[1]) {
    reasons.push(`参考值 ${refValue.toFixed(2)} 超出条件关系训练包络 [${e.referenceRange[0].toFixed(2)}, ${e.referenceRange[1].toFixed(2)}]`);
  }
  if (rain < e.rainRange[0] || rain > e.rainRange[1]) {
    reasons.push(`雨强 ${rain.toFixed(1)}mm/h 超出训练包络 [${e.rainRange[0].toFixed(1)}, ${e.rainRange[1].toFixed(1)}]（罕见暴雨条件关系可能失配）`);
  }
  if (e.gateStates.length > 0 && !e.gateStates.includes(gateState)) {
    reasons.push(`闸门状态 ${gateState} 不在训练工况 ${e.gateStates.join('/')} 内（结构/调度变化）`);
  }
  if (!inMonthRange(at, e.monthRange)) {
    reasons.push(`当前月份不在条件关系适用季节 ${e.monthRange[0]}~${e.monthRange[1]} 月`);
  }
  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// 工程批准传播
// ---------------------------------------------------------------------------

function calibrationFactor(rel: HydrologicRelation, calibration: CalibrationStatus): number {
  if (calibration === 'calibrated') return 1;
  if (calibration === 'due') return 1 + rel.calibrationRelax * 0.5;
  return 1 + rel.calibrationRelax; // uncalibrated 全额放宽
}

interface PropagationResult {
  range: [number, number];
  evidence: RiskEvidence;
  limitations: string[];
}

/** 单条水文关系的区间传播：参考窗口读数 × 增减界 ∪ 回水放宽 ∪ 仪器不确定度 */
function propagateByRelation(
  snapshot: RunSnapshot,
  section: RiverSection,
  rel: HydrologicRelation,
  health: StationHealthRecord,
  at: string,
  sharedTargetCount: number,
  tributary: [number, number] | null,
): PropagationResult | null {
  const refSection = snapshot.riverSections.find((s) => s.id === rel.referenceSectionId);
  if (!refSection) return null;
  const refReadings = usableReadings(snapshot, refSection);
  const winFrom = t(at).subtract(rel.travelTimeMaxSeconds, 'second').toISOString();
  const winTo = t(at).subtract(rel.travelTimeMinSeconds, 'second').toISOString();
  const windowed = valuesBetween(refReadings, winFrom, winTo);
  if (windowed.length === 0) return null;

  const factor = calibrationFactor(rel, health.calibration);
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const r of windowed) {
    const v = r.value as number;
    const kLo = rel.attenuationMin * factor;
    const kHi = rel.attenuationMax * factor;
    const u = r.uncertainty ?? 0;
    lo = Math.min(lo, v * kLo - rel.backwaterWiden - u);
    hi = Math.max(hi, v * kHi + rel.backwaterWiden + u);
  }
  const limitations: string[] = [];
  if (rel.backwaterWiden > 0) limitations.push(`复杂回水条件：工程界附加 ±${rel.backwaterWiden}${section.unit} 放宽，区间偏宽`);
  if (health.calibration !== 'calibrated') {
    limitations.push(`参考站校准状态为 ${health.calibration}，增减界按系数 ${factor.toFixed(2)} 放宽`);
  }
  if (tributary) {
    lo += tributary[0];
    hi += tributary[1];
    limitations.push('已叠加支流汇入贡献界（支流仅给界不给点估计）');
  }
  const independent = sharedTargetCount <= 1;
  return {
    range: [lo, hi],
    evidence: {
      referenceSectionId: rel.referenceSectionId,
      source: 'engineering_propagation',
      relationId: rel.id,
      sourceReadingIds: windowed.map((r) => r.id),
      sharedTargetCount,
      independent,
      travelTimeSeconds: [rel.travelTimeMinSeconds, rel.travelTimeMaxSeconds],
      note: independent ? undefined : `该参考站同时支撑 ${sharedTargetCount} 个断面，非独立证据，多源取区间并集`,
    },
    limitations,
  };
}

/** 条件关系预测区间：窗口内每个参考读数各给一个预测带后取并集 */
function predictByConditional(
  snapshot: RunSnapshot,
  section: RiverSection,
  model: ConditionalRelation,
  at: string,
  tributary: [number, number] | null,
): { range: [number, number]; evidence: RiskEvidence; envelopeReasons: string[] } | null {
  const refSection = snapshot.riverSections.find((s) => s.id === model.referenceSectionId);
  if (!refSection) return null;
  const refReadings = usableReadings(snapshot, refSection);
  // 条件关系复用其参考断面的工程时差窗口取参考读数；无时差记录时退化到临近 1 个步长
  const rel = snapshot.hydrologicRelations.find(
    (h) => h.targetSectionId === section.id && h.referenceSectionId === model.referenceSectionId && h.approvalStatus === 'approved',
  );
  const tauMin = rel?.travelTimeMinSeconds ?? 0;
  const tauMax = rel?.travelTimeMaxSeconds ?? 3600;
  const windowed = valuesBetween(
    refReadings,
    t(at).subtract(tauMax, 'second').toISOString(),
    t(at).subtract(tauMin, 'second').toISOString(),
  );
  if (windowed.length === 0) return null;

  const rain = rainIntensityAt(snapshot, at);
  const gate = gateStateAt(snapshot, section.id, at);
  const envelopeReasons: string[] = [];
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const r of windowed) {
    const v = r.value as number;
    const env = withinEnvelope(model, v, rain, gate, at);
    envelopeReasons.push(...env.reasons);
    const center = model.slope * v + model.intercept;
    const u = r.uncertainty ?? 0;
    lo = Math.min(lo, center - model.residualBand - u);
    hi = Math.max(hi, center + model.residualBand + u);
  }
  if (tributary) {
    lo += tributary[0];
    hi += tributary[1];
  }
  const sharedTargetCount = countSharedTargets(snapshot, model.referenceSectionId);
  return {
    range: [lo, hi],
    envelopeReasons: [...new Set(envelopeReasons)],
    evidence: {
      referenceSectionId: model.referenceSectionId,
      source: 'conditional_fit',
      relationId: model.id,
      sourceReadingIds: windowed.map((r) => r.id),
      sharedTargetCount,
      independent: sharedTargetCount <= 1,
      travelTimeSeconds: [tauMin, tauMax],
      note:
        (sharedTargetCount > 1 ? `参考站同时支撑 ${sharedTargetCount} 个断面，非独立证据；` : '') +
        `基于 ${model.sampleCount} 组历史完好样本，R²=${model.r2}，残差带 ±${model.residualBand.toFixed(2)}${section.unit}`,
    },
  };
}

/** 参考站同时支撑的目标断面数（按已审批工程关系统计） */
function countSharedTargets(snapshot: RunSnapshot, referenceSectionId: ID): number {
  return new Set(
    snapshot.hydrologicRelations
      .filter((h) => h.referenceSectionId === referenceSectionId && h.approvalStatus === 'approved')
      .map((h) => h.targetSectionId),
  ).size;
}

function activeTributaryRange(
  conditions: TributaryCondition[],
  sectionId: ID,
  at: string,
): { range: [number, number] | null; ungaged: boolean } {
  const atMs = t(at).valueOf();
  const active = conditions.filter(
    (c) =>
      c.targetSectionId === sectionId &&
      t(c.activeFrom).valueOf() <= atMs &&
      (c.activeTo === undefined || t(c.activeTo).valueOf() > atMs),
  );
  if (active.length === 0) return { range: null, ungaged: false };
  return {
    range: [
      active.reduce((s, c) => s + c.contributionRange[0], 0),
      active.reduce((s, c) => s + c.contributionRange[1], 0),
    ],
    ungaged: active.some((c) => c.ungaged),
  };
}

// ---------------------------------------------------------------------------
// 分类与版本
// ---------------------------------------------------------------------------

function classify(section: RiverSection, range: [number, number] | null): RiskClass {
  if (!range) return 'undetermined';
  const [lo, hi] = range;
  if (hi <= section.bearingLimit) return 'safe';
  if (lo > section.bearingLimit) return 'exceeded';
  return 'possible';
}

function healthAt(records: StationHealthRecord[], sectionId: ID, t1: string, t2: string): StationHealthRecord | null {
  const a = t(t1).valueOf();
  const b = t(t2).valueOf();
  const hit = records.find((h) => {
    if (h.sectionId !== sectionId) return false;
    const start = t(h.faultStart).valueOf();
    const end = h.faultEnd === undefined ? Number.POSITIVE_INFINITY : t(h.faultEnd).valueOf();
    // 严格内部重叠 (start,end) ∩ (a,b)：故障在 t2 整点开始/结束时不波及相邻区间
    return start < b && end > a;
  });
  return hit ?? null;
}

/** 风险版本：每次“恢复实测”产生新版本；恢复时刻之前为 v1，每跨过一次恢复递增 */
function versionAt(records: StationHealthRecord[], sectionId: ID, at: string): number {
  const atMs = t(at).valueOf();
  const recoveries = records
    .filter((h) => h.sectionId === sectionId && h.recoveredReadingAt)
    .map((h) => t(h.recoveredReadingAt as string).valueOf())
    .sort((a, b) => a - b);
  return 1 + recoveries.filter((ms) => ms <= atMs).length;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function computeRiskSegments(ctx: RiskEngineContext): SectionRiskSegment[] {
  const { snapshot, runId } = ctx;
  // 防御：v2 升级前的旧快照可能没有风险主数据字段，按空集处理而非令整次运行失败
  const riverSections = snapshot.riverSections ?? [];
  const healthRecords = snapshot.healthRecords ?? [];
  const hydrologicRelations = snapshot.hydrologicRelations ?? [];
  const tributaryConditions = snapshot.tributaryConditions ?? [];
  const conditionalRelations = snapshot.conditionalRelations ?? [];
  const grid = buildGrid(ctx.gridStart, ctx.gridEnd, ctx.gridStepSeconds);
  const out: SectionRiskSegment[] = [];

  for (const section of riverSections) {
    const own = usableReadings(snapshot, section);
    const relations = hydrologicRelations.filter(
      (h) => h.targetSectionId === section.id && h.approvalStatus === 'approved',
    );
    const models = conditionalRelations.filter((m) => m.targetSectionId === section.id);

    for (let i = 0; i < grid.length - 1; i += 1) {
      const t1 = grid[i];
      const t2 = grid[i + 1];
      const version = versionAt(healthRecords, section.id, t1);
      const health = healthAt(healthRecords, section.id, t1, t2);
      const measured = valueAt(own, t2);
      const limitations: string[] = [];
      const reviewReasons: string[] = [];
      let pendingReview = false;

      // ---- 故障结束与替代关系重叠：恢复实测首值所在区间一律待人工复核 ----
      // 无论该区间最终走实测还是推导分支，恢复首值与替代关系的重叠都须留痕。
      for (const h of healthRecords.filter((x) => x.sectionId === section.id && x.recoveredReadingAt)) {
        const recoverMs = t(h.recoveredReadingAt as string).valueOf();
        if (recoverMs >= t(t1).valueOf() && recoverMs <= t(t2).valueOf() + BOUNDARY_TOL_MS) {
          pendingReview = true;
          reviewReasons.push('故障结束时刻与替代推导关系重叠，恢复实测首值待人工复核后确认');
        }
        if (h.calibration === 'uncalibrated') {
          reviewReasons.push('站点处于未校准状态，恢复后首个校准周期内的实测仍需复核');
        }
      }

      // ---- 健康时段且有实测：直接按实测分类，不做替代 ----
      if (!health && measured) {
        const classification: RiskClass =
          (measured.value as number) > section.bearingLimit ? 'exceeded' : 'safe';
        if ((measured.value as number) > section.warningLimit) {
          limitations.push(`实测值已超过预警线 ${section.warningLimit}${section.unit}，尚未触及承压线`);
        }
        out.push({
          id: `${runId}-risk-${section.id}-${i}`,
          runId, sectionId: section.id, t1, t2,
          classification,
          inferredRange: null,
          measuredValue: measured.value as number,
          bearingLimit: section.bearingLimit,
          warningLimit: section.warningLimit,
          source: 'measured',
          inferred: false,
          evidence: [],
          tributaryRange: null,
          pendingReview,
          reviewReasons: [...new Set(reviewReasons)],
          limitations,
          version,
        });
        continue;
      }

      // ---- 故障区间（或健康但无实测）：推导风险范围 ----
      // 故障恰在区间终点 t2 整点开始时，终点读数即首条故障读数，挂接该健康记录。
      let activeHealth = health;
      if (!activeHealth) {
        activeHealth = healthRecords.find(
          (h) => h.sectionId === section.id && Math.abs(t(h.faultStart).valueOf() - t(t2).valueOf()) <= BOUNDARY_TOL_MS,
        ) ?? null;
      }
      if (!activeHealth) {
        out.push(buildUndetermined(runId, section, t1, t2, i, version, ['本断面无实测读数且无故障登记，缺乏可用观测与替代关系']));
        continue;
      }

      // 支流活跃度按区间中点判定，覆盖整个网格区间（终点整点关闸不漏算）
      const midAt = t(t1).add(ctx.gridStepSeconds / 2, 'second').toISOString();
      const trib = activeTributaryRange(tributaryConditions, section.id, midAt);
      if (trib.ungaged) limitations.push('汇入支流无测站，贡献仅能给界不能给点估计');

      // 来源选择：优先在环境包络内的条件关系（更紧凑），失配则回退工程界
      let chosenRange: [number, number] | null = null;
      let chosenSource: RangeSource = 'none';
      const evidence: RiskEvidence[] = [];
      let conditionalWidth = Number.POSITIVE_INFINITY;
      let conditionalCandidate: ReturnType<typeof predictByConditional> = null;

      for (const model of models) {
        const pred = predictByConditional(snapshot, section, model, t2, trib.range);
        if (!pred) continue;
        if (pred.envelopeReasons.length > 0) {
          limitations.push(`条件关系 ${model.id} 失配回退工程界：${pred.envelopeReasons.join('；')}`);
          continue;
        }
        const width = pred.range[1] - pred.range[0];
        if (width < conditionalWidth) {
          conditionalWidth = width;
          conditionalCandidate = pred;
        }
      }

      const engineering: PropagationResult[] = [];
      for (const rel of relations) {
        const shared = countSharedTargets(snapshot, rel.referenceSectionId);
        const p = propagateByRelation(snapshot, section, rel, activeHealth, t2, shared, trib.range);
        if (p) engineering.push(p);
      }

      if (conditionalCandidate) {
        chosenRange = conditionalCandidate.range;
        chosenSource = 'conditional_fit';
        evidence.push(conditionalCandidate.evidence);
      } else if (engineering.length > 0) {
        // 多参考站非独立证据：取区间并集，绝不做平均或加权收敛
        chosenRange = [
          Math.min(...engineering.map((p) => p.range[0])),
          Math.max(...engineering.map((p) => p.range[1])),
        ];
        chosenSource = 'engineering_propagation';
        evidence.push(...engineering.map((p) => p.evidence));
        limitations.push(...engineering.flatMap((p) => p.limitations));
      } else {
        limitations.push('故障时段无可用邻近断面观测：传播时差窗口内无参考读数，或无已审批水文关系/可用条件模型');
      }
      if (evidence.some((e) => !e.independent) && evidence.length > 0) {
        limitations.push('参考站同时支撑多个断面，不构成独立证据，结论置信度受限');
      }

      out.push({
        id: `${runId}-risk-${section.id}-${i}`,
        runId, sectionId: section.id, t1, t2,
        classification: classify(section, chosenRange),
        inferredRange: chosenRange,
        measuredValue: null,
        bearingLimit: section.bearingLimit,
        warningLimit: section.warningLimit,
        source: chosenRange ? chosenSource : 'none',
        inferred: chosenRange !== null,
        evidence,
        tributaryRange: trib.range,
        pendingReview,
        reviewReasons: [...new Set(reviewReasons)],
        limitations: [...new Set(limitations)],
        version,
        healthRecordId: activeHealth.id,
        note: chosenRange
          ? '本时间段数值为断面风险推导结果（非实测），仅用于风险分类，不得作为替代水位/流量上报'
          : '不可判定：不得据此断言安全或超限，应立即启用人工巡测',
      });
    }
  }
  return out;
}

function buildUndetermined(
  runId: ID,
  section: RiverSection,
  t1: string,
  t2: string,
  index: number,
  version: number,
  limitations: string[],
): SectionRiskSegment {
  return {
    id: `${runId}-risk-${section.id}-${index}`,
    runId, sectionId: section.id, t1, t2,
    classification: 'undetermined',
    inferredRange: null,
    measuredValue: null,
    bearingLimit: section.bearingLimit,
    warningLimit: section.warningLimit,
    source: 'none',
    inferred: false,
    evidence: [],
    tributaryRange: null,
    pendingReview: false,
    reviewReasons: [],
    limitations,
    version,
  };
}

/** 统计一次风险计算的四类时间段数量（页面/简报使用） */
export function summarizeRisk(segments: SectionRiskSegment[]): Record<RiskClass, number> {
  const summary: Record<RiskClass, number> = { safe: 0, exceeded: 0, possible: 0, undetermined: 0 };
  for (const s of segments) summary[s.classification] += 1;
  return summary;
}
