// 断面风险范围推导演示数据集
// 验收四类样例（全部落在默认运行网格 00:00~06:00 内）：
//  1) 故障（白沙河承压断面 sec-b 03:00~05:00 传感器故障，校准到期）
//  2) 支流汇入（sec-b 闸控无测站支流 03~05 时活跃；sec-c 全日有界巡测支流）
//  3) 罕见暴雨（04~05 时面雨强 9mm/h，超出 sec-c 条件关系训练包络，回退工程界）
//  4) 恢复实测（sec-b 05:00、sec-c 06:00 恢复，重叠区间待复核并另起风险版本；
//     sec-d 04:00 起开放故障、关系仅草稿，持续不可判定）
// 另含 5 天（120 组）双站同步完好历史，供条件关系 OLS 拟合与残差预测带估计。
import type {
  ConditionalRelation,
  HydrologicRelation,
  ISOTime,
  QualityFlag,
  RainZone,
  RawReading,
  RiverSection,
  StationHealthRecord,
  TributaryCondition,
} from '../types';
import { fitConditionalRelation } from '../lib/riskRange';

const HIST_START = '2026-07-10T00:00:00.000Z';
const DAY = '2026-07-15';
const hour = (h: number): ISOTime => `${DAY}T${String(h).padStart(2, '0')}:00:00.000Z`;
const HOUR_MS = 3600_000;

export interface RiskDemoDataset {
  zones: RainZone[];
  sections: RiverSection[];
  health: StationHealthRecord[];
  relations: HydrologicRelation[];
  tributaries: TributaryCondition[];
  conditionalRelations: ConditionalRelation[];
  readings: RawReading[];
}

let seq = 0;
const rid = (prefix: string) => `${prefix}-${(seq += 1)}`;

function sectionReading(
  stationId: string,
  kind: RawReading['kind'],
  sampledAt: string,
  value: number | null,
  quality: QualityFlag,
  unit: string,
  sourceFile: string,
  extra: Partial<RawReading> = {},
): RawReading {
  return {
    id: rid('rr'),
    stationId,
    kind,
    sampledAt,
    receivedAt: extra.receivedAt ?? sampledAt,
    intervalStart: extra.intervalStart,
    value,
    unit,
    quality,
    sourceFile,
    uncertainty: extra.uncertainty,
    note: extra.note,
    createdAt: '2026-07-15T00:05:00.000Z',
  };
}

// 五个断面/分区常量
const SEC_A = 'sec-a';
const SEC_B = 'sec-b';
const SEC_C = 'sec-c';
const SEC_D = 'sec-d';

