/**
 * 새 알림이 안경 화면에 뜨는지 검증.
 *
 * 웹이나 다른 기기에서 만든 알림은 안경이 만든 것이 아니다. 여태
 * 홈 요약의 숫자만 조용히 늘고 화면에는 아무것도 뜨지 않아서, 알림이
 * 온 줄 알려면 사용자가 홈을 들여다봐야 했다.
 *
 * 기준은 목록 맨 앞의 id다. 개수로 세면 하나 오고 하나 읽힌 순간을
 * 놓치고, 지운 뒤에는 줄어들어 새 알림을 지나간 것으로 오해한다.
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

function stub() {
  const shown: { header: string; items: string[] }[] = [];
  const texts: string[] = [];
  const spoken: string[] = [];
  const glasses = {
    name: 'stub',
    logo: GLASSES_LOGO,
    get isVoiceEnabled() {
      return true;
    },
    async connect() {},
    async disconnect() {},
    async showList(header: string, items: readonly ItemLike[]) {
      shown.push({ header, items: asText(items) });
    },
    async showText(t: string) {
      texts.push(t);
    },
    async speak(t: string) {
      spoken.push(t);
    },
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
  return { glasses, shown, texts, spoken };
}

/** 알림 목록을 마음대로 바꿔가며 세울 수 있는 relay. */
async function setup(initial: Notif[]) {
  const s = stub();
  const relay = new GlassesUI(s.glasses, { onLog: () => {} });
  let list = initial;

  const orig = {
    listSessions: agentCli.listSessions,
    listNotifications: agentCli.listNotifications,
    getGlobalChecklist: agentCli.getGlobalChecklist,
  };
  agentCli.listSessions = async () => [] as never;
  agentCli.listNotifications = async () => ({
    items: list as never,
    unread: list.filter((n) => !n.readAt).length,
  });
  agentCli.getGlobalChecklist = async () => [] as never;

  await relay.start();

  const r = relay as unknown as {
    screen: string;
    screenOff: boolean;
    notice: { title: string; text: string; heading?: string } | null;
    refreshSummary(): Promise<void>;
    render(): Promise<void>;
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

const N = (id: string, title: string, readAt?: string): Notif => ({
  id,
  title,
  body: `${title} 본문`,
  kind: 'info',
  createdAt: '',
  readAt,
});

test('첫 조회에서는 쌓여 있던 알림을 띄우지 않는다', async () => {
  // 켤 때마다 지난 알림이 쏟아지면 쓸 수 없다.
  const { r, restore } = await setup([N('n1', '지난 알림')]);
  try {
    assert.equal(r.notice, null, '시작 직후에 팝업이 떠 있으면 안 된다');
  } finally {
    restore();
  }
});

test('새 알림이 오면 화면에 띄우고 읽어준다', async () => {
  const { r, setList, texts, spoken, restore } = await setup([N('n1', '지난 알림')]);
  try {
    setList([N('n2', '배포 완료'), N('n1', '지난 알림')]);
    await r.refreshSummary();

    assert.ok(r.notice, '새 알림인데 팝업이 없다');
    assert.equal(r.notice?.title, '배포 완료');
    assert.equal(r.notice?.heading, '새 알림', "'작업 완료'로 뜨면 완료 알림과 구별되지 않는다");
    assert.ok(
      texts.some((t) => t.includes('배포 완료')),
      '안경 화면에 제목이 나와야 한다',
    );
    assert.ok(spoken.includes('배포 완료'), '음성으로도 알려야 한다');
  } finally {
    restore();
  }
});

test('같은 목록을 다시 읽어도 두 번 띄우지 않는다', async () => {
  // 주기 갱신이 SSE와 겹쳐 돌아도 팝업이 되살아나면 안 된다.
  const { r, setList, restore } = await setup([N('n1', '지난 알림')]);
  try {
    setList([N('n2', '새 알림'), N('n1', '지난 알림')]);
    await r.refreshSummary();
    r.notice = null; // 사용자가 확인했다.

    await r.refreshSummary();
    assert.equal(r.notice, null, '확인한 팝업이 되살아났다');
  } finally {
    restore();
  }
});

test('이미 읽은 알림이 맨 앞에 와도 띄우지 않는다', async () => {
  // 지우기로 순서가 바뀌면 읽은 것이 앞에 올 수 있다.
  const { r, setList, restore } = await setup([N('n1', '지난 알림')]);
  try {
    setList([N('n2', '읽은 알림', '2026-01-01T00:00:00Z'), N('n1', '지난 알림')]);
    await r.refreshSummary();
    assert.equal(r.notice, null, '읽은 알림을 새것으로 띄웠다');
  } finally {
    restore();
  }
});

test('알림 화면을 보고 있으면 팝업으로 가리지 않는다', async () => {
  const { r, setList, restore } = await setup([N('n1', '지난 알림')]);
  try {
    r.screen = 'notifications';
    setList([N('n2', '새 알림'), N('n1', '지난 알림')]);
    await r.refreshSummary();
    assert.equal(r.notice, null, '목록에 이미 보이는데 팝업까지 띄웠다');
  } finally {
    restore();
  }
});

test('알림을 다 지우면 다음 알림을 새것으로 본다', async () => {
  const { r, setList, restore } = await setup([N('n1', '지난 알림')]);
  try {
    setList([]);
    await r.refreshSummary();

    setList([N('n9', '다시 온 알림')]);
    await r.refreshSummary();
    assert.equal(r.notice?.title, '다시 온 알림', '비운 뒤 첫 알림을 놓쳤다');
  } finally {
    restore();
  }
});
