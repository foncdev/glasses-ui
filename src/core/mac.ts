/**
 * 맥 화면(mac-agent)의 자료와 글.
 *
 * mac-agent는 relay-service의 확장 통로(/ext/mac-agent)로 붙는 별도 제품이다.
 * 여기는 화면에 띄울 글을 만드는 순수 함수만 둔다. 화면 전환·제스처는
 * glasses-ui.ts가 맡는다.
 *
 * 맥에서 온 자료(발표자 노트, 자막, 일정 제목, 단축어 이름)는 옮기지 않는다.
 */

import { displayWidth } from './glasses.js';
import { msg } from './i18n.js';

/** relay-service GET /ext가 주는 에이전트 하나. */
export interface ExtAgent {
  agent: string;
  name: string;
  version: string;
  capabilities: ExtCapability[];
}

export interface ExtCapability {
  id: string;
  ready: boolean;
  reason?: string;
}

export interface PresentState {
  /** none · no_document · ready · playing */
  status: string;
  app?: string;
  document?: string;
  slide?: number;
  total?: number;
  notes?: string;
  nextNotes?: string;
  startedAt?: string;
}

/** 맥 발표 폴더의 자료 하나(GET /present/files). */
export interface PresentFile {
  name: string;
  app?: string;
  modifiedAt?: number;
}

export interface CaptionLine {
  id: number;
  text: string;
  final: boolean;
  at: string;
  /** 옮긴 글. 줄이 굳은 뒤 같은 id로 한 번 더 온다. */
  translation?: string;
}

export interface CaptionsState {
  running: boolean;
  stoppedReason?: string;
  /** 옮기는 언어(ko 등). */
  translateTo?: string;
  /** 번역이 안 되는 까닭(translation_not_installed 등). */
  translateError?: string;
}

export interface MacEvent {
  title: string;
  start: string;
  end: string;
  location?: string;
  meetingURL?: string;
}

/** 텔레프롬프터 상태. lines[0]이 start번 줄이다. */
export interface PrompterState {
  hasScript: boolean;
  following: boolean;
  line: number;
  total: number;
  start: number;
  lines: string[];
  error?: string;
  /** 한 화면(페이지)씩 넘기는 원고(mac-agent 0.1.1부터). 없으면 줄 단위로 보인다. */
  page?: number;
  pages?: number;
  pageLines?: string[];
  /** 지금 줄이 페이지에서 몇째 줄인지(따라가기·시간대로일 때 ▷) */
  pageLine?: number;
  /** 이 페이지가 속한 쪽(슬라이드) */
  slide?: number;
  nextPageFirst?: string;
  /** manual · timeline */
  mode?: string;
  playing?: boolean;
}

export interface MacShortcut {
  id: string;
  name: string;
}

/** 맥 메뉴. 기능 목록의 id와 짝지어 쓸 수 있는지 본다. */
export const MAC_ITEMS = [
  { label: 'macPresent', capability: 'present', screen: 'mac-present' },
  { label: 'macCaptions', capability: 'captions', screen: 'mac-captions' },
  { label: 'macMeeting', capability: 'calendar', screen: 'mac-meeting' },
  { label: 'macShortcuts', capability: 'shortcuts', screen: 'mac-shortcuts' },
  { label: 'macPrompter', capability: 'prompter', screen: 'mac-prompter' },
  { label: 'macPresentFiles', capability: 'present-files', screen: 'mac-present-files' },
] as const;

export type MacItem = (typeof MAC_ITEMS)[number];

/** 텍스트 화면 한 줄의 폭(한글 2칸). 576px에 한글 22자 남짓이 들어간다. */
export const MAC_COLS = 44;
/** 텍스트 화면 전체 줄 수. 288px / 27px. */
export const MAC_ROWS = 10;

/** 기능을 못 쓰는 사유를 짧은 글로. 모르는 사유는 '쓸 수 없음'. */
export function reasonText(reason: string | undefined, agent = 'mac-agent'): string {
  const m = msg();
  switch (reason) {
    case 'license_required':
      return m.reasonLicense;
    case 'folder_missing':
      // PC(win-agent)는 단축어 대신 스크립트 폴더
      return agent === 'win-agent' ? m.reasonScriptFolderMissing : m.reasonFolderMissing;
    case 'folder_empty':
      return m.reasonFolderEmpty;
    case 'automation_denied':
      return m.reasonAutomation;
    case 'screen_recording_required':
    case 'screen_recording_denied':
      return m.reasonScreen;
    case 'speech_denied':
      return m.reasonSpeech;
    case 'calendar_denied':
      return m.reasonCalendar;
    case 'no_app':
      return m.reasonNoApp;
    case 'translation_not_installed':
      return m.reasonTranslationModel;
    case 'translation_unsupported':
      // PC(win-agent)는 OS 버전 문제가 아니라 번역기를 고르지 않은 것
      return agent === 'win-agent' ? m.reasonTranslationCloud : m.reasonMacOS;
    case 'macos_too_old':
      return m.reasonMacOS;
    case 'translation_local_en_only':
      return m.reasonTranslationEnOnly;
    case 'model_missing':
      return m.reasonModelMissing;
    default:
      return m.reasonUnavailable;
  }
}

