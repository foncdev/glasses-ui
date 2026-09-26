/**
 * 꾸민 홈 화면 검증.
 *
 * 메뉴 오른쪽 숫자가 바뀌면 목록을 다시 세워야 하고, 그러면 선택이 첫
 * 항목으로 돌아간다. 그래서 자주 바뀌는 값(시각·작업 중 수·CPU)은
 * 상태 표시줄과 게이지에 두고 글자만 고친다. 그 약속을 여기서 지킨다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { measureTextWrap } from '@evenrealities/pretext';
import { G2Display } from '../src/adapters/g2-display.js';
import { gauge, layoutHome, spread } from '../src/adapters/g2-home.js';
import { GLASSES_LOGO } from '../src/adapters/g2-logo.js';
import type { HomeView } from '../src/core/glasses.js';

const VIEW: HomeView = {
  title: '$ relay ~/home',
  status: '● online  14:05',
  items: [
    { label: '에이전트', meta: '2' },
    { label: '알림 보기', meta: '3 new' },
    { label: '체크 보기', meta: '0 / 1' },
    { label: '시스템' },
    { label: '명령', meta: '5' },
    { label: '설정' },
  ],
  logo: GLASSES_LOGO,
  gauges: [
    { label: 'cpu', ratio: 0.42, text: '42%' },
    { label: 'mem', ratio: 0.61, text: '61%' },
  ],
};

/** 칸 안쪽 폭에서 글이 접히지 않는지. 접히면 스크롤바가 생기고 로고가 깨진다. */
function fitsOneLinePerRow(text: string, boxW: number, inset: number): boolean {
  return text.split('\n').every((line) => measureTextWrap(line, boxW - 2 * inset).lineCount === 1);
}

test('로고와 게이지가 칸 안에서 접히지 않는다', () => {
  const l = layoutHome(VIEW);
  assert.ok(l.card && fitsOneLinePerRow(l.card.text, l.card.w, l.card.padding + 1), '로고가 접힌다');
  assert.ok(l.stats && fitsOneLinePerRow(l.stats.text, l.stats.w, l.stats.padding), '게이지가 접힌다');
  assert.ok(fitsOneLinePerRow(l.statusRight.text, l.statusRight.w, l.statusRight.padding));
});

test('모든 칸이 576×288 안에 있다', () => {
  const l = layoutHome(VIEW);
  for (const b of [l.statusLeft, l.statusRight, l.divider, l.list, l.card!, l.stats!]) {
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= 576 && b.y + b.h <= 288, JSON.stringify(b));
  }
  // 목록 6칸(40px씩)이 다 보여야 한다.
  assert.ok(l.list.h - 2 * l.list.padding >= 6 * 40);
});

test('로고를 끄면 카드가, 시스템 상태가 없으면 게이지가 빠진다', () => {
  const l = layoutHome({ ...VIEW, logo: undefined, gauges: undefined });
  assert.equal(l.card, undefined);
  assert.equal(l.stats, undefined);
});

test('오른쪽 값은 정렬되고 긴 글은 잘린다', () => {
  const a = spread('에이전트', '2', 200);
  const b = spread('알림 보기', '3 new', 200);
  assert.ok(a.startsWith('에이전트') && a.endsWith('2'));
  assert.ok(b.endsWith('3 new'));
  assert.ok(measureTextWrap(spread('아주 긴 메뉴 이름이 들어오면 어떻게 되나 보자', '99', 200), 200).lineCount === 1);
  assert.equal(gauge(0.5, 8), '████▒▒▒▒');
  assert.equal(gauge(2, 4), '████', '넘치는 값은 가득으로');
});

function fakeBridge() {
  const calls: string[] = [];
  const bridge = {
    async rebuildPageContainer(c: { textObject?: { containerName?: string; textColor?: number }[] }) {
      calls.push(`rebuild:${(c.textObject ?? []).map((t) => t.containerName).join(',')}`);
      return true;
    },
    async textContainerUpgrade(c: { containerName?: string }) {
      calls.push(`upgrade:${c.containerName}`);
      return true;
    },
  };
  const display = new G2Display();
  (display as unknown as { bridge: unknown }).bridge = bridge;
  return { display, calls };
}

test('시각만 바뀌면 상태 표시줄만 고친다', async () => {
  const { display, calls } = fakeBridge();
  await display.showHome(VIEW);
  await display.showHome(VIEW);
  await display.showHome({ ...VIEW, status: '● online  14:06' });
  assert.deepEqual(calls, ['rebuild:main,status,divider,side,stats', 'upgrade:status']);
});

test('CPU만 바뀌면 게이지만 고친다', async () => {
  const { display, calls } = fakeBridge();
  await display.showHome(VIEW);
  await display.showHome({ ...VIEW, gauges: [{ label: 'cpu', ratio: 0.9, text: '90%' }, VIEW.gauges![1]!] });
  assert.deepEqual(calls.slice(1), ['upgrade:stats']);
});

test('메뉴 글자가 바뀌면 다시 세운다', async () => {
  const { display, calls } = fakeBridge();
  await display.showHome(VIEW);
  const items = VIEW.items.map((i, n) => (n === 1 ? { ...i, meta: '4 new' } : i));
  await display.showHome({ ...VIEW, items });
  assert.equal(calls.filter((c) => c.startsWith('rebuild')).length, 2);
});

test('다른 화면을 거치면 홈을 다시 세운다', async () => {
  const { display, calls } = fakeBridge();
  await display.showHome(VIEW);
  await display.showList('세션', ['a']);
  await display.showHome(VIEW);
  assert.equal(calls.filter((c) => c.startsWith('rebuild')).length, 3);
});
