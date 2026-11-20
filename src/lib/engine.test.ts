import { describe, expect, it } from 'vitest';
import { effectiveCurve, interpolate, CurveError } from './curves';
import { integrateFlow } from './integrate';
import { reservoirRainfallDepth, zoneRainfallDepth } from './rainfall';
import { computeFactsForReservoir, executeRun, ruleOverlapIssues, type RunContext } from './balance';
import { computeIndicator } from './indicators';
import { mergeAnnotationFields } from '../db';
import type { CurveVersion, RawReading } from '../types';
import { buildDemoDataset } from '../demo/demoData';

const T0 = '2026-07-15T00:00:00.000Z';
const T1 = '2026-07-15T01:00:00.000Z';
const T2 = '2026-07-15T02:00:00.000Z';

function reading(partial: Partial<RawReading> & Pick<RawReading, 'id' | 'kind' | 'sampledAt' | 'value' | 'unit' | 'quality'>): RawReading {
  return { receivedAt: partial.sampledAt, sourceFile: 't.csv', createdAt: T0, ...partial };
}

describe('曲线插值与版本选择', () => {
  const curve: CurveVersion = {
    id: 'c1', reservoirId: 'r1', kind: 'storage', version: 'v1',
    validFrom: T0, approvalStatus: 'approved', pointUnit: 'wan_m3',
    points: [{ x: 100, y: 0 }, { x: 110, y: 100 }], // 100 万m³ = 1e6 m³
  };

  it('按万m³单位归一化并线性插值', () => {
    expect(interpolate(curve, 105)).toBeCloseTo(500_000, 0);
  });

  it('超范围不外推而是抛错', () => {
    expect(() => interpolate(curve, 120)).toThrow(CurveError);
  });

  it('无已审批曲线与适用期重叠都抛错', () => {
    const draft = { ...curve, id: 'c2', approvalStatus: 'draft' as const };
    expect(() => effectiveCurve([draft], 'r1', 'storage', T1)).toThrow(/无有效/);
    const a = { ...curve, id: 'a' };
    const b = { ...curve, id: 'b', version: 'v2', validTo: undefined };
    expect(() => effectiveCurve([a, b], 'r1', 'storage', T1)).toThrow(/重叠/);
  });
});

describe('流量积分', () => {
  it('按实际区间秒数梯形积分', () => {
    const rs = [
      reading({ id: '1', kind: 'inflow', sampledAt: T0, value: 10, unit: 'm3/s', quality: 'confirmed' }),
      reading({ id: '2', kind: 'inflow', sampledAt: T1, value: 20, unit: 'm3/s', quality: 'confirmed' }),
      reading({ id: '3', kind: 'inflow', sampledAt: T2, value: 30, unit: 'm3/s', quality: 'confirmed' }),
    ];
    const r = integrateFlow(rs, 'inflow', T0, T2, 3600);
    expect(r.covered).toBe(true);
    // (10+20)/2*3600 + (20+30)/2*3600 = 54000 + 90000
    expect(r.volumeM3).toBeCloseTo(144_000, 0);
  });

  it('显式缺失不以零补齐且覆盖不足', () => {
    const rs = [
      reading({ id: '1', kind: 'outflow', sampledAt: T0, value: 10, unit: 'm3/s', quality: 'confirmed' }),
      reading({ id: '2', kind: 'outflow', sampledAt: T1, value: null, unit: 'm3/s', quality: 'missing' }),
      reading({ id: '3', kind: 'outflow', sampledAt: T2, value: 30, unit: 'm3/s', quality: 'confirmed' }),
    ];
    const r = integrateFlow(rs, 'outflow', T0, T2, 3600);
    expect(r.covered).toBe(false);
    expect(r.volumeM3).toBeNull();
    expect(r.reasons.join()).toContain('缺失');
  });

  it('采样间隔超 1.5 倍名义步长识别为断面故障缺口', () => {
    const rs = [
      reading({ id: '1', kind: 'inflow', sampledAt: T0, value: 10, unit: 'm3/s', quality: 'confirmed' }),
      reading({ id: '2', kind: 'inflow', sampledAt: '2026-07-15T03:00:00.000Z', value: 20, unit: 'm3/s', quality: 'confirmed' }),
    ];
    const r = integrateFlow(rs, 'inflow', T0, '2026-07-15T03:00:00.000Z', 3600);
    expect(r.covered).toBe(false);
    expect(r.reasons.join()).toContain('断面故障');
  });

  it('量纲不相容记录使区间不可闭合', () => {
    const rs = [
      reading({ id: '1', kind: 'inflow', sampledAt: T0, value: 10, unit: 'L/s', quality: 'confirmed' }),
      reading({ id: '2', kind: 'inflow', sampledAt: T1, value: 20, unit: 'L/s', quality: 'confirmed' }),
    ];
    const r = integrateFlow(rs, 'inflow', T0, T1, 3600);
    expect(r.covered).toBe(false);
    expect(r.reasons.join()).toContain('量纲不相容');
  });
});

