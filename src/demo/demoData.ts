// 演示数据集：覆盖六类验收场景
//  1) 迟到雨量：Z2 分区 05~06 时次接收时间晚于首个运行截止点
//  2) 跨库调水：青溪河调入、白沙河调出
//  3) 库容曲线切换：白沙河 03:00 起换用复核后的 v2 库容曲线
//  4) 断面故障：白沙河 04:00 入库断面缺失读数
//  5) 并发批注：见复盘页与 mergeAnnotationFields 单测
//  6) 大文件下钻：东风水库 5 天 10 分钟级流量序列
//  另含：雨量修订替代（非累加）、疑似水位偏差致残差超差、西岭水库无效曲线+规则重叠待核
import type {
  CurveVersion,
  DispatchRule,
  RainStation,
  RainZone,
  RawReading,
  Reservoir,
  SourceFileRecord,
} from '../types';

const DAY = '2026-07-15';
const hour = (h: number) => `${DAY}T${String(h).padStart(2, '0')}:00:00.000Z`;

export const DEMO_CUTOFF_RUN1 = `${DAY}T06:30:00.000Z`;
export const DEMO_CUTOFF_RUN2 = `${DAY}T09:30:00.000Z`;

export interface DemoDataset {
  reservoirs: Reservoir[];
  zones: RainZone[];
  stations: RainStation[];
  curves: CurveVersion[];
  rules: DispatchRule[];
  readings: RawReading[];
  files: SourceFileRecord[];
}

let seq = 0;
const rid = (prefix: string) => `${prefix}-${(seq += 1)}`;

function flowReading(
  reservoirId: string,
  kind: RawReading['kind'],
  sampledAt: string,
  value: number | null,
  quality: RawReading['quality'] = 'confirmed',
  extra: Partial<RawReading> = {},
): RawReading {
  return {
    id: rid('r'),
    reservoirId,
    kind,
    sampledAt,
    receivedAt: extra.receivedAt ?? sampledAt,
    value,
    unit: extra.unit ?? 'm3/s',
    quality,
    sourceFile: extra.sourceFile ?? 'flow-telemetry.csv',
    uncertainty: extra.uncertainty,
    note: extra.note,
    revisionOf: extra.revisionOf,
    supersededById: extra.supersededById,
    createdAt: '2026-07-15T00:05:00.000Z',
  };
}

function levelReading(reservoirId: string, sampledAt: string, value: number, extra: Partial<RawReading> = {}): RawReading {
  return {
    id: rid('r'),
    reservoirId,
    kind: 'water_level',
    sampledAt,
    receivedAt: extra.receivedAt ?? sampledAt,
    value,
    unit: 'm',
    quality: extra.quality ?? 'confirmed',
    sourceFile: extra.sourceFile ?? 'water-level.csv',
    uncertainty: extra.uncertainty,
    note: extra.note,
    createdAt: '2026-07-15T00:05:00.000Z',
  };
}

function zoneRain(
  zoneId: string,
  intervalStart: string,
  sampledAt: string,
  value: number | null,
  receivedAt: string,
  extra: Partial<RawReading> = {},
): RawReading {
  return {
    id: rid('r'),
    zoneId,
    kind: 'rainfall',
    sampledAt,
    intervalStart,
    receivedAt,
    value,
    unit: 'mm',
    quality: extra.quality ?? 'confirmed',
    sourceFile: extra.sourceFile ?? 'rain-gauge.csv',
    uncertainty: extra.uncertainty ?? 0.5,
    note: extra.note,
    revisionOf: extra.revisionOf,
    supersededById: extra.supersededById,
    createdAt: receivedAt,
  };
}

function evapReading(reservoirId: string, intervalStart: string, sampledAt: string, value: number): RawReading {
  return {
    id: rid('r'),
    reservoirId,
    kind: 'evaporation',
    sampledAt,
    intervalStart,
    receivedAt: sampledAt,
    value,
    unit: 'mm',
    quality: 'confirmed',
    sourceFile: 'evaporation.csv',
    uncertainty: 0.1,
    createdAt: '2026-07-15T00:05:00.000Z',
  };
}