/** 메뉴 한 줄. 못 쓰는 기능은 사유를 붙인다. */
export function macItemLabel(item: MacItem, caps: ExtCapability[], agent = 'mac-agent'): string {
  // PC(win-agent)는 맥의 단축어 자리에 스크립트 폴더를 쓴다.
  const label = agent === 'win-agent' && item.label === 'macShortcuts' ? msg().macScripts : msg()[item.label];
  const cap = caps.find((c) => c.id === item.capability);
  if (!cap) return `${label} · ${msg().reasonUnavailable}`;
  return cap.ready ? label : `${label} · ${reasonText(cap.reason, agent)}`;
}

/**
 * 폭에 맞춰 줄로 나눈다. 줄바꿈은 살린다(노트는 줄 단위로 쓴다).
 * 넘치는 줄은 버리고 마지막 줄 끝에 …를 붙인다.
 */
export function wrapLines(text: string, cols: number, maxRows: number): string[] {
  const rows: string[] = [];
  for (const para of text.split('\n')) {
    let rest = para.replace(/\s+/g, ' ').trim();
    if (!rest) continue;
    while (rest) {
      if (rows.length === maxRows) {
        rows[maxRows - 1] = clip(`${rows[maxRows - 1]}…`, cols);
        return rows;
      }
      if (displayWidth(rest) <= cols) {
        rows.push(rest);
        break;
      }
      let cut = 0;
      let width = 0;
      for (const ch of rest) {
        width += displayWidth(ch);
        if (width > cols) break;
        cut += ch.length;
      }
      const space = rest.lastIndexOf(' ', cut);
      if (space > cut / 2) cut = space;
      rows.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
  }
  return rows;
}

function clip(text: string, cols: number): string {
  let out = '';
  let width = 0;
  for (const ch of text) {
    width += displayWidth(ch);
    if (width > cols) break;
    out += ch;
  }
  return out;
}

/** 텍스트 화면에 쓸 글. 첫 줄은 머리, 마지막 줄은 안내다. */
function page(head: string, body: string[], hint: string): string {
  const room = MAC_ROWS - 2;
  // 펌웨어가 빈 줄 앞 공백을 지운다. 빈 줄은 공백 하나로 둔다.
  return [clip(head, MAC_COLS), ...body.slice(0, room).map((l) => l || ' '), hint].join('\n');
}

/** 흐른 분. 발표 시작 시각에서 센다. */
function elapsedMinutes(startedAt: string | undefined, now: number): number | undefined {
  if (!startedAt) return undefined;
  const t = Date.parse(startedAt);
  return Number.isNaN(t) ? undefined : Math.max(0, Math.floor((now - t) / 60_000));
}

/** 발표 중 아래 줄 단추. 위아래로 고르고 탭으로 실행한다. */
export const PRESENT_ACTIONS = ['prev', 'next', 'stop'] as const;
export type PresentAction = (typeof PRESENT_ACTIONS)[number];

/** 발표 단추 고르기 상태. stopArmed면 끄기를 한 번 더 눌러야 실행한다(실수로 끄지 않게). */
export interface PresentControls {
  cursor: number;
  stopArmed: boolean;
}

/** 단추 줄. 고른 단추는 [▶ ]로 감싼다. */
function presentActionsRow(cursor: number): string {
  const m = msg();
  const labels = [m.presentPrevAction, m.presentNextAction, m.presentStopAction];
  return '  ' + labels.map((label, i) => (i === cursor ? `[▶${label}]` : ` ${label} `)).join('   ');
}

export function presentPage(
  state: PresentState | undefined,
  error: string | undefined,
  now: number,
  controls: PresentControls = { cursor: 1, stopArmed: false },
): string {
  const m = msg();
  if (!state) return page(m.macPresent, [error ?? m.reading], m.hintBack);
  if (state.status === 'none') return page(m.macPresent, [m.presentNone, ' ', m.macFixOnMac], m.hintBack);
  if (state.status === 'no_document') return page(m.macPresent, [m.presentNoDoc], m.hintBack);

  const playing = state.status === 'playing';
  const minutes = elapsedMinutes(state.startedAt, now);
  const head = [
    playing ? m.presentPlaying : m.presentReady,
    state.slide && state.total ? m.presentSlide(state.slide, state.total) : '',
    playing && minutes !== undefined ? m.minShort(minutes) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  // 노트가 주인공이다. 다음 쪽 노트는 한 줄만 미리 보인다. 발표 중이면 맨 아래에 단추 줄을 둔다.
  const next = state.nextNotes ? `${m.presentNext}: ${state.nextNotes.split('\n')[0]}` : '';
  const notesRows = MAC_ROWS - 2 - (next ? 2 : 0) - (error ? 1 : 0) - (playing ? 1 : 0);
  const notes = state.notes ? wrapLines(state.notes, MAC_COLS, notesRows) : [m.presentNoNotes];
  const body = [...notes];
  if (next) body.push(' ', clip(next, MAC_COLS));
  if (error) body.unshift(clip(error, MAC_COLS));
  if (!playing) return page(head, body, m.presentStartHint);
  // 단추 줄은 늘 힌트 바로 위다. 노트가 짧으면 빈 줄로 채워 자리를 고정한다.
  while (body.length < MAC_ROWS - 3) body.push(' ');
  body.push(presentActionsRow(controls.cursor));
  return page(head, body, controls.stopArmed ? m.presentStopConfirm : m.presentHint);
}

/**
 * 자막: 맨 아래가 지금 하는 말이다. 굳은 줄 몇 개와 말하는 중인 줄을 폭에 맞춰
 * 접은 뒤 아래쪽부터 화면을 채운다.
 */
export function captionsPage(
  lines: CaptionLine[],
  partial: CaptionLine | undefined,
  state: CaptionsState | undefined,
  error: string | undefined,
  agent = 'mac-agent',
): string {
  const m = msg();
  const running = state?.running ?? false;
  const head = `${m.macCaptions} · ${running ? m.captionsOn : m.captionsOff}`;
  const hint = running ? m.captionsHintOn : m.captionsHintOff;
  const room = MAC_ROWS - 2;

  // 옮긴 글이 있으면 그걸 보인다. 안경은 좁아 둘 다 띄우면 두 줄 남짓밖에 안 남는다.
  // 말하는 중인 줄은 원문 그대로다 — 굳어야 옮긴다.
  const texts = [...lines.slice(-4).map((l) => l.translation ?? l.text), ...(partial?.text ? [partial.text] : [])];
  let rows = texts.flatMap((t) => wrapLines(t, MAC_COLS, room));
  rows = rows.slice(-room);
  const problem = error ?? (state?.translateError ? reasonText(state.translateError, agent) : undefined);
  if (problem) rows = [clip(problem, MAC_COLS), ...rows.slice(-(room - 1))];
  if (rows.length === 0) rows = [running ? m.captionsEmpty : m.captionsIdle];
  return page(head, rows, hint);
}

function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function meetingPage(event: MacEvent | null | undefined, error: string | undefined, now: number): string {
  const m = msg();
  if (error) return page(m.macMeeting, [clip(error, MAC_COLS)], m.meetingHint);
  if (event === undefined) return page(m.macMeeting, [m.reading], m.hintBack);
  if (event === null) return page(m.macMeeting, [m.meetingNone], m.meetingHint);

  const start = Date.parse(event.start);
  const minutes = Math.round((start - now) / 60_000);
  const when =
    start <= now ? m.meetingNow : minutes < 60 ? m.meetingIn(Math.max(1, minutes)) : m.meetingInHours(Math.floor(minutes / 60));
  const body = [
    ...wrapLines(event.title, MAC_COLS, 3),
    ' ',
    `${clock(event.start)} - ${clock(event.end)} · ${when}`,
  ];
  if (event.location) body.push(...wrapLines(event.location, MAC_COLS, 2));
  if (event.meetingURL) body.push(m.meetingLink);
  return page(m.macMeeting, body, m.meetingHint);
}

/**
 * 텔레프롬프터. 지금 줄에 ▷를 붙이고 그 뒤 줄을 이어 보인다. 앞 줄은 하나만 남긴다 —
 * 방금 읽은 끝을 놓쳤을 때 눈을 돌릴 자리다.
 */
export function prompterPage(state: PrompterState | undefined, error: string | undefined): string {
  const m = msg();
  if (!state) return page(m.macPrompter, [error ?? m.reading], m.hintBack);
  if (!state.hasScript) {
    return page(m.macPrompter, [...(error ? [clip(error, MAC_COLS)] : []), m.prompterEmpty], m.prompterLoadHint);
  }
  if ((state.pages ?? 0) > 0 && state.pageLines) return prompterPagedView(state, error);
  const head = `${m.macPrompter} · ${state.line + 1}/${state.total} · ${state.following ? m.prompterFollowing : m.prompterManual}`;
  const room = MAC_ROWS - 2 - (error ? 1 : 0);
  const rows: string[] = [];
  state.lines.forEach((text, i) => {
    const index = state.start + i;
    if (index < state.line - 1) return;
    // 지금 줄은 ▷로 표시한다. 펌웨어 글꼴에 있는 글자다. 다른 줄을 들여 써 맞추지 않는다 —
    // 펌웨어가 줄 앞 공백을 지운다.
    rows.push(...wrapLines(index === state.line ? `▷ ${text}` : text, MAC_COLS, 2));
  });
  const problem = error ?? (state.error ? m.prompterNoMic : undefined);
  const body = problem ? [clip(problem, MAC_COLS), ...rows.slice(0, room)] : rows.slice(0, room);
  return page(head, body, state.following ? m.prompterHintOn : m.prompterHintOff);
}

/**
 * 페이지로 나뉜 원고: 한 화면(빈 줄로 나눈 문단, 4줄까지)을 통째로 보이고, 위아래로 화면을 넘긴다.
 * 머리에 쪽(슬라이드)과 화면 번호. 남는 줄이 있으면 다음 화면 첫 줄을 미리 보인다.
 */
function prompterPagedView(state: PrompterState, error: string | undefined): string {
  const m = msg();
  const timeline = state.mode === 'timeline';
  const head = [
    m.macPrompter,
    ...(state.slide != null ? [m.prompterSlide(state.slide)] : []),
    `${(state.page ?? 0) + 1}/${state.pages}`,
    ...(timeline ? [state.playing ? m.prompterPlaying : m.prompterPaused] : state.following ? [m.prompterFollowing] : []),
  ].join(' · ');
  const mark = state.following || (timeline && state.playing);
  const rows: string[] = [];
  (state.pageLines ?? []).forEach((text, i) => {
    rows.push(...wrapLines(mark && i === state.pageLine ? `▷ ${text}` : text, MAC_COLS, 3));
  });
  const problem = error ?? (state.error ? m.prompterNoMic : undefined);
  const room = MAC_ROWS - 2 - (problem ? 1 : 0);
  const body = rows.slice(0, room);
  // 다음 화면 첫 줄 미리 보기(한 줄 띄우고). 자리가 없으면 뺀다.
  if (state.nextPageFirst && body.length + 2 <= room) body.push('', clip(`${m.prompterNext} ${state.nextPageFirst}`, MAC_COLS));
  const hint = timeline
    ? state.playing ? m.prompterHintPagePlaying : m.prompterHintPagePaused
    : state.following ? m.prompterHintPageOn : m.prompterHintPageOff;
  return page(head, problem ? [clip(problem, MAC_COLS), ...body] : body, hint);
}

/** 단축어 결과. state: running · done · still · failed */
export function shortcutPage(name: string, state: string, output: string | undefined): string {
  const m = msg();
  const status =
    state === 'running' ? m.shortcutRunning : state === 'done' ? m.shortcutDone : state === 'still' ? m.shortcutStill : m.shortcutFailed;
  const body = output ? wrapLines(output, MAC_COLS, MAC_ROWS - 2) : [];
  return page(`${name} · ${status}`, body, m.hintBackToList);
}

/** 메시지 알림 제목에서 보낸 사람을 꺼낸다. "[메시지] 홍길동" → "홍길동". notify-agent가 이 모양으로 넘긴다. */
export function messageSender(title: string | undefined): string | undefined {
  for (const prefix of ['[메시지] ', '[Messages] ']) {
    if (title?.startsWith(prefix)) {
      const name = title.slice(prefix.length).trim();
      return name || undefined;
    }
  }
  return undefined;
}

/** 안경에서 고를 수 있는 짧은 답장. 마지막은 취소. */
export function quickReplies(): string[] {
  const m = msg();
  return [m.replyOk, m.replyOnMyWay, m.replyLater, m.replyThanks];
}

/** 화면에 띄울 오류 글. 서버가 준 코드가 사유로 알려진 것이면 짧은 사유로 바꾼다. */
export function errorText(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e?.code === 'no_agent') return msg().macNotConnected;
  if (e?.code === 'no_presentation') return msg().presentNoDoc;
  if (e?.code) {
    const reason = reasonText(e.code);
    if (reason !== msg().reasonUnavailable) return reason;
  }
  return e?.message ?? String(err);
}
