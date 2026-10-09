/**
 * 안경에서 Claude Code / 명령을 골라 보내는 흐름 검증.
 *
 * 안경은 글을 적을 수 없으므로 세션이 알려 준 명령 목록에서 고른다.
 * 대화가 지워지는 /clear는 탭 한 번에 나가지 않게 한 번 더 묻는다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli } from '../src/core/agent-cli.js';
import type { SessionInfo } from '../src/core/agent-cli.js';
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
  const sent: Array<[string, string]> = [];
  let onG: ((e: GestureEvent) => void) | undefined;
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
    async showText() {},
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
  agentCli.streamSession = (() => () => undefined) as typeof agentCli.streamSession;
  agentCli.sendInput = async (id, prompt) => {
    sent.push([id, prompt]);
  };

  const ui = new GlassesUI(glasses, { onLog: () => {} });
  await ui.start();
  const r = ui as unknown as { screen: string; screenOff: boolean; refresh(): Promise<void> };
  r.screenOff = false;
  await r.refresh();
  await ui.open('a');

  return {
    r,
    lists,
    sent,
    fire: (gesture: string, selectedIndex?: number) => onG?.({ gesture, selectedIndex } as GestureEvent),
    restore: () => Object.assign(agentCli, orig),
  };
}

const settle = (ms = 40) => new Promise((res) => setTimeout(res, ms));

test('대화 화면에서 탭하면 명령 목록이 뜨고, 고른 명령을 그 세션에 보낸다', async () => {
  const t = await setup();
  try {
    t.fire('tap');
    await settle();
    assert.equal(t.r.screen, 'slash');
    const shown = t.lists.at(-1)!;
    assert.equal(shown.items[0], '/compact  대화 줄이기');
    assert.equal(shown.items.at(-1), '할 일 보기', '맨 끝은 할 일 목록이다');
    for (const item of shown.items) assert.equal(fitBytes(item), item, `63바이트를 넘는다: ${item}`);

    t.fire('tap', 0);
    await settle();
    assert.deepEqual(t.sent, [['a', '/compact']]);
    assert.equal(t.r.screen, 'detail', '보낸 뒤에는 진행을 보는 대화 화면으로');
  } finally {
    t.restore();
  }
});

test('/clear는 한 번 더 탭해야 보낸다. 다른 칸으로 옮기면 풀린다', async () => {
  const t = await setup();
  try {
    t.fire('tap');
    await settle();
    const clear = 3;
    t.fire('tap', clear);
    await settle();
    assert.deepEqual(t.sent, []);
    assert.equal(t.lists.at(-1)?.header, '한 번 더 탭하면 /clear');

    t.fire('down');
    await settle();
    t.fire('up');
    await settle();
    t.fire('tap', clear);
    await settle();
    assert.deepEqual(t.sent, [], '옮겼다 돌아오면 다시 물어야 한다');

    t.fire('tap', clear);
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
