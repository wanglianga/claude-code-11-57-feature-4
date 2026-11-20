// 断面风险时间线：把四类风险分段渲染为可点击时间轴，并展示推导区间、来源、
// 证据独立性、支流贡献、待复核与版本信息。所有推导结果强制显示“推导（非实测）”。
import { useMemo, useState } from 'react';
import type { RiverSection, SectionRiskSegment } from '../types';
import { formatHuman } from '../lib/time';
import { RangeSourcePill, RiskClassPill } from './Pills';

const CLASS_COLOR: Record<SectionRiskSegment['classification'], string> = {
  safe: '#15803d',
  exceeded: '#b91c1c',
  possible: '#b45309',
  undetermined: '#6d28d9',
};

function fmtRange(seg: SectionRiskSegment, unit: string): string {
  if (seg.measuredValue !== null) return `${seg.measuredValue} ${unit}（实测）`;
  if (!seg.inferredRange) return '— 无可用区间 —';
  return `[${seg.inferredRange[0].toFixed(1)}, ${seg.inferredRange[1].toFixed(1)}] ${unit}（推导，非实测）`;
}

export default function RiskTimeline({
  sections,
  segments,
}: {
  sections: RiverSection[];
  segments: SectionRiskSegment[];
}) {
  const [selectedId, setSelectedId] = useState<string>('');
  const bySection = useMemo(() => {
    const m = new Map<string, SectionRiskSegment[]>();
    for (const s of segments) {
      const list = m.get(s.sectionId) ?? [];
      list.push(s);
      m.set(s.sectionId, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.t1.localeCompare(b.t1));
    return m;
  }, [segments]);

  const allSegments = useMemo(
    () => [...segments].sort((a, b) => a.t1.localeCompare(b.t1)),
    [segments],
  );
  const selected = allSegments.find((s) => s.id === selectedId) ?? allSegments[0] ?? null;
  const selectedSection = selected ? sections.find((s) => s.id === selected.sectionId) : undefined;

  if (sections.length === 0) {
    return <div className="muted">运行快照内无河道断面主数据，请先在资料接入页播种含断面风险数据的演示集</div>;
  }

  return (
    <div>
      {/* ---- 时间轴（每断面一行） ---- */}
      <div className="risk-timeline">
        {sections.map((section) => {
          const list = bySection.get(section.id) ?? [];
          return (
            <div key={section.id} className="risk-row">
              <div className="risk-row-label">
                <div>{section.name}</div>
                <div className="muted small mono">{section.id}</div>
                <div className="muted small">承压线 {section.bearingLimit} {section.unit}</div>
              </div>
              <div className="risk-track">
                {list.map((seg) => (
                                  <button
                    key={seg.id}
                    type="button"
                    className={`risk-cell ${selected?.id === seg.id ? 'selected' : ''}`}
                    style={{ background: CLASS_COLOR[seg.classification] }}
                    title={`${formatHuman(seg.t1)}~${formatHuman(seg.t2)} ${seg.classification}`}
                    onClick={() => setSelectedId(seg.id)}
                  >
                    {seg.inferred && <span className="risk-inferred-dot">推</span>}
                    {seg.pendingReview && <span className="risk-review-dot">审</span>}
                  </button>
                ))}
                {list.length === 0 && <span className="muted small">本运行网格内无分段</span>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="risk-legend small">
        {(['safe', 'exceeded', 'possible', 'undetermined'] as const).map((c) => (
          <span key={c} className="risk-legend-item">
            <i className="risk-swatch" style={{ background: CLASS_COLOR[c] }} />
            <RiskClassPill classification={c} />
          </span>
        ))}
        <span className="muted">｜<b>推</b>＝推导结果（非实测）　<b>审</b>＝故障结束与替代关系重叠，待复核</span>
      </div>

      {/* ---- 分段明细 ---- */}
      {selected && selectedSection && (
        <div className="risk-detail card" style={{ marginTop: 14 }}>
          <h2>
            {selectedSection.name} · {formatHuman(selected.t1)} ~ {formatHuman(selected.t2)}
            <RiskClassPill classification={selected.classification} />
            {selected.inferred && <span className="pill warn">推导结果·非实测</span>}
            {selected.pendingReview && <span className="pill pending">待复核</span>}
            <span className="pill neutral">风险版本 v{selected.version}</span>
          </h2>
          <div className="grid cols-3">
            <div className="kpi">
              <div className="label">可能范围 / 实测</div>
              <div className="value" style={{ fontSize: 16 }}>{fmtRange(selected, selectedSection.unit)}</div>
              <div className="sub">承压线 {selected.bearingLimit}；预警线 {selected.warningLimit} {selectedSection.unit}</div>
            </div>
            <div className="kpi">
              <div className="label">区间来源</div>
              <div className="value" style={{ fontSize: 16 }}><RangeSourcePill source={selected.source} /></div>
              <div className="sub">{selected.healthRecordId ? `关联健康记录 ${selected.healthRecordId}` : '本断面健康时段'}</div>
            </div>
            <div className="kpi">
              <div className="label">支流汇入贡献界</div>
              <div className="value" style={{ fontSize: 16 }}>
                {selected.tributaryRange
                  ? `[${selected.tributaryRange[0].toFixed(1)}, ${selected.tributaryRange[1].toFixed(1)}] ${selectedSection.unit}`
                  : '无活跃支流'}
              </div>
            </div>
          </div>

          <h3>参考证据链（同一参考站支撑多断面时非独立，多源取区间并集而非平均）</h3>
          {selected.evidence.length === 0 ? (
            <div className="muted small">{selected.source === 'measured' ? '实测时段无需替代证据。' : '无可用参考证据。'}</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>参考断面</th><th>来源</th><th>关系/模型</th><th className="num">传播时差(s)</th><th>独立性</th><th className="num">参考读数</th><th>说明</th></tr>
                </thead>
                <tbody>
                  {selected.evidence.map((e, i) => (
                    <tr key={`${e.referenceSectionId}-${i}`}>
                      <td className="mono small">{e.referenceSectionId}</td>
                      <td><RangeSourcePill source={e.source} /></td>
                      <td className="mono small">{e.relationId ?? '—'}</td>
                      <td className="num">{e.travelTimeSeconds[0]}~{e.travelTimeSeconds[1]}</td>
                      <td>{e.independent ? <span className="pill ok">独立</span> : <span className="pill warn">非独立×{e.sharedTargetCount}</span>}</td>
                      <td className="num">{e.sourceReadingIds.length} 条</td>
                      <td className="muted small">{e.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {selected.reviewReasons.length > 0 && (
            <>
              <h3>待复核事项</h3>
              <ul className="reason-list">{selected.reviewReasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </>
          )}
          {selected.limitations.length > 0 && (
            <>
              <h3>建议限制（推导口径与适用边界）</h3>
              <ul className="reason-list" style={{ color: 'var(--muted)' }}>
                {selected.limitations.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </>
          )}
          {selected.note && <div className="banner info" style={{ marginTop: 10 }}>{selected.note}</div>}
        </div>
      )}
    </div>
  );
}
