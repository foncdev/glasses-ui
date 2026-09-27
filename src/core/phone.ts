/**
 * 폰(Relay 앱)의 타이머·물 마시기 상태.
 *
 * 안경은 폰(127.0.0.1)에 붙어 있고, 폰이 GET /phone/status로 알려 준다.
 * 서버(relay-service)와 상관없는 폰의 기능이라 서버가 있어도 폰이 답한다.
 *
 * 안경은 몇 초마다 읽고, 그 사이에는 받은 때부터 남은 시간을 줄여 그린다.
 */

export interface PhoneTimer {
  phase: 'idle' | 'running' | 'paused' | 'done';
  /** 전체 길이(초). 진행바의 분모다. */
  duration: number;
  /** 폰이 답한 때 남은 시간(초). */
  remaining: number;
  progress: number;
  /** 돌고 있을 때 끝나는 시각(ms). */
  endsAt?: number;
}

export interface PhoneWater {
  enabled: boolean;
  count: number;
  goal: number;
  /** 가장 최근에 알렸어야 하는 시각(ms). 바뀌면 팝업을 띄운다. 목표를 채웠으면 없다. */
  lastDue?: number;
  next?: number;
}

export interface PhoneStatus {
  timer: PhoneTimer;
  water: PhoneWater;
}

/** 지금 남은 시간(초). 받은 때(fetchedAt)부터 흐른 만큼 줄인다. */
export function timerRemaining(t: PhoneTimer, fetchedAt: number, now: number): number {
  if (t.phase === 'done') return 0;
  if (t.phase !== 'running') return t.remaining;
  return Math.max(0, t.remaining - (now - fetchedAt) / 1000);
}

/** 진행바가 찰 비율(0~1). 타이머를 쓰지 않으면 null — 상단은 원래 선이다. */
export function timerRatio(t: PhoneTimer, fetchedAt: number, now: number): number | null {
  if (t.phase === 'idle' || t.duration <= 0) return null;
  return Math.min(1, Math.max(0, 1 - timerRemaining(t, fetchedAt, now) / t.duration));
}

/** 홈 상태 표시줄에 넣을 타이머 글. 분 단위로 올림한다. */
export function timerLabel(t: PhoneTimer, fetchedAt: number, now: number): string {
  const min = () => `${Math.ceil(timerRemaining(t, fetchedAt, now) / 60)}분`;
  switch (t.phase) {
    case 'running':
      // 폰을 못 읽는 사이 다 됐으면 끝난 것으로 보인다. 다음에 읽으면 맞춰진다.
      return timerRemaining(t, fetchedAt, now) <= 0 ? '◆ 끝' : `▶ ${min()}`;
    case 'paused':
      return `■ ${min()}`;
    case 'done':
      return '◆ 끝';
    default:
      return '';
  }
}

/** '60분', '1분 40초'처럼 길이를 적는다. */
export function durationLabel(seconds: number): string {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r}초`;
  return r === 0 ? `${m}분` : `${m}분 ${r}초`;
}

/** 홈 상태 표시줄에 넣을 물 마시기 글. 알림을 껐으면 비운다. */
export function waterLabel(w: PhoneWater): string {
  return w.enabled ? `물 ${w.count}/${w.goal}` : '';
}

export type PhoneEvent = 'timerDone' | 'waterDue';

export type PhoneTimerAction = 'start' | 'pause' | 'resume' | 'add' | 'reset';

/** 안경의 타이머·물 화면 한 줄. 누르면 폰에 조작을 보낸다. */
export interface PhoneAction {
  label: string;
  timer?: { action: PhoneTimerAction; minutes?: number };
  water?: 'drink' | 'undo';
}

/** 타이머 길이 선택지(분). 폰과 같다. */
export const TIMER_PRESETS = [60, 30, 15];

/**
 * 타이머·물 화면의 줄. 타이머 상태에 따라 고를 것이 달라진다.
 *
 * 남은 시간·잔 수는 줄에 넣지 않고 머리줄에 둔다. 목록 글자가 바뀌면
 * 목록을 다시 세워 선택이 첫 줄로 돌아가기 때문이다. 줄은 누를 때만 바뀐다.
 */
export function phoneActions(s: PhoneStatus): PhoneAction[] {
  const timer: PhoneAction[] =
    s.timer.phase === 'running'
      ? [
          { label: '■ 멈춤', timer: { action: 'pause' } },
          { label: '+1분', timer: { action: 'add' } },
          { label: '초기화', timer: { action: 'reset' } },
        ]
      : s.timer.phase === 'paused'
        ? [
            { label: '▶ 계속', timer: { action: 'resume' } },
            { label: '+1분', timer: { action: 'add' } },
            { label: '초기화', timer: { action: 'reset' } },
          ]
        : TIMER_PRESETS.map((m) => ({ label: `▶ ${m}분 시작`, timer: { action: 'start' as const, minutes: m } }));
  return [
    ...timer,
    { label: '물 한 잔 마셨어요', water: 'drink' },
    { label: '물 한 잔 빼기', water: 'undo' },
  ];
}

/** 타이머·물 화면의 머리줄. 남은 시간과 오늘 잔 수를 보인다. */
export function phoneHeader(s: PhoneStatus, fetchedAt: number, now: number): string {
  const timer = timerLabel(s.timer, fetchedAt, now) || '대기';
  return `타이머 ${timer} · 물 ${s.water.count}/${s.water.goal}잔`;
}

/**
 * 앞서 받은 것과 비교해 알릴 일을 찾는다.
 * 처음 받은 것에는 알리지 않는다 — 안경을 켰을 때 지난 일이 뜨면 안 된다.
 */
export function phoneEvents(prev: PhoneStatus | undefined, next: PhoneStatus): PhoneEvent[] {
  if (!prev) return [];
  const events: PhoneEvent[] = [];
  if (prev.timer.phase === 'running' && next.timer.phase === 'done') events.push('timerDone');
  if (next.water.enabled && next.water.lastDue && next.water.lastDue !== prev.water.lastDue) {
    events.push('waterDue');
  }
  return events;
}
