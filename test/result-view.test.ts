/**
 * 명령 실행 결과 화면 검증.
 *
 * 명령 출력은 폭을 모른다 — ps는 전체 경로를 뱉어 한 줄이 100칸을
 * 넘는다. 기기 자동 줄바꿈에 맡기면 몇 줄이 될지 몰라 아래 안내가
 * 화면 밖으로 밀린다. 실제로 그렇게 밀려서 폭과 줄 수를 정해 두었다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { resultView } from '../src/core/glasses-ui.js';
import { displayWidth } from '../src/core/glasses.js';

const COLS = 40;

test('결과와 뒤로 가는 방법을 보여준다', () => {
  const out = resultView({ label: '디스크', text: '/dev/disk3  11%  /' });
  assert.match(out, /실행 결과/);
  assert.match(out, /디스크/);
  assert.match(out, /11%/);
  assert.match(out, /더블탭/, '나가는 방법을 알려야 한다');
});

test('어느 줄도 폭을 넘지 않는다', () => {
  // ps 출력이 실제로 이렇게 길다.
  const long =
    ' 30.7 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/152.0/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper';
  const out = resultView({ label: '프로세스', text: `%CPU COMM\n${long}\n${long}` });
  for (const line of out.split('\n')) {
    assert.ok(displayWidth(line) <= COLS, `폭 초과(${displayWidth(line)}): ${line}`);
  }
});

test('줄이 많으면 잘라내고 알려준다', () => {
  // 안내가 화면 밖으로 밀리면 나가는 방법을 알 수 없다.
  const many = Array.from({ length: 40 }, (_, i) => `줄 ${i}`).join('\n');
  const out = resultView({ label: 'ps', text: many });
  const lines = out.split('\n');
  // 288px / 27px = 열 줄이 전부다. 넘으면 안내가 화면을 벗어난다.
  assert.ok(lines.length <= 10, `줄이 너무 많다: ${lines.length}`);
  assert.match(out, /폰에서 전문/, '잘렸음을 알리지 않았다');
  assert.match(lines.at(-1)!, /더블탭/, '안내가 마지막에 있어야 한다');
});

test('원래 줄바꿈을 살린다', () => {
  // 표 꼴 출력(ps·df)은 줄이 곧 뜻이라 이어 붙이면 읽을 수 없다.
  const out = resultView({ label: 'x', text: 'A 1\nB 2\nC 3' });
  assert.ok(out.includes('A 1\nB 2'), '줄을 이어 붙였다');
});

test('탭을 공백으로 바꾼다', () => {
  // 탭은 기기에서 폭이 예측되지 않아 정렬이 깨진다.
  const out = resultView({ label: 'x', text: 'a\tb' });
  assert.ok(!out.includes('\t'), '탭이 남았다');
});

test('확인이 필요하면 실행 방법을 다르게 안내한다', () => {
  const out = resultView({
    label: '위험',
    text: '· rm으로 지웁니다',
    awaitingConfirm: true,
  });
  assert.match(out, /확인 필요/);
  assert.match(out, /탭: 실행/, '어떻게 실행하는지 알려야 한다');
  assert.match(out, /취소/, '취소 방법도 알려야 한다');
});

test('결과가 없으면 나가는 방법만 보여준다', () => {
  const out = resultView(undefined);
  assert.match(out, /더블탭/);
});