describe('雨量修订与分区加权', () => {
  it('重叠雨量按修订关系替代而非累加', () => {
    const old = reading({
      id: 'old', kind: 'rainfall', zoneId: 'z1', sampledAt: T1, intervalStart: T0,
      value: 8, unit: 'mm', quality: 'confirmed', receivedAt: T1,
    });
    const rev = reading({
      id: 'rev', kind: 'rainfall', zoneId: 'z1', sampledAt: T1, intervalStart: T0,
      value: 12, unit: 'mm', quality: 'confirmed', receivedAt: T1, revisionOf: 'old',
    });
    old.supersededById = 'rev';
    const r = zoneRainfallDepth([old, rev], 'z1', T0, T1);
    expect(r.covered).toBe(true);
    expect(r.depthMm).toBeCloseTo(12, 6);
  });

  it('无修订关系的重叠记录禁止累加并标记不可闭合', () => {
    const a = reading({ id: 'a', kind: 'rainfall', zoneId: 'z1', sampledAt: T1, intervalStart: T0, value: 8, unit: 'mm', quality: 'confirmed', receivedAt: T1 });
    const b = reading({ id: 'b', kind: 'rainfall', zoneId: 'z1', sampledAt: T1, intervalStart: T0, value: 5, unit: 'mm', quality: 'confirmed', receivedAt: T1 });
    const r = zoneRainfallDepth([a, b], 'z1', T0, T1);
    expect(r.covered).toBe(false);
    expect(r.reasons.join()).toContain('禁止累加');
  });

  it('按分区权重计算水库面雨量', () => {
    const data = buildDemoDataset();
    const res = data.reservoirs.find((x) => x.id === 'qx')!;
    const r = reservoirRainfallDepth(data.readings, res, '2026-07-15T00:00:00.000Z', '2026-07-15T01:00:00.000Z');
    // z1=10, z2=5，权重 0.6/0.4
    expect(r.depthMm).toBeCloseTo(8, 6);
  });
});

