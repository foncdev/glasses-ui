/**
 * 꾸민 세션 화면 검증.
 *
 * 목록 한 칸은 63바이트라 한글 제목에 오른쪽 정렬을 넣으면 넘친다.
 * 넘치면 목록이 통째로 안 그려지고 화면이 멈춘다. 그래서 목록은 제목과
 * 경과 시간만, 상태별 개수는 오른쪽 카드(글자 칸)에 둔다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { measureTextWrap } from '@evenrealities/pretext';
import { G2Display } from '../src/adapters/g2-display.js';
import { ITEM_MAX_BYTES, utf8Bytes } from '../src/adapters/g2-bytes.js';
import { layoutSessions } from '../src/adapters/g2-sessions.js';
import { timeAgo } from '../src/core/glasses-ui.js';
import type { SessionsView } from '../src/core/glasses.js';

const VIEW: SessionsView = {
  title: '$ relay ~/agents',
  status: '작업 1   ◆ 승인 1   14:05',
  rows: [
    { state: 'running', title: 'agent-cli 테스트 보강', meta: '방금' },
    { state: 'pending', title: 'relay 보안 점검', meta: '1분' },
    { state: 'idle', title: '안경 홈 화면을 상태 표시줄과 카드로 꾸미고 세션 화면까지', meta: '12분' },
    { state: 'offline', title: 'README 한글화', meta: '어제' },
  ],
  counts: [
    { state: 'running', label: '작업 중', count: 1 },
    { state: 'pending', label: '승인 요청', count: 1 },
    { state: 'idle', label: '대기', count: 1 },
    { state: 'offline', label: '종료', count: 1 },
  ],
  hint: '● 열기    ●● 뒤로',
  total: '세션 4개',
};

test('모든 줄이 63바이트 이하이고 경과 시간은 남는다', () => {
  const l = layoutSessions(VIEW);
  for (const [i, row] of l.list!.items.entries()) {
    assert.ok(utf8Bytes(row) <= ITEM_MAX_BYTES, `${utf8Bytes(row)}: ${row}`);
    assert.ok(row.endsWith(VIEW.rows[i]!.meta));
  }
  assert.ok(l.list!.items[0]!.startsWith('●'), '상태 기호가 앞에 온다');
  assert.ok(l.list!.items[3]!.startsWith('◌'), '끝난 세션은 점선 원');
});

test('카드와 안내 줄이 접히지 않고 화면 안에 있다', () => {
  const l = layoutSessions(VIEW);
  for (const b of [l.statusLeft, l.statusRight, l.divider, l.footer, l.card, l.list!]) {
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= 576 && b.y + b.h <= 288, JSON.stringify(b));
  }
  const inner = (b: { w: number; padding: number; border?: { width: number } }) =>
    b.w - 2 * (b.padding + (b.border?.width ?? 0));
  for (const line of l.card.text.split('\n')) assert.equal(measureTextWrap(line, inner(l.card)).lineCount, 1, line);
  assert.equal(measureTextWrap(l.footer.text, inner(l.footer)).lineCount, 1);
  assert.equal(l.card.capture, false, '목록이 조작을 받는다');
});

test('세션이 없으면 목록 대신 안내 카드가 조작을 받는다', () => {
  const l = layoutSessions({ ...VIEW, rows: [] });
  assert.equal(l.list, undefined);
  assert.equal(l.card.capture, true);
  assert.match(l.card.text, /연결된 세션이 없습니다/);
});

function fakeBridge() {
  const calls: string[] = [];
  const pages: Array<{ text: { name?: string; capture?: number }[]; list: number }> = [];
  const bridge = {
    async rebuildPageContainer(c: {
      textObject?: { containerName?: string; isEventCapture?: number }[];
      listObject?: unknown[];
    }) {
      calls.push('rebuild');
      pages.push({
        text: (c.textObject ?? []).map((t) => ({ name: t.containerName, capture: t.isEventCapture })),
        list: c.listObject?.length ?? 0,
      });
      return true;
    },
    async textContainerUpgrade(c: { containerName?: string }) {
      calls.push(`upgrade:${c.containerName}`);
      return true;
    },
  };
  const display = new G2Display();
  (display as unknown as { bridge: unknown }).bridge = bridge;
  return { display, calls, pages };
}

test('작업·승인 수와 시각만 바뀌면 글자만 고친다', async () => {
  const { display, calls } = fakeBridge();
  await display.showSessions(VIEW);
  await display.showSessions({
    ...VIEW,
    status: '14:06',
    counts: VIEW.counts.map((c) => (c.state === 'pending' ? { ...c, count: 0 } : c)),
  });
  assert.deepEqual(calls, ['rebuild', 'upgrade:status', 'upgrade:side']);
});

test('세션 줄이 바뀌면 다시 세우고, 홈과 세션을 오가도 다시 세운다', async () => {
  const { display, calls } = fakeBridge();
  await display.showSessions(VIEW);
  await display.showSessions({ ...VIEW, rows: VIEW.rows.slice(1) });
  await display.showHome({ title: 't', status: 's', items: [{ label: '에이전트' }] });
  await display.showSessions(VIEW);
  assert.equal(calls.filter((c) => c === 'rebuild').length, 4);
});

test('세션이 없으면 목록 없이 카드가 조작을 받는다', async () => {
  const { display, pages } = fakeBridge();
  await display.showSessions({ ...VIEW, rows: [] });
  assert.equal(pages[0]!.list, 0);
  assert.deepEqual(pages[0]!.text.filter((t) => t.capture === 1).map((t) => t.name), ['side']);
});

test('경과 시간은 짧게 쓴다', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const ago = (ms: number) => timeAgo(new Date(now - ms).toISOString(), now);
  assert.equal(ago(20_000), '방금');
  assert.equal(ago(12 * 60_000), '12분');
  assert.equal(ago(3 * 3600_000), '3시간');
  assert.equal(ago(30 * 3600_000), '어제');
  assert.equal(ago(4 * 86400_000), '4일');
  assert.equal(timeAgo(undefined, now), '');
});