export function buildDemoDataset(): DemoDataset {
  seq = 0;
  const readings: RawReading[] = [];

  const zones: RainZone[] = [
    { id: 'z1', name: '山区面雨量分区' },
    { id: 'z2', name: '平原面雨量分区' },
  ];
  const stations: RainStation[] = [
    { id: 'st1', name: '山区雨量站', zoneId: 'z1', lon: 118.62, lat: 30.24 },
    { id: 'st2', name: '平原雨量站', zoneId: 'z2', lon: 118.95, lat: 30.05 },
  ];
  const reservoirs: Reservoir[] = [
    { id: 'qx', name: '青溪河水库', lon: 118.78, lat: 30.18, rainWeights: [{ zoneId: 'z1', weight: 0.6 }, { zoneId: 'z2', weight: 0.4 }] },
    { id: 'bs', name: '白沙河水库', lon: 119.05, lat: 30.12, rainWeights: [{ zoneId: 'z1', weight: 0.5 }, { zoneId: 'z2', weight: 0.5 }] },
    { id: 'df', name: '东风水库', lon: 118.5, lat: 29.92, rainWeights: [{ zoneId: 'z1', weight: 1 }] },
    { id: 'xl', name: '西岭水库', lon: 119.2, lat: 30.3, rainWeights: [{ zoneId: 'z2', weight: 1 }] },
  ];

  // ---------- 曲线 ----------
  const curves: CurveVersion[] = [
    // 青溪河：库容斜率 1e6 m³/m；面积恒定 5e6 m² 保证闭合可复算
    {
      id: 'cv-qx-s1', reservoirId: 'qx', kind: 'storage', version: 'QX-S-2024', validFrom: '2024-01-01T00:00:00.000Z',
      approvalStatus: 'approved', approvedBy: '水文局-李', pointUnit: 'm3',
      points: [{ x: 100, y: 0 }, { x: 105, y: 5e6 }, { x: 110, y: 10e6 }, { x: 120, y: 20e6 }],
    },
    {
      id: 'cv-qx-a1', reservoirId: 'qx', kind: 'area', version: 'QX-A-2024', validFrom: '2024-01-01T00:00:00.000Z',
      approvalStatus: 'approved', approvedBy: '水文局-李', pointUnit: 'm2',
      points: [{ x: 100, y: 5e6 }, { x: 120, y: 5e6 }],
    },
    // 白沙河：03:00 切换库容曲线（断面复核后斜率 0.8e6 -> 0.88e6）
    {
      id: 'cv-bs-s1', reservoirId: 'bs', kind: 'storage', version: 'BS-S-2019', validFrom: '2019-01-01T00:00:00.000Z',
      validTo: '2026-07-15T03:00:00.000Z', approvalStatus: 'approved', approvedBy: '水文局-周', pointUnit: 'm3',
      points: [{ x: 100, y: 0 }, { x: 108, y: 6.4e6 }, { x: 120, y: 16e6 }],
    },
    {
      id: 'cv-bs-s2', reservoirId: 'bs', kind: 'storage', version: 'BS-S-2026', validFrom: '2026-07-15T03:00:00.000Z',
      approvalStatus: 'approved', approvedBy: '水文局-周', pointUnit: 'm3',
      points: [{ x: 100, y: 0 }, { x: 108, y: 7.04e6 }, { x: 120, y: 17.6e6 }],
      note: '库区地形复测后换版',
    },
    {
      id: 'cv-bs-a1', reservoirId: 'bs', kind: 'area', version: 'BS-A-2020', validFrom: '2020-01-01T00:00:00.000Z',
      approvalStatus: 'approved', approvedBy: '水文局-周', pointUnit: 'm2',
      points: [{ x: 100, y: 4e6 }, { x: 120, y: 4e6 }],
    },
    // 东风：大文件水库
    {
      id: 'cv-df-s1', reservoirId: 'df', kind: 'storage', version: 'DF-S-2023', validFrom: '2023-01-01T00:00:00.000Z',
      approvalStatus: 'approved', approvedBy: '水文局-吴', pointUnit: 'm3',
      points: [{ x: 80, y: 0 }, { x: 100, y: 30e6 }, { x: 120, y: 60e6 }],
    },
    {
      id: 'cv-df-a1', reservoirId: 'df', kind: 'area', version: 'DF-A-2023', validFrom: '2023-01-01T00:00:00.000Z',
      approvalStatus: 'approved', approvedBy: '水文局-吴', pointUnit: 'm2',
      points: [{ x: 80, y: 8e6 }, { x: 120, y: 8e6 }],
    },
    // 西岭：仅有草稿版曲线（无效）-> 指标待核
    {
      id: 'cv-xl-s1-draft', reservoirId: 'xl', kind: 'storage', version: 'XL-S-DRAFT', validFrom: '2026-01-01T00:00:00.000Z',
      approvalStatus: 'draft', pointUnit: 'm3',
      points: [{ x: 90, y: 0 }, { x: 110, y: 10e6 }],
      note: '待审批，不得用于运行换算',
    },
    {
      id: 'cv-xl-a1', reservoirId: 'xl', kind: 'area', version: 'XL-A-2025', validFrom: '2025-01-01T00:00:00.000Z',
      approvalStatus: 'approved', pointUnit: 'm2',
      points: [{ x: 90, y: 2e6 }, { x: 110, y: 2e6 }],
    },
  ];

  // ---------- 规则（西岭两条已审批且适用期重叠 -> 待核） ----------
  const rules: DispatchRule[] = [
    {
      id: 'rule-qx-1', reservoirId: 'qx', version: 'QX-RULE-2026', validFrom: '2026-06-01T00:00:00.000Z',
      approvalStatus: 'approved', approvedBy: '防办-郑', floodLimitStorage: 12e6, targetStorage: 10e6,
      downstreamMinRelease: 30, downstreamMaxRelease: 120,
    },
    {
      id: 'rule-bs-1', reservoirId: 'bs', version: 'BS-RULE-2026', validFrom: '2026-06-01T00:00:00.000Z',
      approvalStatus: 'approved', approvedBy: '防办-郑', floodLimitStorage: 9e6, targetStorage: 7.5e6,
      downstreamMinRelease: 20, downstreamMaxRelease: 90,
    },
    {
      id: 'rule-df-1', reservoirId: 'df', version: 'DF-RULE-2026', validFrom: '2026-06-01T00:00:00.000Z',
      approvalStatus: 'approved', approvedBy: '防办-郑', floodLimitStorage: 45e6, targetStorage: 38e6,
      downstreamMinRelease: 50, downstreamMaxRelease: 300,
    },
    {
      id: 'rule-xl-a', reservoirId: 'xl', version: 'XL-RULE-A', validFrom: '2026-06-01T00:00:00.000Z',
      approvalStatus: 'approved', approvedBy: '防办-郑', floodLimitStorage: 6e6, targetStorage: 5e6,
      downstreamMinRelease: 10, downstreamMaxRelease: 40,
    },
    {
      id: 'rule-xl-b', reservoirId: 'xl', version: 'XL-RULE-B', validFrom: '2026-07-01T00:00:00.000Z',
      approvalStatus: 'approved', approvedBy: '防办-郑', floodLimitStorage: 5.5e6, targetStorage: 4.8e6,
      downstreamMinRelease: 10, downstreamMaxRelease: 35,
      note: '与 A 版适用期重叠，待治理',
    },
  ];

  // ---------- 青溪河：6 个闭合小时区间 + 一处疑似水位偏差 ----------
  const QX_AREA = 5e6;
  for (let h = 0; h < 6; h += 1) {
    readings.push(flowReading('qx', 'inflow', hour(h), 100));
    readings.push(flowReading('qx', 'outflow', hour(h), 50));
    readings.push(flowReading('qx', 'diversion_in', hour(h), 20, 'confirmed', { sourceFile: 'diversion.csv' }));
    readings.push(evapReading('qx', hour(h), hour(h + 1), 0.2));
  }
  readings.push(flowReading('qx', 'inflow', hour(6), 100));
  readings.push(flowReading('qx', 'outflow', hour(6), 50));
  readings.push(flowReading('qx', 'diversion_in', hour(6), 20, 'confirmed', { sourceFile: 'diversion.csv' }));
  // 闸门开度与指令（证据留存，不直接进平衡方程）
  for (let h = 0; h <= 6; h += 1) {
    readings.push(flowReading('qx', 'gate_opening', hour(h), 2.5, 'confirmed', { unit: 'm', sourceFile: 'gate.csv', note: '2号孔开度2.5m' }));
    readings.push(flowReading('qx', 'gate_order', hour(h), 2.5, 'confirmed', { unit: 'm', sourceFile: 'gate-order.csv', note: '防办调度令' }));
  }

  // 分区雨量（小时区间，全局唯一序列，各水库按 rainWeights 共用；同分区不重复生成）
  for (let h = 0; h < 6; h += 1) {
    if (h === 1) {
      // 01~02 时次：先到 8mm，后修订为 12mm（替代而非累加）
      const old = zoneRain('z1', hour(1), hour(2), 8, hour(2), { note: '初报' });
      const rev = zoneRain('z1', hour(1), hour(2), 12, '2026-07-15T02:05:00.000Z', {
        revisionOf: old.id,
        note: '校核后修订',
      });
      old.supersededById = rev.id;
      readings.push(old, rev);
    } else {
      readings.push(zoneRain('z1', hour(h), hour(h + 1), 10, hour(h + 1)));
    }
    if (h === 5) {
      // 迟到雨量：05~06 时次 08:00 才接收到，晚于 RUN1 截止点
      readings.push(zoneRain('z2', hour(5), hour(6), 6, '2026-07-15T08:00:00.000Z', { note: '通信中断后补传' }));
    } else {
      readings.push(zoneRain('z2', hour(h), hour(h + 1), 5, hour(h + 1)));
    }
  }
  /** 取某小时分区雨量真值（修订后） */
  const z1ValAt = (h: number) => (h === 1 ? 12 : 10);
  const z2ValAt = (h: number) => (h === 5 ? 6 : 5);

  // 由平衡反推水位：ΔS = 净项；面积恒定，闭合
  let qxLevel = 105.0;
  const qxLevels: number[] = [qxLevel];
  for (let h = 0; h < 6; h += 1) {
    const rainMm = 0.6 * z1ValAt(h) + 0.4 * z2ValAt(h);
    const rainVol = (rainMm * QX_AREA) / 1000;
    const evapVol = (0.2 * QX_AREA) / 1000;
    const net = 100 * 3600 - 50 * 3600 + rainVol - evapVol + 20 * 3600;
    qxLevel += net / 1e6; // 斜率 1e6 m³/m
    qxLevels.push(qxLevel);
  }
  qxLevels.forEach((lv, h) => {
    const isSuspect = h === 2; // 02:00 人工校测疑似偏高 0.05m，制造 +50,000m³ 残差；最近3h窗口(03~06)仍可确认
    readings.push(
      levelReading('qx', hour(h), isSuspect ? lv + 0.05 : lv, isSuspect
        ? { quality: 'suspect', note: '人工校测疑似偏差，待核查', uncertainty: 0.05 }
        : {}),
    );
  });

  // ---------- 白沙河：曲线切换 + 断面故障 ----------
  const BS_AREA = 4e6;
  for (let h = 0; h <= 6; h += 1) {
    if (h === 4) {
      // 断面故障：04:00 入库流量显式缺失
      readings.push(flowReading('bs', 'inflow', hour(h), null, 'missing', { note: '入库断面设备故障', sourceFile: 'flow-telemetry.csv' }));
    } else {
      readings.push(flowReading('bs', 'inflow', hour(h), 80));
    }
    readings.push(flowReading('bs', 'outflow', hour(h), 60));
    readings.push(flowReading('bs', 'diversion_out', hour(h), 10, 'confirmed', { sourceFile: 'diversion.csv' }));
    if (h < 6) readings.push(evapReading('bs', hour(h), hour(h + 1), 0.2));
  }
  // 白沙河直接复用全局 z1/z2 分区雨量（权重各 0.5），不重复生成
  // 反推水位，03:00 前后按不同曲线斜率换算
  let bsStorage = 6.4e6; // 起始水位 108m，v1 曲线蓄水 6.4e6 m³
  const bsLevels: number[] = [108];
  for (let h = 0; h < 6; h += 1) {
    const bsRainMm = 0.5 * z1ValAt(h) + 0.5 * z2ValAt(h);
    const rainVol = (bsRainMm * BS_AREA) / 1000;
    const evapVol = (0.2 * BS_AREA) / 1000;
    // 故障区间仍用于生成水位真值，但运行时 03~04 区间因 04:00 缺测不可闭合
    const inVol = 80 * 3600;
    const net = inVol - 60 * 3600 + rainVol - evapVol - 10 * 3600;
    bsStorage += net;
    // 区间终点时刻的有效曲线决定水位换算
    const endHour = h + 1;
    const slope = endHour >= 3 ? 0.88e6 : 0.8e6;
    bsLevels.push(100 + bsStorage / slope);
  }
  bsLevels.forEach((lv, h) => readings.push(levelReading('bs', hour(h), lv)));

  // ---------- 西岭：最小数据，曲线无效 + 规则重叠 ----------
  for (let h = 0; h <= 6; h += 1) {
    readings.push(flowReading('xl', 'inflow', hour(h), 15));
    readings.push(flowReading('xl', 'outflow', hour(h), 12));
    readings.push(levelReading('xl', hour(h), 95 + h * 0.05));
  }
  for (let h = 0; h < 6; h += 1) readings.push(evapReading('xl', hour(h), hour(h + 1), 0.1));

  // ---------- 东风：5 天 10 分钟级流量 + 小时水位/雨量（大文件下钻） ----------
  const DF_START = Date.parse('2026-07-10T00:00:00.000Z');
  const TEN_MIN = 600;
  const HOUR = 3600;
  const DF_INTERVALS = 120; // 5 天 × 24 小时
  const dfLevelAt = (storage: number) => 80 + storage / 1.5e6; // 斜率 30e6/20m
  let dfStorage = 24e6;
  const dfLevelByHour = new Map<number, number>();
  dfLevelByHour.set(0, dfLevelAt(dfStorage));
  // 先生成完整 10 分钟级入库序列（含 120h 终点），水位真值按同一序列梯形积分反推，
  // 保证引擎积分结果与水位换算严格闭合（大文件下钻可复算）。
  const totalPoints = DF_INTERVALS * 6 + 1;
  const inflowSeries: number[] = [];
  for (let p = 0; p < totalPoints; p += 1) {
    const sec = p * TEN_MIN;
    inflowSeries.push(Math.round((120 + 40 * Math.sin(sec / 43200)) * 10) / 10);
  }
  // 起始水位读数（网格 t1）
  readings.push(levelReading('df', new Date(DF_START).toISOString(), dfLevelAt(dfStorage), { sourceFile: 'df-level.csv' }));
  for (let i = 0; i < DF_INTERVALS; i += 1) {
    // 每小时 6 个 10 分钟流量点（终点读数在下一小时首点，由 inflowSeries 提供）
    for (let k = 0; k < 6; k += 1) {
      const ts = new Date(DF_START + (i * 3600 + k * TEN_MIN) * 1000).toISOString();
      readings.push(flowReading('df', 'inflow', ts, inflowSeries[i * 6 + k], 'confirmed', { sourceFile: 'df-large-telemetry.csv' }));
      readings.push(flowReading('df', 'outflow', ts, 90, 'confirmed', { sourceFile: 'df-large-telemetry.csv' }));
    }
    const hourStart = new Date(DF_START + i * HOUR * 1000).toISOString();
    const hourEnd = new Date(DF_START + (i + 1) * HOUR * 1000).toISOString();
    const rainMm = i % 24 === 10 ? 3 : 0; // 每日 10 点一场雨
    readings.push(zoneRain('z1', hourStart, hourEnd, rainMm, hourEnd, { sourceFile: 'df-rain.csv' }));
    readings.push(evapReading('df', hourStart, hourEnd, 0.15));
    const rainVol = (rainMm * 8e6) / 1000;
    const evapVol = (0.15 * 8e6) / 1000;
    // 与引擎一致的 6 段梯形积分（每段 600s）
    let inVol = 0;
    for (let k = 0; k < 6; k += 1) {
      inVol += ((inflowSeries[i * 6 + k] + inflowSeries[i * 6 + k + 1]) / 2) * TEN_MIN;
    }
    const net = inVol - 90 * 3600 + rainVol - evapVol;
    dfStorage += net;
    dfLevelByHour.set(i + 1, dfLevelAt(dfStorage));
    readings.push(levelReading('df', hourEnd, dfLevelAt(dfStorage), { sourceFile: 'df-level.csv' }));
  }
  // 末刻流量终点读数（最后一个小时区间的 t2 边界）
  const dfEnd = new Date(DF_START + DF_INTERVALS * HOUR * 1000).toISOString();
  readings.push(flowReading('df', 'inflow', dfEnd, inflowSeries[totalPoints - 1], 'confirmed', { sourceFile: 'df-large-telemetry.csv' }));
  readings.push(flowReading('df', 'outflow', dfEnd, 90, 'confirmed', { sourceFile: 'df-large-telemetry.csv' }));

  const files: SourceFileRecord[] = [
    { id: 'f1', fileName: 'flow-telemetry.csv', kind: 'mixed', importedAt: '2026-07-15T06:35:00.000Z', readingCount: readings.filter((r) => r.sourceFile === 'flow-telemetry.csv').length, byteSize: 48213 },
    { id: 'f2', fileName: 'water-level.csv', kind: 'water_level', importedAt: '2026-07-15T06:35:00.000Z', readingCount: readings.filter((r) => r.sourceFile === 'water-level.csv').length, byteSize: 12044 },
    { id: 'f3', fileName: 'rain-gauge.csv', kind: 'rainfall', importedAt: '2026-07-15T08:05:00.000Z', readingCount: readings.filter((r) => r.sourceFile === 'rain-gauge.csv').length, byteSize: 9821 },
    { id: 'f4', fileName: 'diversion.csv', kind: 'mixed', importedAt: '2026-07-15T06:35:00.000Z', readingCount: readings.filter((r) => r.sourceFile === 'diversion.csv').length, byteSize: 3201 },
    { id: 'f5', fileName: 'gate.csv / gate-order.csv', kind: 'gate_opening', importedAt: '2026-07-15T06:35:00.000Z', readingCount: readings.filter((r) => r.sourceFile?.startsWith('gate')).length, byteSize: 2103 },
    { id: 'f6', fileName: 'evaporation.csv', kind: 'evaporation', importedAt: '2026-07-15T06:35:00.000Z', readingCount: readings.filter((r) => r.sourceFile === 'evaporation.csv').length, byteSize: 1876 },
    { id: 'f7', fileName: 'df-large-telemetry.csv', kind: 'inflow', importedAt: '2026-07-15T06:40:00.000Z', readingCount: readings.filter((r) => r.sourceFile === 'df-large-telemetry.csv').length, byteSize: 386_540 },
  ];

  return { reservoirs, zones, stations, curves, rules, readings, files };
}