export function buildRiskDemoDataset(): RiskDemoDataset {
  seq = 0;
  const readings: RawReading[] = [];

  const zones: RainZone[] = [{ id: 'z3', name: '下游河道面雨量分区' }];

  const sections: RiverSection[] = [
    { id: SEC_A, name: '青溪上游断面', lon: 118.72, lat: 30.2, metric: 'flow', unit: 'm3/s', bearingLimit: 240, warningLimit: 200 },
    { id: SEC_B, name: '白沙河承压断面', lon: 119.02, lat: 30.1, metric: 'flow', unit: 'm3/s', bearingLimit: 170, warningLimit: 145 },
    { id: SEC_C, name: '支流汇合口断面', lon: 119.12, lat: 30.06, metric: 'flow', unit: 'm3/s', bearingLimit: 200, warningLimit: 170 },
    { id: SEC_D, name: '西岭回水断面', lon: 119.18, lat: 30.28, metric: 'water_level', unit: 'm', bearingLimit: 46.5, warningLimit: 45.0 },
  ];

  const relations: HydrologicRelation[] = [
    {
      id: 'rel-a-b', targetSectionId: SEC_B, referenceSectionId: SEC_A, approvalStatus: 'approved', approvedBy: '水文局-李',
      travelTimeMinSeconds: 3000, travelTimeMaxSeconds: 3600,
      attenuationMin: 0.88, attenuationMax: 0.98, backwaterWiden: 6, calibrationRelax: 0.1,
      note: '工程批准：青溪上游→白沙河承压断面传播约 50~60 分钟',
    },
    {
      id: 'rel-a-c', targetSectionId: SEC_C, referenceSectionId: SEC_A, approvalStatus: 'approved', approvedBy: '水文局-李',
      travelTimeMinSeconds: 5400, travelTimeMaxSeconds: 7200,
      attenuationMin: 0.82, attenuationMax: 1.0, backwaterWiden: 4, calibrationRelax: 0.1,
      note: '干流传播 90~120 分钟；sec-a 同时支撑 sec-b/sec-c，非独立证据',
    },
    {
      id: 'rel-b-c', targetSectionId: SEC_C, referenceSectionId: SEC_B, approvalStatus: 'approved', approvedBy: '水文局-周',
      travelTimeMinSeconds: 1800, travelTimeMaxSeconds: 2400,
      attenuationMin: 0.9, attenuationMax: 1.0, backwaterWiden: 3, calibrationRelax: 0.1,
      note: '承压断面→汇合口传播 30~40 分钟',
    },
    {
      id: 'rel-a-d-draft', targetSectionId: SEC_D, referenceSectionId: SEC_A, approvalStatus: 'draft',
      travelTimeMinSeconds: 7200, travelTimeMaxSeconds: 10800,
      attenuationMin: 0.95, attenuationMax: 1.05, backwaterWiden: 0.5, calibrationRelax: 0.15,
      note: '回水断面水位关系尚未率定批准，不得用于推导',
    },
  ];

  const tributaries: TributaryCondition[] = [
    {
      id: 'trib-b', targetSectionId: SEC_B, name: '白沙河左岸无测站支流',
      activeFrom: hour(3), activeTo: hour(5),
      contributionRange: [8, 20], ungaged: true,
      note: '闸门 03:00 起开启分洪，05:00 关闭；无测站只能给工程界',
    },
    {
      id: 'trib-c', targetSectionId: SEC_C, name: '汇合口巡测支流',
      activeFrom: hour(0),
      contributionRange: [5, 12], ungaged: false,
      note: '有巡测资料，贡献界经工程核定',
    },
  ];

  const health: StationHealthRecord[] = [
    {
      id: 'health-b', sectionId: SEC_B, faultStart: hour(3), faultEnd: hour(5),
      reason: '传感器探头堵塞，数据显式缺失', calibration: 'due',
      availableNeighborIds: [SEC_A], recoveredReadingAt: hour(5),
      reviewNote: '恢复首值与替代推导重叠，待人工复核',
    },
    {
      id: 'health-c', sectionId: SEC_C, faultStart: hour(4), faultEnd: hour(6),
      reason: '遥测终端通信故障', calibration: 'calibrated',
      availableNeighborIds: [SEC_A, SEC_B], recoveredReadingAt: hour(6),
      reviewNote: '通信恢复后首条实测待复核',
    },
    {
      id: 'health-d', sectionId: SEC_D, faultStart: hour(4),
      reason: '水位计遭雷击损毁，截至运行截止点未恢复', calibration: 'uncalibrated',
      availableNeighborIds: [SEC_A],
      reviewNote: '唯一水文关系尚为草稿，持续不可判定',
    },
  ];

  // ---------------- 5 天同步完好历史（120 个小时点） ----------------
  const historyA: number[] = [];
  const historyB: number[] = [];
  const historyC: number[] = [];
  const historyD: number[] = [];
  const historyRain: number[] = [];
  const samplesB: Parameters<typeof fitConditionalRelation>[0]['samples'] = [];
  const samplesC: typeof samplesB = [];

  for (let h = 0; h < 120; h += 1) {
    const at = new Date(Date.parse(HIST_START) + h * HOUR_MS).toISOString();
    const a = Math.round((120 + 25 * Math.sin((2 * Math.PI * h) / 24)) * 10) / 10;
    const noiseB = 2.5 * Math.sin(h * 1.7) + 1.8 * Math.sin(h * 0.6);
    const noiseC = 3.0 * Math.sin(h * 1.1 + 2) + 1.5 * Math.sin(h * 0.4);
    const b = Math.round((0.9 * a + 8 + noiseB) * 10) / 10;
    const c = Math.round((0.85 * a + 12 + noiseC) * 10) / 10;
    const d = Math.round((42 + (a - 120) / 30 + 0.12 * Math.sin(h * 1.3 + 1)) * 100) / 100;
    const rain = h % 24 === 10 ? 6 : 1;
    historyA.push(a); historyB.push(b); historyC.push(c); historyD.push(d); historyRain.push(rain);

    readings.push(sectionReading(SEC_A, 'inflow', at, a, 'confirmed', 'm3/s', 'risk-history.csv'));
    readings.push(sectionReading(SEC_B, 'inflow', at, b, 'confirmed', 'm3/s', 'risk-history.csv'));
    readings.push(sectionReading(SEC_C, 'inflow', at, c, 'confirmed', 'm3/s', 'risk-history.csv'));
    readings.push(sectionReading(SEC_D, 'water_level', at, d, 'confirmed', 'm', 'risk-history.csv'));
    readings.push(sectionReading(SEC_B, 'gate_opening', at, 1.8, 'confirmed', 'm', 'risk-history.csv'));
    readings.push(sectionReading(SEC_C, 'gate_opening', at, 1.5, 'confirmed', 'm', 'risk-history.csv'));
    readings.push(sectionReading(SEC_D, 'gate_opening', at, 1.6, 'confirmed', 'm', 'risk-history.csv'));
    readings.push(sectionReading(
      'z3', 'rainfall', new Date(Date.parse(at) + HOUR_MS).toISOString(), rain, 'confirmed', 'mm', 'risk-history.csv',
      { intervalStart: at, uncertainty: 0.5 },
    ));
    samplesB.push({ at, referenceValue: a, targetValue: b, rainIntensity: rain, gateState: 'regulated' });
    samplesC.push({ at, referenceValue: a, targetValue: c, rainIntensity: rain, gateState: 'regulated' });
  }

  // 条件关系：sec-b 工程包络经批准扩展（覆盖泄洪闸门工况与中等雨势）；
  // sec-c 包络不取扩展，罕见暴雨/超量纲参考值时必须失配回退工程界。
  const modelB = fitConditionalRelation({
    id: 'cond-a-b', targetSectionId: SEC_B, referenceSectionId: SEC_A, samples: samplesB,
    environment: { rainIntensityRange: [0, 12], gateStates: ['regulated', 'open'], monthRange: [6, 9] },
    envelopeOverrides: {
      rainRange: [0, 12],
      referenceRange: [90, 200],
      gateStates: ['regulated', 'open'],
      monthRange: [6, 9],
    },
    note: '120 组同步完好样本拟合；工程批准扩展包络覆盖泄洪工况',
  });
  const modelC = fitConditionalRelation({
    id: 'cond-a-c', targetSectionId: SEC_C, referenceSectionId: SEC_A, samples: samplesC,
    environment: { rainIntensityRange: [1, 6], gateStates: ['regulated'], monthRange: [6, 9] },
    // 参考值包络经工程扩展，但雨强包络刻意收紧：罕见暴雨（9mm/h）必然失配回退工程界
    envelopeOverrides: {
      rainRange: [1, 6],
      referenceRange: [90, 200],
      gateStates: ['regulated'],
      monthRange: [6, 9],
    },
    note: '120 组同步完好样本拟合；雨强包络不扩展，罕见暴雨自动失配',
  });
  const conditionalRelations = [modelB, modelC].filter((m): m is ConditionalRelation => m !== null);

  // ---------------- 7-15 故障当天序列（h=0..6，默认运行网格 00:00~06:00） ----------------
  // 参考站 sec-a 全程完好；数值按条件模型 target≈0.9a+8 与目标分类反推。
  const scenarioA = [125, 132, 142, 155, 195, 180, 170];
  // sec-b：04/05 时故障显式缺失（faultStart=04:00），06 时恢复实测
  const scenarioB: (number | null)[] = [120, 126, 135, 148, null, null, 166];
  // sec-c：05 时故障，06 时恢复；罕见暴雨落在 [04,05) 推导区间
  const scenarioC: (number | null)[] = [118, 124, 132, 143, 158, null, 185];
  // sec-d：04 时起开放故障，唯一关系为草稿 → 持续不可判定
  const scenarioD: (number | null)[] = [42.15, 42.33, 42.6, 43.5, null, null, null];
  // 小时区间雨强（读数时刻 h 覆盖 [h-1,h)）：04~05 时 9mm/h 罕见暴雨
  const scenarioRain = [undefined, 1, 1, 1, 4, 9, 7];

  for (let h = 0; h <= 6; h += 1) {
    const at = hour(h);
    readings.push(sectionReading(SEC_A, 'inflow', at, scenarioA[h], 'confirmed', 'm3/s', 'risk-telemetry.csv'));

    const bVal = scenarioB[h];
    if (bVal === null) {
      readings.push(sectionReading(SEC_B, 'inflow', at, null, 'missing', 'm3/s', 'risk-telemetry.csv', { note: '传感器探头故障' }));
    } else {
      readings.push(sectionReading(SEC_B, 'inflow', at, bVal, 'confirmed', 'm3/s', 'risk-telemetry.csv'));
    }
    const cVal = scenarioC[h];
    if (cVal === null) {
      readings.push(sectionReading(SEC_C, 'inflow', at, null, 'missing', 'm3/s', 'risk-telemetry.csv', { note: '通信故障' }));
    } else {
      readings.push(sectionReading(SEC_C, 'inflow', at, cVal, 'confirmed', 'm3/s', 'risk-telemetry.csv'));
    }
    const dVal = scenarioD[h];
    if (dVal === null) {
      readings.push(sectionReading(SEC_D, 'water_level', at, null, 'missing', 'm', 'risk-telemetry.csv', { note: '雷击损毁未恢复' }));
    } else {
      readings.push(sectionReading(SEC_D, 'water_level', at, dVal, 'confirmed', 'm', 'risk-telemetry.csv'));
    }

    // 闸门：sec-b 03 时起加大泄洪（open），其余断面维持 regulated
    readings.push(sectionReading(SEC_B, 'gate_opening', at, h >= 3 ? 3.0 : 1.8, 'confirmed', 'm', 'risk-telemetry.csv'));
    readings.push(sectionReading(SEC_C, 'gate_opening', at, 1.5, 'confirmed', 'm', 'risk-telemetry.csv'));
    readings.push(sectionReading(SEC_D, 'gate_opening', at, 1.6, 'confirmed', 'm', 'risk-telemetry.csv'));

    // z3 面雨量小时区间
    if (h > 0) {
      const rain = scenarioRain[h] as number;
      readings.push(sectionReading(
        'z3', 'rainfall', at, rain, 'confirmed', 'mm', 'risk-telemetry.csv',
        { intervalStart: hour(h - 1), uncertainty: 0.5, note: rain >= 9 ? '罕见暴雨' : undefined },
      ));
    }
  }

  return { zones, sections, health, relations, tributaries, conditionalRelations, readings };
}
