/**
 * 앱이 뒤로 물러났다 돌아올 때를 검증.
 *
 * 안경은 화면이 꺼지면 앱을 뒤로 물리고 화면 컨테이너를 걷어간다.
 * 돌아온 뒤 그냥 그리면 조용히 실패해, 그 뒤로는 알림도 조작도 화면에
 * 나타나지 않는다. 시뮬레이터는 앱을 물리지 않아 이 경로를 한 번도
 * 타지 않았고, 그래서 실기기에서만 증상이 났다.
 *
 * 화면을 다시 세우는 것과 자료를 다시 읽는 것, 둘 다 필요하다.
 * 세우기 전에 그리면 그 그리기가 버려진다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli } from '../src/core/agent-cli.js';
import type { GestureEvent, GlassesAdapter, ItemLike } from '../src/core/glasses.js';
import { readLifecycle } from '../src/adapters/g2.js';
import { GLASSES_LOGO } from '../src/adapters/g2-logo.js';

type Notif = {
  id: string;
  title: string;
  body: string;
  kind: string;
  createdAt: string;
  readAt?: string;
};

const N = (id: string, title: string): Notif => ({
  id,
  title,
  body: `${title} 본문`,
  kind: 'info',
  createdAt: '',
});

/** 어떤 순서로 무슨 일이 있었는지 기록하는 스텁. */
function stub() {
  const calls: string[] = [];
  let onLife: ((p: 'foreground' | 'background') => void) | undefined;

  const glasses = {
    name: 'stub',
    logo: GLASSES_LOGO,
    get isVoiceEnabled() {
      return true;
    },
    async connect() {},
    async disconnect() {},
    async showList(header: string, items: readonly ItemLike[]) {
      void header;
      void items;
      calls.push('draw');
    },
    async showText(t: string) {
      calls.push(t.trim() ? 'draw' : 'blank');
    },
    async speak() {},
    setVoiceEnabled() {},
    async saveSetting() {},
    async loadSetting() {
      return '';
    },
    onGesture(cb: (e: GestureEvent) => void) {
      void cb;
      return () => {};
    },
    onLifecycle(cb: (p: 'foreground' | 'background') => void) {
      onLife = cb;
      return () => {};
    },
    async reattach() {
      calls.push('reattach');
    },
  } as unknown as GlassesAdapter;

  return { glasses, calls, life: (p: 'foreground' | 'background') => onLife?.(p) };
}

async function setup(initial: Notif[]) {
  const s = stub();
  const relay = new GlassesUI(s.glasses, { onLog: () => {} });
  let list = initial;

  const orig = {
    listSessions: agentCli.listSessions,
    listNotifications: agentCli.listNotifications,
    getGlobalChecklist: agentCli.getGlobalChecklist,
    streamEvents: agentCli.streamEvents,
  };
  agentCli.listSessions = async () => [] as never;
  agentCli.listNotifications = async () => ({
    items: list as never,
    unread: list.filter((n) => !n.readAt).length,
  });
  agentCli.getGlobalChecklist = async () => [] as never;
  agentCli.streamEvents = (() => () => undefined) as typeof agentCli.streamEvents;

  await relay.start();

  const r = relay as unknown as {
    screen: string;
    screenOff: boolean;
    notice: { title: string } | null;
    refreshSummary(): Promise<void>;
  };
  r.screenOff = false;
  r.screen = 'home';

  return {
    r,
    ...s,
    setList: (next: Notif[]) => {
      list = next;
    },
    restore: () => Object.assign(agentCli, orig),
  };
}

const settle = () => new Promise((res) => setTimeout(res, 40));

test('뒤로 물러나면 그리기를 멈춘다', async () => {
  const { r, calls, life, restore } = await setup([N('n1', '지난 알림')]);
  try {
    life('background');
    await settle();
    assert.equal(r.screenOff, true, '물러났는데 계속 그리려 한다');

    const before = calls.length;
    await r.refreshSummary();
    assert.equal(calls.length, before, '물러난 동안 그렸다 — 그 그리기는 버려진다');
  } finally {
    restore();
  }
});

test('돌아오면 화면을 먼저 세우고 그린다', async () => {
  // 순서가 뒤바뀌면 첫 그리기가 사라진다.
  const { calls, life, restore } = await setup([N('n1', '지난 알림')]);
  try {
    life('background');
    await settle();
    calls.length = 0;

    life('foreground');
    await settle();

    assert.equal(calls[0], 'reattach', `먼저 세워야 한다 (실제: ${calls.join(',')})`);
    assert.ok(calls.includes('draw'), '세운 뒤 그리지 않았다');
  } finally {
    restore();
  }
});

test('물러난 사이 온 알림이 돌아올 때 뜬다', async () => {
  // 이게 실기기에서 알림이 안 뜨던 증상이다.
  const { r, setList, life, restore } = await setup([N('n1', '지난 알림')]);
  try {
    life('background');
    await settle();

    setList([N('n2', '물러난 사이 온 알림'), N('n1', '지난 알림')]);
    life('foreground');
    await settle();

    assert.equal(r.notice?.title, '물러난 사이 온 알림', '돌아왔는데 알림을 놓쳤다');
    assert.equal(r.screenOff, false, '돌아왔으면 화면이 살아야 한다');
  } finally {
    restore();
  }
});

// --- 이벤트 해석 ---

test('앞뒤 전환 이벤트를 읽는다', () => {
  assert.equal(readLifecycle({ sysEvent: { eventType: 4 } } as never), 'foreground');
  assert.equal(readLifecycle({ sysEvent: { eventType: 5 } } as never), 'background');
});

test('탭은 전환으로 읽지 않는다', () => {
  // protobuf가 0을 생략해 eventType이 빠진 채 온다. ?? 0 보정이 없으면
  // 탭이 전환으로 오해돼 화면이 멋대로 다시 세워진다.
  assert.equal(readLifecycle({ sysEvent: {} } as never), null);
  assert.equal(readLifecycle({ sysEvent: { eventType: 3 } } as never), null);
  assert.equal(readLifecycle({ listEvent: { eventType: 0 } } as never), null);
});
