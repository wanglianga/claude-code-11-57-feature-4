// 断面风险范围推导引擎测试：两类区间来源、四类分类、非独立证据、
// 支流汇入、罕见暴雨包络失配、恢复待复核与风险版本、不可判定保护。
import { describe, expect, it } from 'vitest';
import {
  computeRiskSegments, fitConditionalRelation, summarizeRisk, MIN_FIT_SAMPLES,
  type RiskEngineContext,
} from './riskRange';
import { buildRiskDemoDataset } from '../demo/riskDemo';
import type {
  HydrologicRelation, RawReading, RiverSection, RunSnapshot, StationHealthRecord,
  TributaryCondition, ConditionalRelation,
} from '../types';

const DAY = '2026-07-15';
const H = (h: number) => `${DAY}T${String(h).padStart(2, '0')}:00:00.000Z`;
const GRID_START = H(0);
const GRID_END = H(6);

function demoSnapshot(): RunSnapshot {
  const d = buildRiskDemoDataset();
  return {
    runId: 'risk-test',
    readings: d.readings,
    curves: [],
    rules: [],
    reservoirs: [],
    zones: d.zones,
    riverSections: d.sections,
    healthRecords: d.health,
    hydrologicRelations: d.relations,
    tributaryConditions: d.tributaries,
    conditionalRelations: d.conditionalRelations,
    frozenAt: H(9),
  };
}

function run(snapshot: RunSnapshot): ReturnType<typeof computeRiskSegments> {
  const ctx: RiskEngineContext = {
    snapshot, runId: snapshot.runId, gridStart: GRID_START, gridEnd: GRID_END, gridStepSeconds: 3600,
  };
  return computeRiskSegments(ctx);
}

describe('条件关系拟合', () => {
  it('样本不足 MIN_FIT_SAMPLES 时拒绝拟合（历史覆盖不足不强行使用）', () => {
    const samples = Array.from({ length: MIN_FIT_SAMPLES - 1 }, (_, i) => ({
      at: H(i % 24), referenceValue: i, targetValue: 2 * i + 3,
      rainIntensity: 1, gateState: 'regulated',
    }));
    const m = fitConditionalRelation({
      id: 'm', targetSectionId: 't', referenceSectionId: 'r', samples,
      environment: { rainIntensityRange: [0, 10], gateStates: ['regulated'], monthRange: [6, 9] },
    });
    expect(m).toBeNull();
  });

  it('线性样本恢复 slope/intercept，残差带为 0、R²=1，并应用包络覆盖', () => {
    const samples = Array.from({ length: 12 }, (_, i) => ({
      at: H(i % 24), referenceValue: 10 + i, targetValue: 2 * (10 + i) + 3,
      rainIntensity: 2, gateState: 'regulated',
    }));
    const m = fitConditionalRelation({
      id: 'm', targetSectionId: 't', referenceSectionId: 'r', samples,
      environment: { rainIntensityRange: [0, 10], gateStates: ['regulated'], monthRange: [6, 9] },
      envelopeOverrides: { rainRange: [0, 12] },
    }) as ConditionalRelation;
    expect(m.slope).toBeCloseTo(2, 6);
    expect(m.intercept).toBeCloseTo(3, 6);
    expect(m.residualBand).toBeCloseTo(0, 6);
    expect(m.r2).toBeCloseTo(1, 6);
    expect(m.sampleCount).toBe(12);
    expect(m.envelope.rainRange).toEqual([0, 12]);
  });
});

