import type { IndicatorStatus, RangeSource, RiskClass, RunStatus } from '../types';

export function StatusPill({ status }: { status: IndicatorStatus }) {
  const map: Record<IndicatorStatus, { cls: string; text: string }> = {
    ok: { cls: 'ok', text: '正常' },
    warn: { cls: 'danger', text: '告警' },
    pending: { cls: 'pending', text: '待核' },
  };
  const m = map[status];
  return <span className={`pill ${m.cls}`}>{m.text}</span>;
}

export function RunStatusPill({ status }: { status: RunStatus }) {
  const map: Record<RunStatus, { cls: string; text: string }> = {
    running: { cls: 'info', text: '运行中' },
    completed: { cls: 'ok', text: '已完成' },
    completed_with_warnings: { cls: 'warn', text: '完成有待核' },
    failed: { cls: 'danger', text: '失败' },
  };
  const m = map[status];
  return <span className={`pill ${m.cls}`}>{m.text}</span>;
}

export function QualityPill({ quality }: { quality: string }) {
  const map: Record<string, { cls: string; text: string }> = {
    confirmed: { cls: 'ok', text: '已确认' },
    estimated: { cls: 'info', text: '估算' },
    suspect: { cls: 'warn', text: '可疑' },
    missing: { cls: 'danger', text: '缺失' },
    rejected: { cls: 'neutral', text: '作废' },
  };
  const m = map[quality] ?? { cls: 'neutral', text: quality };
  return <span className={`pill ${m.cls}`}>{m.text}</span>;
}

export function ApprovalPill({ status }: { status: string }) {
  const map: Record<string, { cls: string; text: string }> = {
    draft: { cls: 'pending', text: '草稿' },
    approved: { cls: 'ok', text: '已审批' },
    retired: { cls: 'neutral', text: '已停用' },
  };
  const m = map[status] ?? { cls: 'neutral', text: status };
  return <span className={`pill ${m.cls}`}>{m.text}</span>;
}

export function RiskClassPill({ classification }: { classification: RiskClass }) {
  const map: Record<RiskClass, { cls: string; text: string }> = {
    safe: { cls: 'ok', text: '已确认安全' },
    exceeded: { cls: 'danger', text: '已确认超限' },
    possible: { cls: 'warn', text: '可能超限' },
    undetermined: { cls: 'pending', text: '不可判定' },
  };
  const m = map[classification];
  return <span className={`pill ${m.cls}`}>{m.text}</span>;
}

export function RangeSourcePill({ source }: { source: RangeSource }) {
  const map: Record<RangeSource, { cls: string; text: string }> = {
    measured: { cls: 'ok', text: '实测' },
    engineering_propagation: { cls: 'info', text: '工程传播推导' },
    conditional_fit: { cls: 'info', text: '条件关系推导' },
    none: { cls: 'neutral', text: '无可用来源' },
  };
  const m = map[source];
  return <span className={`pill ${m.cls}`}>{m.text}</span>;
}
