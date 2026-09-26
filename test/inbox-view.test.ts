/**
 * 꾸민 알림 화면(목록·내용·팝업) 검증.
 *
 * 모양은 갈래, 채움은 안 읽음이다. 목록 칸은 63바이트이고 밝기를 따로
 * 줄 수 없다. 글자 칸은 안쪽 높이가 줄 수 × 27보다 작으면 스크롤바가
 * 생긴다(시안의 팝업 카드에서 2px 모자라 생겼다).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { measureTextWrap } from '@evenrealities/pretext';
import { G2Display } from '../src/adapters/g2-display.js';
import { ITEM_MAX_BYTES, utf8Bytes } from '../src/adapters/g2-bytes.js';
import {
  boxHeight,
  layoutNotice,
  layoutNotification,
  layoutNotifications,
  wrapText,
} from '../src/adapters/g2-inbox.js';
import type { Box } from '../src/adapters/g2-home.js';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli } from '../src/core/agent-cli.js';
import type {
  GestureEvent,
  GlassesAdapter,
  NoticeView,
  NotificationView,
  NotificationsView,
} from '../src/core/glasses.js';

const LIST: NotificationsView = {
  title: '$ relay ~/inbox',
  status: '● 새 2   14:05',
  rows: [
    { kind: 'error', read: false, title: '배포 실패: relay-service 도커 허브 인증 토큰이 만료됨', meta: '방금' },
    { kind: 'done', read: false, title: '테스트 통과', meta: '2분' },
    { kind: 'info', read: true, title: 'PR #42 머지됨', meta: '1시간' },
  ],
  counts: [
    { kind: 'error', label: '오류', count: 1 },
    { kind: 'permission', label: '권한', count: 0 },
    { kind: 'done', label: '완료', count: 1 },
    { kind: 'info', label: '정보', count: 0 },
  ],
  unread: 2,
  action: '모두 읽음 처리',
  hint: '● 열기    ●● 뒤로',
  legend: '채움 = 안 읽음',
};

const inner = (b: Box) => b.w - 2 * (b.padding + (b.border?.width ?? 0));
const innerH = (b: Box) => b.h - 2 * (b.padding + (b.border?.width ?? 0));

/** 글이 칸 안에서 접히지 않고, 줄 수만큼 높이가 있는지. */
function fits(b: Box & { text: string }): boolean {
  const lines = b.text.split('\n');
  return (
    lines.every((l) => measureTextWrap(l, inner(b)).lineCount <= 1) && innerH(b) >= lines.length * 27
  );
}

function onScreen(b: Box): boolean {
  return b.x >= 0 && b.y >= 0 && b.x + b.w <= 576 && b.y + b.h <= 288;
}

test('목록: 모양은 갈래, 채움은 안 읽음이고 63바이트를 넘지 않는다', () => {
  const l = layoutNotifications(LIST);
  const items = l.list!.items;
  assert.ok(items[0]!.startsWith('◆') && items[1]!.startsWith('●') && items[2]!.startsWith('□'));
  assert.equal(items.at(-1), '»  모두 읽음 처리', '동작 줄은 맨 끝');
  for (const i of items) assert.ok(utf8Bytes(i) <= ITEM_MAX_BYTES, `${utf8Bytes(i)}: ${i}`);
  assert.ok(items[0]!.endsWith('방금'), '긴 제목을 줄여도 시간은 남는다');
  assert.ok(fits(l.card) && fits(l.footer) && onScreen(l.card) && onScreen(l.list!));
  assert.match(l.card.text, /새 알림\s+2/);
});

test('목록: 알림이 없으면 안내 카드가 조작을 받는다', () => {
  const l = layoutNotifications({ ...LIST, rows: [], unread: 0, action: undefined });
  assert.equal(l.list, undefined);
  assert.equal(l.card.capture, true);
  assert.ok(fits(l.card));
});

const DETAIL: NotificationView = {
  title: '$ relay ~/inbox',
  status: '3분 전   14:05',
  kind: 'error',
  label: '오류',
  heading: '배포 실패: relay-service',
  body: 'docker push 단계에서 인증 오류가 났습니다. DOCKERHUB_TOKEN이 만료됐을 수 있습니다. '.repeat(4),
  hint: '● 닫기    ●● 뒤로',
};

test('내용: 머리 카드와 본문이 칸 안에 들고, 본문은 4줄에서 …로 끝난다', () => {
  const l = layoutNotification(DETAIL);
  assert.ok(fits(l.head) && fits(l.body) && onScreen(l.head) && onScreen(l.body));
  assert.equal(l.body.text.split('\n').length, 4);
  assert.ok(l.body.text.endsWith('…'));
  assert.ok(l.body.y + l.body.h <= 256, '안내 줄을 가리지 않는다');
});

test('낱말 단위로 줄을 나눈다(낱말 한가운데서 끊지 않는다)', () => {
  const lines = wrapText('docker push 단계에서 DOCKERHUB_TOKEN이 만료됐습니다', 220, 5);
  assert.ok(lines.some((l) => l.includes('DOCKERHUB_TOKEN이')), lines.join(' | '));
  assert.deepEqual(wrapText('', 200, 3), []);
  // 빈 줄에서 잘리면 …을 글이 있는 줄에 붙인다(홀로 남지 않게).
  const cut = wrapText('첫 줄\n둘째 줄\n\n— deploy', 300, 3);
  assert.deepEqual(cut, ['첫 줄', '둘째 줄 …']);
  assert.equal(boxHeight(2, 12, 2), 2 * 27 + 28 + 2);
});

