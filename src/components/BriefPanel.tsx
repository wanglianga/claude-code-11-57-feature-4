import type { BalanceFact, BalanceRun, ReservoirIndicator } from '../types';
import { formatM3, formatRangeFlow } from '../lib/units';

/** 值班简报：只引用同一运行已发布的数值、范围与未闭合原因 */
export default function BriefPanel({
  run, indicators, facts, nameOf,
}: {
  run: BalanceRun;
  indicators: ReservoirIndicator[];
  facts: BalanceFact[];
  nameOf: (id: string) => string;
}) {
  const pending = indicators.filter((i) => i.pending);
  const unclosed = facts.filter((f) => f.unclosedReasons.length > 0);
  const lines: string[] = [];
  lines.push(`【运行 ${run.id}】资料截止点 ${run.cutoffAt}，时间网格 ${run.gridStart} 至 ${run.gridEnd}，步长 ${run.gridStepSeconds}s，容差 绝对${run.tolerance.absM3}m³/相对${(run.tolerance.relFraction * 100).toFixed(2)}%。`);
  for (const ind of indicators) {
    const name = nameOf(ind.reservoirId);
    if (ind.pending) {
      lines.push(`· ${name}：指标待核。${ind.pendingReasons.slice(0, 2).join('；')}`);
      continue;
    }
    lines.push(
      `· ${name}：当前蓄水 ${formatM3(ind.currentStorage)}，防洪余量 ${formatM3(ind.floodMargin)}；` +
      `近 ${ind.windowSeconds / 3600}h 净入库 ${formatM3(ind.netInflowConfirmed)}，压力比 ${ind.pressureRatio?.toFixed(2)}` +
      `（未知范围对应 ${ind.pressureRatioRange.map((x) => x?.toFixed(2)).join('~')}）；` +
      `回到目标库容所需出库 ${formatRangeFlow(ind.releaseNeededRange)}，与下游允许范围差额 ${formatRangeFlow(ind.releaseGapRange)}。`,
    );
  }
  if (unclosed.length > 0) {
    lines.push(`共 ${unclosed.length} 个区间存在未闭合来源，差额未计入“损耗”，请按复盘页证据链逐项核查。`);
  }

  return (
    <div className="card">
      <h2>值班简报（与地图/图表/明细同源）</h2>
      <div className="banner ok">
        本简报全部数值来自运行 <span className="mono">{run.id}</span> 的已发布结果；待核水库不输出确定性结论。
      </div>
      <pre className="code-block" style={{ whiteSpace: 'pre-wrap', maxHeight: 360 }}>{lines.join('\n')}</pre>
      {pending.length > 0 && (
        <div className="banner warn mt8">待核水库 {pending.length} 个：{pending.map((p) => nameOf(p.reservoirId)).join('、')}</div>
      )}
    </div>
  );
}
