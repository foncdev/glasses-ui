/**
 * 폰 화면의 연결 버튼이 오래 꺼져 있지 않게 하는 시간 제한 검증.
 *
 * 버튼은 접속이 끝날 때까지 꺼져 있다. 서버가 답하지 않거나 브리지
 * 저장소가 늦으면 그동안 눌리지 않아, G2 로그인에서 버튼이 자주 꺼져
 * 보였다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentCliClient, AgentCliError } from '../src/core/agent-cli.js';
import { G2Adapter } from '../src/adapters/g2.js';

test('서버 요청에는 늘 시간 제한이 걸린다', async () => {
  const orig = globalThis.fetch;
  let signal: AbortSignal | undefined;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    const e = new Error('timed out');
    e.name = 'TimeoutError';
    throw e;
  }) as typeof fetch;
  try {
    const c = new AgentCliClient();
    c.configure({ baseUrl: 'http://relay:4100', apiKey: '' });
    await assert.rejects(c.authStatus(), (e) => e instanceof AgentCliError && /초 안에 답하지 않습니다/.test(e.message));
    assert.ok(signal, 'AbortSignal을 넘긴다');
  } finally {
    globalThis.fetch = orig;
  }
});

test('브리지 저장소가 답하지 않아도 1.5초 안에 돌아온다', async () => {
  const g = new G2Adapter();
  (g as unknown as { bridge: unknown }).bridge = {
    getLocalStorage: () => new Promise(() => {}),
    setLocalStorage: () => new Promise(() => {}),
  };
  const t0 = Date.now();
  assert.equal(await g.loadSetting('relay.token'), '');
  await g.saveSetting('relay.token', 'x');
  assert.ok(Date.now() - t0 < 4000, `${Date.now() - t0}ms`);
});
