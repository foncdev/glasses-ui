/**
 * 모니터링 화면(relay GET /monitor).
 *
 * relay가 Grafana에서 무엇을 읽든 그룹 → 대상 → 지표·서비스 모양으로 준다. 여기는 그 모양만 그린다 —
 * 서버(CPU·디스크·서비스 UP/DOWN)든 업무 지표(오늘 주문·반품)든 같은 세 화면이다.
 *
 *   그룹 목록   ■ web  DOWN 1 · 주의 1 · 서비스 8/9
 *   대상 목록   ■ web-03  worker DOWN
 *   대상 한 장  막대(끝값이 있는 지표)나 값, 서비스 줄, 기준 시각, 안내
 *
 * 목록 줄에는 고른 칸 표시를 넣지 않는다. 줄이 바뀌면 목록을 다시 세우고, 그때 펌웨어의 선택이
 * 맨 위로 돌아간다. 값도 문제 있는 것만 적는다 — 정상인 대상의 CPU가 흔들릴 때마다 다시 세우지 않게.
 */
import { clampWidth } from './glasses.js';
import { msg } from './i18n.js';
import { MAC_COLS, MAC_ROWS } from './mac.js';

export type MonitorState = 'down' | 'crit' | 'warn' | 'ok' | 'unknown';

export interface MonitorMetric {
  key: string;
  label: string;
  value: number;
  unit: string;
  max?: number;
  state: MonitorState;
}

export interface MonitorService {
  name: string;
  up: boolean;
}

export interface MonitorItem {
  id: string;
  name: string;
  state: MonitorState;
  metrics: MonitorMetric[];
  services: MonitorService[];
}

export interface MonitorGroup {
  id: string;
  name: string;
  state: MonitorState;
  counts: Record<MonitorState, number>;
  servicesUp: number;
  servicesTotal: number;
  items: MonitorItem[];
}

export interface MonitorSnapshot {
  enabled: boolean;
  source: string;
  updatedAt?: string;
  error?: string;
  stale?: boolean;
  state: MonitorState;
  counts: Record<MonitorState, number>;
  groups: MonitorGroup[];
}

/** 막대 칸 수. 한 칸 20px — 10칸이면 화면 폭의 3분의 1이 조금 넘는다. */
const BAR = 10;

/** 상태 표시. ✕는 안경 글꼴에 없다. */
export function mark(s: MonitorState): string {
  if (s === 'down' || s === 'crit') return '■';
  if (s === 'warn') return '▲';
  if (s === 'unknown') return '○';
  return '●';
}

/** 홈 메뉴 오른쪽: 문제 있는 대상 수. 모두 정상이면 '●'. */
export function homeMeta(snap: MonitorSnapshot | undefined): string {
  if (!snap?.enabled || snap.groups.length === 0) return '';
  const bad = snap.counts.down + snap.counts.crit;
  const warn = snap.counts.warn;
  const parts = [bad > 0 ? `■${bad}` : '', warn > 0 ? `▲${warn}` : ''].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : '●';
}

/** 1248 → 1,248. 소수는 한 자리. */
export function formatValue(m: Pick<MonitorMetric, 'value' | 'unit' | 'max'>): string {
  const v = m.unit === '%' || (m.max !== undefined && Math.abs(m.value) >= 10) ? Math.round(m.value) : m.value;
  const text = Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(1);
  return `${text}${m.unit}`;
}

function metricText(m: MonitorMetric): string {
  return `${m.label} ${formatValue(m)}`;
}

/** 대상 한 줄의 오른쪽: 내려간 서비스, 위험·주의 지표. 정상이면 '정상'. */
export function itemSummary(item: MonitorItem): string {
  const m = msg();
  const down = item.services.filter((s) => !s.up).map((s) => `${s.name} DOWN`);
  const bad = item.metrics.filter((x) => x.state !== 'ok').map(metricText);
  const parts = [...down, ...bad];
  if (parts.length > 0) return parts.join(' · ');
  return item.state === 'unknown' ? m.monitorNoData : m.monitorOk;
}

/** 그룹 한 줄의 오른쪽: 상태별 수와 서비스 UP/전체. */
export function groupSummary(g: MonitorGroup): string {
  const m = msg();
  const parts = [
    g.counts.down > 0 ? `DOWN ${g.counts.down}` : '',
    g.counts.crit > 0 ? m.monitorCrit(g.counts.crit) : '',
    g.counts.warn > 0 ? m.monitorWarn(g.counts.warn) : '',
  ].filter(Boolean);
  if (parts.length === 0) parts.push(m.monitorAllOk(g.items.length));
  if (g.servicesTotal > 0) parts.push(m.monitorServices(g.servicesUp, g.servicesTotal));
  return parts.join(' · ');
}

const ROW_COLS = 40;

