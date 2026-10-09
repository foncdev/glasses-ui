/**
 * 안경에서 Claude Code / 명령을 골라 보내는 흐름 검증.
 *
 * 안경은 글을 적을 수 없으므로 세션이 알려 준 명령 목록에서 고른다.
 * - 목록의 선택은 펌웨어가 쥔다(반지도 같다). 고를 때 목록을 다시 세우면 선택이 맨 위로 돌아가
 *   다음 탭이 첫 칸(/compact)으로 읽혔다. 그래서 목록은 커서에 따라 바뀌지 않는다.
 * - 모든 명령은 보낼지 묻는 글 화면을 거친다. 탭이 보내기, 더블탭이 취소.
 * - 보낸 뒤에는 '실행 중' 화면에 머물다가 턴이 끝나면 결과 읽기로 결과를 보인다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli } from '../src/core/agent-cli.js';
import type { SessionEvent, SessionInfo } from '../src/core/agent-cli.js';
import type { GestureEvent, GlassesAdapter, ItemLike } from '../src/core/glasses.js';
import { toItem } from '../src/core/glasses.js';
import { slashItems } from '../src/core/slash.js';
import { fitBytes } from '../src/adapters/g2-bytes.js';
import { GLASSES_LOGO } from '../src/adapters/g2-logo.js';

const CLI = ['deep-research', 'claude-mem:do', 'code-review', 'model', 'effort', 'compact', 'clear', 'context', 'config', 'usage', 'ultrareview', '__remote-workflow', 'init', 'recap'];

test('자주 쓰는 명령을 앞에 두고, 값이 필요하거나 터미널 전용·과금 명령은 뺀다. 플러그인 스킬은 뒤로', () => {
  const names = slashItems(CLI, 19).map((c) => c.name);
  assert.deepEqual(names, ['compact', 'context', 'usage', 'clear', 'code-review', 'init', 'deep-research', 'recap', 'claude-mem:do']);
  assert.equal(slashItems(CLI, 19).find((c) => c.name === 'clear')?.confirm, true);
});

test('세션이 목록을 아직 안 알려 줬으면(첫 입력 전) 자주 쓰는 명령을 보인다. 칸 수를 넘지 않는다', () => {
  assert.deepEqual(slashItems(undefined, 19).map((c) => c.name), ['compact', 'context', 'usage', 'clear', 'code-review', 'simplify', 'init']);
  assert.equal(slashItems([...CLI, ...Array.from({ length: 40 }, (_, i) => `skill-${i}`)], 19).length, 19);
});

async function setup() {
  const lists: Array<{ header: string; items: string[] }> = [];
  const texts: string[] = [];
  const sent: Array<[string, string]> = [];
  let onG: ((e: GestureEvent) => void) | undefined;
  let emit: ((e: SessionEvent) => void) | undefined;
  const sessions = [
    { id: 'a', title: '빌드', live: true, status: 'idle', pending: [], slashCommands: CLI } as unknown as SessionInfo,
  ];

  const glasses = {
    name: 'stub',
    logo: GLASSES_LOGO,
    get isVoiceEnabled() {
      return false;
    },
    async connect() {},
    async disconnect() {},
    async showList(header: string, items: readonly ItemLike[]) {
      lists.push({ header, items: items.map((i) => toItem(i).text) });
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
      onG = cb;
      return () => {};
    },
  } as unknown as GlassesAdapter;

  const orig = { ...agentCli };
  agentCli.listSessions = async () => sessions;
  agentCli.listNotifications = async () => ({ items: [] as never, unread: 0 });
  agentCli.getGlobalChecklist = async () => [] as never;
  agentCli.getChecklist = async () => [] as never;
  agentCli.listExt = async () => [] as never;
  agentCli.getHistory = async () => [];
  agentCli.streamEvents = (() => () => undefined) as typeof agentCli.streamEvents;
  agentCli.streamSession = ((id: string, onEvent: (e: SessionEvent) => void) => {
    if (id === 'a') emit = onEvent;
    return () => undefined;
  }) as typeof agentCli.streamSession;
  agentCli.sendInput = async (id, prompt) => {
    sent.push([id, prompt]);
  };

  const ui = new GlassesUI(glasses, { onLog: () => {} });
  await ui.start();
  const r = ui as unknown as { screen: string; screenOff: boolean; slashPickAt: number; refresh(): Promise<void> };
  r.screenOff = false;
  await r.refresh();
  await ui.open('a');

  return {
    r,
    lists,
    texts,
    sent,
    emit: (e: Record<string, unknown>) => emit?.({ sessionId: 'a', ...e } as unknown as SessionEvent),
    fire: (gesture: string, selectedIndex?: number) => onG?.({ gesture, selectedIndex } as GestureEvent),
    /** 헛 탭을 거르는 시간이 지났다고 친다. */
    pass: () => {
      r.slashPickAt = 0;
    },
    restore: () => Object.assign(agentCli, orig),
  };
}

