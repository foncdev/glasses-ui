/**
 * 꺼진 화면에 알림이 스스로 뜨는지, SSE가 막힌 경우를 검증.
 *
 * 실기기에서만 나던 증상이다. 시뮬레이터는 화면이 꺼지지 않아 잡히지
 * 않았다. 안경은 무조작 30초면 꺼지므로 알림은 대부분 꺼진 구간에
 * 들어온다. 그 구간을 건너뛰면 사용자가 안경을 만질 때까지 아무 일도
 * 일어나지 않아, 알림이라 할 수 없다.
 *
 * sleep()은 하드웨어를 끄는 것이 아니라 공백 한 칸을 그린 것이다.
 * 그래서 새 알림이 showText로 화면을 되찾을 수 있다.
 *
 * 다만 조용한 갱신은 화면을 깨우지 않아야 한다. 할 일 숫자가 하나
 * 바뀔 때마다 안경이 켜지면 쓸 수 없다. render()의 screenOff 가드가
 * 그 경계다.
 *
 * SSE는 G2 웹뷰가 막을 때가 있다. 그러면 주기 갱신이 알림을 띄우는
 * 유일한 경로라, 막힌 것을 알아채면 촘촘히 돈다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli } from '../src/core/agent-cli.js';
import { toItem, type GestureEvent, type GlassesAdapter, type ItemLike } from '../src/core/glasses.js';
import { asText } from './g2-text.js';
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
      void asText(items);
      void toItem;
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

/** streamEvents를 가로채 onChange/onDown을 직접 부를 수 있게 한다. */
async function setup(initial: Notif[]) {
  const s = stub();
  const relay = new GlassesUI(s.glasses, { onLog: () => {} });
  let list = initial;

  let fire: (() => void) | undefined;
  let setDown: ((d: boolean) => void) | undefined;

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
  agentCli.streamEvents = ((onChange: () => void, onDown?: (d: boolean) => void) => {
    fire = onChange;
    setDown = onDown;
    return () => undefined;
  }) as typeof agentCli.streamEvents;

  await relay.start();

  const r = relay as unknown as {
    screen: string;
    screenOff: boolean;
    missedWhileOff: boolean;
    sseDown: boolean;
    pollMs: number;
    notice: { title: string } | null;
    refreshSummary(): Promise<void>;
    wake(): void;
    sleep(): Promise<void>;
  };
  r.screenOff = false;
  r.screen = 'home';

  return {
    r,
    ...s,
    setList: (next: Notif[]) => {
      list = next;
    },
    fire: () => fire?.(),
    setDown: (d: boolean) => setDown?.(d),
    restore: () => Object.assign(agentCli, orig),
  };
}

/** 비동기 갱신이 끝날 틈을 준다. */
const settle = () => new Promise((res) => setTimeout(res, 30));

test('꺼진 화면에도 새 알림이 스스로 뜬다', async () => {
  // 이게 실기기에서 알림이 안 뜨던 원인이다. 꺼진 구간을 건너뛰면
  // 사용자가 안경을 만질 때까지 아무 일도 일어나지 않는다.
  const { r, setList, fire, texts, restore } = await setup([N('n1', '지난 알림')]);
  try {
    await r.sleep();
    assert.equal(r.screenOff, true, '먼저 꺼져 있어야 의미가 있다');

    setList([N('n2', '꺼진 사이 온 알림'), N('n1', '지난 알림')]);
    fire();
    await settle();

    assert.equal(r.screenOff, false, '알림이 화면을 깨우지 못했다');
    assert.equal(r.notice?.title, '꺼진 사이 온 알림');
    assert.ok(
      texts.some((t) => t.includes('꺼진 사이 온 알림')),
      '깨웠다면 화면에 내용이 그려져야 한다',
    );
  } finally {
    restore();
  }
});

test('새 알림이 없으면 꺼진 화면을 깨우지 않는다', async () => {
  // 할 일 숫자가 바뀔 때마다 안경이 켜지면 쓸 수 없다.
  const { r, fire, texts, restore } = await setup([N('n1', '지난 알림')]);
  try {
    await r.sleep();
    const before = texts.length;

    fire(); // 목록은 그대로 — 새 알림이 없다
    await settle();

    assert.equal(r.screenOff, true, '새 알림도 없는데 화면이 켜졌다');
    assert.equal(texts.length, before, '꺼진 화면에 그렸다');
  } finally {
    restore();
  }
});

test('SSE가 막히면 폴링을 촘촘히 돈다', async () => {
  const { r, setDown, restore } = await setup([N('n1', '지난 알림')]);
  try {
    const normal = r.pollMs;
    setDown(true);
    assert.ok(r.pollMs < normal, `막혔는데 주기가 그대로다 (${r.pollMs}ms)`);
    assert.equal(r.sseDown, true);

    // 되살아나면 원래 주기로 돌아간다.
    setDown(false);
    assert.equal(r.pollMs, normal, '되살아났는데 계속 촘촘히 돈다');
    assert.equal(r.sseDown, false);
  } finally {
    restore();
  }
});
