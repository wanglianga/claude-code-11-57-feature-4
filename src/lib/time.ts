import dayjs, { type Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

export function t(iso: string): Dayjs {
  return dayjs.utc(iso);
}

export function nowISO(): string {
  return dayjs.utc().toISOString();
}

export function iso(d: Dayjs): string {
  return d.toISOString();
}

export function diffSeconds(a: string, b: string): number {
  return dayjs.utc(b).diff(dayjs.utc(a), 'second', true);
}

/** 以 gridStart 为锚点生成 [start, end] 内的固定时间格边界 */
export function buildGrid(start: string, end: string, stepSeconds: number): string[] {
  const out: string[] = [];
  let cur = dayjs.utc(start);
  const endD = dayjs.utc(end);
  let guard = 0;
  while (cur.valueOf() <= endD.valueOf() && guard < 100_000) {
    out.push(cur.toISOString());
    cur = cur.add(stepSeconds, 'second');
    guard += 1;
  }
  return out;
}

export function floorToGrid(time: string, gridStart: string, stepSeconds: number): string {
  const ms = dayjs.utc(time).valueOf();
  const anchor = dayjs.utc(gridStart).valueOf();
  const stepMs = stepSeconds * 1000;
  const k = Math.floor((ms - anchor) / stepMs);
  return dayjs.utc(anchor + k * stepMs).toISOString();
}

export function formatHuman(isoStr: string): string {
  return dayjs.utc(isoStr).format('MM-DD HH:mm');
}
