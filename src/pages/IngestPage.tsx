import { useEffect, useMemo, useRef, useState } from 'react';
import { getAllReadings, getSourceFiles } from '../db';
import { importCsv, seedDemoData, storageStats } from '../services/seedService';
import { formatHuman } from '../lib/time';
import { QualityPill } from '../components/Pills';
import { useAppState } from '../appState';
import type { RawReading, SourceFileRecord } from '../types';

const KIND_LABEL: Record<string, string> = {
  rainfall: '雨量', water_level: '水位', inflow: '入库流量', outflow: '出库流量',
  gate_opening: '闸门开度', gate_order: '闸门指令', evaporation: '蒸发',
  diversion_in: '跨库调入', diversion_out: '跨库调出',
};

export default function IngestPage() {
  const { dataVersion, bumpData } = useAppState();
  const [readings, setReadings] = useState<RawReading[]>([]);
  const [files, setFiles] = useState<SourceFileRecord[]>([]);
  const [stats, setStats] = useState({ files: 0, readings: 0, curves: 0 });
  const [filter, setFilter] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [msg, setMsg] = useState<{ cls: string; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    const [rs, fs, st] = await Promise.all([getAllReadings(), getSourceFiles(), storageStats()]);
    setReadings(rs.sort((a, b) => b.sampledAt.localeCompare(a.sampledAt)));
    setFiles(fs);
    setStats(st);
  };

  useEffect(() => { void refresh(); /* dataVersion 触发刷新 */ }, [dataVersion]);

  const filtered = useMemo(() => readings.filter((r) => {
    if (kindFilter && r.kind !== kindFilter) return false;
    if (!filter) return true;
    return [r.id, r.reservoirId ?? '', r.zoneId ?? '', r.sourceFile, r.note ?? ''].some((s) => s.includes(filter));
  }), [readings, filter, kindFilter]);

  const onSeed = async () => {
    const res = await seedDemoData();
    setMsg({ cls: 'ok', text: `播种完成：${res.readings} 条读数、${res.curves} 条曲线、${res.rules} 条规则` });
    bumpData();
  };

  const onFiles = async (list: FileList | null) => {
    if (!list) return;
    let total = 0;
    const allErrors: string[] = [];
    for (const f of Array.from(list)) {
      const text = await f.text();
      const res = await importCsv(f.name, text);
      total += res.imported;
      allErrors.push(...res.errors.map((e) => `[${f.name}] ${e}`));
    }
    setMsg(allErrors.length
      ? { cls: 'warn', text: `导入 ${total} 条；${allErrors.length} 条问题：${allErrors.slice(0, 3).join('；')}` }
      : { cls: 'ok', text: `成功导入 ${total} 条读数，修订关系已建立` });
    bumpData();
    if (fileRef.current) fileRef.current.value = '';
  };

  const lateCount = readings.filter((r) => r.receivedAt > r.sampledAt).length;
  const revisedCount = readings.filter((r) => r.supersededById).length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>资料接入</h1>
          <div className="sub">原始读数、采样/接收时间、单位、质量标志与修订关系；显式缺失不补零，重叠雨量按修订替代</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="primary" onClick={onSeed}>播种内置演示数据集</button>
          <button onClick={() => fileRef.current?.click()}>导入 CSV</button>
          <input ref={fileRef} type="file" accept=".csv" multiple hidden onChange={(e) => void onFiles(e.target.files)} />
        </div>
      </div>

      {msg && <div className={`banner ${msg.cls}`}>{msg.text}</div>}

      <div className="grid cols-4">
        <div className="kpi"><div className="label">读数总数</div><div className="value">{stats.readings}</div></div>
        <div className="kpi"><div className="label">来源文件</div><div className="value">{stats.files}</div></div>
        <div className="kpi"><div className="label">迟到读数（接收晚于采样）</div><div className="value">{lateCount}</div><div className="sub">由资料截止点决定是否纳入运行</div></div>
        <div className="kpi"><div className="label">被修订替代的读数</div><div className="value">{revisedCount}</div><div className="sub">替代而非累加</div></div>
      </div>

      <div className="card mt16">
        <h2>来源文件登记</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>文件</th><th>类型</th><th className="num">读数条数</th><th className="num">大小(B)</th><th>导入时间</th><th>备注</th></tr></thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.id}>
                  <td className="mono">{f.fileName}</td>
                  <td>{KIND_LABEL[f.kind] ?? f.kind}</td>
                  <td className="num">{f.readingCount}</td>
                  <td className="num">{f.byteSize.toLocaleString()}</td>
                  <td>{formatHuman(f.importedAt)}</td>
                  <td className="muted small">{f.note ?? '—'}</td>
                </tr>
              ))}
              {files.length === 0 && <tr><td colSpan={6} className="muted">暂无文件，点击右上角播种演示数据</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>原始读数（{filtered.length}）</h2>
        <div className="form-row" style={{ marginBottom: 12 }}>
          <input placeholder="按读数ID/水库/分区/文件名/备注过滤" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
            <option value="">全部类型</option>
            {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="table-wrap" style={{ maxHeight: 520 }}>
          <table>
            <thead>
              <tr>
                <th>读数ID</th><th>类型</th><th>水库/分区</th><th>采样时间</th><th>接收时间</th>
                <th className="num">数值</th><th>单位</th><th>质量</th><th>修订关系</th><th>来源/备注</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 500).map((r) => (
                <tr key={r.id}>
                  <td className="mono small">{r.id}</td>
                  <td>{KIND_LABEL[r.kind]}</td>
                  <td>{r.reservoirId ?? r.zoneId ?? '—'}</td>
                  <td className="mono small">{formatHuman(r.sampledAt)}</td>
                  <td className="mono small">
                    {formatHuman(r.receivedAt)}
                    {new Date(r.receivedAt) > new Date(r.sampledAt) && <span className="pill warn" style={{ marginLeft: 6 }}>迟到</span>}
                  </td>
                  <td className="num">{r.value === null ? <span className="pill danger">NULL</span> : r.value}</td>
                  <td>{r.unit}</td>
                  <td><QualityPill quality={r.quality} /></td>
                  <td className="small">
                    {r.supersededById && <div><span className="pill neutral">已被 {r.supersededById.slice(-6)} 替代</span></div>}
                    {r.revisionOf && <div><span className="pill info">修订 {r.revisionOf.slice(-6)}</span></div>}
                    {!r.supersededById && !r.revisionOf && '—'}
                  </td>
                  <td className="muted small">{r.sourceFile}{r.note ? `：${r.note}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length > 500 && <div className="muted small mt8">仅展示前 500 条，请使用过滤条件定位</div>}
      </div>

      <div className="card">
        <h2>CSV 接入格式</h2>
        <pre className="code-block">{`kind,reservoirId,zoneId,sampledAt,intervalStart,receivedAt,value,unit,quality,revisionOf,uncertainty,note
rainfall,,z2,2026-07-15T06:00:00.000Z,2026-07-15T05:00:00.000Z,2026-07-15T08:00:00.000Z,6,mm,confirmed,,0.5,通信中断后补传
inflow,bs,,2026-07-15T04:00:00.000Z,,,MISSING,m3/s,missing,,,,断面设备故障
water_level,qx,,2026-07-15T02:00:00.000Z,,,107.42,m,suspect,,,,人工校测疑似偏差`}</pre>
      </div>
    </div>
  );
}
