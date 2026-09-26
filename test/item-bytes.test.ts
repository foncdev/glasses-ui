/**
 * 목록 한 칸의 63바이트 한도 검증.
 *
 * 시뮬레이터로 잰 한도다. ASCII 63자는 그려지고 64자는 목록 전체가
 * 그려지지 않는다. 한글은 21자(63바이트)까지. 한 칸이라도 넘으면 SDK
 * 검사는 통과한 채 rebuild만 실패해 화면이 조용히 멈춘다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { G2Display } from '../src/adapters/g2-display.js';
import { ITEM_MAX_BYTES, fitBytes, utf8Bytes } from '../src/adapters/g2-bytes.js';
import { layoutHome, spreadItem } from '../src/adapters/g2-home.js';

test('한도 안이면 그대로, 넘으면 잘라 …을 붙인다', () => {
  assert.equal(fitBytes('짧은 제목'), '짧은 제목');
  assert.equal(utf8Bytes(fitBytes('x'.repeat(64))), ITEM_MAX_BYTES);
  const k = fitBytes('가'.repeat(30));
  assert.ok(utf8Bytes(k) <= ITEM_MAX_BYTES && k.endsWith('…'), k);
  // 이모지(4바이트, 서로게이트 쌍)를 반으로 가르지 않는다.
  assert.ok(!fitBytes('😀'.repeat(20)).includes('�'));
});

test('목록에 보내는 칸은 모두 63바이트 이하다', async () => {
  const sent: string[][] = [];
  const bridge = {
    async rebuildPageContainer(c: { listObject?: { itemContainer?: { itemName?: string[] } }[] }) {
      sent.push(c.listObject?.[0]?.itemContainer?.itemName ?? []);
      return true;
    },
    async textContainerUpgrade() {
      return true;
    },
  };
  const display = new G2Display();
  (display as unknown as { bridge: unknown }).bridge = bridge;

  await display.showList('세션', [
    '> 안경 홈 화면을 상태 표시줄과 카드로 꾸미고 세션 화면까지 같은 스타일로',
    'x'.repeat(64),
    '짧음',
  ]);
  for (const name of sent[0]!) assert.ok(utf8Bytes(name) <= ITEM_MAX_BYTES, `${utf8Bytes(name)}: ${name}`);
  assert.equal(sent[0]![2], '짧음');
});

test('오른쪽 정렬한 한 칸도 63바이트 이하다', () => {
  const row = spreadItem('● 아주 긴 한글 세션 제목이 들어오면 어떻게 되는지 보자', '12시간', 316);
  assert.ok(utf8Bytes(row) <= ITEM_MAX_BYTES, `${utf8Bytes(row)}`);
  assert.ok(row.endsWith('12시간'), '오른쪽 값은 남긴다');

  const l = layoutHome({
    title: 't',
    status: 's',
    items: [{ label: '아주아주 긴 한글 메뉴 이름입니다', meta: '123 new' }],
  });
  assert.ok(utf8Bytes(l.list.items[0]!) <= ITEM_MAX_BYTES);
});
