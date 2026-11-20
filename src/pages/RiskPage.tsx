// 断面风险范围推导页：只发布锁定运行的风险时间段，不给单一替代水位/流量。
// 物化运行读 risk_segments 落库结果，按需运行经 Worker 用同一引擎即时求值。
import { useEffect, useMemo, useState } from 'react';
import {
  getAllRuns, getRiskSegmentsByRun, getSnapshot,
} from '../db';
import { queryOnDemand } from '../services/runService';
import { RiskClassPill, RangeSourcePill, ApprovalPill } from '../components/Pills';
import RiskTimeline from '../components/RiskTimeline';
import { summarizeRisk } from '../lib/riskRange';
import { formatHuman } from '../lib/time';
import { useAppState } from '../appState';
import type {
  BalanceRun, RiverSection, SectionRiskSegment, RunSnapshot, RiskClass,
} from '../types';

const CLASS_ORDER: RiskClass[] = ['safe', 'exceeded', 'possible', 'undetermined'];

export default function RiskPage() {
  const { selectedRunId, setSelectedRunId, dataVersion } = useAppState();
  const [runs, setRuns] = useState<BalanceRun[]>([]);
  const [run, setRun] = useState<BalanceRun | null>(null);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [segments, setSegments] = useState<SectionRiskSegment[]>([]);
  const [loading, setLoading] = useState(false);
  const [classFilter, setClassFilter] = useState<RiskClass | ''>('');

  useEffect(() => {
    void (async () => {
      const rs = await getAllRuns();
      setRuns(rs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    })();
  }, [dataVersion]);

  const effectiveRunId = selectedRunId ?? runs.find((r) => r.status !== 'running' && r.status !== 'failed')?.id ?? null;

  useEffect(() => {
    if (!effectiveRunId) {
      setRun(null); setSnapshot(null); setSegments([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const r = (await getAllRuns()).find((x) => x.id === effectiveRunId) ?? null;
      const snap = await getSnapshot(effectiveRunId);
      if (cancelled || !r || !snap) return;
      setRun(r);
      setSnapshot(snap);
      setLoading(true);
      if (r.design === 'materialized') {
        const segs = await getRiskSegmentsByRun(effectiveRunId);
        if (!cancelled) setSegments(segs);
      } else {
        const res = await queryOnDemand(effectiveRunId);
        if (!cancelled) setSegments(res.riskSegments);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [effectiveRunId, runs]);

  const sections: RiverSection[] = snapshot?.riverSections ?? [];
  const nameOf = (id: string) => sections.find((s) => s.id === id)?.name ?? id;
  const summary = useMemo(() => summarizeRisk(segments), [segments]);
  const filtered = useMemo(
    () => segments
      .filter((s) => !classFilter || s.classification === classFilter)
      .sort((a, b) => a.sectionId.localeCompare(b.sectionId) || a.t1.localeCompare(b.t1)),
    [segments, classFilter],
  );

  if (!effectiveRunId) {
    return (
      <div>
        <div className="page-head">
          <h1>下游断面风险范围推导</h1>
        </div>
        <div className="banner info">尚无可用运行。请先播种演示数据并在「平衡运行台」完成一次运行；风险分段与平衡事实同网格、同快照计算。</div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>下游断面风险范围推导</h1>
          <div className="sub">
            故障期间不替代实测、不输出单一替代水位/流量；按工程批准传播界或历史条件关系给出可能范围，
            输出已确认安全 / 已确认超限 / 可能超限 / 不可判定四类时间段
          </div>
        </div>
        <select value={effectiveRunId} onChange={(e) => setSelectedRunId(e.target.value)} style={{ maxWidth: 360 }}>
          {runs.map((r) => <option key={r.id} value={r.id} disabled={r.status === 'running' || r.status === 'failed'}>{r.name} — {r.id}</option>)}
        </select>
      </div>

      <div className="banner info">
        运行 <span className="mono">{effectiveRunId}</span>（截止点 {run ? formatHuman(run.cutoffAt) : '—'}，
        {run?.design === 'materialized' ? '物化分段读取本地库' : '按需运行 Worker 即时推导'}）。
        所有标注「推导」的结果均非实测，仅用于风险分类与调度限制提示。
        {loading ? '……推导中' : ''}
      </div>

      <div className="grid cols-4">
        {CLASS_ORDER.map((c) => (
          <button
            key={c}
            type="button"
            className={`kpi clickable ${classFilter === c ? 'selected' : ''}`}
            onClick={() => setClassFilter(classFilter === c ? '' : c)}
          >
            <div className="label"><RiskClassPill classification={c} /></div>
            <div className="value">{summary[c]}</div>
            <div className="sub">个网格时间段{classFilter === c ? '（再次点击取消过滤）' : ''}</div>
          </button>
        ))}
      </div>

      <div className="card mt16">
        <h2>风险时间线（格＝一个网格区间，点击查看区间来源与证据链）</h2>
        <RiskTimeline sections={sections} segments={segments} />
      </div>

      <div className="card mt16">
        <h2>风险分段明细（{filtered.length}）</h2>
        <div style={{ marginBottom: 10 }}>
          <span className="muted small">分类过滤：</span>
          {CLASS_ORDER.map((c) => (
            <button
              key={c}
              type="button"
              className={`small ${classFilter === c ? 'primary' : ''}`}
              style={{ marginRight: 8 }}
              onClick={() => setClassFilter(classFilter === c ? '' : c)}
            >
              <RiskClassPill classification={c} />
            </button>
          ))}
        </div>
        <div className="table-wrap" style={{ maxHeight: 460 }}>
          <table>
            <thead>
              <tr>
                <th>断面</th><th>时间段</th><th>分类</th><th>来源</th><th className="num">实测</th>
                <th className="num">推导范围</th><th className="num">承压线</th><th>版本</th><th>待复核</th><th>限制摘要</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => {
                const section = sections.find((x) => x.id === s.sectionId);
                return (
                  <tr key={s.id}>
                    <td>{nameOf(s.sectionId)}<div className="muted small mono">{s.sectionId}</div></td>
                    <td className="mono small">{formatHuman(s.t1)}<br />~{formatHuman(s.t2)}</td>
                    <td><RiskClassPill classification={s.classification} /></td>
                    <td>
                      <RangeSourcePill source={s.source} />
                      {s.inferred && <div className="pill warn" style={{ marginTop: 2 }}>非实测</div>}
                    </td>
                    <td className="num">{s.measuredValue === null ? '—' : `${s.measuredValue} ${section?.unit ?? ''}`}</td>
                    <td className="num small">
                      {s.inferredRange
                        ? `[${s.inferredRange[0].toFixed(1)}, ${s.inferredRange[1].toFixed(1)}]`
                        : '—'}
                    </td>
                    <td className="num">{s.bearingLimit}</td>
                    <td className="num">v{s.version}</td>
                    <td>{s.pendingReview ? <span className="pill pending">是</span> : '—'}</td>
                    <td className="muted small" style={{ maxWidth: 300 }}>
                      {[...s.reviewReasons, ...s.limitations].slice(0, 2).join('；') || '—'}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && <tr><td colSpan={10} className="muted">无匹配分段</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="two-col mt16">
        <div className="card">
          <h2>站点健康记录（故障区间 / 校准 / 可用邻站）</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>断面</th><th>故障起</th><th>故障止</th><th>校准</th><th>可用邻站</th><th>恢复实测</th><th>原因</th></tr></thead>
              <tbody>
                {snapshot?.healthRecords.map((h) => (
                  <tr key={h.id}>
                    <td className="small">{nameOf(h.sectionId)}</td>
                    <td className="mono small">{formatHuman(h.faultStart)}</td>
                    <td className="mono small">{h.faultEnd ? formatHuman(h.faultEnd) : '未恢复'}</td>
                    <td><span className={`pill ${h.calibration === 'calibrated' ? 'ok' : 'warn'}`}>{h.calibration}</span></td>
                    <td className="small">{h.availableNeighborIds.map(nameOf).join('、') || '—'}</td>
                    <td className="mono small">{h.recoveredReadingAt ? formatHuman(h.recoveredReadingAt) : '—'}</td>
                    <td className="muted small">{h.reason}</td>
                  </tr>
                ))}
                {(snapshot?.healthRecords.length ?? 0) === 0 && <tr><td colSpan={7} className="muted">无健康记录</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <h2>水文关系与条件模型（区间来源的工程依据）</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>目标</th><th>参考</th><th>类型/状态</th><th className="num">时差(s)</th><th className="num">增减界/残差带</th></tr></thead>
              <tbody>
                {snapshot?.hydrologicRelations.map((rel) => (
                  <tr key={rel.id}>
                    <td className="small">{nameOf(rel.targetSectionId)}</td>
                    <td className="small">{nameOf(rel.referenceSectionId)}</td>
                    <td><ApprovalPill status={rel.approvalStatus} /><div className="muted small">工程传播</div></td>
                    <td className="num">{rel.travelTimeMinSeconds}~{rel.travelTimeMaxSeconds}</td>
                    <td className="num small">×[{rel.attenuationMin}, {rel.attenuationMax}]{rel.backwaterWiden > 0 ? ` +回水${rel.backwaterWiden}` : ''}</td>
                  </tr>
                ))}
                {snapshot?.conditionalRelations.map((m) => (
                  <tr key={m.id}>
                    <td className="small">{nameOf(m.targetSectionId)}</td>
                    <td className="small">{nameOf(m.referenceSectionId)}</td>
                    <td><span className="pill info">条件拟合</span><div className="muted small">{m.sampleCount} 样本 R²={m.r2}</div></td>
                    <td className="num">见工程关系</td>
                    <td className="num small">±{m.residualBand.toFixed(2)} 残差带</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>支流汇入条件</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>目标断面</th><th>支流</th><th>活跃区间</th><th>测站</th><th className="num">贡献界</th></tr></thead>
              <tbody>
                {snapshot?.tributaryConditions.map((c) => (
                  <tr key={c.id}>
                    <td className="small">{nameOf(c.targetSectionId)}</td>
                    <td className="small">{c.name}</td>
                    <td className="mono small">{formatHuman(c.activeFrom)}{c.activeTo ? `~${formatHuman(c.activeTo)}` : '起长期'}</td>
                    <td>{c.ungaged ? <span className="pill warn">无测站</span> : <span className="pill ok">有巡测</span>}</td>
                    <td className="num">[{c.contributionRange[0]}, {c.contributionRange[1]}]</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