describe('演示数据端到端平衡运行', () => {
  const data = buildDemoDataset();
  const snapshot = {
    runId: 'test-run',
    readings: data.readings,
    curves: data.curves,
    rules: data.rules,
    reservoirs: data.reservoirs,
    zones: data.zones,
    riverSections: [],
    healthRecords: [],
    hydrologicRelations: [],
    tributaryConditions: [],
    conditionalRelations: [],
    frozenAt: '2026-07-15T09:30:00.000Z',
  };
  const ctx: RunContext = {
    snapshot,
    tolerance: { absM3: 20_000, relFraction: 0.02 },
    nominalStepSeconds: 3600,
    gridStart: '2026-07-15T00:00:00.000Z',
    gridEnd: '2026-07-15T06:00:00.000Z',
    gridStepSeconds: 3600,
  };

  it('青溪河常规区间闭合，疑似水位偏差区间残差超差且列出未闭合来源', () => {
    const qx = data.reservoirs.find((r) => r.id === 'qx')!;
    const facts = computeFactsForReservoir(ctx, qx, [
      '2026-07-15T00:00:00.000Z',
      '2026-07-15T01:00:00.000Z',
      '2026-07-15T02:00:00.000Z',
      '2026-07-15T03:00:00.000Z',
    ]);
    expect(facts[0].closed).toBe(true);
    expect(facts[0].residual).not.toBeNull();
    expect(Math.abs(facts[0].residual as number)).toBeLessThan(1000);
    // 01~02 区间终点为 02:00 的 suspect 水位（+0.05m → +50000m³）
    expect(facts[1].closed).toBe(false);
    expect(facts[1].unclosedReasons.join()).toContain('残差');
    expect(facts[1].unclosedReasons.join()).not.toContain('损耗');
  });

  it('白沙河记录库容曲线切换，且断面故障区间残差为 null、保持待核', () => {
    const bs = data.reservoirs.find((r) => r.id === 'bs')!;
    const facts = computeFactsForReservoir(ctx, bs, [
      '2026-07-15T02:00:00.000Z',
      '2026-07-15T03:00:00.000Z',
      '2026-07-15T04:00:00.000Z',
      '2026-07-15T05:00:00.000Z',
    ]);
    expect(facts[0].curveSwitched).toBe(true);
    expect(facts[0].storageCurveIdAtT1).toBe('cv-bs-s1');
    expect(facts[0].storageCurveIdAtT2).toBe('cv-bs-s2');
    const fault = facts[1]; // 03~04，终点 04:00 缺测
    expect(fault.residual).toBeNull();
    expect(fault.closed).toBe(false);
    expect(fault.unclosedReasons.join()).toMatch(/缺失|故障/);
  });

  it('西岭无效库容曲线导致指标待核，规则重叠被识别', () => {
    const issues = ruleOverlapIssues(data.rules, data.reservoirs);
    expect(issues.join()).toContain('XL-RULE-A');
    const facts = executeRun(ctx);
    const ind = computeIndicator(snapshot, facts, 'xl', {
      runId: 'test-run',
      asOf: '2026-07-15T06:00:00.000Z',
      pressureWindowSeconds: 3 * 3600,
      decisionHorizonSeconds: 3600,
    });
    expect(ind.pending).toBe(true);
    expect(ind.pendingReasons.join()).toMatch(/曲线|规则/);
    expect(ind.floodMargin).toBeNull();
  });

  it('青溪河指标给出防洪余量、压力比范围与泄洪空间差额', () => {
    const facts = executeRun(ctx);
    const ind = computeIndicator(snapshot, facts, 'qx', {
      runId: 'test-run',
      asOf: '2026-07-15T06:00:00.000Z',
      pressureWindowSeconds: 3 * 3600,
      decisionHorizonSeconds: 3600,
    });
    expect(ind.currentStorage).not.toBeNull();
    expect(ind.floodMargin).not.toBeNull();
    expect(ind.floodLimitStorage).toBe(12e6);
    expect(ind.pressureRatio).not.toBeNull();
    expect(ind.pressureRatioRange[0]).not.toBeNull();
    expect(ind.releaseNeededRange).not.toBeNull();
    expect(ind.downstreamAllowableRange).toEqual([30, 120]);
    expect(ind.releaseGapRange).not.toBeNull();
    expect(ind.factIds.length).toBe(3);
  });

  it('全量运行事实数 = 水库数 × 区间数', () => {
    const facts = executeRun(ctx);
    expect(facts.length).toBe(4 * 6);
  });
});

describe('字段级并发批注', () => {
  it('两个页面并发修改不同字段时各自保留，不做整单覆盖', () => {
    const first = mergeAnnotationFields(undefined, 'indicator', 'i1', {
      处置理由: { field: '处置理由', author: '甲', value: '加强观测', updatedAt: '2026-07-15T07:00:00.000Z' },
    }, '2026-07-15T07:00:00.000Z');
    const second = mergeAnnotationFields(first.annotation, 'indicator', 'i1', {
      风险结论: { field: '风险结论', author: '乙', value: '待核', updatedAt: '2026-07-15T07:01:00.000Z' },
    }, '2026-07-15T07:01:00.000Z');
    expect(Object.keys(second.annotation.fields).sort()).toEqual(['处置理由', '风险结论']);
    expect(second.conflicts.length).toBe(0);
  });

  it('同一字段并发修改保留差异留痕且较新者胜', () => {
    const first = mergeAnnotationFields(undefined, 'indicator', 'i1', {
      处置理由: { field: '处置理由', author: '甲', value: 'A方案', updatedAt: '2026-07-15T07:00:00.000Z' },
    }, '2026-07-15T07:00:00.000Z');
    const second = mergeAnnotationFields(first.annotation, 'indicator', 'i1', {
      处置理由: { field: '处置理由', author: '乙', value: 'B方案', updatedAt: '2026-07-15T07:05:00.000Z' },
    }, '2026-07-15T07:05:00.000Z');
    expect(second.conflicts.length).toBe(1);
    expect(second.annotation.fields['处置理由'].value).toBe('B方案');
    expect(second.annotation.fields['处置理由'].author).toBe('乙');
  });
});
