import { useEffect, useMemo, useState } from 'react';
import {
  getAllRuns, getFactsByRun, getIndicatorsByRun, getSnapshot,
} from '../db';
import { queryOnDemand } from '../services/runService';
import { QualityPill, StatusPill } from '../components/Pills';
import AnnotationPanel from '../components/AnnotationPanel';
import { formatHuman } from '../lib/time';
import { formatM3 } from '../lib/units';
import type {
  BalanceFact, BalanceRun, RawReading, ReservoirIndicator, RunSnapshot,
} from '../types';

export default function ReviewPage() {
  const [runs, setRuns] = useState<BalanceRun[]>([]);
  const [runId, setRunId] = useState('');
  const [run, setRun] = useState<BalanceRun | null>(null);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [facts, setFacts] = useState<BalanceFact[]>([]);
  const [indicators, setIndicators] = useState<ReservoirIndicator[]>([]);
  const [reservoirId, setReservoirId] = useState('qx');
  const [selectedFactId, setSelectedFactId] = useState('');
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void (async () => {
      const rs = await getAllRuns();
      const sorted = rs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setRuns(sorted);
      if (sorted.length > 0 && !runId) setRunId(sorted[0].id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const r = (await getAllRuns()).find((x) => x.id === runId) ?? null;
      const snap = await getSnapshot(runId);
      if (cancelled || !r || !snap) { setLoading(false); return; }
      setRun(r); setSnapshot(snap);
      if (r.design === 'materialized') {
        const [f, ind] = await Promise.all([getFactsByRun(runId), getIndicatorsByRun(runId)]);
        if (!cancelled) { setFacts(f); setIndicators(ind); }
      } else {
        const res = await queryOnDemand(runId);
        if (!cancelled) { setFacts(res.facts); setIndicators(res.indicators); }
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [runId]);

  const reservoirFacts = useMemo(
    () => facts.filter((f) => f.reservoirId === reservoirId).sort((a, b) => a.t1.localeCompare(b.t1)),
    [facts, reservoirId],
  );
  const selectedFact = reservoirFacts.find((f) => f.id === selectedFactId) ?? reservoirFacts[0] ?? null;
  const selectedIndicator = indicators.find((i) => i.reservoirId === reservoirId) ?? null;
  const readingMap = useMemo(() => {
    const m = new Map<string, RawReading>();
    snapshot?.readings.forEach((r) => m.set(r.id, r));
    return m;
  }, [snapshot]);
  const nameOf = (id: string) => snapshot?.reservoirs.find((r) => r.id === id)?.name ?? id;
  const curveOf = (id?: string) => (id ? snapshot?.curves.find((c) => c.id === id) : undefined);

  useEffect(() => {
    if (selectedFact) {
      const ids = new Set<string>();
      selectedFact.terms.forEach((term) => term.sourceReadingIds.forEach((id) => ids.add(id)));
      setEvidenceIds([...ids]);
    }
  }, [selectedFactId, selectedFact]);

  const jumpToIndicatorFacts = () => {
    if (!selectedIndicator) return;
    const firstId = selectedIndicator.factIds[0];
    if (firstId) setSelectedFactId(firstId);
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>复盘回查</h1>
          <div className="sub">从任一风险结论回查参与的区间、换算曲线版本与平衡项，直至原始读数证据；证据全部取自运行锁定快照</div>
        </div>
        <select value={runId} onChange={(e) => setRunId(e.target.value)} style={{ maxWidth: 380 }}>
          {runs.map((r) => <option key={r.id} value={r.id} disabled={r.status === 'running' || r.status === 'failed'}>{r.name} — {r.id}</option>)}
        </select>
      </div>

      {loading && <div className="banner info">按需运行正在 Worker 中即时复算……</div>}
      {!run && !loading && <div className="banner info">暂无运行，请先到平衡运行台创建运行。</div>}

      {run && snapshot && (
        <>
          <div className="card">
            <h2>运行版本说明（可复算基线）</h2>
            <div className="small mono" style={{ lineHeight: 1.9 }}>
              运行ID：{run.id}<br />
              资料截止点：{run.cutoffAt}（快照读数 {snapshot.readings.length} 条，冻结于 {snapshot.frozenAt}）<br />
              时间网格：{run.gridStart} ~ {run.gridEnd}，步长 {run.gridStepSeconds}s<br />
              容差：绝对 {run.tolerance.absM3} m³，相对 {(run.tolerance.relFraction * 100).toFixed(2)}%；
              压力窗口 {run.pressureWindowSeconds / 3600}h；决策时点 {run.decisionHorizonSeconds / 3600}h<br />
              曲线版本：{[...new Set(snapshot.curves.map((c) => `${c.reservoirId}/${c.kind}/${c.version}(${c.approvalStatus})`))].join('；')}<br />
              规则版本：{[...new Set(snapshot.rules.map((r) => `${r.reservoirId}/${r.version}(${r.approvalStatus})`))].join('；')}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {snapshot.reservoirs.map((r) => (
              <button key={r.id} className={`small ${reservoirId === r.id ? 'primary' : ''}`} onClick={() => { setReservoirId(r.id); setSelectedFactId(''); }}>
                {r.name}
              </button>
            ))}
          </div>

          {selectedIndicator && (
            <div className="card">
              <h2>风险结论 → 参与区间回查 <StatusPill status={selectedIndicator.marginStatus} /></h2>
              <div className="small">
                该指标由 {selectedIndicator.factIds.length} 个平衡区间支撑：
                <span className="mono"> {selectedIndicator.factIds.map((id) => id.split('-').slice(-2).join('-')).join('，')}</span>
              </div>
              {selectedIndicator.pending && (
                <ul className="reason-list">{selectedIndicator.pendingReasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
              )}
              <button className="small mt8" onClick={jumpToIndicatorFacts}>定位到首个参与区间</button>
            </div>
          )}

          <div className="two-col">
            <div className="card">
              <h2>{nameOf(reservoirId)} · 区间平衡事实（相邻残差比对）</h2>
              <div className="table-wrap" style={{ maxHeight: 420 }}>
                <table>
                  <thead><tr><th>区间</th><th className="num">时长s</th><th>闭合</th><th className="num">ΔS m³</th><th className="num">残差 m³</th><th>曲线换版</th></tr></thead>
                  <tbody>
                    {reservoirFacts.map((f) => (
                      <tr
                        key={f.id}
                        style={{ cursor: 'pointer', background: selectedFact?.id === f.id ? 'var(--primary-soft)' : undefined }}
                        onClick={() => setSelectedFactId(f.id)}
                      >
                        <td className="mono small">{formatHuman(f.t1)}<br />~{formatHuman(f.t2)}</td>
                        <td className="num">{f.durationSeconds}</td>
                        <td>{f.closed ? <span className="pill ok">闭合</span> : <span className="pill danger">{f.residual === null ? '不可算' : '超差'}</span>}</td>
                        <td className="num">{f.deltaS === null ? '—' : f.deltaS.toFixed(0)}</td>
                        <td className="num">{f.residual === null ? '待核' : f.residual.toFixed(0)}</td>
                        <td>{f.curveSwitched ? <span className="pill warn">换版</span> : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <h2>区间明细与证据链</h2>
              {selectedFact ? (
                <>
                  <div className="small mono">
                    {selectedFact.t1} ~ {selectedFact.t2}（实际 {selectedFact.durationSeconds}s）
                  </div>
                  <h3>水位→蓄水换算曲线</h3>
                  <div className="small">
                    t1：{curveOf(selectedFact.storageCurveIdAtT1)
                      ? `${curveOf(selectedFact.storageCurveIdAtT1)!.version}（${formatHuman(curveOf(selectedFact.storageCurveIdAtT1)!.validFrom)} 起）`
                      : '无有效曲线'}
                    {selectedFact.curveSwitched && <span className="pill warn" style={{ marginLeft: 6 }}>区间内库容曲线切换</span>}<br />
                    t2：{curveOf(selectedFact.storageCurveIdAtT2)
                      ? `${curveOf(selectedFact.storageCurveIdAtT2)!.version}` : '无有效曲线'}<br />
                    面积曲线：{curveOf(selectedFact.areaCurveId)?.version ?? '无有效曲线'}<br />
                    S1={selectedFact.s1 === null ? '待核' : formatM3(selectedFact.s1)}；S2={selectedFact.s2 === null ? '待核' : formatM3(selectedFact.s2)}
                  </div>
                  <h3>平衡项（缺失项不以零补齐）</h3>
                  <table>
                    <thead><tr><th>项</th><th>覆盖</th><th className="num">水量 m³</th><th className="num">未知范围 m³</th><th>证据读数</th></tr></thead>
                    <tbody>
                      {selectedFact.terms.map((term) => (
                        <tr key={term.key}>
                          <td className="small">{term.label}</td>
                          <td>{term.covered ? <span className="pill ok">是</span> : <span className="pill danger">否</span>}</td>
                          <td className="num">{term.valueM3 === null ? '待核' : term.valueM3.toFixed(0)}</td>
                          <td className="num small">[{term.unknownRangeM3[0].toFixed(0)}, {term.unknownRangeM3[1].toFixed(0)}]</td>
                          <td>
                            <button className="small" onClick={() => setEvidenceIds(term.sourceReadingIds)}>
                              {term.sourceReadingIds.length} 条原始读数
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {selectedFact.unclosedReasons.length > 0 && (
                    <>
                      <h3>未闭合来源（不得塞入“损耗”）</h3>
                      <ul className="reason-list">{selectedFact.unclosedReasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                    </>
                  )}
                </>
              ) : <div className="muted">请选择左侧区间</div>}
            </div>
          </div>

          <div className="card">
            <h2>原始证据读数（{evidenceIds.length} 条，来自运行快照，非最新文件）</h2>
            <div className="table-wrap" style={{ maxHeight: 360 }}>
              <table>
                <thead>
                  <tr><th>读数ID</th><th>类型</th><th>采样</th><th>接收</th><th className="num">值</th><th>单位</th><th>质量</th><th>修订</th><th>备注</th></tr>
                </thead>
                <tbody>
                  {evidenceIds.slice(0, 300).map((id) => {
                    const r = readingMap.get(id);
                    if (!r) return <tr key={id}><td colSpan={9} className="muted">{id} 不在快照（可能已被修订替代）</td></tr>;
                    return (
                      <tr key={id}>
                        <td className="mono small">{r.id}</td>
                        <td>{r.kind}</td>
                        <td className="mono small">{formatHuman(r.sampledAt)}</td>
                        <td className="mono small">{formatHuman(r.receivedAt)}</td>
                        <td className="num">{r.value === null ? 'NULL' : r.value}</td>
                        <td>{r.unit}</td>
                        <td><QualityPill quality={r.quality} /></td>
                        <td className="small">{r.revisionOf ? `修订${r.revisionOf.slice(-5)}` : r.supersededById ? `被替代` : '—'}</td>
                        <td className="muted small">{r.note ?? '—'}</td>
                      </tr>
                    );
                  })}
                  {evidenceIds.length === 0 && <tr><td colSpan={9} className="muted">点击平衡项的“原始读数”按钮查看证据</td></tr>}
                </tbody>
              </table>
            </div>
            {evidenceIds.length > 300 && <div className="muted small mt8">大文件下钻：仅渲染前 300 条，证据总量 {evidenceIds.length} 条（东风水库 10 分钟级序列）</div>}
          </div>

          <div className="two-col">
            {selectedFact && <AnnotationPanel subjectType="fact" subjectId={selectedFact.id} title={`区间批注（字段级并发合并）— ${formatHuman(selectedFact.t1)}`} />}
            {selectedIndicator && <AnnotationPanel subjectType="indicator" subjectId={selectedIndicator.id} title="风险结论批注（模拟两个页面并发编辑）" />}
          </div>
        </>
      )}
    </div>
  );
}
