// 端到端集成测试：fake-indexeddb 复刻 Worker 的“播种→锁定快照→平衡→指标→落库”路径
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearAllData, getFactsByRun, getIndicatorsByRun, getReadingsForCutoff,
  getRiskSegmentsByRun, getSnapshot, saveAnnotationFields,
} from '../db';
import { seedDemoData } from '../services/seedService';
import { createRun } from '../services/runService';
import { executeRun, type RunContext } from './balance';
import { computeAllIndicators } from './indicators';
import { computeRiskSegments, summarizeRisk, type RiskEngineContext } from './riskRange';
import { replaceFacts, replaceIndicators, replaceRiskSegments, saveRun } from '../db';
import { DEMO_CUTOFF_RUN1, DEMO_CUTOFF_RUN2 } from '../demo/demoData';
import type { BalanceRun } from '../types';

async function executeLikeWorker(run: BalanceRun) {
  const snapshot = (await getSnapshot(run.id))!;
  const ctx: RunContext = {
    snapshot,
    tolerance: run.tolerance,
    nominalStepSeconds: run.gridStepSeconds,
    gridStart: run.gridStart,
    gridEnd: run.gridEnd,
    gridStepSeconds: run.gridStepSeconds,
  };
  const facts = executeRun(ctx);
  const indicators = computeAllIndicators(snapshot, facts, {
    runId: run.id,
    asOf: run.gridEnd,
    pressureWindowSeconds: run.pressureWindowSeconds,
    decisionHorizonSeconds: run.decisionHorizonSeconds,
  });
  const riskSegments = computeRiskSegments({
    snapshot,
    runId: run.id,
    gridStart: run.gridStart,
    gridEnd: run.gridEnd,
    gridStepSeconds: run.gridStepSeconds,
  } as RiskEngineContext);
  // 与 balance.worker 一致：仅物化设计落库，按需设计不预落风险分段
  if (run.design === 'materialized') {
    await replaceFacts(run.id, facts);
    await replaceIndicators(run.id, indicators);
    await replaceRiskSegments(run.id, riskSegments);
  }
  await saveRun({ ...run, status: 'completed', stats: { factCount: facts.length, pendingCount: indicators.filter((i) => i.pending).length, unclosedCount: facts.filter((f) => f.unclosedReasons.length > 0).length }, warnings: [] });
  return { facts, indicators, riskSegments };
}

afterEach(async () => {
  await clearAllData();
});

