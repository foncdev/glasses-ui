/**
 * 모니터링 화면 검증.
 *
 *  - 서버든 업무 지표든 같은 세 화면(그룹 → 대상 → 한 장)으로 그린다
 *  - 문제 있는 것만 줄에 값을 적는다(정상 값이 흔들릴 때 목록을 다시 세우지 않게)
 *  - 한 장은 늘 10줄·화면 폭 안이고 안내 줄은 맨 아래다
 *  - 홈 메뉴는 relay에 설정이 있을 때만 보이고, 오른쪽에 문제 수가 붙는다
 *  - 탭·더블탭·위아래로 오간다
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { getTextWidth, measureTextWrap } from '@evenrealities/pretext';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli } from '../src/core/agent-cli.js';
import type { GestureEvent, GlassesAdapter, ItemLike } from '../src/core/glasses.js';
import { msg, setLocale } from '../src/core/i18n.js';
import { MAC_ROWS } from '../src/core/mac.js';
import {
  bar,
  formatValue,
  groupRows,
  homeMeta,
  itemPage,
  itemRows,
  monitorHeader,
  type MonitorGroup,
  type MonitorItem,
  type MonitorSnapshot,
} from '../src/core/monitor.js';
import { visibleMenu, DEFAULT_MENU } from '../src/core/menu.js';
import { asText } from './g2-text.js';

function fitsScreen(page: string): void {
  const lines = page.split('\n');
  assert.ok(lines.length <= MAC_ROWS, `${lines.length}줄 > ${MAC_ROWS}줄:\n${page}`);
  for (const line of lines) {
    assert.ok(getTextWidth(line) <= 564 && measureTextWrap(line, 564).lineCount === 1, `넘치는 줄 (${getTextWidth(line)}px): ${line}`);
  }
}

function fitsRow(row: string): void {
  // 목록 칸은 왼쪽 상태 표시 자리를 빼고 폭이 더 좁다. 넉넉히 500px 안.
  assert.ok(getTextWidth(row) <= 500, `넘치는 줄 (${getTextWidth(row)}px): ${row}`);
}

const zero = { down: 0, crit: 0, warn: 0, ok: 0, unknown: 0 };
const pct = (key: string, label: string, value: number, state: MonitorItem['state'] = 'ok') => ({ key, label, value, unit: '%', max: 100, state });

const WEB: MonitorGroup = {
  id: 'web',
  name: 'web',
  state: 'down',
  counts: { ...zero, down: 1, warn: 1, ok: 1 },
  servicesUp: 5,
  servicesTotal: 6,
  items: [
    {
      id: 'web-03', name: 'web-03', state: 'down',
      metrics: [pct('cpu', 'CPU', 89.3, 'warn'), pct('disk', '디스크', 44), pct('mem', '메모리', 66.8)],
      services: [{ name: 'worker', up: false }, { name: 'api', up: true }, { name: 'nginx', up: true }],
    },
    { id: 'web-04', name: 'web-04', state: 'warn', metrics: [pct('cpu', 'CPU', 83.7, 'warn')], services: [{ name: 'nginx', up: true }] },
    { id: 'web-01', name: 'web-01', state: 'ok', metrics: [pct('cpu', 'CPU', 31)], services: [{ name: 'nginx', up: true }, { name: 'api', up: true }] },
  ],
};

const SHOP: MonitorGroup = {
  id: '쇼핑몰',
  name: '쇼핑몰',
  state: 'warn',
  counts: { ...zero, warn: 1 },
  servicesUp: 0,
  servicesTotal: 0,
  items: [
    {
      id: '오늘', name: '오늘', state: 'warn',
      metrics: [
        { key: 'orders', label: '주문', value: 1248, unit: '건', state: 'ok' },
        { key: 'returns', label: '반품', value: 57, unit: '건', state: 'warn' },
        { key: 'payment_fail', label: '결제 실패율', value: 2.3, unit: '%', max: 10, state: 'ok' },
      ],
      services: [],
    },
  ],
};

const SNAP: MonitorSnapshot = {
  enabled: true,
  source: 'demo',
  updatedAt: '2026-10-09T12:03:00+09:00',
  state: 'down',
  counts: { ...zero, down: 1, warn: 2, ok: 1 },
  groups: [WEB, SHOP],
};

test('그룹 줄: 상태 표시, 이름, 상태별 수, 서비스 UP/전체', () => {
  setLocale('ko');
  assert.deepEqual(groupRows(SNAP), ['■ web  DOWN 1 · 주의 1 · 서비스 5/6', '▲ 쇼핑몰  주의 1']);
  const ok: MonitorGroup = { ...SHOP, state: 'ok', counts: { ...zero, ok: 2 }, items: [SHOP.items[0]!, SHOP.items[0]!] };
  assert.deepEqual(groupRows({ ...SNAP, groups: [ok] }), ['● 쇼핑몰  정상 2']);
});

test('대상 줄: 문제 있는 것만 값을 적고, 정상이면 정상이라고만 적는다', () => {
  setLocale('ko');
  assert.deepEqual(itemRows(WEB), ['■ web-03  worker DOWN · CPU 89%', '▲ web-04  CPU 84%', '● web-01  정상']);
  assert.deepEqual(itemRows(SHOP), ['▲ 오늘  반품 57건']);
});

test('값: 백분율은 정수, 큰 수는 쉼표, 막대는 10칸', () => {
  assert.equal(formatValue({ value: 89.6, unit: '%', max: 100 }), '90%');
  assert.equal(formatValue({ value: 1248, unit: '건' }), '1,248건');
  assert.equal(formatValue({ value: 2.34, unit: '%', max: 10 }), '2%');
  assert.equal(formatValue({ value: 2.3, unit: 'ms' }), '2.3ms');
  assert.equal(bar(0.5), '━━━━━─────');
  assert.equal(bar(1.4), '━━━━━━━━━━');
  assert.equal(bar(-1), '──────────');
});

test('한 장: 머리, 막대·값, 서비스, 기준 시각·위치, 안내', () => {
  setLocale('ko');
  const page = itemPage(SNAP, WEB, 0).split('\n');
  assert.equal(page[0], '■ web-03 · web · DOWN');
  assert.equal(page[1], '━━━━━━━━━─ CPU 89% ▲');
  assert.equal(page[2], '━━━━────── 디스크 44%');
  assert.equal(page[4], '서비스 ■worker ●api ●nginx');
  assert.match(page.at(-2)!, /^\d\d:\d\d 기준 · 1\/3$/);
  assert.equal(page.at(-1), msg().monitorItemHint);
  assert.equal(page.length, MAC_ROWS);

  // 끝값이 없는 업무 지표는 막대 없이 값만.
  const shop = itemPage(SNAP, SHOP, 0).split('\n');
  assert.deepEqual(shop.slice(1, 4), ['주문 1,248건', '반품 57건 ▲', '━━────────── 결제 실패율 2%'.replace('━━──────────', bar(0.23))]);
});

test('지표가 많으면 나쁜 것부터 남기고 나머지는 수만 적는다. 어떤 글이든 화면 안이다', () => {
  for (const locale of ['ko', 'en']) {
    setLocale(locale);
    const many: MonitorItem = {
      id: 'x', name: '아주-긴-서버-이름-'.repeat(4), state: 'crit',
      metrics: Array.from({ length: 12 }, (_, i) => pct(`m${i}`, `지표 이름이 꽤 긴 편 ${i}`, i * 9, i === 11 ? 'crit' : 'ok')),
      services: Array.from({ length: 20 }, (_, i) => ({ name: `service-${i}`, up: i % 3 !== 0 })),
    };
    const g: MonitorGroup = { ...WEB, name: '그룹 이름도 길다 '.repeat(3), items: [many] };
    const page = itemPage({ ...SNAP, stale: true }, g, 0);
    fitsScreen(page);
    const lines = page.split('\n');
    assert.ok(lines.some((l) => l.includes('지표 이름이 꽤 긴 편 11')), '위험 지표는 남는다');
    // 7줄 자리: 지표 다섯, '외 일곱', 서비스 한 줄.
    assert.ok(lines.some((l) => l.includes(msg().monitorMore(7))), page);
    fitsScreen(itemPage(SNAP, WEB, 0));
    fitsScreen(itemPage(SNAP, SHOP, 0));
    fitsScreen(itemPage(SNAP, undefined, 0));
    for (const row of [...groupRows({ ...SNAP, groups: [g, WEB, SHOP] }), ...itemRows(g), ...itemRows(WEB)]) fitsRow(row);
    fitsRow(msg().withBack(monitorHeader({ ...SNAP, stale: true }, msg().menuMonitor)));
  }
  setLocale('ko');
});

test('홈: 설정이 있을 때만 메뉴가 보이고, 문제 수가 붙는다', () => {
  assert.ok(!visibleMenu(DEFAULT_MENU, false).includes('monitor'));
  assert.ok(visibleMenu(DEFAULT_MENU, false, true).includes('monitor'));
  assert.equal(homeMeta(SNAP), '■1 ▲2');
  assert.equal(homeMeta({ ...SNAP, counts: { ...zero, ok: 3 } }), '●');
  assert.equal(homeMeta({ ...SNAP, enabled: false }), '');
  assert.equal(homeMeta(undefined), '');
});

// --- 화면 이동 ---

function stubGlasses() {
  const shown: { header: string; items: string[] }[] = [];
  const texts: string[] = [];
  let onGesture: ((e: GestureEvent) => void) | undefined;
  const glasses = {
    name: 'stub',
    isVoiceEnabled: false,
    async connect() {},
    async disconnect() {},
    async showList(header: string, items: readonly ItemLike[]) {
      shown.push({ header, items: asText(items) });
    },
    async showText(t: string) {
      texts.push(t);
    },
    async speak() {},
    setVoiceEnabled() {},
    async saveSetting() {},
    async loadSetting() {
      return '';
    },
    onGesture(cb: (e: GestureEvent) => void) {
      onGesture = cb;
      return () => {};
    },
  } as unknown as GlassesAdapter;
  return { glasses, shown, texts, fire: (gesture: string, selectedIndex?: number) => onGesture?.({ gesture, selectedIndex } as GestureEvent) };
}

const settle = () => new Promise((res) => setTimeout(res, 60));

test('홈 → 모니터링 → 그룹 → 대상 한 장 → 위아래로 다음 대상 → 탭으로 다시 읽기 → 더블탭으로 올라간다', async () => {
  setLocale('ko');
  const stub = stubGlasses();
  const orig = {
    listSessions: agentCli.listSessions,
    listNotifications: agentCli.listNotifications,
    getGlobalChecklist: agentCli.getGlobalChecklist,
    listExt: agentCli.listExt,
    getMonitor: agentCli.getMonitor,
    refreshMonitor: agentCli.refreshMonitor,
  };
  let refreshed = 0;
  agentCli.listSessions = async () => [];
  agentCli.listNotifications = async () => ({ items: [], unread: 0 });
  agentCli.getGlobalChecklist = async () => [];
  agentCli.listExt = async () => [];
  agentCli.getMonitor = async () => SNAP;
  agentCli.refreshMonitor = async () => {
    refreshed += 1;
    return SNAP;
  };
  try {
    const relay = new GlassesUI(stub.glasses, { onLog: () => {} });
    await relay.start();
    const r = relay as unknown as { screen: string; screenOff: boolean; render(): Promise<void>; refreshSummary(): Promise<void> };
    r.screenOff = false;
    r.screen = 'home';
    await r.refreshSummary();

    const home = stub.shown.at(-1)!;
    const at = home.items.indexOf('모니터링');
    assert.ok(at >= 0, `홈에 모니터링이 없다: ${home.items.join(', ')}`);
    // 오른쪽 숫자는 홈 화면을 그리는 기기(showHome)에 간다.
    const view = (relay as unknown as { homeView(): { items: { label: string; meta: string }[] } }).homeView();
    assert.equal(view.items.find((x) => x.label === '모니터링')?.meta, '■1 ▲2');

    stub.fire('tap', at);
    await settle();
    assert.equal(r.screen, 'monitor');
    assert.deepEqual(stub.shown.at(-1)!.items, groupRows(SNAP));

    stub.fire('tap', 0);
    await settle();
    assert.equal(r.screen, 'monitor-group');
    assert.deepEqual(stub.shown.at(-1)!.items, itemRows(WEB));

    stub.fire('tap', 1);
    await settle();
    assert.equal(r.screen, 'monitor-item');
    assert.match(stub.texts.at(-1)!, /^▲ web-04/);

    stub.fire('down');
    await settle();
    assert.match(stub.texts.at(-1)!, /^● web-01/);
    stub.fire('down');
    await settle();
    assert.match(stub.texts.at(-1)!, /^■ web-03/, '끝에서 처음으로 돈다');

    stub.fire('tap');
    await settle();
    assert.equal(refreshed, 1);
    assert.match(stub.texts.at(-1)!, /^■ web-03/, '다시 읽어도 같은 대상');

    stub.fire('doubleTap');
    await settle();
    assert.equal(r.screen, 'monitor-group');
    stub.fire('doubleTap');
    await settle();
    assert.equal(r.screen, 'monitor');
    stub.fire('doubleTap');
    await settle();
    assert.equal(r.screen, 'home');
    await relay.stop?.();
  } finally {
    Object.assign(agentCli, orig);
  }
});

test('relay에 설정이 없으면 홈에 모니터링이 없다', async () => {
  setLocale('ko');
  const stub = stubGlasses();
  const orig = { getMonitor: agentCli.getMonitor, listSessions: agentCli.listSessions, listNotifications: agentCli.listNotifications, getGlobalChecklist: agentCli.getGlobalChecklist, listExt: agentCli.listExt };
  agentCli.listSessions = async () => [];
  agentCli.listNotifications = async () => ({ items: [], unread: 0 });
  agentCli.getGlobalChecklist = async () => [];
  agentCli.listExt = async () => [];
  agentCli.getMonitor = async () => ({ ...SNAP, enabled: false, groups: [] });
  try {
    const relay = new GlassesUI(stub.glasses, { onLog: () => {} });
    await relay.start();
    const r = relay as unknown as { screen: string; screenOff: boolean; refreshSummary(): Promise<void> };
    r.screenOff = false;
    r.screen = 'home';
    await r.refreshSummary();
    assert.ok(!stub.shown.at(-1)!.items.some((x) => x.startsWith('모니터링')));
    await relay.stop?.();
  } finally {
    Object.assign(agentCli, orig);
  }
});
