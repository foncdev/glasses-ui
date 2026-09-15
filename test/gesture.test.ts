/**
 * 제스처 해석 검증.
 *
 * 리스트 화면에서 오는 이벤트(listEvent)도 eventType을 싣고 온다.
 * 이걸 무시하고 탭으로 고정하면 더블탭이 탭이 되어 뒤로 나갈 수 없다.
 *
 * protobuf가 영값을 생략하므로 CLICK(0)과 index 0은 undefined로 온다.
 * ?? 0 보정이 빠지면 탭이 통째로 사라진다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readGesture } from '../src/adapters/g2.js';

/** OsEventTypeList 값. SDK와 같아야 한다. */
const CLICK = 0;
const SCROLL_TOP = 1;
const SCROLL_BOTTOM = 2;
const DOUBLE_CLICK = 3;

test('리스트 더블탭은 doubleTap으로 읽힌다', () => {
  const g = readGesture({
    listEvent: { eventType: DOUBLE_CLICK, currentSelectItemIndex: 2 },
  } as never);
  assert.equal(g?.gesture, 'doubleTap', '탭으로 뭉개지면 뒤로가기가 죽는다');
});

test('리스트 탭은 선택 위치를 함께 준다', () => {
  const g = readGesture({
    listEvent: { eventType: CLICK, currentSelectItemIndex: 3 },
  } as never);
  assert.equal(g?.gesture, 'tap');
  assert.equal(g?.selectedIndex, 3);
});

test('protobuf가 생략한 영값을 보정한다', () => {
  // eventType(0)과 index(0)이 모두 빠진 채로 온다.
  const g = readGesture({ listEvent: {} } as never);
  assert.equal(g?.gesture, 'tap', 'CLICK=0이 생략돼도 탭이어야 한다');
  assert.equal(g?.selectedIndex, 0, '첫 항목 선택이 사라지면 안 된다');
});

test('리스트 스크롤은 선택 위치를 싣지 않는다', () => {
  // 스크롤에 selectedIndex를 실으면 커서가 펌웨어 값으로 덮인다.
  const up = readGesture({
    listEvent: { eventType: SCROLL_TOP, currentSelectItemIndex: 5 },
  } as never);
  assert.equal(up?.gesture, 'up');
  assert.equal(up?.selectedIndex, undefined);

  const down = readGesture({
    listEvent: { eventType: SCROLL_BOTTOM, currentSelectItemIndex: 5 },
  } as never);
  assert.equal(down?.gesture, 'down');
  assert.equal(down?.selectedIndex, undefined);
});

test('시스템 더블탭도 doubleTap이다', () => {
  const g = readGesture({ sysEvent: { eventType: DOUBLE_CLICK } } as never);
  assert.equal(g?.gesture, 'doubleTap');
});

test('텍스트 화면은 스크롤만 받는다', () => {
  assert.equal(readGesture({ textEvent: { eventType: SCROLL_TOP } } as never)?.gesture, 'up');
  // 텍스트 화면의 탭은 이 경로로 오지 않는다.
  assert.equal(readGesture({ textEvent: { eventType: CLICK } } as never), null);
});