describe('演示数据端到端：四类风险时间段与来源', () => {
  const snapshot = demoSnapshot();
  const segments = run(snapshot);
  const by = (sectionId: string, t1: string) =>
    segments.find((s) => s.sectionId === sectionId && s.t1 === t1)!;

  it('四类分类在默认网格内全部出现，且全部为区间结论而非单点替代值', () => {
    const summary = summarizeRisk(segments);
    expect(summary.safe).toBeGreaterThan(0);
    expect(summary.exceeded).toBeGreaterThan(0);
    expect(summary.possible).toBeGreaterThan(0);
    expect(summary.undetermined).toBeGreaterThan(0);
    for (const s of segments.filter((x) => x.inferred)) {
      expect(Array.isArray(s.inferredRange)).toBe(true);
      expect((s.inferredRange as [number, number])[0]).toBeLessThan((s.inferredRange as [number, number])[1]);
      expect(s.measuredValue).toBeNull();
    }
  });

  it('sec-b 故障：条件关系推导给出 可能超限→已确认超限，全程标注推导非实测', () => {
    const possible = by('sec-b', H(3));
    const exceeded = by('sec-b', H(4));
    expect(possible.classification).toBe('possible');
    expect(possible.source).toBe('conditional_fit');
    expect(possible.inferred).toBe(true);
    expect(exceeded.classification).toBe('exceeded');
    expect(exceeded.source).toBe('conditional_fit');
    expect(exceeded.inferredRange![0]).toBeGreaterThan(170); // 承压线 170
    expect(exceeded.note).toContain('非实测');
  });

  it('sec-b 无测站支流在闸控活跃区间计入贡献界并提示只能给界', () => {
    const seg = by('sec-b', H(3));
    expect(seg.tributaryRange).toEqual([8, 20]);
    expect(seg.limitations.join()).toContain('支流无测站');
    const inactive = by('sec-b', H(0));
    expect(inactive.tributaryRange).toBeNull();
  });

  it('sec-c 罕见暴雨超出条件关系包络，回退工程传播并在限制中说明失配', () => {
    const storm = by('sec-c', H(4));
    expect(storm.source).toBe('engineering_propagation');
    expect(storm.limitations.join()).toMatch(/雨强|包络|失配/);
    expect(storm.inferred).toBe(true);
  });

  it('sec-c 恢复前一区间工程传播判定可能超限，且标记待复核', () => {
    const seg = by('sec-c', H(5));
    expect(seg.classification).toBe('possible');
    expect(seg.source).toBe('engineering_propagation');
    expect(seg.pendingReview).toBe(true);
    expect(seg.reviewReasons.join()).toContain('待人工复核');
  });

  it('sec-d 草稿关系不参与推导，开放故障持续不可判定并建议人工巡测', () => {
    for (const t1 of [H(3), H(4), H(5)]) {
      const seg = by('sec-d', t1);
      expect(seg.classification).toBe('undetermined');
      expect(seg.inferredRange).toBeNull();
      expect(seg.source).toBe('none');
    }
    expect(by('sec-d', H(4)).note).toContain('人工巡测');
  });

  it('参考站 sec-a 同时支撑 sec-b/sec-c，证据标记为非独立且多源取并集', () => {
    const seg = by('sec-c', H(5));
    expect(seg.evidence.length).toBeGreaterThanOrEqual(1);
    const fromA = seg.evidence.find((e) => e.referenceSectionId === 'sec-a')!;
    expect(fromA.independent).toBe(false);
    expect(fromA.sharedTargetCount).toBe(2);
  });

  it('恢复实测后只形成新风险版本：sec-b 05:00 起 v2 且恢复区间待复核，旧推导保持 v1', () => {
    expect(by('sec-b', H(4)).version).toBe(1);
    const recovered = by('sec-b', H(5));
    expect(recovered.version).toBe(2);
    expect(recovered.source).toBe('measured');
    expect(recovered.inferred).toBe(false);
    expect(recovered.pendingReview).toBe(true);
  });

  it('实测健康时段不产出推导，超承压线实测直接判已确认超限', () => {
    const measured = segments.filter((s) => s.source === 'measured');
    expect(measured.every((s) => s.inferred === false && s.evidence.length === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 合成最小快照：工程传播力学、多源并集、校准放宽、包络失配回退
// ---------------------------------------------------------------------------

function flowReading(stationId: string, at: string, value: number | null, quality: RawReading['quality'] = 'confirmed'): RawReading {
  return {
    id: `r-${stationId}-${at}`, stationId, kind: 'inflow', sampledAt: at, receivedAt: at,
    value, unit: 'm3/s', quality, sourceFile: 'syn.csv', createdAt: H(0),
  };
}

function syntheticSnapshot(opts: {
  refValues: number[];
  relation?: Partial<HydrologicRelation> | null;
  calibration?: StationHealthRecord['calibration'];
  extraRelations?: HydrologicRelation[];
  model?: ConditionalRelation;
  tributary?: TributaryCondition;
  bearingLimit?: number;
}): RunSnapshot {
  const ref: RiverSection = { id: 'R', name: '参考', lon: 0, lat: 0, metric: 'flow', unit: 'm3/s', bearingLimit: 999, warningLimit: 900 };
  const target: RiverSection = { id: 'T', name: '目标', lon: 1, lat: 0, metric: 'flow', unit: 'm3/s', bearingLimit: opts.bearingLimit ?? 100, warningLimit: 80 };
  const readings: RawReading[] = [];
  opts.refValues.forEach((v, i) => readings.push(flowReading('R', H(i), v)));
  // 目标断面 01:00 起故障缺失
  for (let i = 0; i <= 3; i += 1) {
    readings.push(flowReading('T', H(i), i === 0 ? 40 : null, i === 0 ? 'confirmed' : 'missing'));
  }
  const relation: HydrologicRelation = {
    id: 'rel-R-T', targetSectionId: 'T', referenceSectionId: 'R', approvalStatus: 'approved',
    travelTimeMinSeconds: 0, travelTimeMaxSeconds: 3600,
    attenuationMin: 0.9, attenuationMax: 1.1, backwaterWiden: 0, calibrationRelax: 0.1,
    ...opts.relation,
  };
  const health: StationHealthRecord = {
    id: 'h-T', sectionId: 'T', faultStart: H(1), reason: '故障',
    calibration: opts.calibration ?? 'calibrated', availableNeighborIds: ['R'],
  };
  return {
    runId: 'syn', readings, curves: [], rules: [], reservoirs: [], zones: [],
    riverSections: [ref, target], healthRecords: [health],
    hydrologicRelations: opts.relation === null ? [] : [relation, ...(opts.extraRelations ?? [])],
    tributaryConditions: opts.tributary ? [opts.tributary] : [],
    conditionalRelations: opts.model ? [opts.model] : [],
    frozenAt: H(9),
  };
}

describe('工程批准区间传播力学', () => {
  it('上界低于承压线判安全；下界高于承压线判超限；跨界判可能超限', () => {
    const safe = run(syntheticSnapshot({ refValues: [50, 50, 50, 50] })).find((s) => s.sectionId === 'T' && s.t1 === H(1))!;
    expect(safe.classification).toBe('safe');
    expect(safe.inferredRange![0]).toBeCloseTo(45, 6);
    expect(safe.inferredRange![1]).toBeCloseTo(55, 6);

    const exceeded = run(syntheticSnapshot({ refValues: [120, 120, 120, 120] })).find((s) => s.sectionId === 'T' && s.t1 === H(1))!;
    expect(exceeded.classification).toBe('exceeded');
    expect(exceeded.inferredRange![0]).toBeCloseTo(108, 6);
    expect(exceeded.inferredRange![1]).toBeCloseTo(132, 6);

    const possible = run(syntheticSnapshot({ refValues: [95, 95, 95, 95] })).find((s) => s.sectionId === 'T' && s.t1 === H(1))!;
    expect(possible.classification).toBe('possible');
  });

  it('未校准状态按 calibrationRelax 放宽增减界，区间宽于校准状态', () => {
    const calibrated = run(syntheticSnapshot({ refValues: [100, 100, 100, 100], calibration: 'calibrated' })).find((s) => s.sectionId === 'T')!;
    const uncalibrated = run(syntheticSnapshot({ refValues: [100, 100, 100, 100], calibration: 'uncalibrated' })).find((s) => s.sectionId === 'T')!;
    const width = (r: [number, number] | null) => (r ? r[1] - r[0] : 0);
    expect(width(uncalibrated.inferredRange)).toBeGreaterThan(width(calibrated.inferredRange));
    expect(uncalibrated.limitations.join()).toContain('uncalibrated');
  });

  it('两个参考站的非独立证据取区间并集而非平均', () => {
    const extra: HydrologicRelation = {
      id: 'rel-R2-T', targetSectionId: 'T', referenceSectionId: 'R2', approvalStatus: 'approved',
      travelTimeMinSeconds: 0, travelTimeMaxSeconds: 3600,
      attenuationMin: 0.5, attenuationMax: 0.6, backwaterWiden: 0, calibrationRelax: 0,
    };
    const snap = syntheticSnapshot({ refValues: [100, 100, 100, 100], extraRelations: [extra] });
    const ref2: RiverSection = { id: 'R2', name: '参考2', lon: 0, lat: 1, metric: 'flow', unit: 'm3/s', bearingLimit: 999, warningLimit: 900 };
    snap.riverSections.push(ref2);
    snap.readings.push(flowReading('R2', H(0), 100), flowReading('R2', H(1), 100));
    const seg = run(snap).find((s) => s.sectionId === 'T' && s.t1 === H(1))!;
    expect(seg.evidence).toHaveLength(2);
    // R 给 [90,110]，R2 给 [50,60]，并集
    expect(seg.inferredRange![0]).toBeCloseTo(50, 6);
    expect(seg.inferredRange![1]).toBeCloseTo(110, 6);
  });

  it('条件关系超出环境包络且无工程关系时判不可判定，有工程关系时回退工程来源', () => {
    const model: ConditionalRelation = {
      id: 'cond', targetSectionId: 'T', referenceSectionId: 'R',
      fittedFrom: H(0), fittedTo: H(2), slope: 1, intercept: 0, residualBand: 2,
      envelope: { referenceRange: [0, 10], rainRange: [0, 10], gateStates: ['regulated'], monthRange: [6, 9] },
      sampleCount: 20, r2: 0.9,
      environment: { rainIntensityRange: [0, 10], gateStates: ['regulated'], monthRange: [6, 9] },
    };
    const noFallback = run(syntheticSnapshot({ refValues: [50, 50, 50, 50], model, relation: null })).find((s) => s.sectionId === 'T' && s.t1 === H(1))!;
    expect(noFallback.classification).toBe('undetermined');
    expect(noFallback.source).toBe('none');

    const withFallback = run(syntheticSnapshot({ refValues: [50, 50, 50, 50], model })).find((s) => s.sectionId === 'T' && s.t1 === H(1))!;
    expect(withFallback.source).toBe('engineering_propagation');
    expect(withFallback.limitations.join()).toContain('失配回退工程界');
  });

  it('活跃支流贡献界叠加到传播区间，关闭后不叠加', () => {
    const tributary: TributaryCondition = {
      id: 'tb', targetSectionId: 'T', name: '支流', activeFrom: H(1), activeTo: H(3),
      contributionRange: [5, 15], ungaged: false,
    };
    const segs = run(syntheticSnapshot({ refValues: [50, 50, 50, 50], tributary })).filter((s) => s.sectionId === 'T');
    const withTrib = segs.find((s) => s.t1 === H(1))!;
    // [45,55] + [5,15]
    expect(withTrib.inferredRange![0]).toBeCloseTo(50, 6);
    expect(withTrib.inferredRange![1]).toBeCloseTo(70, 6);
    const afterClose = segs.find((s) => s.t1 === H(3))!;
    expect(afterClose.tributaryRange).toBeNull();
  });
});
