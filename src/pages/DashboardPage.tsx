import { useEffect, useMemo, useState } from 'react';
import {
  getAllRuns, getFactsByRun, getIndicatorsByRun, getSnapshot, getAllReservoirs,
} from '../db';
import { queryOnDemand } from '../services/runService';
import { StatusPill } from '../components/Pills';
import { formatHuman, formatRangeFlow, formatRangeM3 } from '../lib/formatters';
import { useAppState } from '../appState';
import MapView from '../components/MapView';
import IndicatorCharts from '../components/IndicatorCharts';
import BriefPanel from '../components/BriefPanel';
import type { BalanceFact, BalanceRun, Reservoir, ReservoirIndicator, RunSnapshot } from '../types';

export default function DashboardPage() {
  const { selectedRunId, setSelectedRunId, dataVersion } = useAppState();
  const [runs, setRuns] = useState<BalanceRun[]>([]);
  const [run, setRun] = useState<BalanceRun | null>(null);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [facts, setFacts] = useState<BalanceFact[]>([]);
  const [indicators, setIndicators] = useState<ReservoirIndicator[]>([]);
  const [reservoirs, setReservoirs] = useState<Reservoir[]>([]);
  const [selectedReservoir, setSelectedReservoir] = useState<string>('qx');
  const [loading, setLoading] = useState(false);
  const [loadNote, setLoadNote] = useState('');

  useEffect(() => {
    void (async () => {
      const rs = await getAllRuns();
      setRuns(rs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setReservoirs(await getAllReservoirs());
    })();
  }, [dataVersion]);

  const effectiveRunId = selectedRunId ?? runs.find((r) => r.status !== 'running' && r.status !== 'failed')?.id ?? null;

  useEffect(() => {
    if (!effectiveRunId) {
      setRun(null); setFacts([]); setIndicators([]); setSnapshot(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const r = runs.find((x) => x.id === effectiveRunId) ?? (await getAllRuns()).find((x) => x.id === effectiveRunId) ?? null;
      const snap = await getSnapshot(effectiveRunId);
      if (cancelled || !r || !snap) return;
      setRun(r);
      setSnapshot(snap);
      setLoading(true);
      if (r.design === 'materialized') {
        const [f, ind] = await Promise.all([getFactsByRun(effectiveRunId), getIndicatorsByRun(effectiveRunId)]);
        if (!cancelled) {
          setFacts(f); setIndicators(ind); setLoadNote('物化结果，读取本地平衡事实');
        }
      } else {
        setLoadNote('按需设计：Worker 即时积分求值（同一平衡方程/版本/容差），首次下钻稍慢');
        const res = await queryOnDemand(effectiveRunId);
        if (!cancelled) { setFacts(res.facts); setIndicators(res.indicators); }
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [effectiveRunId, runs]);

  const nameOf = (id: string) => reservoirs.find((r) => r.id === id)?.name ?? snapshot?.reservoirs.find((r) => r.id === id)?.name ?? id;
  const currentIndicator = indicators.find((i) => i.reservoirId === selectedReservoir) ?? null;
  const currentFacts = useMemo(
    () => facts.filter((f) => f.reservoirId === selectedReservoir).sort((a, b) => a.t1.localeCompare(b.t1)),
    [facts, selectedReservoir],
  );

  if (!effectiveRunId) {
    return (
      <div>
        <div className="page-head"><h1>调度看板</h1></div>
        <div className="banner info">尚无可用运行。请先到「平衡运行台」创建并完成一次运行；看板只发布锁定运行的数值、范围与未闭合原因，不直接读取最新文件。</div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>调度看板</h1>
          <div className="sub">
            运行 <span className="mono">{effectiveRunId}</span>
            {run ? `（截止点 ${formatHuman(run.cutoffAt)}，${run.design === 'materialized' ? '物化' : '按需'}，容差 绝对${run.tolerance.absM3}m³ / 相对${(run.tolerance.relFraction * 100).toFixed(2)}%）` : ''}
          </div>
        </div>
        <select value={effectiveRunId} onChange={(e) => setSelectedRunId(e.target.value)} style={{ maxWidth: 360 }}>
          {runs.map((r) => <option key={r.id} value={r.id} disabled={r.status === 'running' || r.status === 'failed'}>{r.name} — {r.id}</option>)}
        </select>
      </div>

      <div className="banner info">{loadNote}{loading ? '……计算中' : ''}。地图、图表、明细与简报共用同一运行结果。</div>

      <div className="grid cols-4">
        {indicators.map((ind) => (
          <div key={ind.id} className={`kpi clickable ${selectedReservoir === ind.reservoirId ? 'selected' : ''}`} onClick={() => setSelectedReservoir(ind.reservoirId)}>
            <div className="label" style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{nameOf(ind.reservoirId)}</span><StatusPill status={ind.marginStatus} />
            </div>
            <div className="value" style={{ fontSize: 17 }}>
              余量 {ind.floodMargin === null ? '待核' : formatRangeM3([ind.floodMargin, ind.floodMargin]).replace(/\[|\]/g, '')}
            </div>
            <div className="sub">
              压力 {ind.pressureRatio === null ? '待核' : ind.pressureRatio.toFixed(2)}
              {ind.pressureRatioRange[0] !== null && `（${ind.pressureRatioRange.map((x) => (x as number).toFixed(2)).join('~')}）`}
            </div>
          </div>
        ))}
      </div>

      <div className="two-col mt16">
        <div className="card">
          <h2>水库分布（颜色＝防洪余量状态，点击切换）</h2>
          <MapView
            reservoirs={snapshot?.reservoirs ?? reservoirs}
            statusOf={(id) => indicators.find((i) => i.reservoirId === id)?.marginStatus ?? 'pending'}
            selectedId={selectedReservoir}
            onSelect={setSelectedReservoir}
          />
        </div>
        <div className="card">
          <h2>{nameOf(selectedReservoir)} · 三类指标</h2>
          {currentIndicator ? (
            <>
              <h3>防洪余量 ＝ 汛限库容 − 已确认蓄水量</h3>
              <div className="small">
                当前蓄水 <b>{currentIndicator.currentStorage?.toLocaleString() ?? '—'}</b> m³；
                汛限 <b>{currentIndicator.floodLimitStorage?.toLocaleString() ?? '—'}</b> m³；
                余量 <b>{currentIndicator.floodMargin?.toLocaleString() ?? '待核'}</b> m³
              </div>
              <h3>近期来水压力（窗口 {(currentIndicator.windowSeconds / 3600).toFixed(0)} 小时）</h3>
              <div className="small">
                可确认净入库 <b>{formatRangeM3(currentIndicator.netInflowConfirmed === null ? null : [currentIndicator.netInflowConfirmed, currentIndicator.netInflowConfirmed])}</b>
                ；未知范围 <b>{formatRangeM3(currentIndicator.netInflowUnknownRange)}</b><br />
                压力比 <b>{currentIndicator.pressureRatio?.toFixed(3) ?? '待核'}</b>
                ；区间 {currentIndicator.pressureRatioRange[0] === null ? '待核' : `[${(currentIndicator.pressureRatioRange[0] as number).toFixed(3)}, ${(currentIndicator.pressureRatioRange[1] as number).toFixed(3)}]`}
              </div>
              <h3>泄洪空间（延续至下一决策时点回到目标库容）</h3>
              <div className="small">
                所需出库 {formatRangeFlow(currentIndicator.releaseNeededRange)}<br />
                下游允许 {currentIndicator.downstreamAllowableRange ? `[${currentIndicator.downstreamAllowableRange.join(', ')}] m³/s` : '待核'}<br />
                差额（正＝允许泄流不足）{formatRangeFlow(currentIndicator.releaseGapRange)}
              </div>
              {currentIndicator.pending && (
                <>
                  <h3>未闭合/待核原因</h3>
                  <ul className="reason-list">{currentIndicator.pendingReasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                </>
              )}
            </>
          ) : <div className="muted">加载中或该水库未参与本运行</div>}
        </div>
      </div>

      <div className="card mt16">
        <h2>{nameOf(selectedReservoir)} · 过程图表</h2>
        <IndicatorCharts facts={currentFacts} />
      </div>

      <div className="card">
        <h2>指标明细（同一运行）</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>水库</th><th>状态</th><th className="num">当前蓄水 m³</th><th className="num">防洪余量 m³</th>
                <th className="num">净入库 m³</th><th className="num">压力比(范围)</th>
                <th className="num">所需出库 m³/s</th><th className="num">泄流差额 m³/s</th><th>待核原因</th>
              </tr>
            </thead>
            <tbody>
              {indicators.map((ind) => (
                <tr key={ind.id}>
                  <td><a onClick={() => setSelectedReservoir(ind.reservoirId)} style={{ cursor: 'pointer' }}>{nameOf(ind.reservoirId)}</a></td>
                  <td><StatusPill status={ind.marginStatus} /></td>
                  <td className="num">{ind.currentStorage?.toLocaleString() ?? '—'}</td>
                  <td className="num">{ind.floodMargin?.toLocaleString() ?? '待核'}</td>
                  <td className="num">{ind.netInflowConfirmed?.toLocaleString() ?? '待核'}</td>
                  <td className="num">
                    {ind.pressureRatio === null ? '待核' : ind.pressureRatio.toFixed(2)}
                    {ind.pressureRatioRange[0] !== null && <span className="muted"> ({(ind.pressureRatioRange[0] as number).toFixed(2)}~{(ind.pressureRatioRange[1] as number).toFixed(2)})</span>}
                  </td>
                  <td className="num">{formatRangeFlow(ind.releaseNeededRange)}</td>
                  <td className="num">{formatRangeFlow(ind.releaseGapRange)}</td>
                  <td className="small" style={{ maxWidth: 320 }}>{ind.pending ? ind.pendingReasons.slice(0, 2).join('；') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {run && <BriefPanel run={run} indicators={indicators} facts={facts} nameOf={nameOf} />}
    </div>
  );
}
