/**
 * 같은 목록을 다시 세우지 않는지 검증.
 *
 * 리스트를 rebuild하면 선택이 첫 항목으로 돌아간다. 주기 갱신(5초)이
 * 같은 목록을 계속 다시 세우면, 링이나 터치로 스크롤해 둔 자리가
 * 5초마다 맨 위로 튄다. 시뮬레이터 입력은 매번 새로 그린 뒤라 이
 * 증상이 드러나지 않았고, 실기기에서 링으로 천천히 내릴 때 보였다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { G2Display } from '../src/adapters/g2-display.js';

function fakeBridge(upgradeOk = true) {
  const calls: string[] = [];
  const bridge = {
    async rebuildPageContainer() {
      calls.push('rebuild');
      return true;
    },
    async textContainerUpgrade(c: { content?: string }) {
      calls.push(`upgrade:${c.content}`);
      return upgradeOk;
    },
  };
  const display = new G2Display();
  (display as unknown as { bridge: unknown }).bridge = bridge;
  return { display, calls };
}

const MENU = ['에이전트', '알림 보기', '설정'];

test('같은 목록을 다시 그려도 리스트를 다시 세우지 않는다', async () => {
  const { display, calls } = fakeBridge();
  await display.showList('세션 0/0', MENU);
  await display.showList('세션 0/0', MENU);
  await display.showList('세션 0/0', MENU);
  assert.deepEqual(calls, ['rebuild'], '처음 한 번만 세운다');
});

test('윗줄만 바뀌면 윗줄만 고친다', async () => {
  const { display, calls } = fakeBridge();
  await display.showList('세션 0/0', MENU);
  await display.showList('세션 1/1', MENU);
  assert.deepEqual(calls, ['rebuild', 'upgrade:세션 1/1'], '선택 위치를 지키려고 목록은 두고 윗줄만');
});

test('윗줄을 못 고치면 통째로 다시 세운다', async () => {
  const { display, calls } = fakeBridge(false);
  await display.showList('세션 0/0', MENU);
  await display.showList('세션 1/1', MENU);
  assert.deepEqual(calls, ['rebuild', 'upgrade:세션 1/1', 'rebuild']);
});

test('항목이나 옆 패널이 바뀌면 다시 세운다', async () => {
  const { display, calls } = fakeBridge();
  await display.showList('h', MENU);
  await display.showList('h', [...MENU, '명령']);
  await display.showList('h', [...MENU, '명령'], ['로고']);
  assert.deepEqual(calls, ['rebuild', 'rebuild', 'rebuild']);
});

test('텍스트 화면을 거치거나 뒤로 물러났다 오면 다시 세운다', async () => {
  const { display, calls } = fakeBridge();
  await display.showList('h', MENU);
  await display.showText(' '); // 화면 끄기
  await display.showList('h', MENU);
  await display.reattach(); // 앱이 뒤로 물러났다 돌아옴
  await display.showList('h', MENU);
  assert.deepEqual(calls, ['rebuild', 'rebuild', 'rebuild', 'rebuild']);
});