export function groupRows(snap: MonitorSnapshot): string[] {
  return snap.groups.map((g) => clampWidth(`${mark(g.state)} ${g.name}  ${groupSummary(g)}`, ROW_COLS));
}

export function itemRows(g: MonitorGroup): string[] {
  return g.items.map((i) => clampWidth(`${mark(i.state)} ${i.name}  ${itemSummary(i)}`, ROW_COLS));
}

/** 목록 윗줄. 실패·오래된 값이면 그것을 먼저 알린다. */
export function monitorHeader(snap: MonitorSnapshot | undefined, title: string): string {
  const m = msg();
  if (snap?.stale) return `${title} · ${m.monitorStale}`;
  const bad = snap ? snap.counts.down + snap.counts.crit : 0;
  const warn = snap?.counts.warn ?? 0;
  const tail = [bad > 0 ? `■${bad}` : '', warn > 0 ? `▲${warn}` : ''].filter(Boolean).join(' ');
  return tail ? `${title} ${tail}` : title;
}

export function bar(ratio: number, n = BAR): string {
  const full = Math.max(0, Math.min(n, Math.round(ratio * n)));
  return '━'.repeat(full) + '─'.repeat(n - full);
}

function hhmm(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 대상 한 장. 늘 MAC_ROWS줄 안이고, 안내 줄은 맨 아래 자리다.
 *
 *   web-03 · web · DOWN            (이름 · 그룹 · 상태)
 *   ━━━━━━━━━─ CPU 89% ▲           (끝값이 있으면 막대)
 *   주문 1,248건                     (없으면 값만)
 *   서비스 ■worker ●api ●nginx
 *   12:03 기준 · 2/4
 *   ● 새로 읽기  ▲▼ 다른 대상  ●● 뒤로
 */
export function itemPage(
  snap: MonitorSnapshot | undefined,
  group: MonitorGroup | undefined,
  index: number,
): string {
  const m = msg();
  const item = group?.items[index];
  if (!group || !item) {
    return [m.menuMonitor, ' ', m.monitorNoData, ...Array(MAC_ROWS - 4).fill(' '), m.monitorItemHint].join('\n');
  }

  const head = clampWidth(`${mark(item.state)} ${item.name} · ${group.name} · ${stateWord(item.state)}`, MAC_COLS);
  // 머리 한 줄, 아래 둘(기준 시각·안내)을 뺀 자리.
  const room = MAC_ROWS - 3;
  const body: string[] = [];

  const services = [...item.services].sort((a, b) => Number(a.up) - Number(b.up));
  const serviceLine =
    services.length > 0
      ? clampWidth(`${m.monitorServiceLabel} ${services.map((s) => `${s.up ? '●' : '■'}${s.name}`).join(' ')}`, MAC_COLS)
      : '';

  // 나쁜 지표가 먼저 보이게: 자리가 모자라면 정상인 지표부터 뺀다.
  const metricRoom = room - (serviceLine ? 1 : 0);
  const metrics = item.metrics.length > metricRoom
    ? [...item.metrics].sort((a, b) => rank(b.state) - rank(a.state)).slice(0, metricRoom - 1)
    : item.metrics;
  for (const x of metrics) {
    const tail = x.state === 'ok' ? '' : ` ${mark(x.state)}`;
    const line = x.max !== undefined && x.max > 0 ? `${bar(x.value / x.max)} ${metricText(x)}${tail}` : `${metricText(x)}${tail}`;
    body.push(clampWidth(line, MAC_COLS));
  }
  if (metrics.length < item.metrics.length) body.push(m.monitorMore(item.metrics.length - metrics.length));
  if (serviceLine) body.push(serviceLine);
  if (body.length === 0) body.push(m.monitorNoData);

  const when = hhmm(snap?.updatedAt);
  const status = [
    when ? m.monitorAt(when) : '',
    snap?.stale ? m.monitorStale : '',
    group.items.length > 1 ? `${index + 1}/${group.items.length}` : '',
  ].filter(Boolean).join(' · ');

  // 펌웨어가 빈 줄 앞 공백을 지운다. 빈 줄은 공백 하나로 둔다.
  const pad = Array(Math.max(0, room - body.length)).fill(' ');
  return [head, ...body, ...pad, clampWidth(status || ' ', MAC_COLS), m.monitorItemHint].join('\n');
}

function rank(s: MonitorState): number {
  return { down: 4, crit: 3, warn: 2, unknown: 1, ok: 0 }[s];
}

export function stateWord(s: MonitorState): string {
  const m = msg();
  if (s === 'down') return 'DOWN';
  if (s === 'crit') return m.monitorCritWord;
  if (s === 'warn') return m.monitorWarnWord;
  if (s === 'unknown') return m.monitorNoData;
  return m.monitorOk;
}