const settle = (ms = 40) => new Promise((res) => setTimeout(res, ms));

test('명령을 고르면 보낼지 묻고, 탭하면 보낸 뒤 실행 중 화면에 머물다가 결과를 보인다', async () => {
  const t = await setup();
  try {
    t.fire('tap');
    await settle();
    assert.equal(t.r.screen, 'slash');
    const shown = t.lists.at(-1)!;
    assert.equal(shown.items[0], '/compact  대화 줄이기');
    assert.equal(shown.items.at(-1), '할 일 보기', '맨 끝은 할 일 목록이다');
    for (const item of shown.items) assert.equal(fitBytes(item), item, `63바이트를 넘는다: ${item}`);

    const usage = shown.items.indexOf('/usage  사용 한도');
    t.fire('tap', usage);
    await settle();
    assert.equal(t.r.screen, 'slash-confirm');
    assert.match(t.texts.at(-1)!, /^\/usage 보낼까요\?\n/);
    assert.match(t.texts.at(-1)!, /세션: 빌드/);
    assert.deepEqual(t.sent, []);

    // 화면이 바뀐 직후 펌웨어가 흘리는 선택 이벤트는 보내기로 읽지 않는다.
    t.fire('tap');
    await settle();
    assert.deepEqual(t.sent, [], '헛 탭으로 보냈다');

    t.pass();
    t.fire('tap');
    await settle();
    assert.deepEqual(t.sent, [['a', '/usage']]);
    assert.equal(t.r.screen, 'reader', '보낸 뒤 대화 화면으로 빠져나가지 않는다');
    assert.match(t.texts.at(-1)!, /^\/usage\n실행 중/);

    t.emit({ type: 'user', text: '/usage' });
    t.emit({ type: 'turn_complete', result: 'Current session: 5% used · resets Oct 9 at 7pm (Asia/Seoul)' });
    await settle();
    assert.equal(t.r.screen, 'reader');
    assert.match(t.texts.at(-1)!, /^사용 한도/);
    assert.match(t.texts.at(-1)!, /세션 +━─+ +5%/);
  } finally {
    t.restore();
  }
});

test('묻는 화면에서 더블탭하면 보내지 않고 목록으로. 목록은 고른 칸에 따라 바뀌지 않는다(펌웨어 선택이 그대로)', async () => {
  const t = await setup();
  try {
    t.fire('tap');
    await settle();
    const before = t.lists.at(-1)!;
    t.fire('tap', 3);
    await settle();
    t.fire('doubleTap');
    await settle();
    assert.equal(t.r.screen, 'slash');
    assert.deepEqual(t.sent, []);
    assert.deepEqual(t.lists.at(-1), before, '고른 칸에 따라 목록이 바뀌면 펌웨어 선택이 맨 위로 돌아간다');
  } finally {
    t.restore();
  }
});

test('/clear는 대화가 지워진다고 알린다', async () => {
  const t = await setup();
  try {
    t.fire('tap');
    await settle();
    t.fire('tap', t.lists.at(-1)!.items.indexOf('/clear  대화 비우기'));
    await settle();
    assert.match(t.texts.at(-1)!, /지금까지의 대화가 지워집니다/);
    t.pass();
    t.fire('tap');
    await settle();
    assert.deepEqual(t.sent, [['a', '/clear']]);
  } finally {
    t.restore();
  }
});

test('맨 끝 칸은 할 일 목록을 연다. 더블탭은 대화 화면으로 돌아간다', async () => {
  const t = await setup();
  try {
    t.fire('tap');
    await settle();
    t.fire('doubleTap');
    await settle();
    assert.equal(t.r.screen, 'detail');

    t.fire('tap');
    await settle();
    const last = t.lists.at(-1)!.items.length - 1;
    t.fire('tap', last);
    await settle();
    assert.equal(t.r.screen, 'checklist');
  } finally {
    t.restore();
  }
});
