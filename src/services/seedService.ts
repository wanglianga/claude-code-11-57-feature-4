// 演示数据播种与 CSV 接入：保存原始读数、采样/接收时间、单位、质量标志与修订关系
import {
  clearAllData,
  getAllCurves,
  getAllReadings,
  importReadings,
  putConditionalRelation,
  putCurve,
  putHydrologicRelation,
  putRainStation,
  putRainZone,
  putReservoir,
  putRiverSection,
  putRule,
  putSourceFile,
  putStationHealth,
  putTributaryCondition,
  getSourceFiles,
} from '../db';
import { buildDemoDataset } from '../demo/demoData';
import { buildRiskDemoDataset } from '../demo/riskDemo';
import { nowISO } from '../lib/time';
import type { QualityFlag, RawReading, ReadingKind, SourceFileRecord } from '../types';

export async function isSeeded(): Promise<boolean> {
  return (await getAllReadings()).length > 0;
}

export async function seedDemoData(): Promise<{ readings: number; curves: number; rules: number }> {
  const data = buildDemoDataset();
  const risk = buildRiskDemoDataset();
  await clearAllData();
  for (const z of data.zones) await putRainZone(z);
  for (const z of risk.zones) await putRainZone(z);
  for (const s of data.stations) await putRainStation(s);
  for (const r of data.reservoirs) await putReservoir(r);
  for (const c of data.curves) await putCurve(c);
  for (const rule of data.rules) await putRule(rule);
  // 断面风险推导主数据
  for (const s of risk.sections) await putRiverSection(s);
  for (const h of risk.health) await putStationHealth(h);
  for (const rel of risk.relations) await putHydrologicRelation(rel);
  for (const trib of risk.tributaries) await putTributaryCondition(trib);
  for (const m of risk.conditionalRelations) await putConditionalRelation(m);
  const allReadings = [...data.readings, ...risk.readings];
  const file: SourceFileRecord = {
    id: 'seed-bundle',
    fileName: '演示数据集（内置播种）',
    kind: 'mixed',
    importedAt: nowISO(),
    readingCount: allReadings.length,
    byteSize: new Blob([JSON.stringify(allReadings)]).size,
    note: '含迟到雨量、跨库调水、曲线切换、断面故障、修订关系、大文件下钻，以及断面风险推导（故障/支流/罕见暴雨/恢复实测）场景',
  };
  const res = await importReadings(allReadings, file);
  for (const f of data.files) await putSourceFile(f);
  return { readings: res.imported, curves: data.curves.length, rules: data.rules.length };
}

// ---------- CSV 接入 --------

const VALID_KINDS: ReadingKind[] = [
  'rainfall', 'water_level', 'inflow', 'outflow', 'gate_opening',
  'gate_order', 'evaporation', 'diversion_in', 'diversion_out',
];
const VALID_QUALITY: QualityFlag[] = ['confirmed', 'estimated', 'suspect', 'missing', 'rejected'];

export interface CsvImportResult {
  imported: number;
  revisions: number;
  errors: string[];
  fileName: string;
}

/**
 * 解析并导入读数 CSV。表头（首行）：
 * kind,reservoirId,zoneId,sampledAt,intervalStart,receivedAt,value,unit,quality,revisionOf,uncertainty,note
 * value 为空或 MISSING 时按显式缺失保存（null），绝不补 0。
 */
export async function importCsv(fileName: string, text: string): Promise<CsvImportResult> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const errors: string[] = [];
  if (lines.length < 2) return { imported: 0, revisions: 0, errors: ['CSV 无数据行'], fileName };
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const readings: RawReading[] = [];
  const idByRowKey = new Map<string, string>();

  lines.slice(1).forEach((line, idx) => {
    const row = line;
    const cells = splitCsvLine(row);
    const get = (name: string) => cells[headers.indexOf(name)]?.trim() ?? '';
    const lineNo = idx + 2;
    const kind = get('kind') as ReadingKind;
    if (!VALID_KINDS.includes(kind)) {
      errors.push(`第 ${lineNo} 行：未知读数类型 ${kind || '(空)'}`);
      return;
    }
    const quality = (get('quality') || 'confirmed') as QualityFlag;
    if (!VALID_QUALITY.includes(quality)) {
      errors.push(`第 ${lineNo} 行：未知质量标志 ${quality}`);
      return;
    }
    const rawValue = get('value');
    const value = rawValue === '' || rawValue.toUpperCase() === 'MISSING' ? null : Number(rawValue);
    if (value !== null && Number.isNaN(value)) {
      errors.push(`第 ${lineNo} 行：数值无法解析 ${rawValue}`);
      return;
    }
    const sampledAt = get('sampledAt');
    if (!sampledAt) {
      errors.push(`第 ${lineNo} 行：缺少 sampledAt`);
      return;
    }
    const id = `csv-${fileName.replace(/[^a-z0-9]/gi, '-')}-${lineNo}-${idByRowKey.size}`;
    idByRowKey.set(String(lineNo), id);
    readings.push({
      id,
      kind,
      reservoirId: get('reservoirId') || undefined,
      zoneId: get('zoneId') || undefined,
      stationId: get('stationId') || undefined,
      sampledAt,
      intervalStart: get('intervalStart') || undefined,
      receivedAt: get('receivedAt') || sampledAt,
      value,
      unit: get('unit') || 'm3/s',
      quality,
      sourceFile: fileName,
      revisionOf: get('revisionOf') || undefined,
      uncertainty: get('uncertainty') ? Number(get('uncertainty')) : undefined,
      note: get('note') || undefined,
      createdAt: nowISO(),
    });
  });

  if (readings.length === 0) {
    return { imported: 0, revisions: 0, errors, fileName };
  }
  const fileRecord: SourceFileRecord = {
    id: `file-${nowISO().replace(/[:.]/g, '-')}`,
    fileName,
    kind: 'mixed',
    importedAt: nowISO(),
    readingCount: readings.length,
    byteSize: new Blob([text]).size,
  };
  const { imported, revisions } = await importReadings(readings, fileRecord);
  return { imported, revisions, errors, fileName };
}

/** 极简 CSV 行拆分，支持双引号包裹与转义 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export async function storageStats(): Promise<{ files: number; readings: number; curves: number }> {
  const [files, readings, curves] = await Promise.all([getSourceFiles(), getAllReadings(), getAllCurves()]);
  return { files: files.length, readings: readings.length, curves: curves.length };
}
