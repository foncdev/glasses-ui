/**
 * G2 어댑터가 화면 그리기(show…)를 빠짐없이 G2Display에 넘기는지.
 *
 * 본체는 어댑터에 show…가 있을 때만 꾸민 화면을 쓰고, 없으면 조용히 목록·글로 그린다.
 * 모니터링 화면을 G2Display에만 더하고 어댑터에 빠뜨려, 실기기에서 꾸민 화면이 한 번도
 * 쓰이지 않았다(시험은 G2Display를 직접 불러 통과했다).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { G2Display } from '../src/adapters/g2-display.js';
import { G2Adapter } from '../src/adapters/g2.js';

test('G2Display의 show… 메서드는 G2 어댑터에도 있다', () => {
  const shows = Object.getOwnPropertyNames(G2Display.prototype).filter((n) => n.startsWith('show') && n !== 'showRich'); // showRich는 G2Display 안쪽 도우미다
  const missing = shows.filter((n) => typeof (G2Adapter.prototype as unknown as Record<string, unknown>)[n] !== 'function');
  assert.deepEqual(missing, []);
});
