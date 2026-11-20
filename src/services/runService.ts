// 运行编排：固定来源截止点、曲线版本、容差与时间网格，形成不可变快照后交给 Worker
import type { BalanceRun, RunSnapshot } from '../types';
import {
  getAllConditionalRelations,
  getAllCurves,
  getAllHydrologicRelations,
  getAllRainZones,
  getAllReadings,
  getAllReservoirs,
  getAllRiverSections,
  getAllRules,
  getAllStationHealth,
  getAllTributaryConditions,
  getReadingsForCutoff,
  saveRun,
  saveSnapshot,
} from '../db';
import { nowISO } from '../lib/time';
import type { WorkerProgress, WorkerRunRequest } from '../workers/balance.worker';

export interface CreateRunParams {
  name: string;
  cutoffAt: string;
  gridStart: string;
  gridEnd: string;
  gridStepSeconds: number;
  tolerance: BalanceRun['tolerance'];
  pressureWindowSeconds: number;
  decisionHorizonSeconds: number;
  reservoirIds: string[];
  design: BalanceRun['design'];
}

export interface DesignAdvice {
  design: BalanceRun['design'];
  reason: string;
}

/**
 * 物化 vs 按需的选择依据：文件规模、值班响应时限、复盘粒度。
 * 两种设计产出指标的平衡方程/版本/容差完全相同。
 */
export function adviseDesign(readingCount: number, gridIntervalCount: number, reservoirCount: number): DesignAdvice {
  const factCount = readingCount * gridIntervalCount * reservoirCount;
  if (factCount > 200_000) {
    return {
      design: 'on_demand',
      reason: `预计事实量 ${factCount} 条，全量物化将占用过多本地存储，采用来源索引+积分计划按需求值`,
    };
  }
  return {
    design: 'materialized',
    reason: `预计事实量 ${factCount} 条，物化水库—时段平衡事实可让看板切换与相邻区间残差比对更快`,
  };
}

export async function createRun(params: CreateRunParams): Promise<BalanceRun> {
  const id = `run-${nowISO().replace(/[:.]/g, '-')}`;
  const run: BalanceRun = {
    id,
    name: params.name,
    cutoffAt: params.cutoffAt,
    gridStart: params.gridStart,
    gridEnd: params.gridEnd,
    gridStepSeconds: params.gridStepSeconds,
    tolerance: params.tolerance,
    pressureWindowSeconds: params.pressureWindowSeconds,
    decisionHorizonSeconds: params.decisionHorizonSeconds,
    reservoirIds: params.reservoirIds,
    status: 'running',
    design: params.design,
    createdAt: nowISO(),
    warnings: [],
  };

  // 锁定快照：截止点之后到达的读数一律不进本运行（迟到雨量在截止点后即被排除）
  const [allReservoirs, zones, curves, rules, riverSections, healthRecords, hydrologicRelations, tributaryConditions, conditionalRelations] = await Promise.all([
    getAllReservoirs(),
    getAllRainZones(),
    getAllCurves(),
    getAllRules(),
    getAllRiverSections(),
    getAllStationHealth(),
    getAllHydrologicRelations(),
    getAllTributaryConditions(),
    getAllConditionalRelations(),
  ]);
  const readings = await getReadingsForCutoff(params.cutoffAt);
  const totalReadings = await getAllReadings();
  const lateCount = totalReadings.length - readings.length;

  const snapshot: RunSnapshot = {
    runId: id,
    readings,
    curves,
    rules,
    reservoirs: allReservoirs.filter((r) => params.reservoirIds.includes(r.id)),
    zones,
    riverSections,
    healthRecords,
    hydrologicRelations,
    tributaryConditions,
    conditionalRelations,
    frozenAt: nowISO(),
  };

  await saveRun(run);
  await saveSnapshot(snapshot);
  if (lateCount > 0) {
    await saveRun({
      ...run,
      warnings: [`资料截止点 ${params.cutoffAt} 之后到达的读数 ${lateCount} 条已排除，可在后续运行纳入`],
    });
  }
  return run;
}

/** 启动 Worker 执行运行，返回取消函数 */
export function startRunWorker(
  runId: string,
  onProgress: (p: WorkerProgress) => void,
): () => void {
  const worker = new Worker(new URL('../workers/balance.worker.ts', import.meta.url), { type: 'module' });
  const req: WorkerRunRequest = { type: 'run', runId };
  worker.onmessage = (ev: MessageEvent<WorkerProgress>) => {
    onProgress(ev.data);
    if (ev.data.type === 'done' || ev.data.type === 'error') worker.terminate();
  };
  worker.onerror = (e) => {
    onProgress({ type: 'error', runId, message: e.message });
    worker.terminate();
  };
  worker.postMessage(req);
  return () => worker.terminate();
}

export interface OnDemandResult {
  facts: import('../types').BalanceFact[];
  indicators: import('../types').ReservoirIndicator[];
  riskSegments: import('../types').SectionRiskSegment[];
}

/**
 * 按需设计的下钻查询：不预落库，在 Worker 内用与物化运行完全相同的
 * 平衡方程/曲线版本/容差即时求值。
 */
export function queryOnDemand(runId: string): Promise<OnDemandResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/balance.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<WorkerProgress>) => {
      const p = ev.data;
      if (p.type === 'ondemand_result') {
        resolve({ facts: p.facts, indicators: p.indicators, riskSegments: p.riskSegments });
        worker.terminate();
      } else if (p.type === 'error') {
        reject(new Error(p.message));
        worker.terminate();
      }
    };
    worker.onerror = (e) => {
      reject(new Error(e.message));
      worker.terminate();
    };
    const req: WorkerRunRequest = { type: 'ondemand', runId };
    worker.postMessage(req);
  });
}
