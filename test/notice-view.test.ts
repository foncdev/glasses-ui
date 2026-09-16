/**
 * 알림 팝업 레이아웃 검증.
 *
 * 안경 화면은 576×288 단색에 64칸이다. 색도 굵기도 없어 빈 줄만이 층을
 * 나누는 수단이다. 처음에는 구분선을 그었는데 전각 '─'가 두 칸을 먹어
 * 폭을 넘겨 두 겹으로 접혔고, 반각으로 바꿔도 글자와 굵기가 같아
 * 어수선했다. 그래서 선을 버리고 빈 줄로 나눈다.
 *
 * 화면 없이 글자만 보고 확인할 수 있어야 해서 순수 함수로 두었다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { noticeView } from '../src/core/glasses-ui.js';
import { displayWidth } from '../src/core/glasses.js';

/** 팝업이 쓸 수 있는 칸 수. 넘으면 기기가 접어 줄 수가 어긋난다. */
const COLS = 40;

test('갈래를 머리말로 먼저 보여준다', () => {
  const out = noticeView({ label: '* 할 일', title: '추가: 우유', text: '' }, 5000);
  assert.equal(out.split('\n')[0], '* 할 일', '무엇을 알리는지 먼저 보여야 한다');
});

test('제목과 본문이 같으면 한 번만 그린다', () => {
  // 웹에서 제목만 적어 보내면 본문이 제목으로 채워져 두 줄로 겹쳤다.
  const out = noticeView({ label: '* 알림', title: '회의 5분 전', text: '회의 5분 전' }, 5000);
  const hits = out.split('\n').filter((l) => l.includes('회의 5분 전'));
  assert.equal(hits.length, 1, `같은 글이 ${hits.length}줄로 겹쳤다`);
});

test('머리말과 겹치는 말머리를 뗀다', () => {
  // '* 할 일' 아래 '할 일 추가: …'가 오면 같은 말이 두 번 보인다.
  const out = noticeView({ label: '* 할 일', title: '할 일 추가: 우유', text: '' }, 5000);
  assert.ok(out.includes('추가: 우유'), '내용이 사라졌다');
  assert.ok(!out.includes('할 일 추가'), '말머리가 남아 머리말과 겹친다');
});

test('어느 줄도 화면 폭을 넘지 않는다', () => {
  // 넘치면 기기가 접어 줄 수가 늘고, 아래 안내가 화면 밖으로 밀린다.
  const out = noticeView(
    {
      label: '* 오류',
      title: '아주 긴 제목을 넣어 폭을 넘기는지 확인한다 이것은 일부러 길게 적은 제목이다',
      text: '본문도 길게 적어 세 줄로 나뉘는지, 각 줄이 폭 안에 들어가는지 함께 확인한다. 한글은 한 글자가 두 칸이라 글자 수로 세면 넘친다.',
    },
    5000,
  );
  for (const line of out.split('\n')) {
    assert.ok(displayWidth(line) <= COLS, `폭 초과(${displayWidth(line)}): ${line}`);
  }
});

test('본문이 길면 세 줄까지만 보여주고 잘렸음을 알린다', () => {
  const out = noticeView(
    {
      label: '* 알림',
      title: '제목',
      text: '가'.repeat(300),
    },
    5000,
  );
  const lines = out.split('\n');
  // 머리말·빈줄·제목·본문·빈줄·안내
  const body = lines.filter((l) => l.startsWith('가'));
  assert.ok(body.length <= 3, `본문이 ${body.length}줄이다 — 화면을 넘긴다`);
  assert.ok(out.includes('…'), '잘렸는데 알려주지 않는다');
});

test('남은 시간과 닫는 방법을 마지막에 알려준다', () => {
  const out = noticeView({ label: '* 알림', title: '제목', text: '' }, 5000);
  const last = out.split('\n').at(-1)!;
  assert.match(last, /5초/, '몇 초 뒤 사라지는지 보여야 한다');
  assert.match(last, /탭/, '먼저 닫는 방법도 알려야 한다');
});

test('선을 긋지 않는다', () => {
  // 전각 선은 폭을 넘겨 접히고, 반각 선은 글자와 구별되지 않는다.
  const out = noticeView({ label: '* 알림', title: '제목', text: '본문' }, 5000);
  assert.ok(!out.includes('─'), '전각 구분선은 폭을 넘긴다');
  assert.ok(!out.includes('---'), '반각 구분선은 단색 화면에서 어수선하다');
});
