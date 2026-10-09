/**
 * 안경에서 권한 요청에 답하는 흐름 검증.
 *
 * 허용을 눌렀는데 반응이 없고 웹에는 요청이 그대로 남던 일이 있었다. 원인은 셋이었다.
 * - 다시 그릴 때마다 탭을 막는 시간(1.2초)을 새로 세어, 화면이 자주 바뀌면 탭이 버려졌다.
 * - 답을 보내기 전에 화면에서 내려, 보내기가 실패하면 다시 답할 길이 없었다.
 * - 새 요청이 앞 요청을 덮어써 앞 요청은 답할 수 없었다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli, AgentCliError } from '../src/core/agent-cli.js';
import type { SessionEvent, SessionInfo } from '../src/core/agent-cli.js';
import type { GestureEvent, GlassesAdapter, PermissionView } from '../src/core/glasses.js';
import { GLASSES_LOGO } from '../src/adapters/g2-logo.js';

type Pending = { id: string; toolName: string; summary: string };

function session(id: string, title: string, pending: Pending[] = []): SessionInfo {
  return { id, title, live: true, status: pending.length ? 'waiting' : 'busy', pending } as unknown as SessionInfo;
}

async function setup(sessions: SessionInfo[]) {
  const views: PermissionView[] = [];
  const resolved: Array<[string, string, string]> = [];
  const streams = new Map<string, (e: SessionEvent) => void>();
  let onG: ((e: GestureEvent) => void) | undefined;
  let fail: Error | undefined;

  const glasses = {
    name: 'stub',
    logo: GLASSES_LOGO,
    get isVoiceEnabled() {
      return false;
    },
    async connect() {},
    async disconnect() {},
    async showList() {},
    async showText() {},
    async showPermission(v: PermissionView) {
      views.push(v);
    },
    async speak() {},
    setVoiceEnabled() {},
    async saveSetting() {},
    async loadSetting() {
      return '';
    },
    onGesture(cb: (e: GestureEvent) => void) {
      onG = cb;
      return () => {};
    },
  } as unknown as GlassesAdapter;

  const orig = { ...agentCli };
  agentCli.listSessions = async () => sessions;
  agentCli.listNotifications = async () => ({ items: [] as never, unread: 0 });
  agentCli.getGlobalChecklist = async () => [] as never;
  agentCli.listExt = async () => [] as never;
  agentCli.getHistory = async () => [];
  agentCli.streamEvents = (() => () => undefined) as typeof agentCli.streamEvents;
  agentCli.streamSession = ((id: string, onEvent: (e: SessionEvent) => void) => {
    streams.set(id, onEvent);
    return () => streams.delete(id);
  }) as typeof agentCli.streamSession;
  agentCli.resolvePermission = async (id, requestId, behavior) => {
    if (fail) throw fail;
    resolved.push([id, requestId, behavior]);
    // 서버에서 그 요청이 끝났다.
    const s = sessions.find((x) => x.id === id) as unknown as { pending: Pending[] };
    s.pending = s.pending.filter((p) => p.id !== requestId);
  };

  const ui = new GlassesUI(glasses, { onLog: () => {} });
  await ui.start();
  const r = ui as unknown as {
    screen: string;
    screenOff: boolean;
    activeId: string;
    permShownAt: number;
    pending: (Pending & { sessionId: string }) | null;
    render(): Promise<void>;
    refresh(): Promise<void>;
  };
  r.screenOff = false;

  return {
    ui,
    r,
    views,
    resolved,
    streams,
    failNext: (e: Error | undefined) => {
      fail = e;
    },
    fire: (gesture: string, selectedIndex?: number) => onG?.({ gesture, selectedIndex } as GestureEvent),
    restore: () => Object.assign(agentCli, orig),
  };
}

const settle = (ms = 40) => new Promise((res) => setTimeout(res, ms));
const ALLOW_ONCE = 1;

test('다시 그려도 탭을 막는 시간은 새로 세지 않는다 — 화면이 자주 바뀌어도 허용이 먹는다', async () => {
  const sessions = [session('a', '빌드', [{ id: 'p1', toolName: 'Write', summary: 'tetris.html' }])];
  const t = await setup(sessions);
  try {
    await t.r.refresh();
    assert.equal(t.r.pending?.id, 'p1', '서버에 남은 요청을 띄워야 한다');
    // 막는 시간이 지났다고 치고, 다른 소식으로 여러 번 다시 그린다.
    t.r.permShownAt = 0;
    await t.r.render();
    await t.r.render();
    assert.equal(t.r.permShownAt, 0, '다시 그릴 때 막는 시간을 새로 셌다');

    t.fire('tap', ALLOW_ONCE);
    await settle();
    assert.deepEqual(t.resolved, [['a', 'p1', 'allow']]);
    assert.equal(t.r.pending, null);
  } finally {
    t.restore();
  }
});

test('보내기가 실패하면 요청을 남기고 오류를 띄운다. 다시 고르면 보낸다', async () => {
  const sessions = [session('a', '빌드', [{ id: 'p1', toolName: 'Write', summary: '' }])];
  const t = await setup(sessions);
  try {
    await t.r.refresh();
    t.r.permShownAt = 0;
    t.failNext(new Error('relay에 연결할 수 없습니다'));
    t.fire('tap', ALLOW_ONCE);
    await settle();
    assert.equal(t.r.pending?.id, 'p1', '실패했는데 요청을 내렸다');
    assert.match(t.views.at(-1)?.status ?? '', /권한 처리 실패: relay에 연결할 수 없습니다/);

    t.failNext(undefined);
    t.fire('tap', ALLOW_ONCE);
    await settle();
    assert.deepEqual(t.resolved, [['a', 'p1', 'allow']]);
    assert.equal(t.r.pending, null);
  } finally {
    t.restore();
  }
});

test('이미 처리된 요청(웹에서 먼저 답함)이면 내린다', async () => {
  const sessions = [session('a', '빌드', [{ id: 'p1', toolName: 'Write', summary: '' }])];
  const t = await setup(sessions);
  try {
    await t.r.refresh();
    t.r.permShownAt = 0;
    t.failNext(new AgentCliError('없거나 이미 처리된 권한 요청', 404, 'permission_not_found'));
    (sessions[0] as unknown as { pending: Pending[] }).pending = [];
    t.fire('tap', ALLOW_ONCE);
    await settle();
    assert.equal(t.r.pending, null);
  } finally {
    t.restore();
  }
});

test('웹에서 답한 요청은 세션 목록을 다시 읽을 때 내린다', async () => {
  const sessions = [session('a', '빌드', [{ id: 'p1', toolName: 'Write', summary: '' }])];
  const t = await setup(sessions);
  try {
    await t.r.refresh();
    assert.equal(t.r.pending?.id, 'p1');
    (sessions[0] as unknown as { pending: Pending[] }).pending = [];
    await t.r.refresh();
    assert.equal(t.r.pending, null);
  } finally {
    t.restore();
  }
});

test('다른 세션의 요청은 보고 있는 세션을 바꾸지 않고, 앞 요청을 덮지 않는다. 앞 요청을 답하면 다음을 띄운다', async () => {
  const sessions = [session('a', '빌드'), session('b', '문서')];
  const t = await setup(sessions);
  try {
    await t.r.refresh();
    await t.ui.open('a');
    await settle();
    assert.equal(t.r.activeId, 'a');

    // 보고 있는 세션 a의 요청
    (sessions[0] as unknown as { pending: Pending[] }).pending = [{ id: 'p1', toolName: 'Write', summary: '' }];
    t.streams.get('a')?.({ type: 'permission_request', sessionId: 'a', requestId: 'p1', toolName: 'Write' } as unknown as SessionEvent);
    await settle();
    assert.equal(t.r.pending?.id, 'p1');

    // 그사이 b에서도 요청. 덮지 않고, 보고 있는 세션도 그대로다.
    (sessions[1] as unknown as { pending: Pending[] }).pending = [{ id: 'p2', toolName: 'Bash', summary: 'npm test' }];
    for (const [, on] of t.streams) on({ type: 'permission_request', sessionId: 'b', requestId: 'p2', toolName: 'Bash' } as unknown as SessionEvent);
    await settle();
    assert.equal(t.r.pending?.id, 'p1', '뒤 요청이 앞 요청을 덮었다');
    assert.equal(t.r.activeId, 'a', '다른 세션 요청 때문에 보고 있는 세션이 바뀌었다');

    t.r.permShownAt = 0;
    t.fire('tap', ALLOW_ONCE);
    await settle();
    assert.equal(t.r.pending?.id, 'p2', '앞 요청을 답한 뒤 다음 요청을 띄워야 한다');
    assert.equal(t.r.pending?.sessionId, 'b');
    assert.equal(t.views.at(-1)?.title, '$ ~/문서', '요청이 온 세션 이름이어야 한다');

    t.r.permShownAt = 0;
    t.fire('tap', ALLOW_ONCE);
    await settle();
    assert.deepEqual(t.resolved, [['a', 'p1', 'allow'], ['b', 'p2', 'allow']]);
    assert.equal(t.r.pending, null);
  } finally {
    t.restore();
  }
});

test('세션을 고르지 않고 보내면 버리지 않고 까닭을 알린다', async () => {
  const t = await setup([]);
  try {
    await assert.rejects(t.ui.send('테스트 추가해줘'), /세션을 먼저 여세요/);
  } finally {
    t.restore();
  }
});
