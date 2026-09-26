/**
 * 401을 받으면 다시 로그인할 때까지 주기 갱신을 멈추는지 검증.
 *
 * 폰이 로그인 화면에 머무는 동안 안경은 5초마다 알림·할 일·세션·시스템
 * 상태를 읽었다. 토큰이 없으니 전부 401이라 relay 로그에 '인증 실패'가
 * 끝없이 쌓였다(실제 로그에서 봤다).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentCliClient, AgentCliError } from '../src/core/agent-cli.js';

function stubFetch(status: (path: string) => number) {
  const seen: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    seen.push(path);
    const s = status(path);
    return new Response(JSON.stringify(s === 200 ? { items: [], unread: 0 } : { error: { message: '인증에 실패했습니다.' } }), {
      status: s,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { seen, restore: () => (globalThis.fetch = orig) };
}

test('401을 받으면 canPoll이 꺼지고, 접속 정보가 바뀌면 다시 켜진다', async () => {
  const f = stubFetch(() => 401);
  try {
    const c = new AgentCliClient();
    c.configure({ baseUrl: 'http://relay:4100', apiKey: '' });
    let fired = 0;
    c.onUnauthorized(() => (fired += 1));
    assert.equal(c.canPoll, true);

    await assert.rejects(c.listNotifications(), (e) => e instanceof AgentCliError && e.status === 401);
    await assert.rejects(c.getGlobalChecklist());
    assert.equal(c.canPoll, false);
    assert.equal(fired, 1, '한 번 풀릴 때 한 번만 알린다');

    c.configure({ baseUrl: 'http://relay:4100', apiKey: 'new-token' });
    assert.equal(c.canPoll, true, '로그인하면 다시 두드린다');
  } finally {
    f.restore();
  }
});

test('로그인 요청의 401(비밀번호 틀림)은 로그인이 풀린 것으로 보지 않는다', async () => {
  const f = stubFetch(() => 401);
  try {
    const c = new AgentCliClient();
    c.configure({ baseUrl: 'http://relay:4100', apiKey: '' });
    let fired = 0;
    c.onUnauthorized(() => (fired += 1));
    await assert.rejects(c.login('me', 'wrong'), /인증에 실패했습니다/);
    assert.equal(c.canPoll, true);
    assert.equal(fired, 0);
  } finally {
    f.restore();
  }
});

test('안경: 401 뒤의 요약 갱신은 서버에 요청하지 않는다', async () => {
  const { agentCli } = await import('../src/core/agent-cli.js');
  const { GlassesUI } = await import('../src/core/glasses-ui.js');
  const f = stubFetch((p) => (p === '/auth/status' ? 200 : 401));
  try {
    agentCli.configure({ baseUrl: 'http://relay:4100', apiKey: '' });
    const glasses = {
      name: 'stub', isVoiceEnabled: false,
      async connect() {}, async disconnect() {}, async showList() {}, async showText() {},
      speak() {}, stopSpeaking() {}, setVoiceEnabled() {},
      async saveSetting() {}, async loadSetting() { return ''; },
      onGesture() { return () => {}; },
    } as never;
    const ui = new GlassesUI(glasses, { onLog: () => {} });
    await ui.start();
    const r = ui as unknown as { refreshSummary(): Promise<void> };
    const before = f.seen.filter((p) => p !== '/events').length;
    await r.refreshSummary();
    await r.refreshSummary();
    assert.equal(f.seen.filter((p) => p !== '/events').length, before, '로그인 전 주기 갱신이 멈춘다');
  } finally {
    f.restore();
    agentCli.configure({ baseUrl: 'http://reset:1', apiKey: 'x' });
  }
});
