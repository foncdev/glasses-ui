/**
 * 알림 팝업이 잠깐 알리고 사라지는지 검증.
 *
 * 팝업이 탭할 때까지 남아 있어서 세 가지가 한꺼번에 망가져 있었다.
 *   1. 화면이 팝업 상태로 굳는다 — 알림은 잠깐 알리고 사라져야 한다
 *   2. 다음 알림이 "이미 떠 있다"는 이유로 막힌다 — 첫 알림만 계속 보인다
 *   3. 팝업을 들고 화면이 꺼지면, 깨어나도 지나간 알림이 남고
 *      그동안의 새 알림이 전부 막힌다
 *
 * 놓쳐도 알림 목록에 남으므로 팝업이 사라져도 잃는 것이 없다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli } from '../src/core/agent-cli.js';
import type { GestureEvent, GlassesAdapter, ItemLike } from '../src/core/glasses.js';
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

function stub() {
  const texts: string[] = [];
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
      void cb;
      return () => {};
    },
  } as unknown as GlassesAdapter;
  return { glasses, texts };
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
    sleep(): Promise<void>;
  };
  r.screenOff = false;
  r.screen = 'home';
  // 6초를 기다리지 않는다. 걷히는 동작만 보면 된다.
  (r as unknown as { noticeMs: number }).noticeMs = 60;

  return {
    r,
    ...s,
    setList: (next: Notif[]) => {
      list = next;
    },
    restore: () => Object.assign(agentCli, orig),
  };
}

const settle = (ms = 30) => new Promise((res) => setTimeout(res, ms));

test('팝업은 시간이 지나면 스스로 사라진다', async () => {
  // 알림은 잠깐 알리고 사라져야 한다.
  const { r, setList, restore } = await setup([N('n1', '지난 알림')]);
  try {
    setList([N('n2', '새 알림'), N('n1', '지난 알림')]);
    await r.refreshSummary();
    assert.ok(r.notice, '일단 떠야 한다');

    assert.ok(
      (r as unknown as { noticeTimer?: unknown }).noticeTimer,
      '스스로 사라질 타이머가 없다 — 탭까지 굳는다',
    );

    // 실제로 걷히는지 본다. 타이머만 걸고 안 지우는 실수를 잡는다.
    await settle(120);
    assert.equal(r.notice, null, '시간이 지나도 팝업이 남았다');
  } finally {
    restore();
  }
});

test('다음 알림이 앞선 팝업을 덮는다', async () => {
  // 첫 알림만 계속 보이던 증상이다.
  const { r, setList, restore } = await setup([N('n1', '지난 알림')]);
  try {
    setList([N('n2', '첫 알림'), N('n1', '지난 알림')]);
    await r.refreshSummary();
    assert.equal(r.notice?.title, '첫 알림');

    // 탭하지 않은 채로 다음 알림이 온다.
    setList([N('n3', '둘째 알림'), N('n2', '첫 알림'), N('n1', '지난 알림')]);
    await r.refreshSummary();
    assert.equal(r.notice?.title, '둘째 알림', '앞선 팝업에 막혀 최신을 놓쳤다');
  } finally {
    restore();
  }
});

test('팝업을 들고 화면이 꺼지지 않는다', async () => {
  const { r, setList, restore } = await setup([N('n1', '지난 알림')]);
  try {
    setList([N('n2', '새 알림'), N('n1', '지난 알림')]);
    await r.refreshSummary();
    assert.ok(r.notice);

    await r.sleep();
    assert.equal(r.notice, null, '팝업을 들고 꺼졌다 — 깨어나면 지나간 알림이 보인다');
  } finally {
    restore();
  }
});

test('꺼진 뒤 온 알림이 막히지 않는다', async () => {
  // 알림 → 유지 → 꺼짐 → 다음 알림이 안 오던 증상이다.
  const { r, setList, restore } = await setup([N('n1', '지난 알림')]);
  try {
    setList([N('n2', '첫 알림'), N('n1', '지난 알림')]);
    await r.refreshSummary();
    await r.sleep();

    setList([N('n3', '꺼진 뒤 온 알림'), N('n2', '첫 알림'), N('n1', '지난 알림')]);
    await r.refreshSummary();
    await settle();

    assert.equal(r.notice?.title, '꺼진 뒤 온 알림', '꺼진 뒤 알림이 막혔다');
    assert.equal(r.screenOff, false, '알림이 화면을 깨우지 못했다');
  } finally {
    restore();
  }
});

test('권한 요청은 알림으로 덮지 않는다', async () => {
  // 사용자가 답해야 작업이 진행된다. 가리면 승인이 막힌다.
  const { r, setList, restore } = await setup([N('n1', '지난 알림')]);
  try {
    (r as unknown as { pending: unknown }).pending = {
      id: 'p1',
      toolName: 'Bash',
      summary: 'rm -rf',
    };
    setList([N('n2', '새 알림'), N('n1', '지난 알림')]);
    await r.refreshSummary();
    assert.equal(r.notice, null, '권한 요청을 알림으로 가렸다');
  } finally {
    restore();
  }
});
