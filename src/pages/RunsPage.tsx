import { useEffect, useState } from 'react';
import { getAllRuns, getAllReadings, getAllReservoirs } from '../db';
import { adviseDesign, createRun, startRunWorker } from '../services/runService';
import { RunStatusPill } from '../components/Pills';
import { formatHuman } from '../lib/time';
import { useAppState } from '../appState';
import type { BalanceRun } from '../types';
import type { WorkerProgress } from '../workers/balance.worker';
import { DEMO_CUTOFF_RUN1, DEMO_CUTOFF_RUN2 } from '../demo/demoData';

export default function RunsPage() {
  const { dataVersion, bumpData, selectedRunId, setSelectedRunId } = useAppState();
  const [runs, setRuns] = useState<BalanceRun[]>([]);
  const [reservoirCount, setReservoirCount] = useState(4);
  const [readingCount, setReadingCount] = useState(0);
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    name: '07-15 上午班运行',
    cutoffAt: DEMO_CUTOFF_RUN2,
    gridStart: '2026-07-15T00:00:00.000Z',
    gridEnd: '2026-07-15T06:00:00.000Z',
    gridStepSeconds: 3600,
    absTol: 20_000,
    relTol: 0.02,
    pressureWindowSeconds: 3 * 3600,
    decisionHorizonSeconds: 3600,
    design: 'materialized' as BalanceRun['design'],
    reservoirIds: ['qx', 'bs', 'df', 'xl'],
  });

  const refresh = async () => {
    const [rs, readings, reservoirs] = await Promise.all([getAllRuns(), getAllReadings(), getAllReservoirs()]);
    setRuns(rs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    setReadingCount(readings.length);
    setReservoirCount(reservoirs.length);
  };
  useEffect(() => { void refresh(); }, [dataVersion]);

  const intervalCount = Math.max(
    0,
    Math.round((Date.parse(form.gridEnd) - Date.parse(form.gridStart)) / (form.gridStepSeconds * 1000)),
  );
  const advice = adviseDesign(readingCount, intervalCount, form.reservoirIds.length);

  const onCreate = async () => {
    const run = await createRun({
      name: form.name,
      cutoffAt: form.cutoffAt,
      gridStart: form.gridStart,
      gridEnd: form.gridEnd,
      gridStepSeconds: form.gridStepSeconds,
      tolerance: { absM3: form.absTol, relFraction: form.relTol },
      pressureWindowSeconds: form.pressureWindowSeconds,
      decisionHorizonSeconds: form.decisionHorizonSeconds,
      reservoirIds: form.reservoirIds,
      design: form.design,
    });
    setProgress((p) => ({ ...p, [run.id]: '已锁定快照，Worker 排队中' }));
    startRunWorker(run.id, (msg: WorkerProgress) => {
      if (msg.type === 'progress') setProgress((p) => ({ ...p, [run.id]: msg.message }));
      if (msg.type === 'done') {
        setProgress((p) => ({ ...p, [run.id]: `完成：事实 ${msg.factCount} 条，待核指标 ${msg.pendingCount} 个，未闭合区间 ${msg.unclosedCount} 个，断面风险分段 ${msg.riskSegmentCount} 条` }));
        bumpData();
      }
      if (msg.type === 'error') setProgress((p) => ({ ...p, [run.id]: `失败：${msg.message}` }));
    });
    bumpData();
  };

  const toggleReservoir = (id: string) => setForm((f) => ({
    ...f,
    reservoirIds: f.reservoirIds.includes(id) ? f.reservoirIds.filter((x) => x !== id) : [...f.reservoirIds, id],
  }));

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>平衡运行台</h1>
          <div className="sub">固定资料截止点、曲线版本、容差与时间网格后形成不可变快照；看板与复盘只能读取同一运行结果，不直接读最新文件</div>
        </div>
      </div>

      <div className="card">
        <h2>新建运行</h2>
        <div className="form-row three">
          <label className="field">运行名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field">资料截止点（receivedAt ≤ 截止点才纳入）
            <input value={form.cutoffAt} onChange={(e) => setForm({ ...form, cutoffAt: e.target.value })} />
          </label>
          <label className="field">截止点预设
            <select value={form.cutoffAt} onChange={(e) => setForm({ ...form, cutoffAt: e.target.value })}>
              <option value={DEMO_CUTOFF_RUN1}>RUN1 06:30（迟到雨量 08:00 补传，被排除）</option>
              <option value={DEMO_CUTOFF_RUN2}>RUN2 09:30（迟到雨量已纳入）</option>
            </select>
          </label>
          <label className="field">网格起<input value={form.gridStart} onChange={(e) => setForm({ ...form, gridStart: e.target.value })} /></label>
          <label className="field">网格止<input value={form.gridEnd} onChange={(e) => setForm({ ...form, gridEnd: e.target.value })} /></label>
          <label className="field">网格步长（秒）
            <input type="number" value={form.gridStepSeconds} onChange={(e) => setForm({ ...form, gridStepSeconds: Number(e.target.value) })} />
          </label>
          <label className="field">绝对容差 m³<input type="number" value={form.absTol} onChange={(e) => setForm({ ...form, absTol: Number(e.target.value) })} /></label>
          <label className="field">相对容差（比例）<input type="number" step="0.005" value={form.relTol} onChange={(e) => setForm({ ...form, relTol: Number(e.target.value) })} /></label>
          <label className="field">来水压力窗口（秒）<input type="number" value={form.pressureWindowSeconds} onChange={(e) => setForm({ ...form, pressureWindowSeconds: Number(e.target.value) })} /></label>
          <label className="field">下一决策时点（秒）<input type="number" value={form.decisionHorizonSeconds} onChange={(e) => setForm({ ...form, decisionHorizonSeconds: Number(e.target.value) })} /></label>
          <label className="field">物化策略
            <select value={form.design} onChange={(e) => setForm({ ...form, design: e.target.value as BalanceRun['design'] })}>
              <option value="materialized">物化平衡事实（切换快、便于相邻残差比对）</option>
              <option value="on_demand">按需积分计划（省本地存储，首次查询较慢）</option>
            </select>
          </label>
        </div>
        <div className="banner info" style={{ marginBottom: 10 }}>
          设计建议（依据文件规模 {readingCount} 条读数 / 值班响应时限 / 复盘粒度，共 {intervalCount} 个网格区间 × {form.reservoirIds.length} 库）：
          <strong>{advice.design === 'materialized' ? '物化' : '按需'}</strong> —— {advice.reason}。两种设计调用同一平衡方程、版本与容差。
        </div>
        <div style={{ marginBottom: 10 }}>
          <span className="muted small">参与水库：</span>
          {[['qx', '青溪河'], ['bs', '白沙河'], ['df', '东风水库'], ['xl', '西岭']].map(([id, name]) => (
            <button
              key={id}
              className={`small ${form.reservoirIds.includes(id) ? 'primary' : ''}`}
              style={{ marginRight: 8 }}
              onClick={() => toggleReservoir(id)}
            >
              {name}
            </button>
          ))}
          <span className="muted small" style={{ marginLeft: 12 }}>当前库数 {reservoirCount}</span>
        </div>
        <button className="primary" onClick={() => void onCreate()} disabled={form.reservoirIds.length === 0}>锁定快照并在 WebWorker 中运行</button>
      </div>

      <div className="card">
        <h2>运行历史（{runs.length}）</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>运行</th><th>状态</th><th>截止点</th><th>时间网格</th><th>策略</th><th>统计</th><th>运行告警/进度</th><th>操作</th></tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="mono small">{r.id}</div>
                    <div>{r.name}</div>
                  </td>
                  <td><RunStatusPill status={r.status} /></td>
                  <td className="mono small">{formatHuman(r.cutoffAt)}</td>
                  <td className="mono small">{formatHuman(r.gridStart)} ~ {formatHuman(r.gridEnd)}<br />步长 {r.gridStepSeconds}s</td>
                  <td>{r.design === 'materialized' ? '物化' : '按需'}</td>
                  <td className="small">
                    {r.stats ? (
                      <>事实 <b>{r.stats.factCount}</b><br />待核 {r.stats.pendingCount} / 未闭合 {r.stats.unclosedCount}</>
                    ) : '—'}
                  </td>
                  <td className="small" style={{ maxWidth: 360 }}>
                    {progress[r.id] && <div className="progress-line">{progress[r.id]}</div>}
                    {r.warnings.slice(0, 3).map((w, i) => <div key={i} className="muted">• {w}</div>)}
                  </td>
                  <td>
                    <button
                      className={`small ${selectedRunId === r.id ? 'primary' : ''}`}
                      onClick={() => setSelectedRunId(r.id)}
                      disabled={r.status === 'running' || r.status === 'failed'}
                    >
                      {selectedRunId === r.id ? '已选为看板运行' : '选为看板运行'}
                    </button>
                  </td>
                </tr>
              ))}
              {runs.length === 0 && <tr><td colSpan={8} className="muted">尚无运行，请先在资料接入页播种数据后新建运行</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
