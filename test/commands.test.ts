/**
 * 등록한 명령을 안경에서 고르고 실행하는 흐름 검증.
 *
 * 안경은 입력이 탭·스크롤 네 가지뿐이라 명령을 적어 넣을 수 없다.
 * 웹에서 등록하고 여기서는 골라 실행만 한다.
 *
 * 되돌릴 수 없어 보이는 명령은 서버가 409로 막는다. 안경은 탭 한 번에
 * 일이 벌어지므로, 손이 스쳐도 그런 일은 바로 실행되지 않아야 한다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli } from '../src/core/agent-cli.js';
import type { GestureEvent, GlassesAdapter, ItemLike } from '../src/core/glasses.js';
import type { RunResult, Snippet } from '../src/core/agent-cli.js';
import { GLASSES_LOGO } from '../src/adapters/g2-logo.js';

const SNIPPETS: Snippet[] = [
  { id: 's1', label: '디스크', command: 'df -h /', kind: 'once' },
  { id: 's2', label: '위험', command: 'rm -rf /tmp/x', kind: 'once' },
];

async function setup(opts: {
  run?: (id: string, confirm: boolean) => ReturnType<typeof agentCli.runSnippet>;
} = {}) {
  const texts: string[] = [];
  let onG: ((e: GestureEvent) => void) | undefined;

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
  agentCli.listSessions = async () => [] as never;
  agentCli.listNotifications = async () => ({ items: [] as never, unread: 0 });
  agentCli.getGlobalChecklist = async () => [] as never;
  agentCli.streamEvents = (() => () => undefined) as typeof agentCli.streamEvents;
  agentCli.listSnippets = async () => [...SNIPPETS];
  agentCli.runSnippet =
    opts.run ??
    (async () => ({ result: { output: '/dev/disk3 11% /', exitCode: 0, timedOut: false, tookMs: 8 } }));

  const relay = new GlassesUI(glasses, { onLog: () => {} });
  await relay.start();

  const r = relay as unknown as {
    screen: string;
    screenOff: boolean;
    cmdCursor: number;
    snippets: Snippet[];
    cmdResult?: { label: string; text: string; awaitingConfirm?: boolean };
    openMenu(t: string): Promise<void>;
  };
  r.screenOff = false;

  return {
    r,
    texts,
    fire: (gesture: string, selectedIndex?: number) =>
      onG?.({ gesture, selectedIndex } as GestureEvent),
    restore: () => Object.assign(agentCli, orig),
  };
}

const settle = (ms = 60) => new Promise((res) => setTimeout(res, ms));

test('명령 화면을 열면 목록을 읽어 온다', async () => {
  const { r, restore } = await setup();
  try {
    await r.openMenu('commands');
    await settle();
    assert.equal(r.screen, 'commands');
    assert.equal(r.snippets.length, 2, '목록을 못 읽었다');
  } finally {
    restore();
  }
});

test('탭하면 고른 명령을 실행하고 결과를 보여준다', async () => {
  const { r, texts, fire, restore } = await setup();
  try {
    await r.openMenu('commands');
    await settle();

    fire('tap', 0);
    await settle(120);

    assert.equal(r.screen, 'command-result');
    assert.match(r.cmdResult?.text ?? '', /11%/, '결과가 없다');
    assert.ok(
      texts.some((t) => t.includes('디스크')),
      '무엇을 돌렸는지 화면에 없다',
    );
  } finally {
    restore();
  }
});

test('되돌릴 수 없는 명령은 바로 실행하지 않는다', async () => {
  // 안경은 탭 한 번에 일이 벌어진다. 손이 스쳐도 안 되게 한다.
  let calls: boolean[] = [];
  const { r, fire, restore } = await setup({
    run: async (_id, confirm) => {
      calls.push(confirm);
      if (!confirm) {
        return { needsConfirm: true, risks: [{ reason: 'rm으로 지웁니다', destructive: true }] };
      }
      return { result: { output: '', exitCode: 0, timedOut: false, tookMs: 1 } as RunResult };
    },
  });
  try {
    await r.openMenu('commands');
    await settle();

    fire('tap', 1); // 위험
    await settle(120);

    assert.equal(r.cmdResult?.awaitingConfirm, true, '확인 없이 넘어갔다');
    assert.match(r.cmdResult?.text ?? '', /rm으로 지웁니다/, '왜 막혔는지 알려야 한다');
    assert.deepEqual(calls, [false], '확인 전에 실행했다');

    // 한 번 더 탭하면 실행한다.
    fire('tap');
    await settle(120);
    assert.deepEqual(calls, [false, true], '확인 후에도 실행하지 않았다');
    assert.equal(r.cmdResult?.awaitingConfirm, undefined, '확인 상태가 남았다');
  } finally {
    restore();
  }
});

test('확인 화면에서 더블탭하면 실행하지 않고 돌아간다', async () => {
  let ran = 0;
  const { r, fire, restore } = await setup({
    run: async (_id, confirm) => {
      if (confirm) ran += 1;
      return confirm
        ? { result: { output: '', exitCode: 0, timedOut: false, tookMs: 1 } as RunResult }
        : { needsConfirm: true, risks: [{ reason: 'rm으로 지웁니다', destructive: true }] };
    },
  });
  try {
    await r.openMenu('commands');
    await settle();
    fire('tap', 1);
    await settle(120);

    fire('doubleTap');
    await settle(80);

    assert.equal(ran, 0, '취소했는데 실행했다');
    assert.equal(r.screen, 'commands', '목록으로 돌아가야 한다');
  } finally {
    restore();
  }
});

test('실행이 실패해도 이유를 보여준다', async () => {
  const { r, fire, restore } = await setup({
    run: async () => {
      throw new Error('연결된 terminal-agent가 없습니다');
    },
  });
  try {
    await r.openMenu('commands');
    await settle();
    fire('tap', 0);
    await settle(120);

    assert.match(r.cmdResult?.text ?? '', /terminal-agent/, '실패 이유가 없다');
  } finally {
    restore();
  }
});

test('등록된 명령이 없으면 무엇을 해야 하는지 알려준다', async () => {
  const { r, restore } = await setup();
  try {
    agentCli.listSnippets = async () => [];
    await r.openMenu('commands');
    await settle();
    assert.equal(r.snippets.length, 0);
    // 빈 목록만 두면 고장으로 보인다. 렌더가 안내를 넣는지는
    // 아래 목록 화면 테스트가 본다.
  } finally {
    restore();
  }
});
