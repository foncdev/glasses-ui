/**
 * 무조작 화면 꺼짐 타이머 검증.
 *
 * 실기기에서 메인 메뉴인데 화면이 안 꺼지는 일이 간혹 있었다. 설정을
 * 다시 만지면 나았는데, 그건 설정이 wake()를 불러 타이머를 다시 걸어
 * 줬기 때문이다. 원인은 타이머가 사라지는 경로가 있다는 것이었다.
 *
 * setTimeout은 한 번 터지면 사라진다. 다시 거는 곳이 wake()뿐이라,
 * 이미 꺼진 상태로 sleep()에 다시 들어와 조기 반환하면 타이머를 놓쳤다.
 * 그 뒤 화면을 켜는 일이 생기면 켜진 채로 남았다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli } from '../src/core/agent-cli.js';
import type { GestureEvent, GlassesAdapter, ItemLike } from '../src/core/glasses.js';
import { GLASSES_LOGO } from '../src/adapters/g2-logo.js';

function stub() {
  const glasses = {
    name: 'stub',
    logo: GLASSES_LOGO,
    get isVoiceEnabled() {
      return true;
    },
    async connect() {},
    async disconnect() {},
    async showList(h: string, i: readonly ItemLike[]) {
      void h;
      void i;
    },
    async showText(t: string) {
      void t;
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
  return { glasses };
}

async function setup() {
  const s = stub();
  const relay = new GlassesUI(s.glasses, { onLog: () => {} });

  const orig = {
    listSessions: agentCli.listSessions,
    listNotifications: agentCli.listNotifications,
    getGlobalChecklist: agentCli.getGlobalChecklist,
    streamEvents: agentCli.streamEvents,
  };
  agentCli.listSessions = async () => [] as never;
  agentCli.listNotifications = async () => ({ items: [] as never, unread: 0 });
  agentCli.getGlobalChecklist = async () => [] as never;
  agentCli.streamEvents = (() => () => undefined) as typeof agentCli.streamEvents;

  await relay.start();

  const r = relay as unknown as {
    screenOff: boolean;
    idleMs: number;
    idleTimer?: ReturnType<typeof setTimeout>;
    screen: string;
    sleep(): Promise<void>;
    wake(): void;
  };
  r.screenOff = false;
  r.screen = 'home';

  return { relay, r, restore: () => Object.assign(agentCli, orig) };
}

test('꺼진 상태로 다시 sleep에 들어와도 타이머가 살아 있다', async () => {
  // 이게 화면이 안 꺼지던 원인이다. 타이머를 놓치면 다시 걸 기회가 없다.
  const { r, restore } = await setup();
  try {
    await r.sleep();
    assert.equal(r.screenOff, true);

    // 타이머가 터진 것처럼 비우고, 꺼진 상태로 다시 들어온다.
    clearTimeout(r.idleTimer);
    r.idleTimer = undefined;
    await r.sleep();

    assert.ok(r.idleTimer, '타이머를 놓쳤다 — 이후 화면이 켜지면 안 꺼진다');
  } finally {
    restore();
  }
});

test('화면이 실제로 꺼진다', async () => {
  const { r, restore } = await setup();
  try {
    r.idleMs = 40;
    r.wake();
    assert.equal(r.screenOff, false);

    await new Promise((res) => setTimeout(res, 90));
    assert.equal(r.screenOff, true, '무조작인데 화면이 꺼지지 않았다');
  } finally {
    restore();
  }
});

test('대화 이어가기가 화면을 켜면 타이머도 함께 건다', async () => {
  // render()를 거치지 않고 직접 그리는 자리다. 깨우지 않으면
  // 화면만 켜지고 꺼질 약속이 없어 그대로 남는다.
  const { relay, r, restore } = await setup();
  try {
    await r.sleep();
    clearTimeout(r.idleTimer);
    r.idleTimer = undefined;

    // 서버가 없으니 실패 경로로 간다. 그 경로도 직접 그린다.
    await relay.resume('nope').catch(() => undefined);

    assert.ok(r.idleTimer, '직접 그리고 타이머를 걸지 않았다');
  } finally {
    restore();
  }
});
