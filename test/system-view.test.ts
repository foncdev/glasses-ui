/**
 * 시스템 화면 레이아웃 검증.
 *
 * top을 그대로 보여주지 않는다. ANSI 이스케이프가 안경에서 깨지고,
 * 한 줄이 80칸을 넘어 접히고, 갱신을 계속 밀어 배터리를 먹는다.
 * 그래서 숫자만 뽑아 한눈에 읽히게 둔다.
 *
 * 못 구한 값은 0이나 -1로 온다. 그것을 그대로 보여주면 "CPU 0%"나
 * "MEM -1G"처럼 사실과 다른 값이 화면에 남는다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { systemView } from '../src/core/glasses-ui.js';
import { displayWidth } from '../src/core/glasses.js';
import type { SysProc, SysSummary } from '../src/core/agent-cli.js';

/** 시스템 화면 한 줄이 쓸 수 있는 칸 수. */
const COLS = 38;

const SYS: SysSummary = {
  cpuPercent: 18.5,
  memUsedGB: 34.3,
  memTotalGB: 64,
  load: [2.37, 2.48, 2.53],
  uptime: '5일 21시간',
  host: 'mac-dev',
  os: 'darwin',
};

const PROCS: SysProc[] = [
  { pid: 37732, cpu: 15.8, mem: 0.8, name: 'iTerm2' },
  { pid: 405, cpu: 13.1, mem: 0.5, name: 'WindowServer' },
  { pid: 9445, cpu: 7.2, mem: 1.0, name: 'claude' },
];

test('CPU·메모리·가동 시간을 보여준다', () => {
  const out = systemView(SYS, PROCS);
  const text = out.items.join('\n');
  assert.match(text, /CPU 19%/, 'CPU를 반올림해 보여야 한다');
  assert.match(text, /34\.3\/64G/, '메모리는 쓰는 양/전체로 보여야 한다');
  assert.match(text, /5일 21시간/, '가동 시간이 없다');
  assert.match(out.header, /mac-dev/, '어느 기계인지 보여야 한다');
});

test('프로세스를 사용률과 함께 보여준다', () => {
  const out = systemView(SYS, PROCS);
  const text = out.items.join('\n');
  for (const p of PROCS) {
    assert.ok(text.includes(p.name), `${p.name}이 없다`);
  }
  assert.match(text, /15\.8%/, '사용률이 없다');
});

test('어느 줄도 화면 폭을 넘지 않는다', () => {
  // 넘치면 기기가 접어 줄이 늘고 목록이 화면 밖으로 밀린다.
  const long: SysProc[] = [
    { pid: 1, cpu: 99.9, mem: 9.9, name: 'Google Chrome Helper (Renderer) 아주 긴 이름' },
    { pid: 2, cpu: 5, mem: 1, name: 'a'.repeat(80) },
  ];
  const out = systemView(SYS, long);
  for (const line of [out.header, ...out.items]) {
    assert.ok(displayWidth(line) <= 64, `폭 초과(${displayWidth(line)}): ${line}`);
  }
  for (const line of out.items) {
    assert.ok(displayWidth(line) <= COLS, `목록 폭 초과(${displayWidth(line)}): ${line}`);
  }
});

test('긴 이름이어도 사용률이 잘리지 않는다', () => {
  // 이름을 먼저 자르면 긴 이름에서 사용률이 다음 줄로 밀린다.
  const out = systemView(SYS, [
    { pid: 1, cpu: 42.5, mem: 1, name: '아주아주긴프로세스이름을넣어본다그래도잘려야한다' },
  ]);
  assert.ok(out.items.some((l) => l.includes('42.5%')), '사용률이 사라졌다');
});

test('못 구한 값은 숫자 대신 빈 표시를 쓴다', () => {
  // -1과 0을 그대로 보여주면 사실과 다른 값이 화면에 남는다.
  const out = systemView(
    { ...SYS, cpuPercent: -1, memTotalGB: 0, memUsedGB: 0, load: [], uptime: '' },
    [],
  );
  const text = out.items.join('\n');
  assert.match(text, /CPU —/, 'CPU를 못 구했는데 숫자를 보여준다');
  assert.match(text, /MEM —/, '메모리를 못 구했는데 숫자를 보여준다');
  assert.ok(!text.includes('-1'), `-1이 화면에 남았다: ${text}`);
  assert.ok(!text.includes('0.0/0G'), '0으로 채운 값이 남았다');
});

test('아직 못 읽었으면 읽는 중이라고 알린다', () => {
  // 빈 목록만 두면 고장으로 보인다.
  const out = systemView(undefined, []);
  assert.match(out.items.join(' '), /읽는 중/);
});

test('프로세스를 못 읽어도 요약은 보여준다', () => {
  // terminal-agent가 일부만 답할 수 있다. 하나가 없다고 전부 버리지 않는다.
  const out = systemView(SYS, []);
  assert.match(out.items.join('\n'), /CPU 19%/, '요약이 사라졌다');
  assert.match(out.items.join('\n'), /읽지 못했습니다/, '무엇이 없는지 알려야 한다');
});

test('뒤로 가는 방법을 머리말에 적는다', () => {
  assert.match(systemView(SYS, PROCS).header, /더블탭/);
  assert.match(systemView(undefined, []).header, /더블탭/);
});
