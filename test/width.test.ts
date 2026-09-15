/**
 * 폭 계산 검증.
 *
 * 좁은 화면에서는 글자 수가 아니라 칸 수가 기준이다. 한글은 한 글자가
 * 두 칸을 먹어서, 글자 수로 자르면 목록이 화면 밖으로 밀린다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { clampWidth, displayWidth } from '../src/core/glasses.js';

test('한글은 두 칸, 영문은 한 칸으로 센다', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('가나다'), 6);
  assert.equal(displayWidth('a가b'), 4);
  assert.equal(displayWidth(''), 0);
});

test('상태 마크에 쓰는 문자는 한 칸이다', () => {
  // 이게 두 칸이면 목록 첫 칸이 밀린다.
  for (const m of ['*', '·', '!', '>', '○', '-']) {
    assert.equal(displayWidth(m), 1, `${m}이(가) 한 칸이 아니다`);
  }
});

test('폭에 맞으면 그대로 둔다', () => {
  assert.equal(clampWidth('abc', 10), 'abc');
  assert.equal(clampWidth('가나', 4), '가나');
});

test('넘치면 자르고 …를 붙인다', () => {
  const out = clampWidth('가'.repeat(10), 8);
  assert.ok(out.endsWith('…'));
  // … 도 한 칸을 먹는다. 전체가 상한을 넘으면 안 된다.
  assert.ok(displayWidth(out) <= 8, `${displayWidth(out)}칸`);
});

test('자른 결과가 상한을 넘지 않는다', () => {
  // 경계에서 한 칸씩 새는 실수를 잡는다.
  for (const max of [2, 3, 4, 5, 8, 20, 63, 64]) {
    for (const src of ['가'.repeat(50), 'a'.repeat(50), '가a'.repeat(25)]) {
      const out = clampWidth(src, max);
      assert.ok(
        displayWidth(out) <= max,
        `max=${max}에서 ${displayWidth(out)}칸이 나왔다: ${out}`,
      );
    }
  }
});

test('한글이 반 칸 걸치면 넣지 않는다', () => {
  // 상한 5에 '…'(1칸)을 빼면 4칸. 한글 두 자가 딱 맞는다.
  const out = clampWidth('가나다라', 5);
  assert.equal(out, '가나…');
  assert.equal(displayWidth(out), 5);
});