describe('端到端：六类验收场景', () => {
  it('播种与资料截止点：RUN1 排除迟到雨量，RUN2 纳入', async () => {
    await seedDemoData();
    const run1Readings = await getReadingsForCutoff(DEMO_CUTOFF_RUN1);
    const run2Readings = await getReadingsForCutoff(DEMO_CUTOFF_RUN2);
    const late = run2Readings.filter((r) => r.note === '通信中断后补传');
    expect(late.length).toBe(1);
    expect(run1Readings.some((r) => r.id === late[0].id)).toBe(false);
    expect(run2Readings.some((r) => r.id === late[0].id)).toBe(true);
  });

  it('RUN1 青溪河 05~06 区间因迟到雨量缺失不可闭合；RUN2 同区间闭合', async () => {
    await seedDemoData();
    const base = {
      name: 't', gridStart: '2026-07-15T00:00:00.000Z', gridEnd: '2026-07-15T06:00:00.000Z',
      gridStepSeconds: 3600, tolerance: { absM3: 20_000, relFraction: 0.02 },
      pressureWindowSeconds: 3 * 3600, decisionHorizonSeconds: 3600, reservoirIds: ['qx'], design: 'materialized' as const,
    };
    const r1 = await createRun({ ...base, name: 'RUN1', cutoffAt: DEMO_CUTOFF_RUN1 });
    const r2 = await createRun({ ...base, name: 'RUN2', cutoffAt: DEMO_CUTOFF_RUN2 });
    const out1 = await executeLikeWorker(r1);
    const out2 = await executeLikeWorker(r2);

    const last1 = out1.facts.find((f) => f.t1 === '2026-07-15T05:00:00.000Z')!;
    const last2 = out2.facts.find((f) => f.t1 === '2026-07-15T05:00:00.000Z')!;
    expect(last1.closed).toBe(false);
    expect(last1.unclosedReasons.join()).toContain('覆盖率');
    expect(last2.closed).toBe(true);
    // 同一引擎两次运行确定性一致（除截止点差异外的区间完全相同）
    const f0run1 = out1.facts.find((f) => f.t1 === '2026-07-15T00:00:00.000Z')!;
    const f0run2 = out2.facts.find((f) => f.t1 === '2026-07-15T00:00:00.000Z')!;
    expect(f0run1.residual).toEqual(f0run2.residual);
  });

  it('跨库调水进入平衡项且符号正确（青溪河调入为正、白沙河调出为负）', async () => {
    await seedDemoData();
    const run = await createRun({
      name: '调水', cutoffAt: DEMO_CUTOFF_RUN2,
      gridStart: '2026-07-15T00:00:00.000Z', gridEnd: '2026-07-15T01:00:00.000Z',
      gridStepSeconds: 3600, tolerance: { absM3: 20_000, relFraction: 0.02 },
      pressureWindowSeconds: 3600, decisionHorizonSeconds: 3600,
      reservoirIds: ['qx', 'bs'], design: 'materialized',
    });
    const { facts } = await executeLikeWorker(run);
    const qx = facts.find((f) => f.reservoirId === 'qx')!;
    const bs = facts.find((f) => f.reservoirId === 'bs')!;
    expect(qx.terms.find((t) => t.key === 'transferIn')!.valueM3).toBe(20 * 3600);
    expect(qx.terms.find((t) => t.key === 'transferOut')!.valueM3).toBe(0);
    expect(bs.terms.find((t) => t.key === 'transferOut')!.valueM3).toBe(10 * 3600);
    expect(bs.terms.find((t) => t.key === 'transferIn')!.valueM3).toBe(0);
  });

  it('库容曲线切换被记录，断面故障区间残差为 null', async () => {
    await seedDemoData();
    const run = await createRun({
      name: '曲线与故障', cutoffAt: DEMO_CUTOFF_RUN2,
      gridStart: '2026-07-15T02:00:00.000Z', gridEnd: '2026-07-15T05:00:00.000Z',
      gridStepSeconds: 3600, tolerance: { absM3: 20_000, relFraction: 0.02 },
      pressureWindowSeconds: 3600, decisionHorizonSeconds: 3600,
      reservoirIds: ['bs'], design: 'materialized',
    });
    const { facts, indicators } = await executeLikeWorker(run);
    expect(facts[0].curveSwitched).toBe(true);
    expect(facts[0].storageCurveIdAtT1).toBe('cv-bs-s1');
    expect(facts[0].storageCurveIdAtT2).toBe('cv-bs-s2');
    const fault = facts.find((f) => f.t1 === '2026-07-15T03:00:00.000Z')!;
    expect(fault.residual).toBeNull();
    expect(fault.terms.find((t) => t.key === 'inflow')!.covered).toBe(false);
    expect(indicators[0].pending).toBe(true);
  });

  it('无效曲线 + 规则重叠：西岭指标保持待核，不输出确定性余量', async () => {
    await seedDemoData();
    const run = await createRun({
      name: '待核', cutoffAt: DEMO_CUTOFF_RUN2,
      gridStart: '2026-07-15T00:00:00.000Z', gridEnd: '2026-07-15T06:00:00.000Z',
      gridStepSeconds: 3600, tolerance: { absM3: 20_000, relFraction: 0.02 },
      pressureWindowSeconds: 3 * 3600, decisionHorizonSeconds: 3600,
      reservoirIds: ['xl'], design: 'materialized',
    });
    const { indicators } = await executeLikeWorker(run);
    const ind = indicators[0];
    expect(ind.pending).toBe(true);
    expect(ind.floodMargin).toBeNull();
    expect(ind.pendingReasons.join()).toMatch(/曲线|规则/);
  });

  it('大文件下钻：东风水库 5 天 120 个小时区间、10 分钟级流量全部可闭合', async () => {
    await seedDemoData();
    const run = await createRun({
      name: '大文件', cutoffAt: '2026-07-15T09:30:00.000Z',
      gridStart: '2026-07-10T00:00:00.000Z', gridEnd: '2026-07-15T00:00:00.000Z',
      gridStepSeconds: 3600, tolerance: { absM3: 50_000, relFraction: 0.05 },
      pressureWindowSeconds: 6 * 3600, decisionHorizonSeconds: 3600,
      reservoirIds: ['df'], design: 'materialized',
    });
    const { facts, indicators } = await executeLikeWorker(run);
    expect(facts.length).toBe(120);
    const unclosed = facts.filter((f) => !f.closed);
    expect(unclosed.length).toBe(0);
    const evidenceCount = facts[60].terms.reduce((s, t) => s + t.sourceReadingIds.length, 0);
    expect(evidenceCount).toBeGreaterThan(20); // 10 分钟级证据链
    expect(indicators[0].floodMargin).not.toBeNull();
    // 落库路径校验：物化事实与指标可被复盘页直接读取
    expect((await getFactsByRun(run.id)).length).toBe(120);
    expect((await getIndicatorsByRun(run.id)).length).toBe(1);
  });

  it('并发批注：不同字段保留、同字段冲突留痕，不做整单覆盖', async () => {
    await seedDemoData();
    await saveAnnotationFields('indicator', 'i-x', {
      处置理由: { field: '处置理由', author: '甲', value: '加强观测', updatedAt: '2026-07-15T07:00:00.000Z' },
    }, '2026-07-15T07:00:00.000Z');
    const b = await saveAnnotationFields('indicator', 'i-x', {
      风险结论: { field: '风险结论', author: '乙', value: '待核', updatedAt: '2026-07-15T07:01:00.000Z' },
    }, '2026-07-15T07:01:00.000Z');
    expect(Object.keys(b.annotation.fields).sort()).toEqual(['处置理由', '风险结论']);
    const c = await saveAnnotationFields('indicator', 'i-x', {
      处置理由: { field: '处置理由', author: '乙', value: '提前预泄', updatedAt: '2026-07-15T07:05:00.000Z' },
    }, '2026-07-15T07:05:00.000Z');
    expect(c.conflicts.length).toBe(1);
    expect(c.annotation.fields['处置理由'].value).toBe('提前预泄');
    expect(c.annotation.fields['风险结论'].value).toBe('待核');
    expect(c.annotation.revision).toBe(3);
  });

  it('断面风险端到端：快照冻结风险主数据，物化分段落库且四类分类齐全', async () => {
    await seedDemoData();
    const run = await createRun({
      name: '风险推导', cutoffAt: DEMO_CUTOFF_RUN2,
      gridStart: '2026-07-15T00:00:00.000Z', gridEnd: '2026-07-15T06:00:00.000Z',
      gridStepSeconds: 3600, tolerance: { absM3: 20_000, relFraction: 0.02 },
      pressureWindowSeconds: 3 * 3600, decisionHorizonSeconds: 3600,
      reservoirIds: ['qx'], design: 'materialized',
    });
    const snap = (await getSnapshot(run.id))!;
    // 风险主数据随快照冻结
    expect(snap.riverSections.length).toBe(4);
    expect(snap.healthRecords.length).toBe(3);
    expect(snap.hydrologicRelations.length).toBe(4);
    expect(snap.conditionalRelations.length).toBe(2);

    const { riskSegments } = await executeLikeWorker(run);
    const summary = summarizeRisk(riskSegments);
    expect(summary.safe + summary.exceeded + summary.possible + summary.undetermined).toBe(riskSegments.length);
    expect(summary.exceeded).toBeGreaterThan(0);
    expect(summary.possible).toBeGreaterThan(0);
    expect(summary.undetermined).toBeGreaterThan(0);
    // 物化落库路径：风险分段可被风险页直接读取
    const stored = await getRiskSegmentsByRun(run.id);
    expect(stored.length).toBe(riskSegments.length);
    // 所有推导分段强制非实测标记，且不存在单点替代值
    expect(stored.filter((s) => s.inferred).every((s) => s.inferredRange !== null && s.measuredValue === null)).toBe(true);
  });
});