const NOTICE: NoticeView = {
  kind: 'error',
  label: '오류',
  title: '배포 실패: relay-service',
  body: 'docker push 단계에서 인증 오류가 났습니다.',
  closeHint: '5초 후 닫힘  ·  탭: 닫기',
};

test('팝업: 카드에 스크롤바가 생기지 않고 본문이 없으면 비운다', () => {
  const l = layoutNotice(NOTICE);
  assert.ok(fits(l.card) && fits(l.body) && fits(l.hint));
  assert.match(l.card.text, /^◆\s+오류.*새 알림\n배포 실패/);
  assert.equal(layoutNotice({ ...NOTICE, body: '' }).body.text, ' ');
});

function fakeBridge() {
  const pages: Array<{ names: string[]; capture: string[]; list: number }> = [];
  const bridge = {
    async rebuildPageContainer(c: {
      textObject?: { containerName?: string; isEventCapture?: number }[];
      listObject?: unknown[];
    }) {
      pages.push({
        names: (c.textObject ?? []).map((t) => t.containerName!),
        capture: (c.textObject ?? []).filter((t) => t.isEventCapture === 1).map((t) => t.containerName!),
        list: c.listObject?.length ?? 0,
      });
      return true;
    },
    async textContainerUpgrade() {
      return true;
    },
  };
  const display = new G2Display();
  (display as unknown as { bridge: unknown }).bridge = bridge;
  return { display, pages };
}

test('내용·팝업은 본문 칸이, 목록은 목록이 조작을 받는다', async () => {
  const { display, pages } = fakeBridge();
  await display.showNotifications(LIST);
  await display.showNotification(DETAIL);
  await display.showNotice(NOTICE);
  assert.deepEqual(pages.map((p) => [p.list, p.capture]), [[1, []], [0, ['body']], [0, ['body']]]);
});

// --- 본체가 넘기는 값 ---

async function uiWith(notifications: unknown[]) {
  const seen: { list?: NotificationsView; detail?: NotificationView; notice?: NoticeView } = {};
  const glasses = {
    name: 'stub', isVoiceEnabled: false,
    async connect() {}, async disconnect() {}, async showList() {}, async showText() {},
    async showHome() {},
    async showNotifications(v: NotificationsView) { seen.list = v; },
    async showNotification(v: NotificationView) { seen.detail = v; },
    async showNotice(v: NoticeView) { seen.notice = v; },
    speak() {}, stopSpeaking() {}, setVoiceEnabled() {},
    async saveSetting() {}, async loadSetting() { return ''; },
    onGesture(_cb: (e: GestureEvent) => void) { return () => {}; },
  } as unknown as GlassesAdapter;
  const orig = { ...agentCli };
  let items = notifications;
  Object.assign(agentCli, {
    listSessions: async () => [],
    listNotifications: async () => ({ items, unread: items.filter((n) => !(n as { readAt?: string }).readAt).length }),
    getGlobalChecklist: async () => [],
    sysSummary: async () => { throw new Error('x'); },
  });
  const ui = new GlassesUI(glasses, { onLog: () => {} });
  await ui.start();
  const r = ui as unknown as {
    refreshSummary(): Promise<void>;
    openMenu(t: string): Promise<void>;
    render(): Promise<void>;
    screen: string;
    openNotif: unknown;
  };
  await r.refreshSummary();
  return {
    seen, r,
    push(n: unknown) { items = [n, ...items]; },
    restore() { Object.assign(agentCli, orig); },
  };
}

test('본체: 목록에 갈래·읽음·경과 시간과 갈래별 안 읽은 수를 넘긴다', async () => {
  const now = Date.now();
  const t = await uiWith([
    { id: 'a', title: '배포 실패', body: '', kind: 'error', createdAt: new Date(now - 60_000).toISOString() },
    { id: 'b', title: '빌드', body: '', kind: 'done', createdAt: new Date(now - 7200_000).toISOString(), readAt: 'x' },
  ]);
  try {
    await t.r.openMenu('notifications');
    const v = t.seen.list!;
    assert.deepEqual(v.rows.map((r) => [r.kind, r.read, r.meta]), [['error', false, '1분'], ['done', true, '2시간']]);
    assert.equal(v.counts.find((c) => c.kind === 'error')!.count, 1);
    assert.equal(v.counts.find((c) => c.kind === 'done')!.count, 0, '읽은 것은 세지 않는다');
    assert.equal(v.action, '모두 읽음 처리');
  } finally {
    t.restore();
  }
});

test('본체: 대화 전문을 볼 때는 ~/history로 시각만 보인다', async () => {
  const t = await uiWith([]);
  try {
    t.r.openNotif = { id: '', title: 'AI 응답', body: '긴 대답', kind: 'info', createdAt: '' };
    t.r.screen = 'notification';
    await t.r.render();
    const v = t.seen.detail!;
    assert.equal(v.title, '$ relay ~/history');
    assert.match(v.status, /^\d\d:\d\d$/);
    assert.equal(v.body, '긴 대답');
  } finally {
    t.restore();
  }
});

test('본체: 새 알림 팝업에 갈래를 싣고 별표를 뗀다', async () => {
  const t = await uiWith([{ id: 'old', title: '예전', body: '', kind: 'info', createdAt: '' }]);
  try {
    t.push({ id: 'new', title: '배포 실패', body: 'push 인증 오류', kind: 'error', createdAt: new Date().toISOString() });
    await t.r.refreshSummary();
    const v = t.seen.notice!;
    assert.equal(v.kind, 'error');
    assert.equal(v.label, '오류');
    assert.equal(v.body, 'push 인증 오류');
    assert.match(v.closeHint, /초 후 닫힘/);
  } finally {
    t.restore();
  }
});
