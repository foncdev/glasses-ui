/**
 * 꾸민 할 일 화면 검증.
 *
 * 안 함 □, 함 ▣. 목록 끝 '완료 항목 치우기'는 예전 자리(마지막)를 지킨다 —
 * 탭 처리가 그 자리를 동작으로 읽는다. 할 일이 없으면 안내 카드가 조작을
 * 받는다(더블탭 뒤로).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { measureTextWrap } from '@evenrealities/pretext';
import { G2Display } from '../src/adapters/g2-display.js';
import { ITEM_MAX_BYTES, utf8Bytes } from '../src/adapters/g2-bytes.js';
import type { Box } from '../src/adapters/g2-home.js';
import { layoutChecklist } from '../src/adapters/g2-todo.js';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli } from '../src/core/agent-cli.js';
import type { ChecklistView, GestureEvent, GlassesAdapter } from '../src/core/glasses.js';

const VIEW: ChecklistView = {
  title: '$ ~/todo',
  status: '2 / 6   14:05',
  items: [
    { done: true, text: 'glasses-g2 0.3.9 실기기에 설치' },
    { done: false, text: '링 스크롤 중 화면 꺼짐 확인하고 안 되면 무조작 타이머를 스크롤 이벤트로 다시 세기' },
    { done: false, text: 'iOS 앱 API 키 새 값으로 바꾸기' },
  ],
  action: '완료 항목 치우기',
  progress: { done: 1, total: 3 },
  hint: '● 체크    ●● 뒤로',
  note: '폰·웹에서 추가',
};

const inner = (b: Box) => b.w - 2 * (b.padding + (b.border?.width ?? 0));
const innerH = (b: Box) => b.h - 2 * (b.padding + (b.border?.width ?? 0));
const fits = (b: Box & { text: string }) =>
  b.text.split('\n').every((l) => measureTextWrap(l, inner(b)).lineCount <= 1) &&
  innerH(b) >= b.text.split('\n').length * 27;

test('함 ▣·안 함 □, 63바이트, 끝에 치우기 줄', () => {
  const l = layoutChecklist(VIEW);
  const items = l.list!.items;
  assert.ok(items[0]!.startsWith('▣') && items[1]!.startsWith('□'));
  assert.equal(items.at(-1), '»  완료 항목 치우기');
  for (const i of items) assert.ok(utf8Bytes(i) <= ITEM_MAX_BYTES, `${utf8Bytes(i)}: ${i}`);
  assert.equal(l.list!.h, 4 * 40 + 8, '항목 수만큼만 높다');
});

test('진행 카드가 칸 안에 들고 비율·남음·완료를 보여준다', () => {
  const l = layoutChecklist(VIEW);
  assert.ok(fits(l.card) && fits(l.footer));
  assert.match(l.card.text, /진행\s+33%\n█{2}▒{5}\n□\s+남음\s+2\n▣\s+완료\s+1/);
  assert.equal(l.card.capture, false);
});

test('할 일이 없으면 목록 없이 안내 카드가 조작을 받는다', async () => {
  const l = layoutChecklist({ ...VIEW, items: [], action: undefined, progress: { done: 0, total: 0 } });
  assert.equal(l.list, undefined);
  assert.equal(l.card.capture, true);
  assert.ok(fits(l.card));

  const calls: string[] = [];
  const display = new G2Display();
  (display as unknown as { bridge: unknown }).bridge = {
    async rebuildPageContainer(c: { textObject?: { containerName?: string; isEventCapture?: number }[]; listObject?: unknown[] }) {
      calls.push(`list=${c.listObject?.length ?? 0} capture=${(c.textObject ?? []).filter((t) => t.isEventCapture === 1).map((t) => t.containerName).join(',')}`);
      return true;
    },
    async textContainerUpgrade() { return true; },
  };
  await display.showChecklist({ ...VIEW, items: [], action: undefined, progress: { done: 0, total: 0 } });
  await display.showChecklist(VIEW);
  assert.deepEqual(calls, ['list=0 capture=side', 'list=1 capture=']);
});

test('본체: 전역 목록은 ~/todo, 세션 목록은 세션 제목 아래 todo', async () => {
  let seen: ChecklistView | undefined;
  const glasses = {
    name: 'stub', isVoiceEnabled: false,
    async connect() {}, async disconnect() {}, async showList() {}, async showText() {}, async showHome() {},
    async showChecklist(v: ChecklistView) { seen = v; },
    speak() {}, stopSpeaking() {}, setVoiceEnabled() {},
    async saveSetting() {}, async loadSetting() { return ''; },
    onGesture(_cb: (e: GestureEvent) => void) { return () => {}; },
  } as unknown as GlassesAdapter;
  const orig = { ...agentCli };
  Object.assign(agentCli, {
    listSessions: async () => [],
    listNotifications: async () => ({ items: [], unread: 0 }),
    getGlobalChecklist: async () => [],
    sysSummary: async () => { throw new Error('x'); },
  });
  try {
    const ui = new GlassesUI(glasses, { onLog: () => {} });
    await ui.start();
    const r = ui as unknown as Record<string, unknown> & { render(): Promise<void> };
    r.screen = 'checklist';
    r.checklist = [
      { id: 'a', text: '하나', done: true, createdAt: '' },
      { id: 'b', text: '둘', done: false, createdAt: '' },
    ];
    r.checkGlobal = true;
    await r.render();
    assert.equal(seen!.title, '$ ~/todo');
    assert.deepEqual(seen!.progress, { done: 1, total: 2 });
    assert.match(seen!.status, /^1 \/ 2/);
    assert.equal(seen!.action, '완료 항목 치우기');

    r.checkGlobal = false;
    r.sessions = [{ id: 's', title: '빌드 고치기' }];
    r.activeId = 's';
    await r.render();
    assert.equal(seen!.title, '$ ~/빌드 고치기/todo');
  } finally {
    Object.assign(agentCli, orig);
  }
});

test('할 일 화면에서는 할 일 변경 알림을 팝업으로 띄우지 않는다', async () => {
  const r = new GlassesUI(
    {
      name: 'stub', isVoiceEnabled: false,
      async connect() {}, async disconnect() {}, async showList() {}, async showText() {},
      speak() {}, stopSpeaking() {}, setVoiceEnabled() {},
      async saveSetting() {}, async loadSetting() { return ''; },
      onGesture() { return () => {}; },
    } as unknown as GlassesAdapter,
    { onLog: () => {} },
  ) as unknown as Record<string, unknown> & { noticeForNewNotifications(items: unknown[]): void };
  const n = (id: string, title: string) => ({ id, title, body: '', kind: 'done', createdAt: '' });
  r.lastSeenNotifId = 'old';
  r.screen = 'checklist';
  r.noticeForNewNotifications([n('a', '할 일 완료: 설치')]);
  assert.equal(r.notice, null, '방금 체크한 것은 띄우지 않는다');
  r.noticeForNewNotifications([n('b', '배포 실패')]);
  assert.equal((r.notice as { title: string } | null)?.title, '배포 실패', '다른 알림은 띄운다');
});
