import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { BalanceFact } from '../types';
import { formatHuman } from '../lib/time';

const COLORS = {
  deltaS: '#1d4ed8',
  net: '#0891b2',
  residualOk: '#15803d',
  residualBad: '#b91c1c',
  storage: '#7c3aed',
};

export default function IndicatorCharts({ facts }: { facts: BalanceFact[] }) {
  if (facts.length === 0) return <div className="muted">该水库在本运行内无平衡事实</div>;

  const balanceData = facts.map((f) => ({
    interval: `${formatHuman(f.t1)}`,
    蓄变ΔS: f.deltaS,
    可确认净项: f.confirmedNet,
    残差: f.residual,
  }));

  const residualData = facts.map((f) => ({
    interval: `${formatHuman(f.t1)}`,
    残差: f.residual,
    闭合: f.closed,
    fill: f.closed ? COLORS.residualOk : COLORS.residualBad,
  }));

  const storageData = facts.map((f) => ({
    interval: `${formatHuman(f.t2)}`,
    起点蓄水: f.s1,
    终点蓄水: f.s2,
  }));

  return (
    <div>
      <h3>蓄变 ΔS 与可确认平衡项（m³，相邻区间可直接比对）</h3>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={balanceData} margin={{ top: 8, right: 20, bottom: 8, left: 10 }}>
          <CartesianGrid stroke="#e5e7eb" />
          <XAxis dataKey="interval" fontSize={11} />
          <YAxis fontSize={11} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
          <Tooltip formatter={(v: number | string) => Number(v).toLocaleString()} />
          <Legend />
          <Line type="monotone" dataKey="蓄变ΔS" stroke={COLORS.deltaS} strokeWidth={2} connectNulls />
          <Line type="monotone" dataKey="可确认净项" stroke={COLORS.net} strokeWidth={2} connectNulls />
        </LineChart>
      </ResponsiveContainer>

      <h3 style={{ marginTop: 18 }}>区间残差 R（绿＝闭合，红＝超测量容差，空＝覆盖不足不可计算）</h3>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={residualData} margin={{ top: 8, right: 20, bottom: 8, left: 10 }}>
          <CartesianGrid stroke="#e5e7eb" />
          <XAxis dataKey="interval" fontSize={11} />
          <YAxis fontSize={11} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
          <Tooltip formatter={(v: number | string) => (v === null ? '不可计算' : Number(v).toLocaleString())} />
          <Bar dataKey="残差">
            {residualData.map((d) => (
              <Cell key={d.interval} fill={d.残差 === null ? '#c4b5fd' : d.fill} fillOpacity={d.残差 === null ? 0.5 : 1} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      <h3 style={{ marginTop: 18 }}>蓄水过程（m³）</h3>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={storageData} margin={{ top: 8, right: 20, bottom: 8, left: 10 }}>
          <CartesianGrid stroke="#e5e7eb" />
          <XAxis dataKey="interval" fontSize={11} />
          <YAxis fontSize={11} tickFormatter={(v) => `${(v / 1e6).toFixed(1)}M`} />
          <Tooltip formatter={(v: number | string) => (v === null ? '缺失' : Number(v).toLocaleString())} />
          <Legend />
          <Line type="monotone" dataKey="起点蓄水" stroke="#94a3b8" connectNulls />
          <Line type="monotone" dataKey="终点蓄水" stroke={COLORS.storage} strokeWidth={2} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
