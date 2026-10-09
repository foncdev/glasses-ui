/**
 * 꾸민 모니터링 화면 검증.
 *
 *  - 목록·요약 카드·한 장 카드의 글이 칸 안에 들고(한 줄이 접히지 않고), 칸끼리 겹치지 않는다
 *  - 목록 한 칸은 63바이트 안이다(넘치면 목록 전체가 그려지지 않는다)
 *  - 한 장의 막대는 같은 자리에서 시작하고, DOWN·위험이면 테두리가 굵다
 *  - 줄이 없으면 가운데 안내가 조작을 받는다
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { getTextWidth, measureTextWrap } from '@evenrealities/pretext';
import type { Box } from '../src/adapters/g2-home.js';
import { utf8Bytes } from '../src/adapters/g2-bytes.js';
import { layoutMonitorItem, layoutMonitorList } from '../src/adapters/g2-monitor.js';
import { setLocale } from '../src/core/i18n.js';
import { groupView, groupsView, itemView, type MonitorGroup, type MonitorSnapshot } from '../src/core/monitor.js';

const inner = (b: Box) => b.w - 2 * (b.padding + (b.border?.width ?? 0));
const innerH = (b: Box) => b.h - 2 * (b.padding + (b.border?.width ?? 0));
function fits(b: Box & { text: string }, bottom = 256): void {
  for (const l of b.text.split('\n')) {
    assert.ok(measureTextWrap(l, inner(b)).lineCount <= 1, `접히는 줄 (${getTextWidth(l)}px > ${inner(b)}px): ${l}`);
  }
  assert.ok(innerH(b) >= b.text.split('\n').length * 27, `줄 수가 칸 높이를 넘는다:\n${b.text}`);
  assert.ok(b.y + b.h <= bottom, `아래 칸을 덮는다: y ${b.y} + h ${b.h}`);
}

const zero = { down: 0, crit: 0, warn: 0, ok: 0, unknown: 0 };
const pct = (key: string, label: string, value: number, state: 'ok' | 'warn' | 'crit' = 'ok') => ({ key, label, value, unit: '%', max: 100, state });

const WEB: MonitorGroup = {
  id: 'web', name: 'web', state: 'down', counts: { ...zero, down: 1, warn: 1, ok: 2 }, servicesUp: 8, servicesTotal: 9,
  items: [
    {
      id: 'web-03', name: 'web-03', state: 'down',
      metrics: [pct('cpu', 'CPU', 89.3, 'warn'), pct('disk', '디스크', 44), pct('mem', '메모리', 66.8)],
      services: [{ name: 'api', up: true }, { name: 'worker', up: false }, { name: 'nginx', up: true }],
    },
    { id: 'web-04', name: 'web-04', state: 'warn', metrics: [pct('cpu', 'CPU', 83.7, 'warn'), pct('disk', '디스크', 52)], services: [] },
    { id: 'web-01', name: 'web-01', state: 'ok', metrics: [pct('cpu', 'CPU', 31)], services: [{ name: 'nginx', up: true }] },
    { id: 'web-02', name: 'web-02', state: 'ok', metrics: [pct('cpu', 'CPU', 29)], services: [{ name: 'nginx', up: true }] },
  ],
};
const SHOP: MonitorGroup = {
  id: '쇼핑몰', name: '쇼핑몰', state: 'warn', counts: { ...zero, warn: 1 }, servicesUp: 0, servicesTotal: 0,
  items: [{
    id: '오늘', name: '오늘', state: 'warn', services: [],
    metrics: [
      { key: 'orders', label: '주문', value: 1248, unit: '건', state: 'ok' },
      { key: 'returns', label: '반품', value: 57, unit: '건', state: 'warn' },
      { key: 'payment_fail', label: '결제 실패율', value: 2.3, unit: '%', max: 10, state: 'ok' },
    ],
  }],
};
const SNAP: MonitorSnapshot = {
  enabled: true, source: 'demo', updatedAt: '2026-10-09T12:03:00+09:00', state: 'down',
  counts: { ...zero, down: 1, warn: 2, ok: 5 }, groups: [WEB, SHOP],
};

test('그룹 목록: 줄마다 기호·이름·가장 나쁜 수, 카드는 전체 요약', () => {
  setLocale('ko');
  const l = layoutMonitorList(groupsView(SNAP));
  assert.ok(l.list);
  assert.match(l.list.items[0]!, /^■ web[\s　]+DOWN 1$/);
  assert.match(l.list.items[1]!, /^▲ 쇼핑몰[\s　]+주의 1$/);
  const card = l.card.text.split('\n');
  assert.match(card[0]!, /^■ 문제[\s\u3000]+1$/);
  assert.match(card[3]!, /^서비스[\s　]+8\/9$/);
  assert.equal(l.card.capture, false);
  fits(l.card);
  for (const row of l.list.items) assert.ok(utf8Bytes(row) <= 63, `${utf8Bytes(row)}바이트: ${row}`);
  assert.ok(l.list.x + l.list.w <= l.card.x, '목록과 카드가 겹치지 않는다');
});

test('대상 목록: 줄 오른쪽은 첫 문제, 카드는 그룹 요약과 지표마다 가장 나쁜 값', () => {
  setLocale('ko');
  const l = layoutMonitorList(groupView(SNAP, WEB));
  assert.match(l.list!.items[0]!, /web-03[\s　]+worker DOWN$/);
  assert.match(l.list!.items[1]!, /web-04[\s　]+CPU 84%$/);
  assert.match(l.list!.items[2]!, /web-01[\s　]+정상$/);
  const card = l.card.text.split('\n');
  assert.equal(card[0], 'web');
  assert.ok(card.some((x) => /^CPU[\s　]+89% ▲$/.test(x)), card.join('\n'));
  fits(l.card);
});

test('한 장: 막대가 같은 자리에서 시작하고, 값은 오른쪽, DOWN이면 굵은 테두리', () => {
  setLocale('ko');
  const l = layoutMonitorItem(itemView(SNAP, WEB, 0));
  assert.equal(l.statusLeft.text, '■ web-03');
  assert.match(l.statusRight.text, /web · DOWN · 12:03 기준$/);
  const lines = l.card.text.split('\n');
  const starts = lines.slice(0, 3).map((x) => getTextWidth(x.slice(0, x.indexOf('█'))));
  assert.ok(Math.max(...starts) - Math.min(...starts) <= 5, `막대 시작이 어긋난다: ${starts}`);
  assert.match(lines[0]!, /89% {2}▲$/);
  assert.match(lines[3]!, /^서비스\s+■ worker\u3000● api\u3000● nginx$/);
  assert.equal(l.card.border?.width, 2);
  fits(l.card);
  assert.equal(layoutMonitorItem(itemView(SNAP, WEB, 2)).card.border?.width, 1);
});

test('한 장: 끝값이 없는 업무 지표는 막대 없이 값만', () => {
  setLocale('ko');
  const lines = layoutMonitorItem(itemView(SNAP, SHOP, 0)).card.text.split('\n');
  assert.ok(!lines[0]!.includes('█') && /1,248건/.test(lines[0]!));
  assert.ok(lines[2]!.includes('█'));
});

test('어떤 글이든 칸 안이다(긴 이름·많은 지표·영어)', () => {
  for (const locale of ['ko', 'en']) {
    setLocale(locale);
    const long: MonitorGroup = {
      ...WEB, name: '아주 길게 지은 운영 서버 그룹 이름'.repeat(2),
      items: [{
        id: 'x', name: 'very-long-hostname-for-production-database-01.example.internal', state: 'crit',
        metrics: Array.from({ length: 12 }, (_, i) => pct(`m${i}`, `지표 이름이 꽤 긴 편 ${i}`, i * 9, i === 11 ? 'crit' : 'ok')),
        services: Array.from({ length: 20 }, (_, i) => ({ name: `service-${i}`, up: i % 3 !== 0 })),
      }],
    };
    const snap = { ...SNAP, stale: true, groups: [long, WEB, SHOP] };
    for (const view of [groupsView(snap), groupView(snap, long), groupView(snap, WEB), groupView(snap, SHOP)]) {
      const l = layoutMonitorList(view);
      fits(l.card);
      for (const row of l.list?.items ?? []) assert.ok(utf8Bytes(row) <= 63 && getTextWidth(row) <= 390 - 8 - 24, row);
      assert.ok(getTextWidth(l.statusLeft.text) <= l.statusLeft.w, l.statusLeft.text);
      fits(l.footer, 288);
    }
    for (const view of [itemView(snap, long, 0), itemView(snap, WEB, 0), itemView(snap, SHOP, 0)]) {
      const l = layoutMonitorItem(view);
      fits(l.card);
      fits(l.footer, 288);
    }
    const crowded = layoutMonitorItem(itemView(snap, long, 0)).card.text;
    assert.ok(crowded.split('\n').some((x) => x.includes('99%') && x.endsWith('■')), `위험 지표는 남는다:\n${crowded}`);
  }
  setLocale('ko');
});

test('줄이 없으면 가운데 안내가 조작을 받는다', () => {
  setLocale('ko');
  const off = layoutMonitorList(groupsView({ ...SNAP, enabled: false, groups: [] }));
  assert.equal(off.list, undefined);
  assert.equal(off.card.capture, true);
  assert.match(off.card.text, /모니터링 설정이 없습니다/);
});
