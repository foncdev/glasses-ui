/**
 * G2 목록은 20줄까지다.
 *
 * 알림이 24건 쌓이자 홈에는 '7 new'인데 알림 목록은 한 줄만 뜨고 탭도 먹지
 * 않았다. 25줄(알림 24 + 모두 읽음)을 한 번에 보내 목록이 서지 못한 것이다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli } from '../src/core/agent-cli.js';
import type { ChecklistView, GestureEvent, GlassesAdapter, NotificationsView } from '../src/core/glasses.js';
import { layoutNotifications } from '../src/adapters/g2-inbox.js';

const settle = () => new Promise((res) => setTimeout(res, 60));

test('알림·할 일이 20건을 넘어도 목록은 20줄 안에서 그리고, 끝 줄이 동작이다', async () => {
  const notifs: NotificationsView[] = [];
  const lists: ChecklistView[] = [];
  let onGesture: ((e: GestureEvent) => void) | undefined;
  const glasses = {
    name: 'stub',
    isVoiceEnabled: false,
    async connect() {},
    async disconnect() {},
    async showList() {},
    async showText() {},
    async showHome() {},
    async showNotifications(v: NotificationsView) {
      notifs.push(v);
    },
    async showChecklist(v: ChecklistView) {
      lists.push(v);
    },
    speak() {},
    stopSpeaking() {},
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

  const items = Array.from({ length: 24 }, (_, i) => ({
    id: `n${i}`,
    title: `알림 ${i}`,
    body: '',
    kind: 'info',
    createdAt: '',
    ...(i < 7 ? {} : { readAt: '2026-01-01T00:00:00Z' }),
  }));
  const todos = Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, text: `할 일 ${i}`, done: i === 0, createdAt: '' }));
  let readAll = 0;
  const orig = { ...agentCli };
  Object.assign(agentCli, {
    listSessions: async () => [],
    listNotifications: async () => ({ items, unread: 7 }),
    getGlobalChecklist: async () => todos,
    readAllNotifications: async () => {
      readAll += 1;
    },
    sysSummary: async () => {
      throw new Error('없음');
    },
  });
  const ui = new GlassesUI(glasses, { onLog: () => {} });
  const r = ui as unknown as { openMenu(t: string): Promise<void>; screenOff: boolean };
  try {
    await ui.start();
    r.screenOff = false;

    await r.openMenu('notifications');
    const v = notifs.at(-1)!;
    assert.equal(v.rows.length, 19, '알림은 19줄까지');
    assert.equal(v.unread, 7, '안 읽은 수는 전체에서 센다');
    assert.equal(v.counts.find((c) => c.kind === 'info')?.count, 7);
    const list = layoutNotifications(v).list!;
    assert.equal(list.items.length, 20, '모두 읽음까지 20줄');
    assert.match(list.items.at(-1)!, /모두 읽음/);

    // 끝 줄(20번째)을 누르면 모두 읽음이다.
    onGesture?.({ gesture: 'tap', selectedIndex: 19 } as GestureEvent);
    await settle();
    assert.equal(readAll, 1, '끝 줄이 모두 읽음이 아니다');

    await r.openMenu('checklist');
    const c = lists.at(-1)!;
    assert.equal(c.items.length, 19, '할 일은 19줄까지');
    assert.equal(c.progress.total, 25, '진행 수는 전체에서 센다');
  } finally {
    await ui.stop();
    Object.assign(agentCli, orig);
  }
});
