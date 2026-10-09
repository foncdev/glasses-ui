/**
 * 안경 UI 본체.
 *
 * 서버의 세션 상태를 안경 화면으로 옮기고, 안경 제스처를 서버 명령으로 옮긴다.
 * 기기에 대해서는 GlassesAdapter 인터페이스만 알고 있어, 안경 종류가 늘어나도
 * 이 파일은 그대로 둔다.
 */

import {
  agentCli,
  AgentCliError,
  DESKTOP_AGENTS,
  type DesktopAgentName,
  type ChecklistItem,
  type Notification,
  type SessionEvent,
  type SessionInfo,
  type Snippet,
  type SysProc,
  type SysSummary,
} from './agent-cli.js';
import {
  clamp,
  clampWidth,
  displayWidth,
  type GestureEvent,
  type GlassesAdapter,
  type Item,
  type ItemState,
  type ChecklistView,
  type SystemView,
  type CommandsView,
  type CommandResultView,
  type HistoryView,
  type HomeView,
  type LineKind,
  type LiveView,
  type PermissionView,
  type NoticeKind,
  type NotificationView,
  type NotificationsView,
  type SessionsView,
} from './glasses.js';
import {
  durationLabel,
  phoneActions,
  phoneEvents,
  phoneHeader,
  timerLabel,
  timerRatio,
  waterLabel,
  type PhoneAction,
  type PhoneEvent,
  type PhoneStatus,
} from './phone.js';
import { msg } from './i18n.js';
import { slashItems, type SlashItem } from './slash.js';
import {
  DEFAULT_MENU,
  menuLabel,
  moveMenu,
  normalizeMenu,
  sameMenu,
  toggleMenu,
  visibleMenu,
  type MenuConfig,
  type MenuId,
} from './menu.js';
import {
  MAC_ITEMS,
  captionsPage,
  errorText,
  macItemLabel,
  meetingPage,
  messageSender,
  quickReplies,
  presentPage,
  presentFilesPage,
  documentPage,
  PRESENT_ACTIONS,
  READY_ACTIONS,
  type PresentAction,
  prompterPage,
  reasonText,
  shortcutPage,
  type CaptionLine,
  type CaptionsState,
  type ExtCapability,
  type MacEvent,
  type MacItem,
  type MacShortcut,
  type PresentFile,
  type PresentState,
  type PrompterState,
  MAC_COLS,
  MAC_ROWS,
} from './mac.js';
import { paginate, padWidth, parseUsage, plainText, shortReset, usageBar } from './reader.js';

/**
 * 화면 구성.
 *
 *   home ─ 상단 요약 + 메뉴 4개 (옆에 DEV 로고)
 *     ├ 에이전트  sessions → history → detail
 *     ├ 알림 보기 notifications → notification
 *     ├ 체크 보기 checklist
 *     └ 설정      settings
 *
 * 더블탭은 늘 한 단계 위로 간다. 최상위(home)에서는 아무 일도 하지 않는다.
 */
type Screen =
  | 'home'
  | 'sessions'
  | 'history'
  | 'detail'
  | 'slash'
  | 'reader'
  | 'notifications'
  | 'notification'
  | 'checklist'
  | 'system'
  | 'commands'
  | 'command-result'
  | 'phone'
  | 'home-menu'
  | 'settings'
  | 'menu-edit'
  | 'menu-item'
  | 'mac'
  | 'mac-present'
  | 'mac-captions'
  | 'mac-meeting'
  | 'mac-shortcuts'
  | 'mac-present-files'
  | 'mac-document'
  | 'mac-prompter'
  | 'mac-reply'
  | 'mac-result';

/** home에서 한 단계 아래로 내려갈 메뉴. 순서가 곧 커서 위치다. */
/** 상태 표시줄 시각. HH:MM. */
function clock(now = new Date()): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * 마지막 활동이 얼마나 지났는지. 안경 한 줄에 들어가게 짧게 쓴다.
 * 방금 · 12분 · 3시간 · 어제 · 4일
 */
/**
 * 도구 입력에서 한 줄로 보여줄 대상을 고른다. 명령·파일·검색어 순.
 * 모르는 도구면 비워 둔다.
 */
export function toolBrief(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  for (const k of ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'path', 'description']) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) {
      const line = v.split('\n')[0]!.trim();
      // 경로는 끝 두 칸이면 알아본다. 앞부분은 대개 홈 폴더다.
      return k.endsWith('path') ? line.split('/').slice(-2).join('/') : line;
    }
  }
  return '';
}

type Elapsed = { unit: 'now' | 'min' | 'hour' | 'yesterday' | 'day'; n: number };

function elapsed(iso: string | undefined, now: number): Elapsed | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return null;
  const min = Math.floor((now - t) / 60_000);
  if (min < 1) return { unit: 'now', n: 0 };
  if (min < 60) return { unit: 'min', n: min };
  const hour = Math.floor(min / 60);
  if (hour < 24) return { unit: 'hour', n: hour };
  const day = Math.floor(hour / 24);
  return day === 1 ? { unit: 'yesterday', n: 1 } : { unit: 'day', n: day };
}

export function timeAgo(iso: string | undefined, now = Date.now()): string {
  const e = elapsed(iso, now);
  if (!e) return '';
  const m = msg();
  switch (e.unit) {
    case 'now':
      return m.justNow;
    case 'min':
      return m.minShort(e.n);
    case 'hour':
      return m.hourShort(e.n);
    case 'yesterday':
      return m.yesterday;
    default:
      return m.dayShort(e.n);
  }
}

/**
 * '12분 전'처럼 문장으로. 방금·어제는 '전'을 붙이지 않는다.
 * tight면 좁은 카드용으로 줄인다(영어는 '12m ago' 대신 '12m').
 */
export function agoPhrase(iso: string | undefined, now = Date.now(), tight = false): string {
  const e = elapsed(iso, now);
  if (!e) return '';
  const m = msg();
  if (e.unit === 'now') return m.justNow;
  if (e.unit === 'yesterday') return m.yesterdayAgo;
  const short = timeAgo(iso, now);
  return tight ? m.agoTight(short) : m.ago(short);
}


/**
 * 홈에서 더블탭하면 뜨는 선택지.
 *
 * 예전에는 더블탭이 곧바로 화면을 껐다. 그런데 Relay가 켜져 있는 동안은 안경이
 * 카카오톡·전화 같은 시스템 알림을 가려서, 안 쓸 때 빠르게 나갈 길이 필요했다.
 * 화면 끄기가 가장 흔하므로 맨 위에 둔다.
 */
const HOME_MENU = ['screenOff', 'exit', 'cancel'] as const;

/**
 * 화면이 꺼지기까지의 시간 선택지.
 * 설정 화면에서 고른다.
 */
const IDLE_CHOICES = [10_000, 15_000, 30_000];


/** 폰트에 확실히 있는 문자만 쓴다. 기기 폰트에 없는 글자는 빈칸이 된다. */
const SPINNER = ['|', '/', '-', '\\'];

/** 권한 화면을 띄운 직후 들어오는 자동 이벤트를 무시할 시간. */
const PERMISSION_GUARD_MS = 1200;

/**
 * 아무 조작이 없을 때 화면을 비우기까지의 기본값.
 * 안경은 늘 시야에 있으므로 켜둔 채 두면 배터리와 눈 모두에 부담이다.
 * 설정 화면에서 바꿀 수 있다.
 */
const SCREEN_IDLE_MS = 15_000;

/**
 * 체크리스트·알림을 다시 읽는 간격.
 *
 * 평소에는 SSE가 알려주므로 이 타이머는 거의 할 일이 없다. 안경 웹뷰가
 * 절전으로 연결을 조용히 끊었을 때를 메우는 용도라 길게 잡는다.
 */
const SERVER_POLL_MS = 60_000;

/**
 * SSE가 막혔을 때의 갱신 주기.
 *
 * G2 웹뷰는 EventSource를 막을 때가 있다. 그때 60초를 기다리면 알림이
 * 한참 뒤에 뜨거나, 그 사이 화면이 꺼져 아예 못 본다. 이 경우에만
 * 촘촘히 돈다 — 평소에는 SSE가 즉시 알려주므로 자주 돌 이유가 없다.
 */
const SERVER_POLL_FAST_MS = 5_000;

/** 대화 화면의 실시간 연결이 막혔을 때 기록·상태를 다시 읽는 주기. */
const DETAIL_POLL_MS = 3_000;

/**
 * 폰(Relay 앱)의 타이머·물 마시기를 읽는 간격.
 *
 * 폰은 같은 기기(127.0.0.1)라 싸다. 타이머가 끝난 것을 늦게 알리지 않게
 * 짧게 잡는다. 폰이 답하지 않으면(옛 앱·서버에 직접 붙음) 드물게 읽는다.
 */
const PHONE_POLL_MS = 15_000;
const PHONE_POLL_SLOW_MS = 60_000;
/** 읽을 때가 됐는지 보는 간격. 읽기 자체는 위 간격을 지킨다. */
const PHONE_TICK_MS = 5_000;

/**
 * G2 목록은 20줄까지다. 넘기면 목록을 세우지 못해 한 줄만 뜨거나 화면이 멈춘다.
 * 알림이 24건 쌓이자 '7 new'인데 목록에는 한 줄만 보였고 탭도 먹지 않았다.
 * 끝에 동작 줄(모두 읽음·치우기·이어 보기)을 붙이는 목록은 19줄까지 보인다.
 * 그리는 곳과 탭을 받는 곳이 같은 줄을 봐야 하므로 shown*()으로만 고른다.
 */
const LIST_MAX = 20;
const LIST_ROWS = LIST_MAX - 1;
/** 폰이 이만큼 답하지 않으면 가진 타이머를 버리고 원래 선으로 돌린다. */
const PHONE_STALE_MS = 5 * 60_000;

/**
 * 알림 팝업이 화면에 머무는 시간.
 *
 * 알림은 잠깐 알리고 사라져야 한다. 탭할 때까지 남겨두면 두 가지가
 * 망가진다 — 화면이 그 상태로 굳고, 다음 알림이 "이미 팝업이 떠 있다"는
 * 이유로 막힌다. 놓쳐도 목록에 남으니 사라져도 잃는 것이 없다.
 *
 * 무조작 화면 꺼짐(15초)보다 짧게 둔다. 그래야 팝업이 걷히고 원래
 * 화면으로 돌아간 뒤에 꺼진다.
 */
const NOTICE_MS = 5_000;

/**
 * 알림 팝업 화면을 글자로 짠다.
 *
 * 안경은 576×288 단색에 64칸이다. 색도 굵기도 없어서 구분선과 빈 줄만이
 * 층을 나누는 수단이다. 그래서 머리말·본문·안내를 줄로 갈라 눈이 먼저
 * 갈래를 잡고 내용으로 내려가게 한다.
 *
 * 순수 함수로 둔다. 화면 없이 글자만 보고 확인할 수 있어야 한다.
 */
export function noticeView(
  notice: { title: string; text: string; label: string },
  ms: number = NOTICE_MS,
): string {
  /*
   * 선을 긋지 않고 빈 줄로 층을 나눈다.
   *
   * 처음에는 구분선을 넣었는데 이 화면에는 맞지 않았다. 전각 '─'는
   * 한 칸이 아니라 두 칸을 먹어 폭을 넘겨 두 겹으로 접혔고, 반각 '-'로
   * 바꿔도 단색 화면에서는 글자와 굵기가 같아 어수선하기만 했다.
   *
   * 빈 줄은 폭 계산이 필요 없고 어디서도 깨지지 않는다.
   */
  const title = notice.title.trim();
  const body = notice.text.trim();

  /*
   * 머리말은 갈래 하나로 끝낸다.
   *
   * '알림 · 새 알림'처럼 같은 말이 겹쳐 보였다. 팝업이 떴다는 것 자체가
   * 새 소식이라는 뜻이므로 '새 알림'은 군말이다.
   */
  const lines = [notice.label, ''];

  // 제목과 본문 중 있는 것만 넣는다. 둘이 같으면 제목만 남아
  // 같은 글이 두 줄로 겹치지 않는다.
  //
  // 자를 때는 글자 수가 아니라 폭을 센다. 한글은 한 글자가 두 칸이라
  // 글자 수로 세면 줄이 넘쳐 접힌다.
  // 머리말과 겹치는 말머리를 뗀다. '* 할 일' 아래 '할 일 추가: …'가
  // 오면 같은 말이 두 번 보인다.
  const head = title.replace(/^할 일\s*/, '').replace(/^완료한 할 일\s*/, '');
  if (head) lines.push(clampWidth(head, NOTICE_COLS));
  if (body && body !== title && body !== head) {
    for (const line of wrapToWidth(body, NOTICE_COLS, NOTICE_BODY_ROWS)) {
      lines.push(line);
    }
  }

  lines.push('', msg().closeHintShort(Math.round(ms / 1000)));
  return lines.join('\n');
}

/**
 * 본문을 폭에 맞춰 줄로 나눈다. 넘치는 만큼은 버린다.
 *
 * 기기가 알아서 접어주긴 하지만, 그러면 몇 줄이 될지 몰라 팝업이
 * 화면을 넘길 수 있다. 여기서 줄 수를 정해두면 아래 안내가 늘 보인다.
 */
function wrapToWidth(text: string, cols: number, maxRows: number): string[] {
  const rows: string[] = [];
  let rest = text.replace(/\s+/g, ' ').trim();

  while (rest && rows.length < maxRows) {
    if (displayWidth(rest) <= cols) {
      rows.push(rest);
      break;
    }
    // 폭에 맞는 만큼 끊고, 가능하면 낱말 사이에서 나눈다.
    const head = clampWidth(rest, cols + 1).replace(/…$/, '');
    const at = head.lastIndexOf(' ');
    const cut = at > cols / 2 ? at : head.length;
    rows.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }

  // 더 남았으면 마지막 줄 끝에 …를 붙여 잘렸음을 알린다.
  if (rest && rows.length === maxRows) {
    const last = rows[maxRows - 1];
    rows[maxRows - 1] = clampWidth(`${last}…`, cols);
  }
  return rows;
}

/**
 * 시스템 화면을 줄 목록으로 짠다.
 *
 * top을 그대로 보여주지 않는다. ANSI 이스케이프가 깨지고, 한 줄이
 * 80칸을 넘어 접히고, 갱신을 계속 밀어 배터리를 먹는다. 여기서는
 * 숫자만 뽑아 한눈에 읽히게 둔다.
 *
 * 순수 함수로 둔다. 화면 없이 글자만 보고 확인할 수 있어야 한다.
 */
export function systemView(
  sys: SysSummary | undefined,
  procs: readonly SysProc[],
): { header: string; items: string[] } {
  const m = msg();
  if (!sys) {
    return { header: m.withBack(m.system), items: [m.reading] };
  }

  // 못 구한 값은 칸을 비운다. -1이나 0을 그대로 보여주면 오해한다.
  const cpu = sys.cpuPercent >= 0 ? `CPU ${Math.round(sys.cpuPercent)}%` : 'CPU —';
  const mem =
    sys.memTotalGB > 0
      ? `MEM ${sys.memUsedGB.toFixed(1)}/${Math.round(sys.memTotalGB)}G`
      : 'MEM —';
  const load = sys.load.length > 0 ? m.load(sys.load[0].toFixed(1)) : '';

  const items = [[cpu, mem].join('  '), [load, sys.uptime ? m.uptime(sys.uptime) : '']
    .filter(Boolean)
    .join(' · ')].filter(Boolean);

  if (procs.length === 0) {
    items.push('', m.procsReadFailed);
    return { header: m.withBack(m.system), items };
  }

  items.push('');
  for (const p of procs) {
    /*
     * 이름을 폭에 맞춰 자르고 사용률을 오른쪽에 붙인다.
     *
     * 사용률을 먼저 계산해 그만큼 이름 자리를 줄인다. 이름을 먼저
     * 자르면 긴 이름에서 사용률이 다음 줄로 밀린다.
     */
    const pct = p.cpu >= 0 ? `${p.cpu.toFixed(1)}%` : '—';
    const room = SYS_COLS - displayWidth(pct) - 1;
    const name = clampWidth(p.name, Math.max(room, 8));
    const gap = Math.max(SYS_COLS - displayWidth(name) - displayWidth(pct), 1);
    items.push(name + ' '.repeat(gap) + pct);
  }

  return { header: m.withBack(sys.host || m.system), items };
}

/** 시스템 화면 한 줄의 칸 수. */
const SYS_COLS = 38;

/**
 * 명령 실행 결과 화면을 글자로 짠다.
 *
 * 명령 출력은 폭을 모른다 — ps는 전체 경로를 뱉어 한 줄이 100칸을
 * 넘는다. 기기 자동 줄바꿈에 맡기면 몇 줄이 될지 몰라 아래 안내가
 * 화면 밖으로 밀린다. 그래서 여기서 폭과 줄 수를 정해 둔다.
 *
 * 순수 함수로 둔다. 화면 없이 글자만 보고 확인할 수 있어야 한다.
 */
export function resultView(
  r: { label: string; text: string; awaitingConfirm?: boolean } | undefined,
): string {
  const m = msg();
  if (!r) return m.noResult;

  /*
   * 줄을 아낀다.
   *
   * 화면은 288px, 한 줄 27px이라 열 줄이 전부다. 머리말과 이름 사이에
   * 빈 줄까지 넣으면 본문에 두세 줄밖에 남지 않아 결과를 못 읽는다.
   * 머리말에 갈래를, 이름에 무엇을 돌렸는지 담아 두 줄로 끝낸다.
   */
  const lines = [
    `${r.awaitingConfirm ? m.resultMarkConfirm : m.resultMarkDone} · ${clampWidth(r.label, 24)}`,
    '',
  ];

  // 줄마다 폭에 맞춰 자른다. 원래 줄바꿈은 살린다 — 표 꼴로 나오는
  // 출력(ps·df)은 줄이 곧 뜻이라 이어 붙이면 읽을 수 없다.
  const body = r.text.split('\n').slice(0, RESULT_ROWS);
  for (const line of body) {
    lines.push(clampWidth(line.replace(/\t/g, ' '), RESULT_COLS));
  }
  if (r.text.split('\n').length > RESULT_ROWS) {
    lines.push(m.resultMore);
  }

  lines.push('', r.awaitingConfirm ? m.resultTapRun : m.doubleTapBack);
  return lines.join('\n');
}

/** 결과 한 줄에 들어가는 칸 수. */
const RESULT_COLS = 40;
/*
 * 결과로 보여줄 줄 수.
 *
 * 화면은 288px이고 한 줄이 27px이라 열 줄이 전부다. 머리말·빈 줄·
 * 잘림 안내·빈 줄·나가기 안내가 다섯 줄을 쓰므로 본문에 남는 것은
 * 다섯이다. 더 넣으면 아래 안내가 화면을 벗어나 나가는 방법을 알 수 없다.
 */
const RESULT_ROWS = 5;

/** 팝업 한 줄에 들어가는 칸 수. 화면 폭(64칸)보다 좁게 둬 여백을 남긴다. */
const NOTICE_COLS = 40;
/** 본문에 허용하는 줄 수. 자세한 내용은 알림 목록에서 본다. */
const NOTICE_BODY_ROWS = 3;

/**
 * 권한 요청에 대한 선택지.
 * 가장 위(커서 기본 위치)에 가장 안전한 선택을 둬서 실수로 승인되지 않게 한다.
 */
const PERMISSION_CHOICES = [
  { label: 'permDeny', behavior: 'deny' as const, always: false },
  { label: 'permOnce', behavior: 'allow' as const, always: false },
  { label: 'permAlways', behavior: 'allow' as const, always: true },
] as const;

const STORE_VOICE = 'voice.enabled';
const STORE_IDLE = 'screen.idleMs';
const STORE_LOGO = 'home.logo';
/** 홈 메뉴 순서·숨김(JSON). 비어 있으면 기본값이다. */
const STORE_MENU = 'home.menu';

export interface GlassesUIHooks {
  /** 화면 밖으로 알릴 일. 폰 UI가 로그로 보여준다. */
  onLog?: (text: string, level?: 'info' | 'ok' | 'warn' | 'error') => void;
  /** 세션 목록이 바뀌었을 때. 폰 UI 미러링에 쓴다. */
  onSessionsChanged?: (sessions: SessionInfo[], cursor: number) => void;
}

/**
 * 할 일 변경 알림의 제목인지. 서버(relay-service)와 폰이 만든다.
 *
 * 글은 서버 언어(RELAY_LANG)를 따르므로 두 언어를 다 본다. 영어 문구는 폰 앱·서버와 같다:
 * "To-Do Added: …", "Cleared 2 completed to-dos", "Added 3 to-dos", "Deleted 2 to-dos".
 */
export function isTodoNoticeTitle(title: string): boolean {
  return /^(완료한 )?할 일/.test(title) || /^(To-Do |Cleared \d+ completed to-do|(Added|Deleted) \d+ to-do)/.test(title);
}

export class GlassesUI {
  private screen: Screen = 'home';
  private sessions: SessionInfo[] = [];
  private cursor = 0;
  private activeId = '';
  private lines: string[] = [];
  /**
   * lines와 같은 것을 누가 했는지와 함께 담는다. 꾸민 대화 화면(showLive)이
   * 기호를 고르는 데 쓴다. lines는 글 화면과 기존 테스트가 쓰므로 그대로 둔다.
   */
  private feed: Array<{ kind: LineKind; text: string }> = [];
  /** 지금 하는 일의 대상(명령·파일)과 시작 시각. 진행 카드에 쓴다. */
  private activityDetail = '';
  private activityAt = 0;
  private status = '';
  /** 답을 기다리는 권한 요청. 한 번에 하나만 띄우고, 나머지는 이게 끝나면 syncPending이 띄운다. */
  private pending: { id: string; sessionId: string; toolName: string; summary: string } | null = null;
  private permCursor = 0;
  private permShownAt = 0;
  /** permShownAt을 센 요청. 같은 요청을 다시 그릴 때는 막는 시간을 새로 세지 않는다. */
  private permShownId = '';
  /** 답을 보내는 중. 그사이 탭이 한 번 더 와도 두 번 보내지 않는다. */
  private deciding = false;
  /** 마지막으로 답을 보내다 난 오류. 권한 화면에 띄워 다시 고르게 한다. */
  private permError = '';
  /** 소리로 알린 요청. 다시 맞출 때마다 같은 요청을 또 읽지 않게. */
  private announcedPerms = new Set<string>();
  private doneIds = new Set<string>();
  private notice: {
    /** 한 줄 제목. 없으면 본문만 보여준다. */
    title: string;
    /** 자세한 내용. 제목과 같으면 한 번만 그린다. */
    text: string;
    /** 머리말에 붙는 갈래. 에이전트·할일·알림을 나눈다. */
    label: string;
    /** 알림 갈래. 꾸민 팝업이 기호를 고르는 데 쓴다. */
    kind?: NoticeKind;
  } | null = null;
  private activity = '';
  private tick = 0;
  private spinTimer?: ReturnType<typeof setInterval>;
  private detailStop?: () => void;
  /** 체크리스트·알림 변화 구독. 서버가 바뀌면 알려준다. */
  private eventStop?: () => void;
  /** 앞뒤 전환 구독. 끊을 때 쓴다. */
  private lifecycleStop?: () => void;
  /** 위 구독이 끊겼을 때를 대비한 주기 갱신. */
  private pollTimer?: ReturnType<typeof setInterval>;
  private watchers = new Map<string, () => void>();
  /** 화면이 꺼져 있는지. 꺼진 동안에는 그리지 않는다. */
  private screenOff = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  /** 알림 팝업을 스스로 걷는 타이머. */
  private noticeTimer?: ReturnType<typeof setTimeout>;
  /**
   * 팝업이 머무는 시간. 테스트에서 짧게 줄여 실제로 걷히는지 본다.
   * 기기에서는 기본값을 쓴다.
   */
  private noticeMs: number = NOTICE_MS;
  /** 현재 세션의 할 일 목록. */
  private checklist: ChecklistItem[] = [];
  /** 체크리스트 화면에서 커서 위치. */
  private checkCursor = 0;
  /** 지금 보고 있는 목록이 전역인지. 세션 목록에서 열면 전역이다. */
  private checkGlobal = false;

  /** home과 settings의 커서. 화면마다 따로 둬야 오가도 위치가 남는다. */
  private menuCursor = 0;
  private setCursor = 0;
  /** 홈 메뉴 순서·숨김. 안경 설정이나 폰 앱에서 바꾼다. */
  private menuConfig: MenuConfig = DEFAULT_MENU;
  /** 기본값이 아닌지(누가 바꿨는지). */
  private menuCustom = false;
  /** 폰이 지난번 상태에 메뉴를 실었는지. 실었다가 빠지면 폰 앱에서 기본값으로 돌린 것이다. */
  private phoneHadMenu = false;
  /** 안경에서 바꾼 메뉴를 폰에 올려 봤는지. 예전 폰 앱(경로 없음)에 거듭 보내지 않는다. */
  private menuPushTried = false;
  /** 서버(relay-service) 쪽에 붙은 맥·PC가 있는지. 폰 직접 연결과 별개로 본다. */
  private extLinked = false;
  /** 메뉴 편집 화면의 커서, 고른 항목. */
  private menuEditCursor = 0;
  private menuItemCursor = 0;
  private menuEditing?: MenuId;
  /** 타이머·물 화면의 커서. */
  private phoneCursor = 0;
  /** 홈 더블탭 선택지의 커서. */
  private homeMenuCursor = 0;
  /** 종료했는지. 폰 화면(웹뷰)은 남아 주기 갱신이 돌 수 있어, 그려서 다시 열지 않게 막는다. */
  private stopped = false;

  /** 서버가 쌓아둔 알림. */
  private notifications: Notification[] = [];
  private unread = 0;
  private notifCursor = 0;
  /** 지금 펼쳐 보고 있는 알림. */
  private openNotif: Notification | null = null;
  /**
   * 마지막으로 본 알림의 id.
   *
   * 새 알림이 왔는지는 이 값과 목록 맨 앞을 견줘서 안다. 개수만 보면
   * 하나 오고 하나 읽힌 순간을 놓치고, 지운 뒤에는 줄어들어 새 알림을
   * 지나간 것으로 오해한다.
   *
   * null은 "아직 한 번도 못 읽었다"는 뜻이다. 첫 조회에서 쌓여 있던
   * 알림이 한꺼번에 뜨지 않게, 그때는 띄우지 않고 기준값만 채운다.
   *
   * 목록이 비면 빈 문자열로 둔다. null로 돌리면 다 지운 뒤에 오는
   * 알림이 "첫 조회"로 취급돼 조용히 묻힌다.
   */
  private lastSeenNotifId: string | null = null;

  /** 폰의 타이머·물 마시기(phone.ts). 폰이 답하지 않으면 없다. */
  private phone?: PhoneStatus;
  /** phone을 받은 시각(ms). 그 사이 흐른 만큼 타이머를 줄여 그린다. */
  private phoneAt = 0;
  private phoneTimer?: ReturnType<typeof setInterval>;
  private phoneStopped = false;
  /** 폰을 읽는 중인지. 겹쳐 불린 타이머가 읽기를 늘리지 못하게 한다. */
  private phoneBusy = false;
  private phoneLastPoll = 0;
  /** 마지막에 폰이 답했는지. 답하지 않으면 드물게 읽는다. */
  private phoneOk = true;
  /** 마지막으로 그린 홈 상태 글의 폰 부분. 바뀔 때만 다시 그린다. */
  private lastPhoneLabel = '';

  /** 맥의 지금 상태. 시스템 화면에서 쓴다. */
  private sys?: SysSummary;
  private procs: SysProc[] = [];
  /** 시스템 상태를 마지막으로 읽은 시각. 스스로 갱신하지 않으므로 화면에 보인다. */
  private sysReadAt?: Date;
  /** 시스템 상태를 읽지 못한 까닭. 한 번이라도 읽었으면 비운다. */
  private sysError?: string;

  /** 등록해 둔 명령. 안경에서는 골라 실행만 한다. */
  private snippets: Snippet[] = [];
  private cmdCursor = 0;
  /** Claude 명령 화면의 커서. 맨 끝 한 칸은 '할 일 보기'다. */
  private slashCursor = 0;
  /** 한 번 더 탭해야 보내는 명령(/clear). 커서를 옮기면 풀린다. */
  private slashConfirm = '';
  /** 보고 있는 세션의 마지막 답 전문. 대화 화면은 첫 줄만 보이므로 결과 읽기에서 끝까지 넘긴다. */
  private lastReply = '';
  /** 결과 읽기: 머리글과 쪽들, 지금 쪽 */
  private reader: { title: string; pages: string[][]; page: number } | null = null;

  // --- 맥(mac-agent) ---
  /** 기능 목록. undefined: 읽는 중, null: 맥이 붙어 있지 않음. */
  private macCaps: ExtCapability[] | null | undefined;
  private macCursor = 0;
  /** 지금 화면의 SSE를 끊는다. 화면을 떠날 때 꼭 부른다. */
  private macStop?: () => void;
  /** SSE가 막혔을 때 대신 읽는 타이머. */
  private macPoll?: ReturnType<typeof setInterval>;
  /** 발표 경과 시간을 고쳐 그리는 타이머. */
  private macTick?: ReturnType<typeof setInterval>;
  private macError?: string;
  private macPresent?: PresentState;
  /** 발표 단추 줄에서 고른 것(presentActions() 순서). 발표 중엔 '다음', 발표 전엔 '시작'에서 시작한다. */
  private presentCursor = 1;
  /** '끄기'를 한 번 눌러 확인을 기다리는 중인지. */
  private presentStopArmed = false;
  private macCaptionLines: CaptionLine[] = [];
  private macPartial?: CaptionLine;
  private macCaptionsState?: CaptionsState;
  /** undefined: 읽는 중, null: 일정 없음. */
  private macEvent?: MacEvent | null;
  /** undefined: 읽는 중. */
  private macShortcuts?: MacShortcut[];
  private macShortcutCursor = 0;
  /** 맥 발표 폴더의 자료. 읽기 전이면 undefined. */
  private macPresentFiles?: PresentFile[];
  private macPresentFolder = '';
  private macPresentFileCursor = 0;
  /** 안경에서 연 문서(Pages·PDF). 문서 화면에서 위아래로 스크롤한다. */
  private macDocument?: { name: string; app: string };
  private macPrompter?: PrompterState;
  private macResult?: { name: string; state: string; output?: string };
  /** 결과 화면에서 돌아갈 곳. */
  private macResultBack: 'mac' | 'mac-shortcuts' | 'notifications' = 'mac';
  /** 답장할 상대(메시지 알림의 보낸 사람). */
  private macReplyTo?: string;
  private macReplyCursor = 0;
  /**
   * 마지막 실행 결과. 결과 화면에서 보여준다.
   *
   * 확인이 필요해 막힌 경우도 여기 담는다 — 무엇 때문에 막혔는지
   * 보여주고 한 번 더 탭하면 실행한다.
   */
  private cmdResult?: {
    label: string;
    /** 글자만 그리는 기기(showText)에 쓰는 본문. */
    text: string;
    /** 참이면 아직 실행하지 않았고, 탭하면 실행한다. */
    awaitingConfirm?: boolean;
    snippetId?: string;
    /** 꾸민 결과 화면(showCommandResult)에 쓰는 값. */
    command?: string;
    state?: CommandResultView['state'];
    lines?: string[];
    exitCode?: number;
    tookMs?: number;
    timedOut?: boolean;
  };

  /** SSE가 막혀 있는지. 막혀 있으면 폴링을 촘촘히 돈다. */
  private sseDown = false;
  /** 서버에서 읽는 데 성공한 적이 있는지. 로그인이 풀렸다고 알릴 때 쓴다. */
  private loggedIn = false;
  /** 지금 걸린 폴링 주기. 같은 값으로 다시 걸지 않으려고 둔다. */
  private pollMs = 0;

  /** 한 세션의 대화 기록. sessions → history 단계에서 쓴다. */
  private history: SessionEvent[] = [];
  private histCursor = 0;

  /** 화면이 꺼지기까지의 시간. 설정에서 바꾼다. */
  private idleMs: number = SCREEN_IDLE_MS;

  /** 홈 메뉴 옆에 DEV 로고를 둘지. 설정에서 끌 수 있다. */
  private showLogo = true;


  constructor(
    private readonly glasses: GlassesAdapter,
    private readonly hooks: GlassesUIHooks = {},
  ) {}

  private log(text: string, level: 'info' | 'ok' | 'warn' | 'error' = 'info'): void {
    this.hooks.onLog?.(text, level);
  }

  /**
   * 안경을 연결하고 첫 화면을 그린다.
   *
   * agent-cli 접속과는 분리한다. 아직 접속 정보가 없어도 안경은 붙어 있어야
   * "연결 중" 같은 안내를 띄울 수 있다. 목록은 접속 후 refresh가 채운다.
   */
  async start(): Promise<void> {
    // 서버 구독을 먼저 건다. 안경 연결과 상관이 없는 일이다.
    //
    // 아래 connect()는 안경이 없으면 던진다. 브라우저로 열었을 때가
    // 그렇고, 실기기라도 안경이 꺼져 있거나 BLE가 끊겨 있으면 마찬가지다.
    // 구독을 뒤에 두면 그런 경우에 영영 붙지 못해, 할 일을 바꿔도
    // 화면이 그대로다.
    // 폰 상태도 다시 읽는다. 로그인 전에는 읽지 않아 드물게 돌고 있다.
    agentCli.onConnectionChange(() => {
      this.watchServerData();
      this.watchPhone();
    });
    // 쓰는 중에 토큰이 폐기되거나 만료되면 안경에도 알린다. 로그인 전의
    // 401(아직 토큰이 없음)에는 이미 '폰에서 인증' 안내가 떠 있다.
    agentCli.onUnauthorized(() => {
      if (!this.loggedIn) return;
      this.loggedIn = false;
      void this.glasses.showText(msg().loggedOut).catch(() => undefined);
    });
    this.watchServerData();
    this.watchPhone();

    await this.glasses.connect();

    // 앱이 뒤로 물러났다 돌아오면 화면을 다시 세운다.
    //
    // 안경은 화면이 꺼지면 앱을 뒤로 물리고 화면 컨테이너를 걷어간다.
    // 돌아온 뒤 그냥 그리면 조용히 실패해, 그 뒤로는 알림도 조작도
    // 화면에 나타나지 않는다. 실기기에서만 나던 증상이 이것이었다.
    this.lifecycleStop = this.glasses.onLifecycle?.((phase) => {
      if (phase === 'background') {
        // 물러난 동안은 그리지 않는다. 깨어날 때 다시 세운다.
        this.screenOff = true;
        return;
      }
      void this.returnToForeground();
    });

    // 조작 처리가 던지면 조용한 unhandled rejection으로 사라진다.
    // 화면이 바뀌다 만 채로 멈추므로 여기서 받아 로그로 남긴다.
    this.glasses.onGesture((e) => {
      void this.handleGesture(e).catch((err: Error) => {
        this.log(msg().gestureError(err.message), 'error');
      });
    });

    // 저장된 음성 설정을 복원한다. 값이 없으면 켜진 상태로 둔다.
    const saved = await this.loadSetting(STORE_VOICE);
    if (saved === '0') this.glasses.setVoiceEnabled(false);

    // 화면 꺼짐 시간도 복원한다. 모르는 값이면 기본값을 쓴다.
    const idle = Number(await this.loadSetting(STORE_IDLE));
    if (IDLE_CHOICES.includes(idle)) this.idleMs = idle;

    // 로고 표시 여부. 값이 없으면 켜둔다.
    if ((await this.loadSetting(STORE_LOGO)) === '0') this.showLogo = false;

    // 홈 메뉴 순서·숨김. 폰 앱에 저장한 것이 있으면 폰 상태를 읽을 때 그것으로 바뀐다.
    const savedMenu = await this.loadSetting(STORE_MENU);
    if (savedMenu) {
      try {
        this.menuConfig = normalizeMenu(JSON.parse(savedMenu));
        this.menuCustom = true;
      } catch {
        // 깨진 값이면 기본값을 쓴다.
      }
    }

    // 켜진 채로 두지 않도록 처음부터 무조작 타이머를 돌린다.
    this.wake();

    // 인증 전에는 아무것도 못 읽는다. 홈에 0만 뜨면 고장처럼 보이므로
    // 접속을 확인하고 나서 요약을 채운다.
    try {
      await agentCli.listNotifications();
    } catch {
      await this.glasses.showText(msg().connectingAuth);
      return;
    }

    // 첫 화면은 홈이다. 상단 요약에 쓸 값을 채워야 0으로 보이지 않는다.
    // 알림·체크리스트는 서버가 직접 주므로 맥이 꺼져 있어도 읽힌다.
    this.loggedIn = true;
    await this.refreshSummary();
  }

  /**
   * 웹이나 폰에서 할 일·알림을 바꾸면 안경도 따라 바뀌게 한다.
   *
   * 예전에는 화면을 옮길 때만 읽어서, 홈을 보고 있으면 바뀐 줄 몰랐다.
   *
   * SSE로 받되 주기 갱신을 함께 돌린다. 안경은 웹뷰라 절전으로 연결이
   * 조용히 끊길 때가 있는데, 그러면 SSE만으로는 영영 모른다.
   */
  private watchServerData(): void {
    this.eventStop?.();
    this.eventStop = agentCli.streamEvents(
      () => {
        // 화면이 꺼져 있어도 읽는다.
        //
        // 예전에는 여기서 건너뛰고 깨어날 때 읽었다. 그런데 안경은
        // 무조작 30초면 꺼지므로 알림은 대부분 꺼진 구간에 들어온다.
        // 사용자가 안경을 만질 때까지 아무 일도 일어나지 않으니
        // 알림이라 할 수 없었다. 새 알림은 스스로 화면을 깨워야 한다.
        //
        // sleep()은 하드웨어를 끄는 것이 아니라 공백 한 칸을 그린
        // 것이다. 그래서 showText가 그대로 먹고, 깨우는 데 돈이 들지
        // 않는다.
        void this.refreshSummary();
      },
      (down) => this.setPolling(down),
    );

    this.setPolling(this.sseDown);
  }

  /**
   * 폰의 타이머·물 마시기를 주기적으로 읽는다.
   *
   * 예전에는 읽고 나서 다음 읽기를 setTimeout으로 거는 사슬이었다. 그런데
   * 안경 웹뷰는 화면이 꺼진 사이 미뤄 둔 타이머를 한꺼번에 부를 때 같은 것을
   * 두 번 부르기도 한다. 그때마다 사슬이 둘로 갈라져 1분마다 네 배로 늘었고
   * (폰 읽기 12 → 48 → 250 → 948 → 3360 → 12271번/분), 웹뷰가 CPU·메모리를
   * 다 먹고 iOS에 죽었다. 그래서 간격 하나(setInterval)로 돌리고, 읽는 중이거나
   * 간격이 안 됐으면 건너뛴다. 타이머가 몇 번 겹쳐 불려도 읽기는 늘지 않는다.
   */
  private watchPhone(): void {
    clearInterval(this.phoneTimer);
    this.phoneTimer = setInterval(() => void this.pollPhone(false), PHONE_TICK_MS);
    (this.phoneTimer as { unref?: () => void }).unref?.();
    void this.pollPhone(true);
  }

  /** 한 번 읽는다. force가 아니면 간격을 지킨다. 동시에 둘은 읽지 않는다. */
  private async pollPhone(force: boolean): Promise<void> {
    if (this.phoneStopped || this.phoneBusy) return;
    const gap = this.phoneOk ? PHONE_POLL_MS : PHONE_POLL_SLOW_MS;
    const now = Date.now();
    if (!force && now - this.phoneLastPoll < gap - 1000) return;
    this.phoneBusy = true;
    this.phoneLastPoll = now;
    try {
      this.phoneOk = await this.refreshPhone();
    } finally {
      this.phoneBusy = false;
    }
  }

  /**
   * 폰 상태를 읽고 상단 진행바·홈 상태를 맞춘다. 끝난 타이머·물 마실 때는 팝업으로 알린다.
   * 폰이 답했으면 true.
   */
  private async refreshPhone(): Promise<boolean> {
    // 로그인 전에는 읽지 않는다. 키 없이 두드리면 401이 나고, 그 401이 로그인
    // 직후에 도착하면 멀쩡한 로그인이 풀린 것으로 처리된다.
    if (!agentCli.canPoll || !agentCli.isConfigured || !agentCli.connection.apiKey) return false;
    let events: PhoneEvent[] = [];
    try {
      const next = await agentCli.phoneStatus();
      events = phoneEvents(this.phone, next);
      const computerBefore = this.computerLinked();
      this.phone = next;
      this.phoneAt = Date.now();
      for (const e of events) this.noticePhone(e, next);
      const menuChanged = await this.syncMenuFromPhone(next);
      if ((menuChanged || computerBefore !== this.computerLinked()) && this.screen === 'home') {
        this.clampMenuCursor();
        await this.render();
      }
    } catch (err) {
      // 한두 번 못 읽는 것은 흔하다 — 폰 앱이 뒤에 있으면 가끔 늦는다. 그때마다
      // 지우면 진행바가 사라졌다 돌아오며 화면을 통째로 다시 세워 깜빡였다.
      // 가진 값으로 계속 줄여 그리고, 폰이 이 경로를 모르거나(404) 오래
      // 답하지 않을 때만 원래 선으로 돌린다.
      const missing = err instanceof AgentCliError && err.status === 404;
      if (this.phone && (missing || Date.now() - this.phoneAt > PHONE_STALE_MS)) {
        this.phone = undefined;
        this.lastPhoneLabel = '';
        this.glasses.setTopBar?.(null);
        await this.render();
      }
      if (!this.phone) return false;
    }
    await this.drawPhone(events.length > 0);
    return true;
  }

  // --- 홈 메뉴 ---

  /** 맥·PC가 연결돼 있는지. 폰 직접 연결이나 서버 쪽 연결 중 하나면 된다. */
  private computerLinked(): boolean {
    return this.phone?.computer === true || this.extLinked;
  }

  /** 지금 홈에 보일 항목. */
  private homeMenu(): MenuId[] {
    return visibleMenu(this.menuConfig, this.computerLinked());
  }

  private clampMenuCursor(): void {
    this.menuCursor = Math.min(this.menuCursor, Math.max(this.homeMenu().length - 1, 0));
  }

  /**
   * 폰 상태에 실린 메뉴를 따른다. 바뀌었으면 true.
   * 폰이 메뉴를 실었다가 빼면 폰 앱에서 기본값으로 돌린 것이라 안경도 기본값으로 돌린다.
   * 폰에 메뉴가 없는데 안경에서 바꾼 것이 있으면 폰에 한 번 올려 앱에도 보이게 한다.
   */
  private async syncMenuFromPhone(next: PhoneStatus): Promise<boolean> {
    if (next.menu) {
      this.phoneHadMenu = true;
      const config = normalizeMenu(next.menu);
      if (this.menuCustom && sameMenu(config, this.menuConfig)) return false;
      this.menuConfig = config;
      this.menuCustom = true;
      await this.saveSetting(STORE_MENU, JSON.stringify(config));
      return true;
    }
    if (this.phoneHadMenu) {
      this.phoneHadMenu = false;
      const changed = !sameMenu(this.menuConfig, DEFAULT_MENU);
      this.menuConfig = DEFAULT_MENU;
      this.menuCustom = false;
      await this.saveSetting(STORE_MENU, '');
      return changed;
    }
    if (this.menuCustom && !this.menuPushTried) {
      this.menuPushTried = true;
      await this.pushMenu(this.menuConfig);
    }
    return false;
  }

  /**
   * 폰에 메뉴를 맞춘다. 폰이 받아 상태에 실어 줬을 때만 '폰에 있다'로 친다 —
   * 예전 폰 앱처럼 경로를 모르면 다음 상태에 메뉴가 없어도 기본값으로 돌린 것으로 보지 않는다.
   */
  private async pushMenu(body: MenuConfig | { reset: true }): Promise<void> {
    try {
      const reply = await agentCli.phoneMenu(body);
      this.phoneHadMenu = Boolean(reply?.menu);
    } catch {
      this.phoneHadMenu = false;
    }
  }

  /** 안경에서 메뉴를 바꿨다. 저장하고 폰에도 맞춘다(폰이 없으면 안경에만 남는다). */
  private async saveMenu(config: MenuConfig | null): Promise<void> {
    this.menuConfig = config ?? DEFAULT_MENU;
    this.menuCustom = config !== null;
    await this.saveSetting(STORE_MENU, config ? JSON.stringify(config) : '');
    if (this.phone) await this.pushMenu(config ?? { reset: true });
    else this.phoneHadMenu = false;
  }

  /** 가진 폰 상태로 진행바·홈 상태를 맞춘다. 글자가 바뀌었을 때만 그린다. */
  private async drawPhone(force: boolean): Promise<void> {
    if (!this.phone) return;
    const barChanged = this.glasses.setTopBar?.(timerRatio(this.phone.timer, this.phoneAt, Date.now())) ?? false;
    const label = this.phoneLabel();
    if (force || barChanged || label !== this.lastPhoneLabel) {
      this.lastPhoneLabel = label;
      await this.render();
    }
  }

  /** 타이머·물 조작을 폰에 보내고 바뀐 상태로 다시 그린다. */
  private async runPhoneAction(action: PhoneAction): Promise<void> {
    const before = this.phone ? phoneActions(this.phone).map((a) => a.id).join('|') : '';
    try {
      const next = action.timer
        ? await agentCli.phoneTimer(action.timer.action, action.timer.minutes)
        : await agentCli.phoneWater(action.water ?? 'drink');
      // 안경에서 한 일이다. 끝남·물 알림을 여기서 다시 띄우지 않게 비교 없이 바꾼다.
      this.phone = next;
      this.phoneAt = Date.now();
      this.log(action.label, 'ok');
    } catch (err) {
      this.log(msg().actionFailed(action.label, (err as Error).message), 'warn');
      return;
    }
    // 줄이 바뀌면(시작 → 멈춤…) 목록을 다시 세워 선택이 첫 줄로 간다. 커서도 맞춘다.
    const after = phoneActions(this.phone).map((a) => a.id).join('|');
    if (after !== before) this.phoneCursor = 0;
    this.glasses.setTopBar?.(timerRatio(this.phone.timer, this.phoneAt, this.phoneAt));
    this.lastPhoneLabel = this.phoneLabel();
    await this.render();
  }

  private noticePhone(event: PhoneEvent, status: PhoneStatus): void {
    this.wake();
    const m = msg();
    if (event === 'timerDone') {
      this.glasses.speak(m.speakTimerDone);
      this.showNotice({
        title: m.timerDoneTitle,
        text: m.timerDoneText(durationLabel(status.timer.duration)),
        label: m.timerLabel,
        kind: 'done',
      });
    } else {
      this.glasses.speak(m.speakWater);
      this.showNotice({
        title: m.waterTitle,
        text: m.waterText(status.water.count, status.water.goal),
        label: m.waterLabel,
        kind: 'info',
      });
    }
  }

  /** 홈 상태 표시줄의 폰 부분(타이머·물). 없으면 빈 글. */
  private phoneLabel(): string {
    if (!this.phone) return '';
    // 칸이 모자라면 상태 줄은 왼쪽부터 뺀다(fitStatus). 물을 타이머 앞에 두어 먼저 빠지게 한다.
    return [waterLabel(this.phone.water), timerLabel(this.phone.timer, this.phoneAt, Date.now())]
      .filter(Boolean)
      .join('  ');
  }

  /**
   * 주기 갱신을 건다. SSE가 죽어 있으면 촘촘히 돈다.
   *
   * 같은 주기로 다시 부르면 타이머를 그냥 둔다. SSE가 끊겼다 붙을 때마다
   * 타이머를 다시 만들면 주기가 계속 밀려 갱신이 드물어진다.
   */
  private setPolling(down: boolean): void {
    const next = down ? SERVER_POLL_FAST_MS : SERVER_POLL_MS;
    if (this.pollTimer && this.pollMs === next) {
      this.sseDown = down;
      return;
    }
    this.sseDown = down;
    this.pollMs = next;

    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      // SSE와 같은 이유로 꺼져 있어도 읽는다. SSE가 막힌 기기에서는
      // 이 주기가 알림을 띄우는 유일한 경로다.
      void this.refreshSummary();
    }, next);

    // node에서는 이 타이머 하나 때문에 프로세스가 안 끝난다. 테스트가
    // 멈춘다. 브라우저의 setInterval은 number라 unref가 없으므로 있을
    // 때만 부른다.
    (this.pollTimer as { unref?: () => void }).unref?.();
  }

  private async loadSetting(key: string): Promise<string> {
    const g = this.glasses as GlassesAdapter & { loadSetting?: (k: string) => Promise<string> };
    return (await g.loadSetting?.(key)) ?? '';
  }

  private async saveSetting(key: string, value: string): Promise<void> {
    const g = this.glasses as GlassesAdapter & {
      saveSetting?: (k: string, v: string) => Promise<void>;
    };
    await g.saveSetting?.(key, value);
  }

  // --- 상태 갱신 ---

  /** 세션 목록을 다시 읽는다. */
  async refresh(): Promise<void> {
    if (this.stopped) return;
    const before = this.sessions.map((s) => s.id).join(',');
    this.sessions = await agentCli.listSessions();
    const after = this.sessions.map((s) => s.id).join(',');

    // 세션이 줄었으면 커서를 목록 안으로 되돌린다.
    if (this.cursor > this.shownSessions().length - 1) {
      this.cursor = Math.max(this.shownSessions().length - 1, 0);
    }
    this.watchLive();
    this.hooks.onSessionsChanged?.(this.sessions, this.cursor);
    // askPermission이 띄우면 거기서 그린다.
    const permChanged = await this.syncPending();

    // 목록이 그대로면 다시 그리지 않는다.
    // 주기적 갱신마다 리스트를 재생성하면 커서가 튀어 조작이 끊긴다.
    if (before === after && this.screen === 'sessions' && !this.notice && !this.pending && !permChanged) return;
    await this.render();
  }

  /**
   * 살아있는 세션을 전부 구독한다.
   * 목록만 보고 있어도 작업 완료와 권한 요청을 받기 위해서다.
   */
  private watchLive(): void {
    const live = new Set(this.sessions.filter((s) => s.live).map((s) => s.id));

    for (const [id, stop] of this.watchers) {
      if (!live.has(id)) {
        stop();
        this.watchers.delete(id);
      }
    }

    for (const id of live) {
      if (this.watchers.has(id)) continue;
      const stop = agentCli.streamSession(
        id,
        (e) => {
          // 상세 화면에서 보고 있는 세션은 그쪽 구독이 처리한다.
          if (this.screen === 'detail' && this.activeId === id) return;
          void this.handleBackgroundEvent(id, e);
        },
        () => undefined,
      );
      this.watchers.set(id, stop);
    }
  }

  // --- 화면 ---

  /**
   * 세션이 지금 어떤 상태인지 정한다.
   *
   * 글자를 고르지 않는다. 어떻게 보일지는 어댑터가 정한다.
   * 순서가 곧 우선순위다. 끝난 것을 가장 먼저 알리고, 끊긴 것은
   * 안쪽 상태를 볼 것도 없이 offline이다.
   */
  private statusOf(s: SessionInfo): ItemState {
    if (this.doneIds.has(s.id)) return 'done';
    if (!s.live) return 'offline';
    if (s.pending?.length) return 'pending';
    if (s.status === 'busy') return 'running';
    if (s.status === 'waiting') return 'waiting';
    return 'idle';
  }

  private statusText(raw: string): string {
    const m = msg();
    return (
      (
        {
          busy: m.stateBusy,
          waiting: m.stateWaiting,
          idle: m.stateIdle,
          starting: m.stateStarting,
          closed: m.stateClosed,
          error: m.stateError,
          done: m.stateDone,
        } as Record<string, string>
      )[raw] ?? raw
    );
  }

  /**
   * 홈 상단에 띄우는 한 줄 요약.
   *
   * 안경 화면은 좁아 헤더 한 줄이 전부다. 세 가지를 한 줄에 넣는다.
   *   세션 (진행중/전체) · 알림 (안읽음) · 체크 (완료/전체)
   */
  /**
   * 홈 화면에 그릴 것.
   *
   * 값을 두 갈래로 나눈다. 메뉴 오른쪽 숫자가 바뀌면 목록을 다시 세워
   * 선택이 첫 항목으로 돌아가므로, 거기에는 드물게 바뀌는 것만 둔다
   * (세션 수·안 읽은 알림·할 일). 작업 중 수·시각·연결처럼 수시로 바뀌는
   * 것은 상태 표시줄에, CPU·메모리는 게이지에 둔다. 이 둘은 제자리에서
   * 글자만 고친다.
   */
  private homeView(): HomeView {
    const busy = this.sessions.filter((s) => s.live && s.status === 'busy').length;
    const done = this.checklist.filter((i) => i.done).length;
    const meta: Record<string, string> = {
      sessions: this.sessions.length > 0 ? String(this.sessions.length) : '',
      notifications: this.unread > 0 ? msg().homeUnread(this.unread) : '',
      checklist: this.checklist.length > 0 ? `${done} / ${this.checklist.length}` : '',
      commands: this.snippets.length > 0 ? String(this.snippets.length) : '',
    };

    // 타이머·물이 있으면 자리가 모자라 연결 표시는 점만 남긴다.
    // 그래도 넘치면 왼쪽(작업 수 → 물 → 타이머)부터 빠지고 시각은 남는다.
    const phone = this.phoneLabel();
    const status = [
      busy > 0 ? msg().busyCount(busy) : '',
      phone,
      phone ? (this.sseDown ? '○' : '●') : this.sseDown ? '○ offline' : '● online',
      clock(),
    ]
      .filter(Boolean)
      .join('  ');

    const sys = this.sys;
    const gauges =
      sys && sys.cpuPercent >= 0
        ? [
            { label: 'cpu', ratio: sys.cpuPercent / 100, text: `${Math.round(sys.cpuPercent)}%` },
            ...(sys.memTotalGB > 0
              ? [
                  {
                    label: 'mem',
                    ratio: sys.memUsedGB / sys.memTotalGB,
                    text: `${Math.round((sys.memUsedGB / sys.memTotalGB) * 100)}%`,
                  },
                ]
              : []),
          ]
        : undefined;

    return {
      title: '$ relay ~/home',
      status,
      items: this.homeMenu().map((id) => ({ label: menuLabel(id), meta: meta[id] ?? '' })),
      logo: this.showLogo ? this.glasses.logo : undefined,
      gauges,
    };
  }

  /**
   * 세션 화면에 그릴 것.
   *
   * 한 줄의 오른쪽에는 경과 시간을 둔다. 분 단위로 바뀌지만 세션 목록은
   * 세션이 생기거나 없어질 때만 다시 그리므로(refresh 참고) 화면을 연
   * 시점 기준으로 남는다. 자주 바뀌는 작업·승인 수는 상태 표시줄과
   * 오른쪽 카드에 두어 글자만 고친다.
   */
  private sessionsView(): SessionsView {
    const m = msg();
    const all = this.sessions.map((s) => ({
      state: this.statusOf(s),
      title: s.title || m.newChat,
      meta: timeAgo(s.lastActivityAt),
    }));
    const rows = all.slice(0, LIST_MAX);
    const count = (...states: string[]) => all.filter((r) => states.includes(r.state)).length;
    const busy = count('running');
    const approvals = count('pending', 'waiting');

    return {
      title: '$ relay ~/agents',
      status: [busy > 0 ? m.busyCount(busy) : '', approvals > 0 ? m.approvals(approvals) : '', clock()]
        .filter(Boolean)
        .join('   '),
      rows,
      counts: [
        { state: 'running', label: m.countRunning, count: busy },
        { state: 'pending', label: m.countPending, count: approvals },
        { state: 'idle', label: m.countIdle, count: count('idle', 'done') },
        { state: 'offline', label: m.countOffline, count: count('offline') },
      ],
      hint: m.hintOpenBack,
      total: m.sessionsTotal(rows.length),
    };
  }

  /**
   * 알림 목록에 그릴 것.
   *
   * 목록 끝의 '모두 읽음 처리' 줄은 예전과 같은 자리(마지막)에 둔다.
   * 탭 처리가 그 자리를 동작으로 읽는다.
   */
  private notificationsView(): NotificationsView {
    const rows = this.shownNotifications().map((n) => ({
      kind: n.kind,
      read: Boolean(n.readAt),
      title: n.title,
      meta: timeAgo(n.createdAt),
    }));
    // 갈래별 수는 목록에 안 보이는 것까지 센다.
    const unreadOf = (k: NoticeKind) => this.notifications.filter((n) => n.kind === k && !n.readAt).length;
    const m = msg();
    return {
      title: '$ relay ~/inbox',
      status: [this.unread > 0 ? m.unreadStatus(this.unread) : '', clock()].filter(Boolean).join('   '),
      rows,
      counts: [
        { kind: 'error', label: m.kindError, count: unreadOf('error') },
        { kind: 'permission', label: m.kindPermission, count: unreadOf('permission') },
        { kind: 'done', label: m.kindDone, count: unreadOf('done') },
        { kind: 'info', label: m.kindInfo, count: unreadOf('info') },
      ],
      unread: this.unread,
      action: rows.length > 0 ? m.markAllRead : undefined,
      hint: m.hintOpenBack,
      legend: m.legendUnread,
    };
  }

  /**
   * 알림 하나의 내용. 대화 기록의 전문을 볼 때도 이 화면을 쓴다(id가 빈 알림).
   */
  private notificationView(n: Notification | null): NotificationView {
    const kind: NoticeKind = n?.kind ?? 'info';
    const m = msg();
    return {
      title: n?.id ? '$ relay ~/inbox' : '$ relay ~/history',
      status: [n?.createdAt ? agoPhrase(n.createdAt) : '', clock()].filter(Boolean).join('   '),
      kind,
      label: this.kindLabel(kind),
      heading: n?.title ?? m.kindNotification,
      body: n?.body?.trim() || m.noContent,
      // 메시지 알림이면 탭으로 답장한다(맥의 mac-agent가 보낸다).
      hint: messageSender(n?.title) ? m.hintReplyBack : m.hintCloseBack,
    };
  }

  /**
   * 할 일 화면에 그릴 것. 목록 끝의 '완료 항목 치우기' 줄은 예전과 같은
   * 자리(마지막)에 둔다. 탭 처리가 그 자리를 동작으로 읽는다.
   */
  private checklistView(): ChecklistView {
    const done = this.checklist.filter((i) => i.done).length;
    const s = this.sessions.find((x) => x.id === this.activeId);
    const m = msg();
    return {
      title: this.checkGlobal ? '$ ~/todo' : `$ ~/${s?.title || m.newChat}/todo`,
      status: [`${done} / ${this.checklist.length}`, clock()].join('   '),
      items: this.shownChecklist().map((i) => ({ done: i.done, text: i.text })),
      action: this.checklist.length > 0 ? m.clearDone : undefined,
      progress: { done, total: this.checklist.length },
      hint: m.hintCheckBack,
      note: m.addOnPhoneWeb,
    };
  }

  /** 명령 목록에 그릴 것. 오른쪽 카드는 고른 줄과 상관없는 요약이다. */
  private commandsView(): CommandsView {
    const cron = this.snippets.filter((x) => x.kind === 'cron').length;
    // 가장 최근에 돈 것. ISO 시각이라 글자 비교로 순서가 맞는다.
    const last = this.snippets
      .filter((x) => x.lastRunAt && x.lastExitCode !== undefined)
      .sort((a, b) => (b.lastRunAt! > a.lastRunAt! ? 1 : -1))[0];
    const m = msg();
    return {
      title: '$ ~/cmd',
      status: [cron > 0 ? m.cronCount(cron) : '', clock()].filter(Boolean).join('   '),
      rows: this.shownSnippets().map((x) => ({
        label: x.label,
        ...(x.kind === 'cron' && x.everyMinutes ? { cron: x.everyMinutes } : {}),
      })),
      counts: { once: this.snippets.length - cron, cron },
      last: last ? { label: last.label, exitCode: last.lastExitCode!, ago: agoPhrase(last.lastRunAt, Date.now(), true) } : undefined,
      hint: m.hintRunBack,
      note: m.registerOnPhoneWeb,
    };
  }

  /** 실행 결과에 그릴 것. 종료 코드와 걸린 시간은 상태 표시줄로 올린다. */
  private commandResultView(r: NonNullable<GlassesUI['cmdResult']>): CommandResultView {
    const state = r.state ?? (r.awaitingConfirm ? 'confirm' : 'done');
    const m = msg();
    let status = clock();
    if (state === 'done') {
      const ok = r.exitCode === 0 && !r.timedOut;
      // 금방 끝난 명령은 '0.0초'로 보여 멈춘 것처럼 읽힌다.
      const took =
        r.tookMs === undefined ? '' : r.tookMs < 100 ? ` · ${m.tookUnder}` : ` · ${m.secShort((r.tookMs / 1000).toFixed(1))}`;
      const exit = r.timedOut ? m.timedOut : m.exitCode(r.exitCode ?? '?');
      status = `${ok ? '◎' : '◇'} ${exit}${took}   ${clock()}`;
    } else if (state === 'failed') {
      status = `◇ ${m.failed}   ${clock()}`;
    } else if (state === 'confirm') {
      status = `▲ ${m.confirmNeeded}   ${clock()}`;
    }
    return {
      title: `$ ${r.label}`,
      status,
      state,
      command: r.command ?? '',
      lines: r.lines ?? r.text.split('\n'),
      hint: state === 'confirm' ? m.hintRunAnyway : m.hintBackToList,
      note: state === 'done' ? r.command ?? '' : '',
    };
  }

  /** 시스템 화면에 그릴 것. 못 구한 값(-1·0)은 null로 바꿔 넘긴다. */
  private systemScreenView(): SystemView {
    const sys = this.sys;
    const at = this.sysReadAt;
    // 탭해서 다시 읽어도 같은 분이면 달라진 게 없어 보인다. 초까지 적는다.
    const m = msg();
    const read = at ? m.readAt(`${clock(at)}:${String(at.getSeconds()).padStart(2, '0')}`) : '';
    return {
      title: '$ ~/sys',
      status: read || clock(),
      summary: sys
        ? {
            cpu: sys.cpuPercent >= 0 ? sys.cpuPercent : null,
            mem: sys.memTotalGB > 0 ? { used: sys.memUsedGB, total: sys.memTotalGB } : null,
            load: sys.load,
            uptime: sys.uptime,
          }
        : undefined,
      procs: this.procs.map((p) => ({ name: p.name, cpu: p.cpu >= 0 ? p.cpu : null })),
      notice: sys ? undefined : this.sysError ?? m.reading,
      hint: m.hintRefreshBack,
      note: (sys?.host ?? '').replace(/\.local$/, ''),
    };
  }

  /** 세션 상태를 사람 말로. 상태 표시줄과 카드에 쓴다. */
  private sessionStateLabel(s: SessionInfo | undefined): string {
    if (s && !s.live) return msg().stateClosed;
    if (this.pending) return msg().stateWaiting;
    return this.statusText(this.status || s?.status || 'idle');
  }

  /** 대화 목록에 그릴 것. 오른쪽 카드는 세션 정보라 고른 줄과 상관없다. */
  private historyView(s: SessionInfo | undefined): HistoryView {
    const m = msg();
    return {
      title: `$ ~/${s?.title || m.newChat}`,
      status: clock(),
      rows: this.shownHistory().map((h) => ({
        kind: h.kind,
        text: h.full.replace(/\n/g, ' ').trim() || m.noContent,
      })),
      action: m.continueChat,
      info: {
        state: s ? this.statusOf(s) : 'idle',
        label: this.sessionStateLabel(s),
        rows: [
          { label: m.infoTurns, value: String(s?.turns ?? 0) },
          { label: m.infoCost, value: `$${(s?.totalCostUsd ?? 0).toFixed(2)}` },
          { label: m.infoFolder, value: s?.cwd ? (s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? '') : '' },
          { label: m.infoActivity, value: s?.lastActivityAt ? agoPhrase(s.lastActivityAt) : '' },
        ],
      },
      hint: m.hintFullBack,
    };
  }

  /** 진행 중 대화에 그릴 것. 하는 일이 바뀌거나 도는 기호가 돌 때 글자만 고친다. */
  private liveView(s: SessionInfo | undefined): LiveView {
    const closed = Boolean(s && !s.live);
    const busy = !closed && this.status === 'busy';
    const secs = this.activityAt ? Math.max(0, Math.floor((Date.now() - this.activityAt) / 1000)) : 0;
    const m = msg();
    return {
      title: `$ ~/${s?.title || m.newChat}`,
      status: [this.sessionStateLabel(s), clock()].join('   '),
      lines: this.feed.slice(-6),
      activity: busy
        ? {
            text: [this.activity || m.stateBusy, this.activityDetail].filter(Boolean).join('  '),
            elapsed: this.activityAt ? (secs < 60 ? m.secShort(secs) : m.minShort(Math.floor(secs / 60))) : '',
            tick: this.tick,
          }
        : undefined,
      idle: closed ? m.endedTapResume : m.stateTapCommands(this.sessionStateLabel(s)),
      hint: closed ? m.hintResumeBack : m.hintCommandsBack,
      meta: s ? `${m.turns(s.turns)}  ·  $${s.totalCostUsd.toFixed(2)}` : '',
    };
  }

  /** 권한 요청에 그릴 것. 선택지 순서는 PERMISSION_CHOICES와 같다(거부가 맨 앞). */
  private permissionView(p: { sessionId: string; toolName: string; summary: string }): PermissionView {
    const s = this.sessions.find((x) => x.id === p.sessionId);
    const m = msg();
    return {
      title: `$ ~/${s?.title || m.newChat}`,
      status: this.permError ? clamp(m.permFailed(this.permError), 40) : [m.permRequest, clock()].join('   '),
      tool: p.toolName,
      summary: p.summary.replace(/\n/g, ' ').trim(),
      choices: PERMISSION_CHOICES.map((c) => ({
        kind: c.behavior === 'deny' ? 'deny' : c.always ? 'always' : 'once',
        label: m[c.label],
      })),
      hint: m.permHint,
    };
  }

  private summary(): string {
    const busy = this.sessions.filter((s) => s.live && s.status === 'busy').length;
    const done = this.checklist.filter((i) => i.done).length;
    return msg().summary(busy, this.sessions.length, this.unread, done, this.checklist.length);
  }

  /**
   * 대화 기록에서 목록에 보여줄 항목만 고른다.
   *
   * 상세 화면과 같은 변환(toLine)을 쓴다. 도구 호출·오류까지 전부 넣으면
   * 목록이 길어져 정작 주고받은 말을 찾기 어려우므로 여기서는 빼고,
   * 고르면 그 전문을 보여준다.
   */
  /** 목록에 보이는 세션(G2 목록 한도까지). */
  private shownSessions(): SessionInfo[] {
    return this.sessions.slice(0, LIST_MAX);
  }

  /** 목록에 보이는 알림. 최신이 앞이라 앞에서 자른다. */
  private shownNotifications(): Notification[] {
    return this.notifications.slice(0, LIST_ROWS);
  }

  private shownChecklist(): ChecklistItem[] {
    return this.checklist.slice(0, LIST_ROWS);
  }

  /** 목록에 보이는 대화. 최근 것이 쓸모 있으니 뒤에서 자른다. */
  private shownHistory(): { line: string; full: string; kind: 'me' | 'ai' }[] {
    return this.historyItems().slice(-LIST_ROWS);
  }

  /** 대화 화면에서 고를 Claude 명령. 맨 끝 한 칸('할 일 보기')을 남긴다. */
  private shownSlash(): SlashItem[] {
    const s = this.sessions.find((x) => x.id === this.activeId);
    return slashItems(s?.slashCommands, LIST_ROWS);
  }

  private shownSnippets(): Snippet[] {
    return this.snippets.slice(0, LIST_MAX);
  }

  private historyItems(): { line: string; full: string; kind: 'me' | 'ai' }[] {
    const out: { line: string; full: string; kind: 'me' | 'ai' }[] = [];
    for (const e of this.history) {
      if (e.type !== 'user' && e.type !== 'assistant') continue;
      const full = String(e.text ?? '');
      const who = e.type === 'user' ? msg().me : 'AI';
      out.push({
        line: `${who}> ${clamp(full.replace(/\n/g, ' ').trim() || msg().noContent, 34)}`,
        full,
        kind: e.type === 'user' ? 'me' : 'ai',
      });
    }
    return out;
  }

  /** 알림 시각을 짧게. 안경에서는 날짜보다 시:분이 쓸모 있다. */
  private notifTime(n: Notification | null): string {
    if (!n) return '';
    const d = new Date(n.createdAt);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /**
   * 화면을 깨우고 무조작 타이머를 다시 센다.
   * 사용자 조작이나 알릴 만한 이벤트가 있을 때 부른다.
   */
  /**
   * 뒤로 물러났다 돌아왔을 때 화면과 자료를 되찾는다.
   *
   * 화면을 다시 세우고, 물러난 사이 바뀐 것을 읽는다. 순서가 중요하다 —
   * 세우기 전에 그리면 그 그리기가 버려진다.
   */
  private async returnToForeground(): Promise<void> {
    try {
      await this.glasses.reattach?.();
    } catch (err) {
      this.log(msg().restoreFailed((err as Error).message), 'warn');
    }

    // 돌아왔으니 화면을 쓸 수 있다. 무조작 타이머도 다시 센다.
    this.wake();

    // 물러난 사이 온 알림이 있으면 여기서 뜬다.
    try {
      await this.refreshSummary();
    } catch {
      // 못 읽어도 화면은 되살아났다. 다음 주기가 다시 읽는다.
    }
  }

  /**
   * 알림이 어디서 왔는지 한 낱말로 고른다.
   *
   * 머리말에 붙여 무엇을 알리는지 먼저 보이게 한다. 안경 화면은 좁아
   * 제목을 다 읽기 전에 갈래부터 알아야 쓸모가 있다.
   */
  private labelFor(n: Notification): string {
    const m = msg();
    if (n.kind === 'permission') return `* ${m.kindPermission}`;
    if (n.kind === 'error') return `* ${m.kindError}`;

    /*
     * 에이전트 일인지는 세션이 붙어 있는지로 본다.
     *
     * kind만 보면 안 된다. 외부 훅도 done을 보낼 수 있어서, 남의
     * 서비스가 보낸 성공 알림이 에이전트 작업으로 보였다.
     */
    if (n.sessionId) return `* ${m.kindAgent}`;

    // 서버·폰이 할 일 변경에 붙이는 제목이다. 서버 언어(RELAY_LANG)에 따라 한국어나 영어다.
    if (isTodoNoticeTitle(n.title)) return `* ${m.kindTodo}`;
    return `* ${m.kindNotification}`;
  }

  /** 알림 갈래의 이름. */
  private kindLabel(kind: NoticeKind): string {
    const m = msg();
    return { done: m.kindDone, error: m.kindError, permission: m.kindPermission, info: m.kindInfo }[kind];
  }

  /**
   * 알림 팝업을 띄우고, 시간이 지나면 스스로 걷는다.
   *
   * 걷을 때 화면을 다시 그려 원래 보던 곳으로 돌아간다. 그리지 않으면
   * 팝업 글자가 화면에 그대로 남는다.
   */
  private showNotice(notice: { title: string; text: string; label: string; kind?: NoticeKind }): void {
    this.notice = notice;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      // 그 사이 사용자가 탭으로 치웠거나 다른 것이 떴으면 건드리지 않는다.
      if (this.notice !== notice) return;
      this.notice = null;
      void this.render();
    }, this.noticeMs);
    (this.noticeTimer as { unref?: () => void }).unref?.();
  }

  /** 팝업을 지금 걷는다. 타이머도 함께 푼다. */
  private dismissNotice(): void {
    clearTimeout(this.noticeTimer);
    this.noticeTimer = undefined;
    this.notice = null;
  }

  private wake(): void {
    this.screenOff = false;
    this.armIdle();
  }

  /**
   * 무조작 타이머를 다시 센다.
   *
   * 화면을 켜는 일과 분리해 둔다. 켜지 않고 타이머만 다시 걸어야 하는
   * 자리가 있기 때문이다 — 이미 꺼진 상태로 sleep()에 다시 들어올 때다.
   * 거기서 타이머를 놓치면 다시 걸 기회가 없다.
   */
  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    // 발표·원고 화면에서는 끄지 않는다. 보며 말하는 동안 손을 대지 않으니
    // 무조작으로 꺼지면 정작 필요할 때 화면이 없다.
    if (this.screen === 'mac-present' || this.screen === 'mac-prompter') return;
    this.idleTimer = setTimeout(() => void this.sleep(), this.idleMs);
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  /** 화면을 비운다. 상태는 그대로 두고 표시만 끈다. */
  private async sleep(): Promise<void> {
    // 이미 꺼져 있으면 그릴 것은 없다. 그래도 타이머는 다시 무장한다.
    //
    // setTimeout은 한 번 터지면 사라지고, 다시 거는 곳은 wake()뿐이었다.
    // 그래서 이 경로로 빠져나오면 화면이 꺼질 기회를 영구히 잃었다.
    // 그 뒤 무언가가 화면을 켜면(아래 render를 거치지 않는 직접 그리기
    // 같은 것) 켜진 채로 남는다. 메인 메뉴에서 화면이 안 꺼지는 증상이
    // 이것이었다 — 설정을 다시 만지면 wake가 불려 나은 것처럼 보였다.
    if (this.screenOff) {
      this.armIdle();
      return;
    }
    this.screenOff = true;
    // 작업 중 갱신이 계속 돌면 다시 켜지므로 같이 멈춘다.
    this.setSpinning(false);

    // 팝업을 들고 꺼지지 않는다.
    //
    // 남겨두면 두 가지가 망가진다. 깨어났을 때 지나간 알림이 다시
    // 보이고, 그동안 새 알림이 "이미 떠 있다"는 이유로 막힌다.
    // 이미 화면에 띄워 알렸고 목록에도 남아 있으니 여기서 걷는다.
    this.dismissNotice();
    try {
      // 빈 문자열은 기기가 거부할 수 있어 공백 한 칸을 보낸다.
      await this.glasses.showText(' ');
    } catch {
      // 화면을 못 끄는 건 치명적이지 않다.
    }
  }

  async render(): Promise<void> {
    // 꺼진 상태에서는 그리지 않는다. 깨우는 건 조작이나 새 이벤트뿐이다.
    // 종료한 뒤에도 그리지 않는다 — 그리면 닫은 화면이 다시 열린다.
    if (this.screenOff || this.stopped) return;
    try {
      // 1) 권한 요청이 최우선. 사용자가 답해야 작업이 진행된다.
      if (this.pending) {
        const p = this.pending;
        // 막는 시간은 이 요청을 처음 그릴 때만 센다. 다시 그릴 때마다 세면 다른 세션 소식이나
        // 주기 갱신으로 화면이 자주 바뀔 때 탭이 계속 버려진다(허용을 눌러도 반응이 없었다).
        if (this.permShownId !== p.id) {
          this.permShownId = p.id;
          this.permShownAt = Date.now();
        }
        if (this.glasses.showPermission) {
          await this.glasses.showPermission(this.permissionView(p));
          return;
        }
        await this.glasses.showList(msg().permHeader(clamp(p.toolName, 30)), [
          ...PERMISSION_CHOICES.map((c) => msg()[c.label]),
          ...(p.summary ? [`  ${clamp(p.summary.replace(/\n/g, ' '), 60)}`] : []),
        ]);
        return;
      }

      // 2) 작업 완료·새 알림.
      if (this.notice) {
        if (this.glasses.showNotice) {
          const n = this.notice;
          await this.glasses.showNotice({
            kind: n.kind ?? 'info',
            // 글 화면에서는 '* 오류'처럼 별표를 붙였다. 꾸민 팝업은 기호를 따로 그린다.
            label: n.label.replace(/^\*\s*/, ''),
            title: n.title.trim(),
            body: n.text.trim() === n.title.trim() ? '' : n.text.trim(),
            closeHint: msg().closeHint(Math.round(this.noticeMs / 1000)),
          });
          return;
        }
        await this.glasses.showText(noticeView(this.notice, this.noticeMs));
        return;
      }

      // 4) 홈. 상단에 요약, 메뉴 옆에 서버 상태를 띄운다.
      if (this.screen === 'home') {
        // 꾸밀 수 있는 기기는 상태 표시줄·게이지까지 그린다.
        if (this.glasses.showHome) {
          await this.glasses.showHome(this.homeView());
          return;
        }
        // 옆 패널은 로고만 둔다. 서버 상태는 상단 요약과 폰 로그에 이미 있고,
        // 여기 같이 넣으면 높이가 모자라 아래가 잘린다.
        // 로고를 끄면 패널 없이 목록이 화면을 다 쓴다.
        await this.glasses.showList(
          this.summary(),
          this.homeMenu().map((id) => menuLabel(id)),
          // 로고 아트는 기기마다 달라 어댑터가 갖는다.
          this.showLogo ? this.glasses.logo : undefined,
        );
        return;
      }

      // 4) 세션 목록.
      if (this.screen === 'sessions') {
        if (this.glasses.showSessions) {
          await this.glasses.showSessions(this.sessionsView());
          return;
        }
        const m = msg();
        const items: Item[] = this.shownSessions().map((s) => ({
          text: s.title || m.newChat,
          state: this.statusOf(s),
        }));
        if (items.length === 0) items.push({ text: m.noSessionsRow });
        const busy = this.sessions.filter((s) => s.live && s.status === 'busy').length;
        const parts = [m.sessionsHeader(this.sessions.length)];
        if (busy > 0) parts.push(m.busyHeader(busy));
        await this.glasses.showList(m.withBack(parts.join(' · ')), items);
        return;
      }

      // 5) 한 세션의 대화 기록.
      if (this.screen === 'history') {
        const s = this.sessions.find((x) => x.id === this.activeId);
        if (this.glasses.showHistory) {
          await this.glasses.showHistory(this.historyView(s));
          return;
        }
        const items = this.shownHistory().map((h) => h.line);
        // 리스트는 비어 있으면 만들 수 없다.
        const m = msg();
        if (items.length === 0) items.push(m.noHistoryRow);
        // 진행 상황을 보거나 말을 거는 자리는 항상 맨 아래에 둔다.
        items.push(`> ${m.continueChat}`);
        await this.glasses.showList(m.withBack(clamp(s?.title || m.session, 30)), items);
        return;
      }

      // 6) 알림 목록.
      if (this.screen === 'notifications') {
        if (this.glasses.showNotifications) {
          await this.glasses.showNotifications(this.notificationsView());
          return;
        }
        const items: Item[] = this.shownNotifications().map((n) => ({
          text: n.title,
          state: n.readAt ? 'read' : 'unread',
        }));
        const m = msg();
        if (items.length === 0) items.push({ text: m.noNotificationsRow });
        else items.push({ text: m.markAllRead });
        await this.glasses.showList(
          m.withBack(m.notificationsHeader(this.unread, this.notifications.length)),
          items,
        );
        return;
      }

      // 7) 알림 하나를 펼쳐 본다.
      if (this.screen === 'notification') {
        const n = this.openNotif;
        if (this.glasses.showNotification) {
          await this.glasses.showNotification(this.notificationView(n));
          return;
        }
        await this.glasses.showText(
          [
            clamp(n?.title ?? msg().kindNotification, 46),
            `─ ${msg().withBack(this.notifTime(n))}`,
            '',
            clamp(n?.body || msg().noContent, 320),
          ].join('\n'),
        );
        return;
      }

      // 8) 시스템 상태.
      if (this.screen === 'system') {
        if (this.glasses.showSystem) {
          await this.glasses.showSystem(this.systemScreenView());
          return;
        }
        const view = systemView(this.sys, this.procs);
        await this.glasses.showList(view.header, view.items);
        return;
      }

      // 9) 등록한 명령 목록.
      if (this.screen === 'reader' && this.reader) {
        const m = msg();
        const r = this.reader;
        const body = r.pages[r.page] ?? [];
        const head = r.pages.length > 1 ? `${r.title}  ${r.page + 1}/${r.pages.length}` : r.title;
        // 펌웨어가 빈 줄 앞 공백을 지운다. 빈 줄은 공백 하나로 둔다.
        await this.glasses.showText(
          [clampWidth(head, MAC_COLS), ...body.map((l) => l || ' '), ...Array(Math.max(0, MAC_ROWS - 2 - body.length)).fill(' '), m.readerHint].join('\n'),
        );
        return;
      }

      if (this.screen === 'slash') {
        const m = msg();
        const items = this.shownSlash();
        const header = this.slashConfirm
          ? m.slashConfirm(this.slashConfirm)
          : m.withBack(m.slashHeader(this.slashCursor + 1, items.length + 1));
        await this.glasses.showList(header, [
          ...items.map((c, i) => {
            const desc = c.key ? m.slashDesc(c.key) : '';
            return { text: clamp(`/${c.name}${desc ? `  ${desc}` : ''}`, 40), state: i === this.slashCursor ? ('running' as const) : undefined };
          }),
          { text: m.slashTodo, state: this.slashCursor === items.length ? ('running' as const) : undefined },
        ]);
        return;
      }

      if (this.screen === 'commands') {
        if (this.glasses.showCommands) {
          await this.glasses.showCommands(this.commandsView());
          return;
        }
        const m = msg();
        if (this.snippets.length === 0) {
          await this.glasses.showList(m.withBack(m.menuCommands), [m.noCommandsRow, m.registerOnWebRow]);
          return;
        }
        await this.glasses.showList(
          m.withBack(m.commandsHeader(this.cmdCursor + 1, this.snippets.length)),
          this.shownSnippets().map((x, i) => ({
            text: x.kind === 'cron' ? `${x.label}${m.scheduledSuffix}` : x.label,
            state: i === this.cmdCursor ? 'running' : undefined,
          })),
        );
        return;
      }

      // 10) 실행 결과.
      if (this.screen === 'command-result') {
        if (this.glasses.showCommandResult && this.cmdResult) {
          await this.glasses.showCommandResult(this.commandResultView(this.cmdResult));
          return;
        }
        await this.glasses.showText(resultView(this.cmdResult));
        return;
      }

      // 홈 더블탭 선택지.
      if (this.screen === 'home-menu') {
        await this.glasses.showList(msg().homeMenuHeader, HOME_MENU.map((k) => msg()[k]));
        return;
      }

      // 11) 타이머·물 마시기. 폰(Relay 앱)의 것을 조작한다.
      if (this.screen === 'phone') {
        if (!this.phone) {
          await this.glasses.showList(msg().withBack(msg().menuPhone), [msg().phoneNeedsApp]);
          return;
        }
        await this.glasses.showList(
          msg().withBack(phoneHeader(this.phone, this.phoneAt, Date.now())),
          phoneActions(this.phone).map((a) => a.label),
        );
        return;
      }

      // 맥(mac-agent). 글이 많은 화면은 텍스트 한 장으로 그린다 —
      // 같은 모드면 기기가 깜빡임 없이 글자만 바꾼다(자막·쪽 넘김).
      if (this.screen === 'mac') {
        const m = msg();
        const rows =
          this.macCaps === undefined
            ? [m.reading]
            : this.macCaps === null
              ? [m.macNotConnected]
              : MAC_ITEMS.map((i) => macItemLabel(i, this.macCaps as ExtCapability[], agentCli.desktopAgent));
        await this.glasses.showList(m.withBack(this.macCaps ? m.deviceWord(agentCli.desktopAgent) : m.menuMac), rows);
        return;
      }
      if (this.screen === 'mac-present') {
        await this.glasses.showText(
          presentPage(this.macPresent, this.macError, Date.now(), {
            cursor: this.presentCursor,
            stopArmed: this.presentStopArmed,
            actions: this.presentActions(),
          }),
        );
        return;
      }
      if (this.screen === 'mac-captions') {
        await this.glasses.showText(captionsPage(this.macCaptionLines, this.macPartial, this.macCaptionsState, this.macError, agentCli.desktopAgent));
        return;
      }
      if (this.screen === 'mac-meeting') {
        await this.glasses.showText(meetingPage(this.macEvent, this.macError, Date.now()));
        return;
      }
      if (this.screen === 'mac-prompter') {
        await this.glasses.showText(prompterPage(this.macPrompter, this.macError));
        return;
      }
      if (this.screen === 'mac-shortcuts') {
        const m = msg();
        const rows =
          this.macShortcuts === undefined
            ? [m.reading]
            : this.macShortcuts.length > 0
              ? this.macShortcuts.map((s) => s.name)
              : [this.macError ?? m.shortcutsEmpty];
        await this.glasses.showList(m.withBack(m.macShortcuts), rows);
        return;
      }
      if (this.screen === 'mac-present-files') {
        const m = msg();
        const files = this.macPresentFiles;
        if (files !== undefined && files.length === 0) {
          // 비었거나 못 읽었다(권한 등). 안내가 길어 목록 대신 글로 보인다.
          await this.glasses.showText(
            presentFilesPage(this.macError ?? m.presentFilesEmpty(this.macPresentFolder || '~/Documents')),
          );
          return;
        }
        // 맥 파일 이름은 한글이 자모로 풀려(NFD) 오기도 한다. 안경 글꼴은 완성형만 그린다.
        const rows = files === undefined ? [m.reading] : files.map((f) => f.name.normalize('NFC'));
        // 열다 실패하면 머리에 사유를 싣는다. 줄을 끼워 넣으면 커서 자리가 어긋난다.
        const head = files && this.macError ? this.macError : m.macPresentFiles;
        await this.glasses.showList(m.withBack(head), rows);
        return;
      }
      if (this.screen === 'mac-document') {
        const d = this.macDocument;
        await this.glasses.showText(documentPage(d?.name ?? '', d?.app ?? 'pages', this.macError));
        return;
      }
      if (this.screen === 'mac-reply') {
        const m = msg();
        await this.glasses.showList(m.withBack(m.replyTo(this.macReplyTo ?? '')), [...quickReplies(), m.replyCancel]);
        return;
      }
      if (this.screen === 'mac-result') {
        const r = this.macResult;
        await this.glasses.showText(shortcutPage(r?.name ?? '', r?.state ?? 'failed', r?.output));
        return;
      }

      // 12) 설정.
      if (this.screen === 'settings') {
        const m = msg();
        await this.glasses.showList(m.withBack(m.menuSettings), [
          this.glasses.isVoiceEnabled ? m.voiceOn : m.voiceOff,
          this.showLogo ? m.logoOn : m.logoOff,
          // 펌웨어가 앞쪽 공백을 지워 들여쓰기로는 정렬이 안 맞는다.
          // 고른 값과 아닌 값 모두 보이는 문자를 앞에 둔다.
          ...IDLE_CHOICES.map(
            (ms) => m.idleChoice(this.idleMs === ms ? '*' : '-', ms / 1000),
          ),
          m.menuEdit,
        ]);
        return;
      }
      // 메뉴 편집: 모든 항목을 순서대로, 보이는 것은 [x]. 마지막 줄은 기본값으로.
      if (this.screen === 'menu-edit') {
        const m = msg();
        const rows = this.menuConfig.order.map((id) => {
          const shown = !this.menuConfig.hidden.includes(id);
          const note = id === 'mac' ? ` · ${m.menuWhenLinked}` : '';
          return `${shown ? '[x]' : '[ ]'} ${menuLabel(id)}${note}`;
        });
        await this.glasses.showList(m.withBack(m.menuEdit), [...rows, m.menuReset]);
        return;
      }
      // 항목 하나: 보이기·숨기기, 위로, 아래로, 완료.
      if (this.screen === 'menu-item' && this.menuEditing) {
        const m = msg();
        const id = this.menuEditing;
        const shown = !this.menuConfig.hidden.includes(id);
        const pos = this.menuConfig.order.indexOf(id) + 1;
        await this.glasses.showList(m.withBack(`${menuLabel(id)} ${pos}/${this.menuConfig.order.length}`), [
          id === 'settings' ? m.menuCannotHide : shown ? m.menuHide : m.menuShow,
          m.menuUp,
          m.menuDown,
          m.menuDone,
        ]);
        return;
      }

      // 9) 체크리스트 화면.
      if (this.screen === 'checklist') {
        if (this.glasses.showChecklist) {
          await this.glasses.showChecklist(this.checklistView());
          return;
        }
        const done = this.checklist.filter((i) => i.done).length;
        const items: Item[] = this.shownChecklist().map((i) => ({
          text: i.text,
          state: i.done ? 'done' : 'todo',
        }));
        // 비어 있으면 리스트를 만들 수 없으므로 안내를 항목으로 넣는다.
        const m = msg();
        if (items.length === 0) items.push({ text: m.noTodosRow });
        else items.push({ text: m.clearDone });
        const label = this.checkGlobal ? m.globalTodos : m.todos;
        await this.glasses.showList(
          m.withBack(`${label} ${done}/${this.checklist.length}`),
          items,
        );
        return;
      }

      // 5) 상세 화면.
      const s = this.sessions.find((x) => x.id === this.activeId);
      if (this.glasses.showLive) {
        await this.glasses.showLive(this.liveView(s));
        return;
      }
      const m = msg();
      const head = s ? clamp(s.title || m.newChat, 46) : m.session;

      let status: string;
      if (s && !s.live) {
        status = m.detailEnded;
      } else if (this.status === 'busy') {
        // 가만히 있는 화면은 멈춘 것처럼 보인다.
        status = `${SPINNER[this.tick % SPINNER.length]} ${this.activity || m.stateBusy}`;
      } else {
        status = m.detailStatus(this.statusText(this.status || s?.status || ''));
      }

      await this.glasses.showText(
        [head, `─ ${status}`, '', clamp(this.lines.slice(-6).join('\n'), 360)].join('\n'),
      );
    } catch (err) {
      // 화면 갱신 실패가 glasses-ui를 멈추면 안 된다.
      this.log(msg().renderError((err as Error).message), 'error');
    }
  }

  // --- 이벤트 ---

  /** 이벤트 한 건을 누가 했는지와 함께 한 줄로. 꾸민 대화 화면용이다. */
  private toFeed(e: SessionEvent): { kind: LineKind; text: string } | null {
    const first = (k: string): string => String(e[k] ?? '').split('\n')[0]?.trim() ?? '';
    switch (e.type) {
      case 'user':
        return { kind: 'me', text: first('text') };
      case 'assistant':
        return first('text') ? { kind: 'ai', text: first('text') } : null;
      case 'tool_use': {
        const brief = toolBrief(e.input);
        return { kind: 'tool', text: brief ? `${String(e.name ?? '')}  ${brief}` : String(e.name ?? '') };
      }
      case 'stderr':
        return { kind: 'error', text: first('text') };
      case 'resumed':
        return { kind: 'info', text: msg().resumedHere };
      default:
        return null;
    }
  }

  /**
   * 마지막 답을 모은다. 새 질문이 오면 비우고, 답 조각을 잇고, 턴이 끝나면 CLI가 준 결과 전문으로 바꾼다.
   * 대화 화면은 첫 줄만 보이므로 결과 읽기가 이걸 쓴다.
   */
  private collectReply(e: SessionEvent): void {
    if (e.type === 'user') this.lastReply = '';
    else if (e.type === 'assistant' && e.text) this.lastReply = [this.lastReply, String(e.text)].filter(Boolean).join('\n\n');
    else if (e.type === 'turn_complete' && String(e.result ?? '').trim()) this.lastReply = String(e.result);
  }

  /** 마지막 답을 쪽으로 나눠 연다. /usage 결과면 한도 카드를 첫 쪽에 둔다. */
  private async openReader(): Promise<void> {
    const m = msg();
    const rows = MAC_ROWS - 2;
    const usage = parseUsage(this.lastReply);
    let title = m.readerTitle;
    let pages: string[][];
    if (usage) {
      title = m.usageTitle(usage.subscription);
      const name = (k: (typeof usage.limits)[number]): string =>
        k.kind === 'session' ? m.usageSession : k.kind === 'week' ? m.usageWeek : k.label;
      const width = Math.max(...usage.limits.map((k) => displayWidth(name(k)))) + 2;
      const card = usage.limits.map(
        (k) => `${padWidth(name(k), width)}${usageBar(k.percent, 14)} ${String(Math.round(k.percent)).padStart(3)}%  ${shortReset(k.resets, new Date())}`,
      );
      const details = usage.details ? paginate(plainText(usage.details), MAC_COLS, rows) : [];
      if (details.length > 0) card.push('', m.usageMore);
      pages = [card, ...details];
    } else {
      pages = paginate(plainText(this.lastReply) || m.readerEmpty, MAC_COLS, rows);
    }
    this.reader = { title, pages, page: 0 };
    this.screen = 'reader';
    await this.render();
  }

  /** 이벤트 한 건을 화면에 보여줄 짧은 줄로 바꾼다. */
  private toLine(e: SessionEvent): string | null {
    const text = (k: string): string => String(e[k] ?? '');
    switch (e.type) {
      case 'user':
        return `${msg().me}: ${clamp(text('text').split('\n')[0] ?? '', 60)}`;
      case 'assistant':
        // 긴 답변이 화면을 다 먹으면 진행 상황이 묻힌다.
        return clamp(text('text').split('\n')[0] ?? '', 90);
      case 'tool_use':
        return `> ${text('name')}`;
      case 'stderr':
        return `${msg().kindError}: ${clamp(text('text'), 60)}`;
      case 'resumed':
        return `── ${msg().resumedHere} ──`;
      default:
        return null;
    }
  }

  private setSpinning(on: boolean): void {
    if (on && !this.spinTimer) {
      // BLE로 매번 화면을 보내므로 너무 자주 갱신하지 않는다.
      this.spinTimer = setInterval(() => {
        this.tick += 1;
        void this.render();
      }, 1500);
    } else if (!on && this.spinTimer) {
      clearInterval(this.spinTimer);
      this.spinTimer = undefined;
      // 승인 대기로 잠깐 멈출 때는 하던 일을 남긴다. 승인하면 같은 일을
      // 이어서 하는데, 지우면 진행 카드에 '작업 중'만 남았다.
      if (this.status !== 'waiting') {
        this.activity = '';
        this.activityDetail = '';
        this.activityAt = 0;
      }
    }
  }

  /** 상세 화면에서 보고 있는 세션의 이벤트. */
  private async handleEvent(e: SessionEvent): Promise<void> {
    this.collectReply(e);
    // CLI가 시작하며 알려 준 / 명령 목록. 세션 목록을 다시 읽기 전에도 명령 화면에 쓴다.
    if (e.type === 'session' && Array.isArray(e.slashCommands)) {
      const s = this.sessions.find((x) => x.id === (e.sessionId ?? this.activeId));
      if (s) s.slashCommands = e.slashCommands as string[];
    }
    if (e.type === 'status') {
      this.status = String(e.status);
      this.setSpinning(this.status === 'busy' && this.screen === 'detail');
      await this.render();
      return;
    }

    if (e.type === 'tool_use') {
      this.activity = String(e.name ?? '');
      this.activityDetail = toolBrief(e.input);
      this.activityAt = Date.now();
    }
    if (e.type === 'thinking') {
      this.activity = msg().thinking;
      this.activityDetail = '';
      this.activityAt = Date.now();
    }

    if (e.type === 'permission_request') {
      await this.askPermission(String(e.sessionId ?? this.activeId), {
        id: String(e.requestId),
        toolName: String(e.toolName),
        summary: String(e.summary ?? ''),
      });
      return;
    }

    if (e.type === 'permission_resolved') {
      await this.permissionResolved(String(e.requestId));
      return;
    }

    if (e.type === 'turn_complete') {
      const result = String(e.result ?? '');
      const failed = e.isError === true;
      // 글이 아니라 상태 값을 둔다. 글은 statusText가 고른다.
      this.status = failed ? 'error' : 'done';
      this.setSpinning(false);
      this.doneIds.add(String(e.sessionId ?? this.activeId));
      // 결과를 보여줘야 하므로 깨운다.
      this.wake();
      const m = msg();
      this.glasses.speak(failed ? m.speakFailed : m.speakDone(result));
      this.log(`${failed ? m.kindError : m.kindDone}: ${result}`, failed ? 'error' : 'ok');
      await this.render();
      void this.refresh();
      return;
    }

    const line = this.toLine(e);
    const fed = this.toFeed(e);
    if (fed) {
      this.feed.push(fed);
      if (this.feed.length > 40) this.feed.shift();
    }
    if (line) {
      this.lines.push(line);
      if (this.lines.length > 40) this.lines.shift();
      await this.render();
    }
  }

  /** 목록 화면에서 다른 세션의 이벤트를 받았을 때. 완료와 권한만 본다. */
  private async handleBackgroundEvent(id: string, e: SessionEvent): Promise<void> {
    const s = this.sessions.find((x) => x.id === id);

    if (e.type === 'turn_complete') {
      const result = String(e.result ?? '');
      const failed = e.isError === true;
      this.doneIds.add(id);
      this.wake();
      const m = msg();
      const verdict = failed ? m.kindError : m.kindDone;
      this.glasses.speak(failed ? m.speakFailed : m.speakDone(result));
      this.log(`[${s?.title ?? m.session}] ${verdict}: ${result}`, failed ? 'error' : 'ok');

      // 서버에 남겨 나중에 '알림 보기'에서 다시 볼 수 있게 한다.
      // 화면에 한 번 띄우고 마는 팝업은 놓치면 그만이다.
      try {
        const saved = await agentCli.addNotification({
          title: `${verdict}: ${s?.title || m.newChat}`,
          body: result,
          kind: failed ? 'error' : 'done',
          sessionId: id,
        });
        this.unread += 1;
        // 방금 내가 남긴 알림이다. 아래에서 팝업을 직접 띄우므로
        // 되돌아온 SSE가 같은 것을 한 번 더 띄우지 않게 눌러둔다.
        if (saved?.id) this.lastSeenNotifId = saved.id;
      } catch (err) {
        this.log(m.saveNotifFailed((err as Error).message), 'warn');
      }

      // 목록·홈에 있을 때만 팝업을 띄운다. 대화 화면에서는 이미 보고 있다.
      //
      // showNotice로 띄운다. 직접 넣으면 스스로 걷는 타이머가 걸리지
      // 않아 탭할 때까지 화면이 굳는다.
      if (this.screen === 'home' || this.screen === 'sessions') {
        this.showNotice({
          title: s?.title || m.newChat,
          text: failed ? `${m.kindError}: ${result}` : result,
          label: m.kindAgent,
          kind: failed ? 'error' : 'done',
        });
      }
      await this.render();
      return;
    }

    // 보고 있는 세션(activeId)은 바꾸지 않는다. 바꾸면 대화 화면은 그대로 앞 세션의 이벤트를
    // 받는데 이름만 바뀌어, 두 세션의 진행이 뒤섞이고 이 세션의 진행은 버려졌다.
    if (e.type === 'permission_request') {
      await this.askPermission(id, {
        id: String(e.requestId),
        toolName: String(e.toolName),
        summary: String(e.summary ?? ''),
      });
      return;
    }

    if (e.type === 'permission_resolved') await this.permissionResolved(String(e.requestId));
  }

  /**
   * 권한 요청을 띄운다. 이미 다른 요청을 띄우고 있으면 그게 끝난 뒤 syncPending이 띄운다 —
   * 덮어쓰면 앞 요청은 답할 길이 없어진다.
   */
  private async askPermission(sessionId: string, p: { id: string; toolName: string; summary: string }): Promise<void> {
    if (this.pending) return;
    this.pending = { ...p, sessionId };
    this.permCursor = 0;
    this.permError = '';
    // 답해야 진행되는 일이므로 화면을 깨운다.
    this.wake();
    if (!this.announcedPerms.has(p.id)) {
      this.announcedPerms.add(p.id);
      this.glasses.speak(msg().speakPermission(p.toolName));
      const title = this.sessions.find((x) => x.id === sessionId)?.title;
      this.log(`${sessionId === this.activeId ? '' : `[${title ?? msg().session}] `}${msg().logPermission(p.toolName)}`, 'warn');
    }
    await this.render();
  }

  /** 다른 곳(웹)에서 답했거나 여기서 답한 요청이 끝났다. 다음 요청이 있으면 띄운다. */
  private async permissionResolved(requestId: string): Promise<void> {
    if (this.pending?.id !== requestId) return;
    this.pending = null;
    this.permError = '';
    await this.render();
    void this.refresh();
  }

  /**
   * 서버가 들고 있는 대기 요청과 맞춘다. 세션 목록을 읽을 때마다 부른다.
   * 웹에서 답한 요청은 내리고, 실시간 연결이 끊겨 놓친 요청은 다시 띄운다. 바뀌었으면 true.
   */
  private async syncPending(): Promise<boolean> {
    const p = this.pending;
    if (p) {
      if (this.deciding) return false;
      const s = this.sessions.find((x) => x.id === p.sessionId);
      if (s?.live && (s.pending ?? []).some((q) => q.id === p.id)) return false;
      this.pending = null;
      this.permError = '';
    }
    // 보고 있는 세션의 요청을 먼저.
    const live = this.sessions.filter((s) => s.live && (s.pending?.length ?? 0) > 0);
    const next = live.find((s) => s.id === this.activeId) ?? live[0];
    const q = next?.pending?.[0];
    if (next && q) {
      await this.askPermission(next.id, { id: q.id, toolName: q.toolName, summary: q.summary ?? '' });
      return true;
    }
    return p !== null;
  }

  // --- 입력 ---

  /**
   * 목록 커서를 옮긴다. 옮겼으면 true.
   *
   * 리스트 스크롤은 기기마다 다르게 온다. 펌웨어가 직접 처리하고 선택 위치만
   * 알려주기도 하고(selectedIndex), 위/아래 제스처만 오기도 한다. 양쪽을
   * 한자리에서 처리해 화면마다 같은 코드를 반복하지 않는다.
   */
  private moveCursor(
    gesture: string,
    selectedIndex: number | undefined,
    field:
      | 'cursor'
      | 'menuCursor'
      | 'setCursor'
      | 'menuEditCursor'
      | 'menuItemCursor'
      | 'notifCursor'
      | 'histCursor'
      | 'checkCursor'
      | 'cmdCursor'
      | 'slashCursor'
      | 'phoneCursor'
      | 'homeMenuCursor'
      | 'macCursor'
      | 'macShortcutCursor'
      | 'macPresentFileCursor'
      | 'macReplyCursor',
    count: number,
  ): boolean {
    const last = Math.max(count - 1, 0);
    if (selectedIndex !== undefined) {
      this[field] = Math.min(Math.max(selectedIndex, 0), last);
      // 선택 위치만 온 것은 이동이 아니다. 탭 처리로 넘긴다.
      return false;
    }
    if (gesture === 'down') {
      this[field] = Math.min(this[field] + 1, last);
      return true;
    }
    if (gesture === 'up') {
      this[field] = Math.max(this[field] - 1, 0);
      return true;
    }
    return false;
  }

  /** 홈으로 올라간다. 요약을 최신으로 맞춘다. */
  private async goHome(): Promise<void> {
    this.detailStop?.();
    this.detailStop = undefined;
    this.stopMacStream();
    this.setSpinning(false);
    this.screen = 'home';
    this.activeId = '';
    await this.render();
    // 요약 숫자는 서버에서 온다. 실패해도 화면은 이미 떠 있다.
    await this.refreshSummary();
  }

  /**
   * 홈 화면을 최신으로 맞춘다.
   *
   * 폰이 로그인을 마친 뒤 부른다. start()는 인증 전에 돌기 때문에
   * 그때 읽은 값은 비어 있다.
   */
  async refreshHome(): Promise<void> {
    this.loggedIn = true;
    await this.refreshSummary();
  }

  /**
   * 접속을 마쳤을 때 안경을 홈으로 깨운다.
   *
   * 서버 상태 문구는 안경에 두지 않는다. 상단 요약(세션·알림·체크)이
   * 같은 내용을 더 짧게 보여주고, 자세한 건 폰 로그에 남는다.
   */
  async showMotd(): Promise<void> {
    this.screen = 'home';
    this.wake();
    await this.refreshSummary();
  }

  /**
   * 새로 들어온 알림을 안경에 띄운다.
   *
   * 웹이나 다른 기기에서 만든 알림은 안경이 만든 것이 아니라서, 여태
   * 홈 요약의 숫자만 조용히 늘고 화면에는 아무것도 뜨지 않았다.
   * 알림이 왔다는 걸 알려면 사용자가 홈을 들여다봐야 했다.
   *
   * 목록 맨 앞이 지난번과 다르면 새 알림으로 본다. 서버가 최신을
   * 앞에 놓아주므로 이 비교로 충분하다.
   */
  private noticeForNewNotifications(items: Notification[]): void {
    const newest = items[0];
    if (!newest) {
      // 비어 있다(다 지웠거나 처음부터 없다). null이 아닌 빈 값으로 둬야
      // 다음에 오는 알림을 첫 조회가 아니라 새 알림으로 본다.
      //
      // 처음 조회에서 비어 있어도 그렇다. 예전에는 null로 남겨 두어, 알림이
      // 하나도 없던 상태(폰만으로 막 쓰기 시작할 때)의 첫 알림이 팝업으로 뜨지 않았다.
      this.lastSeenNotifId = '';
      return;
    }

    // 첫 조회다. 쌓여 있던 것을 새 알림으로 쏟아내지 않는다.
    if (this.lastSeenNotifId === null) {
      this.lastSeenNotifId = newest.id;
      return;
    }

    if (newest.id === this.lastSeenNotifId) return;
    this.lastSeenNotifId = newest.id;

    // 이미 읽은 알림이 앞에 올 수도 있다(지우기 등으로 순서가 바뀔 때).
    // 그때는 띄우지 않는다.
    if (newest.readAt) return;

    // 권한 요청은 덮지 않는다. 사용자가 답해야 작업이 진행되므로,
    // 알림으로 가리면 승인이 막힌다.
    if (this.pending) return;

    // 앞선 알림 팝업은 덮는다.
    //
    // 예전에는 팝업이 떠 있으면 건너뛰었다. 그런데 팝업은 탭할 때까지
    // 남아 있어서, 한 번 뜨면 그 뒤의 알림이 전부 막혔다. 첫 알림만
    // 계속 보이는 증상이 이것이었다. 최신이 더 중요하므로 새로 덮고,
    // 지나간 것은 알림 목록에 남는다.

    // 알림 화면을 보고 있으면 목록으로 이미 보인다.
    if (this.screen === 'notifications') return;

    // 발표·자막 중에는 팝업으로 덮지 않는다. 노트와 자막이 가려지고, 팝업이 떠 있는
    // 동안은 위·아래(쪽 넘기기)도 먹힌다. 알림 목록에는 남는다.
    if (this.screen === 'mac-present' || this.screen === 'mac-captions' || this.screen === 'mac-prompter') return;

    // 할 일 화면에서 할 일이 바뀐 알림은 띄우지 않는다. 서버가 할 일
    // 변경마다 알림을 남기는데, 안경에서 체크하면 방금 한 일이 팝업으로
    // 떠서 체크한 목록을 덮었다. 목록에 이미 보이는 변화다.
    if (this.screen === 'checklist' && isTodoNoticeTitle(newest.title)) return;

    this.wake();
    this.glasses.speak(newest.title);
    this.showNotice({
      title: newest.title,
      // 본문이 없으면 비워 둔다. 제목을 넣으면 같은 글이 두 줄로 겹친다 —
      // 웹에서 제목만 적어 보낼 때가 그렇다.
      text: newest.body.trim() === newest.title.trim() ? '' : newest.body,
      label: this.labelFor(newest),
      kind: newest.kind,
    });
  }

  /**
   * 맥의 지금 상태를 다시 읽는다.
   *
   * 둘을 나란히 부른다. 하나가 느려도 다른 하나는 보여줄 수 있다.
   * terminal-agent가 꺼져 있으면 둘 다 실패하는데, 그때는 화면에
   * 무엇이 없는지 적어 준다 — 빈 목록만 두면 고장으로 보인다.
   */
  private async refreshSystem(): Promise<void> {
    const [sys, procs] = await Promise.allSettled([
      agentCli.sysSummary(),
      agentCli.sysProcs(8),
    ]);

    if (sys.status === 'fulfilled') {
      this.sys = sys.value;
      this.sysReadAt = new Date();
      this.sysError = undefined;
    } else {
      this.sysError = msg().sysReadFailed;
      this.log(msg().loadSysFailed(String(sys.reason)), 'warn');
    }
    this.procs = procs.status === 'fulfilled' ? procs.value : [];

    // 화면을 옮겼으면 그리지 않는다. 늦게 온 응답이 다른 화면을 덮으면
    // 사용자가 보고 있던 것이 사라진다.
    if (this.screen === 'system') await this.render();
  }

  /**
   * 등록한 명령을 실행하고 결과 화면으로 넘어간다.
   *
   * 되돌릴 수 없어 보이는 명령은 서버가 막는다. 그때는 무엇 때문에
   * 막혔는지 보여주고, 한 번 더 탭하면 실행한다. 안경은 탭 한 번에
   * 일이 벌어지므로 손이 스쳐도 되돌릴 수 없는 일은 하지 않게 한다.
   */
  private async runSnippet(s: Snippet, confirm = false): Promise<void> {
    this.wake();
    this.screen = 'command-result';
    const m = msg();
    this.cmdResult = { label: s.label, text: m.running, snippetId: s.id, command: s.command, state: 'running' };
    await this.render();

    try {
      const res = await agentCli.runSnippet(s.id, confirm);

      if (res.needsConfirm) {
        const why = (res.risks ?? []).map((r) => `· ${r.reason}`).join('\n');
        this.cmdResult = {
          label: s.label,
          text: `${why || `${m.irreversible}.`}\n\n${m.runAnywayQ}`,
          awaitingConfirm: true,
          snippetId: s.id,
          command: s.command,
          state: 'confirm',
          lines: (res.risks ?? []).map((r) => r.reason),
        };
        this.glasses.speak(m.needsConfirm);
        await this.render();
        return;
      }

      const r = res.result;
      const head = r?.timedOut ? `(${m.timedOut}) ` : r?.exitCode ? `(${m.exitCode(r.exitCode)}) ` : '';
      this.cmdResult = {
        label: s.label,
        text: head + (r?.output?.trim() || m.noOutput),
        snippetId: s.id,
        command: s.command,
        state: 'done',
        // 끝의 빈 줄은 버린다. 출력은 대개 줄바꿈으로 끝나 빈 줄 하나가 자리를 먹는다.
        lines: (r?.output ?? '').replace(/\s+$/, '').split('\n').filter((l, i, a) => l || i < a.length - 1),
        exitCode: r?.exitCode,
        tookMs: r?.tookMs,
        timedOut: r?.timedOut,
      };
      this.log(m.logExit(s.label, r?.exitCode ?? '?', r?.tookMs ?? 0), 'ok');
    } catch (err) {
      this.cmdResult = {
        label: s.label,
        text: m.failedWith((err as Error).message),
        snippetId: s.id,
        command: s.command,
        state: 'failed',
        lines: [(err as Error).message],
      };
      this.log(m.logRunFailed(s.label, (err as Error).message), 'error');
    }
    await this.render();
  }

  /** 홈 상단 요약에 쓰는 값을 모은다. */
  private async refreshSummary(): Promise<void> {
    // 401을 받은 뒤로는 다시 로그인할 때까지 서버를 두드리지 않는다.
    // agentCli.canPoll 참고.
    if (!agentCli.canPoll) return;
    try {
      const { items, unread } = await agentCli.listNotifications();
      this.notifications = items;
      this.unread = unread;
      this.noticeForNewNotifications(items);
    } catch {
      // 알림을 못 읽어도 나머지는 보여준다.
    }
    try {
      this.checklist = await agentCli.getGlobalChecklist();
    } catch {
      // 체크리스트도 마찬가지다.
    }
    // 홈의 '컴퓨터'를 보일지. 서버 쪽에 붙은 맥·PC가 있는지 본다(폰 직접 연결은 폰 상태가 알려 준다).
    try {
      this.extLinked = (await agentCli.listExt()).length > 0;
    } catch {
      this.extLinked = false;
    }
    this.clampMenuCursor();
    try {
      await this.refresh();
    } catch {
      // agent-cli가 꺼져 있으면 세션은 0으로 남는다.
    }
    // 홈 게이지용. terminal-agent가 없으면 게이지 없이 그린다.
    if (this.glasses.showHome) {
      try {
        this.sys = await agentCli.sysSummary();
        this.sysReadAt = new Date();
      } catch {
        // 시스템 상태는 꾸밈이다. 못 읽어도 홈은 그린다.
      }
    }
    await this.render();
  }

  /** 홈 메뉴에서 한 단계 내려간다. */
  private async openMenu(target?: Screen): Promise<void> {
    if (!target) return;
    if (target === 'sessions') {
      this.screen = 'sessions';
      this.cursor = 0;
      await this.render();
      try {
        await this.refresh();
      } catch (err) {
        this.log(msg().loadSessionsFailed((err as Error).message), 'warn');
      }
      return;
    }
    if (target === 'notifications') {
      this.screen = 'notifications';
      this.notifCursor = 0;
      await this.render();
      try {
        const { items, unread } = await agentCli.listNotifications();
        this.notifications = items;
        this.unread = unread;
      } catch (err) {
        this.log(msg().loadNotificationsFailed((err as Error).message), 'warn');
      }
      await this.render();
      return;
    }
    if (target === 'checklist') {
      await this.openChecklist(true);
      return;
    }
    if (target === 'system') {
      this.screen = 'system';
      // 먼저 '읽는 중…'을 띄운다. 명령이 도는 동안 빈 화면이면
      // 눌리지 않은 것처럼 보인다.
      await this.render();
      await this.refreshSystem();
      return;
    }
    if (target === 'commands') {
      this.screen = 'commands';
      this.cmdCursor = 0;
      await this.render();
      try {
        this.snippets = await agentCli.listSnippets();
      } catch (err) {
        this.log(msg().loadCommandsFailed((err as Error).message), 'warn');
      }
      await this.render();
      return;
    }
    if (target === 'phone') {
      this.screen = 'phone';
      this.phoneCursor = 0;
      await this.refreshPhone();
      await this.render();
      return;
    }
    if (target === 'settings') {
      this.screen = 'settings';
      this.setCursor = 0;
      await this.render();
      return;
    }
    if (target === 'mac') {
      this.screen = 'mac';
      this.macCursor = 0;
      this.macCaps = undefined;
      await this.render();
      await this.refreshMacCaps();
    }
  }

  // --- 맥(mac-agent) ---

  /** 맥이 붙어 있는지와 기능 목록을 읽는다. 권한을 켜고 돌아왔을 수 있어 들어올 때마다 읽는다. */
  private async refreshMacCaps(): Promise<void> {
    try {
      const agents = await agentCli.listExt();
      // 고른 적 있는 쪽이 붙어 있으면 그쪽, 아니면 맥 → PC 순서로 처음 붙은 것.
      const desk =
        agents.find((a) => a.agent === agentCli.desktopAgent) ??
        DESKTOP_AGENTS.map((name) => agents.find((a) => a.agent === name)).find(Boolean);
      if (desk) agentCli.desktopAgent = desk.agent as DesktopAgentName;
      this.macCaps = desk?.capabilities ?? null;
    } catch (err) {
      this.macCaps = null;
      this.log(errorText(err), 'warn');
    }
    if (this.screen === 'mac') await this.render();
  }

  private stopMacStream(): void {
    this.macStop?.();
    this.macStop = undefined;
    clearInterval(this.macPoll);
    this.macPoll = undefined;
    clearInterval(this.macTick);
    this.macTick = undefined;
  }

  /** SSE가 막히면 이걸로 대신 읽는다. 한 번만 건다. */
  private pollMac(load: () => Promise<void>): void {
    if (this.macPoll) return;
    this.macPoll = setInterval(() => void load(), 2000);
    (this.macPoll as { unref?: () => void }).unref?.();
  }

  /** 맥 메뉴로 돌아온다. 발표 화면에서 나오면 꺼짐 타이머를 다시 건다. */
  private async backToMac(): Promise<void> {
    this.stopMacStream();
    this.macError = undefined;
    this.screen = 'mac';
    this.armIdle();
    await this.render();
    await this.refreshMacCaps();
  }

  private async openMacItem(item: MacItem): Promise<void> {
    const cap = this.macCaps?.find((c) => c.id === item.capability);
    if (!cap?.ready) {
      // 못 쓰는 까닭과 고칠 곳을 보여 준다. 고치는 일은 맥에서 한다.
      this.macResult = { name: msg()[item.label], state: 'failed', output: `${reasonText(cap?.reason)}\n${msg().macFixOnMac}` };
      this.macResultBack = 'mac';
      this.screen = 'mac-result';
      await this.render();
      return;
    }
    this.macError = undefined;
    if (item.screen === 'mac-present') return this.openPresent();
    if (item.screen === 'mac-captions') return this.openCaptions();
    if (item.screen === 'mac-meeting') return this.openMeeting();
    if (item.screen === 'mac-prompter') return this.openPrompter();
    if (item.screen === 'mac-present-files') return this.openPresentFiles();
    return this.openMacShortcuts();
  }

  /**
   * 발표 리모컨. 열린 문서가 없고 맥에 발표 자료 폴더가 있으면 자료 목록으로 넘어간다.
   * 자료를 골라 연 뒤에 부를 때는 목록으로 돌려보내지 않는다(autoFiles=false).
   */
  private async openPresent(autoFiles = true): Promise<void> {
    this.screen = 'mac-present';
    this.macPresent = undefined;
    this.presentCursor = 0;
    this.presentStopArmed = false;
    this.armIdle(); // 발표 화면에서는 타이머를 걷는다.
    await this.render();
    const load = async (): Promise<void> => {
      try {
        this.setPresent(await agentCli.mac<PresentState>('/present/state'));
        this.macError = undefined;
      } catch (err) {
        this.macError = errorText(err);
      }
      if (this.screen === 'mac-present') await this.render();
    };
    await load();
    // load()가 채운 값이다. 위에서 undefined로 비운 것으로 좁혀지지 않게 다시 읽는다.
    // 상태를 못 읽었어도(권한·오류) 자료 목록은 볼 수 있게 넘어간다.
    const status = (this.macPresent as PresentState | undefined)?.status;
    const noDocument = status === undefined || status === 'none' || status === 'no_document';
    if (autoFiles && noDocument && this.presentFilesReady()) return this.openPresentFiles();
    this.macStop = agentCli.streamMac(
      '/present/stream',
      ['state', 'error'],
      (type, data) => {
        if (type === 'state') {
          this.setPresent(data as PresentState);
          this.macError = undefined;
        } else {
          this.macError = errorText((data as { error?: unknown }).error);
        }
        void this.render();
      },
      () => this.pollMac(load),
    );
    // 경과 분을 고쳐 그린다. 분 단위라 자주 그릴 필요는 없다.
    this.macTick = setInterval(() => {
      if (this.macPresent?.status === 'playing') void this.render();
    }, 15_000);
    (this.macTick as { unref?: () => void }).unref?.();
  }

  /** 맥에 발표 자료 폴더 기능이 있는지. */
  private presentFilesReady(): boolean {
    return Boolean(this.macCaps?.some((c) => c.id === 'present-files' && c.ready));
  }

  /** 지금 상태에서 쓸 발표 단추. 단추가 없으면 예전처럼 탭은 시작, 위아래는 쪽이다. */
  private presentActions(): readonly PresentAction[] {
    if (this.macPresent?.status === 'playing') return PRESENT_ACTIONS;
    if (this.macPresent?.status === 'ready' && this.presentFilesReady()) return READY_ACTIONS;
    return [];
  }

  /**
   * 발표 상태를 바꾼다. 발표 중↔발표 전으로 바뀌면 단추 자리를 처음으로(발표 중 '다음', 발표 전 '시작'),
   * 발표가 끝났으면 끄기 확인도 거둔다.
   */
  private setPresent(state: PresentState): void {
    const before = this.macPresent?.status === 'playing';
    this.macPresent = state;
    const playing = state.status === 'playing';
    if (before !== playing) this.presentCursor = playing ? 1 : 0;
    if (!playing) this.presentStopArmed = false;
  }

  private async presentCommand(command: 'next' | 'prev' | 'start' | 'stop'): Promise<void> {
    try {
      this.setPresent(await agentCli.mac<PresentState>(`/present/${command}`, {}));
      this.macError = undefined;
    } catch (err) {
      this.macError = errorText(err);
    }
    await this.render();
  }

  private async openCaptions(): Promise<void> {
    this.screen = 'mac-captions';
    this.macCaptionLines = [];
    this.macPartial = undefined;
    this.macCaptionsState = undefined;
    await this.render();
    const load = async (): Promise<void> => {
      try {
        this.macCaptionsState = await agentCli.mac<CaptionsState>('/captions/state');
        const { lines } = await agentCli.mac<{ lines: CaptionLine[] }>('/captions/transcript');
        this.macCaptionLines = lines.slice(-6);
        this.macError = undefined;
      } catch (err) {
        this.macError = errorText(err);
      }
      if (this.screen === 'mac-captions') await this.render();
    };
    await load();
    this.macStop = agentCli.streamMac(
      '/captions/stream',
      ['caption', 'state', 'error'],
      (type, data) => this.onCaption(type, data),
      () => this.pollMac(load),
    );
  }

  /** 자막 이벤트. 같은 id가 말하는 동안 고쳐지다가 final로 굳는다. */
  private onCaption(type: string, data: unknown): void {
    if (type === 'state') {
      this.macCaptionsState = data as CaptionsState;
    } else if (type === 'caption') {
      const line = data as CaptionLine;
      if (!line.final) {
        this.macPartial = line;
      } else {
        if (this.macPartial?.id === line.id) this.macPartial = undefined;
        // 빈 채로 굳은 줄은 지우라는 뜻이다.
        const rest = this.macCaptionLines.filter((l) => l.id !== line.id);
        this.macCaptionLines = line.text ? [...rest, line].slice(-6) : rest;
      }
      // 말이 들리면 화면을 켠다. 조용하면 평소처럼 꺼진다.
      this.wake();
    } else {
      this.macError = errorText((data as { error?: unknown }).error);
    }
    void this.render();
  }

  private async toggleCaptions(): Promise<void> {
    const running = this.macCaptionsState?.running ?? false;
    try {
      this.macCaptionsState = await agentCli.mac<CaptionsState>(running ? '/captions/stop' : '/captions/start', {});
      if (!running) {
        this.macCaptionLines = [];
        this.macPartial = undefined;
      }
      this.macError = undefined;
    } catch (err) {
      this.macError = errorText(err);
    }
    await this.render();
  }

  private async openPrompter(): Promise<void> {
    this.screen = 'mac-prompter';
    this.macPrompter = undefined;
    this.armIdle(); // 원고 화면에서는 타이머를 걷는다.
    await this.render();
    const load = async (): Promise<void> => {
      try {
        this.macPrompter = await agentCli.mac<PrompterState>('/prompter/state');
        this.macError = undefined;
      } catch (err) {
        this.macError = errorText(err);
      }
      if (this.screen === 'mac-prompter') await this.render();
    };
    await load();
    this.macStop = agentCli.streamMac(
      '/prompter/stream',
      ['state', 'error'],
      (type, data) => {
        if (type === 'state') this.macPrompter = data as PrompterState;
        else this.macError = errorText((data as { error?: unknown }).error);
        void this.render();
      },
      () => this.pollMac(load),
    );
  }

  /** 원고가 없으면 맥 클립보드에서 불러오고, 있으면 말 따라가기를 켜고 끈다. */
  private async prompterCommand(path: string, body: unknown = {}): Promise<void> {
    try {
      this.macPrompter = await agentCli.mac<PrompterState>(path, body);
      this.macError = undefined;
    } catch (err) {
      this.macError = errorText(err);
    }
    await this.render();
  }

  /** 메시지 답장을 맥에서 보낸다. 결과를 보이고 알림 목록으로 돌아간다. */
  private async sendReply(to: string, text: string): Promise<void> {
    this.macResult = { name: msg().replyTo(to), state: 'running' };
    this.macResultBack = 'notifications';
    this.screen = 'mac-result';
    await this.render();
    try {
      await agentCli.mac('/messages/reply', { to, text });
      this.macResult = { name: msg().replyTo(to), state: 'done', output: text };
    } catch (err) {
      this.macResult = { name: msg().replyTo(to), state: 'failed', output: errorText(err) };
    }
    await this.render();
  }

  private async openMeeting(): Promise<void> {
    this.screen = 'mac-meeting';
    this.macEvent = undefined;
    await this.render();
    await this.loadMeeting();
  }

  private async loadMeeting(): Promise<void> {
    try {
      const { event } = await agentCli.mac<{ event: MacEvent | null }>('/calendar/next');
      this.macEvent = event ?? null;
      this.macError = undefined;
    } catch (err) {
      this.macError = errorText(err);
    }
    await this.render();
  }

  private async openPresentFiles(): Promise<void> {
    this.stopMacStream();
    this.screen = 'mac-present-files';
    this.armIdle();
    this.macPresentFileCursor = 0;
    this.macPresentFiles = undefined;
    this.macError = undefined;
    await this.render();
    try {
      const r = await agentCli.mac<{ folder?: string; files: PresentFile[] }>('/present/files');
      this.macPresentFiles = r.files.slice(0, LIST_MAX);
      this.macPresentFolder = r.folder ?? '';
    } catch (err) {
      this.macPresentFiles = [];
      this.macError = errorText(err);
    }
    if (this.screen === 'mac-present-files') await this.render();
  }

  /**
   * 고른 자료를 맥에서 열고 발표 리모컨으로 간다. 발표 시작은 리모컨에서 탭으로 한다.
   * 발표 앱이 아닌 문서(Pages·PDF)는 맥이 열기만 하고 status:"opened"로 답한다. 그때는 문서 화면으로 가서
   * 위아래로 그 문서를 스크롤한다.
   */
  private async openPresentFile(file: PresentFile): Promise<void> {
    const name = file.name.normalize('NFC');
    await this.glasses.showText(msg().presentOpening(name));
    let reply: { status?: string; app?: string };
    try {
      // 앱을 띄우고 문서를 여는 데 몇 초 걸린다. 맥은 문서가 잡힐 때까지(최대 15초) 기다렸다 답한다.
      reply = await agentCli.mac<{ status?: string; app?: string }>('/present/open', { name: file.name }, 30_000);
    } catch (err) {
      this.macError = errorText(err);
      await this.render();
      return;
    }
    this.macError = undefined;
    if (reply.status === 'opened') {
      this.macDocument = { name, app: reply.app ?? file.app ?? 'pages' };
      this.screen = 'mac-document';
      await this.render();
      return;
    }
    await this.openPresent(false);
  }

  /** 연 문서를 스크롤한다. page면 거의 한 화면. */
  private async scrollDocument(direction: 'up' | 'down', page = false): Promise<void> {
    try {
      await agentCli.mac('/present/scroll', { direction, page });
      if (this.macError) {
        this.macError = undefined;
        await this.render();
      }
    } catch (err) {
      this.macError = errorText(err);
      await this.render();
    }
  }

  private async openMacShortcuts(): Promise<void> {
    this.screen = 'mac-shortcuts';
    this.macShortcutCursor = 0;
    this.macShortcuts = undefined;
    await this.render();
    try {
      const r = await agentCli.mac<{ shortcuts: MacShortcut[]; reason?: string }>('/shortcuts');
      this.macShortcuts = r.shortcuts.slice(0, LIST_MAX);
      this.macError = r.reason ? reasonText(r.reason) : undefined;
    } catch (err) {
      this.macShortcuts = [];
      this.macError = errorText(err);
    }
    await this.render();
  }

  private async runMacShortcut(s: MacShortcut): Promise<void> {
    this.macResult = { name: s.name, state: 'running' };
    this.macResultBack = 'mac-shortcuts';
    this.screen = 'mac-result';
    await this.render();
    try {
      const r = await agentCli.mac<{ status: string; output?: string }>('/shortcuts/run', { id: s.id }, 35_000);
      this.macResult = { name: s.name, state: r.status === 'done' ? 'done' : 'still', output: r.output };
    } catch (err) {
      this.macResult = { name: s.name, state: 'failed', output: errorText(err) };
    }
    this.wake();
    await this.render();
  }

  /** 세션 하나의 대화 기록을 연다. */
  private async openHistory(id: string): Promise<void> {
    this.activeId = id;
    this.screen = 'history';
    this.histCursor = 0;
    this.history = [];
    await this.render();
    try {
      this.history = await agentCli.getHistory(id, 40);
    } catch (err) {
      this.log(msg().loadHistoryFailed((err as Error).message), 'warn');
    }
    await this.render();
  }

  /** 알림 하나를 펼치고 읽음으로 표시한다. */
  private async openNotification(n: Notification): Promise<void> {
    this.openNotif = n;
    this.screen = 'notification';
    await this.render();
    if (n.readAt) return;
    try {
      this.unread = await agentCli.readNotification(n.id);
      n.readAt = new Date().toISOString();
    } catch {
      // 읽음 표시 실패는 화면을 막지 않는다.
    }
  }

  private async readAllNotifications(): Promise<void> {
    try {
      await agentCli.readAllNotifications();
      const now = new Date().toISOString();
      for (const n of this.notifications) n.readAt ??= now;
      this.unread = 0;
      this.log(msg().markedAllRead, 'ok');
    } catch (err) {
      this.log(msg().markReadFailed((err as Error).message), 'error');
    }
    await this.render();
  }

  private async handleGesture({ gesture, selectedIndex }: GestureEvent): Promise<void> {
    // 조작이 있으면 무조건 깨운다.
    const wasOff = this.screenOff;
    this.wake();
    // 꺼져 있었으면 이번 입력은 켜는 용도로만 쓴다.
    // 안 보이는 화면의 항목이 눌리면 곤란하다.
    if (wasOff) {
      await this.render();
      return;
    }

    if (selectedIndex !== undefined && this.screen === 'sessions') {
      this.cursor = Math.min(Math.max(selectedIndex, 0), Math.max(this.shownSessions().length - 1, 0));
      this.hooks.onSessionsChanged?.(this.sessions, this.cursor);
    }

    // 완료 알림은 어떤 탭이든 확인으로 받는다.
    if (this.notice) {
      if (gesture === 'tap' || gesture === 'doubleTap') {
        this.dismissNotice();
        await this.render();
      }
      return;
    }

    if (this.pending) {
      // 화면을 새로 그리면 펌웨어가 선택 이벤트를 한 번 흘린다.
      // 그걸 사용자의 탭으로 오인해 즉시 승인하는 사고를 막는다.
      if (Date.now() - this.permShownAt < PERMISSION_GUARD_MS) return;

      const picked = selectedIndex ?? this.permCursor;
      if (gesture === 'up') {
        this.permCursor = Math.max(this.permCursor - 1, 0);
        await this.render();
        return;
      }
      if (gesture === 'down') {
        this.permCursor = Math.min(this.permCursor + 1, PERMISSION_CHOICES.length - 1);
        await this.render();
        return;
      }
      if (gesture === 'tap') {
        const choice = PERMISSION_CHOICES[picked];
        if (choice) await this.decidePermission(choice);
        return;
      }
      // 더블탭은 거부. 빠져나갈 길을 하나 더 둔다.
      if (gesture === 'doubleTap') await this.decidePermission(PERMISSION_CHOICES[0]);
      return;
    }

    // 홈: 메뉴 네 개.
    if (this.screen === 'home') {
      const items = this.homeMenu();
      if (this.moveCursor(gesture, selectedIndex, 'menuCursor', items.length)) {
        await this.render();
        return;
      }
      // 최상위라 더블탭으로 갈 곳이 없다. 기기에 종료 확인 창이 있으면 그것을 띄우고(나갈지는 사용자가
      // 그 창에서 정한다), 없으면 화면 끄기·종료·취소를 고른다.
      if (gesture === 'doubleTap') {
        if (this.glasses.requestExit) {
          await this.glasses.requestExit();
          return;
        }
        this.screen = 'home-menu';
        this.homeMenuCursor = 0;
        await this.render();
        return;
      }
      if (gesture === 'tap') await this.openMenu(items[this.menuCursor]);
      return;
    }

    if (this.screen === 'sessions') {
      if (gesture === 'doubleTap') return this.goHome();
      if (this.moveCursor(gesture, selectedIndex, 'cursor', this.shownSessions().length)) {
        this.hooks.onSessionsChanged?.(this.sessions, this.cursor);
        await this.render();
        return;
      }
      if (gesture === 'tap') {
        const target = this.shownSessions()[this.cursor];
        if (target) await this.openHistory(target.id);
      }
      return;
    }

    // 대화 목록: 주고받은 말을 훑고, 맨 아래로 실제 대화 화면에 들어간다.
    if (this.screen === 'history') {
      if (gesture === 'doubleTap') {
        this.screen = 'sessions';
        await this.render();
        return;
      }
      const items = this.shownHistory();
      // 맨 끝의 '대화 이어서 보기' 한 칸을 더 센다.
      if (this.moveCursor(gesture, selectedIndex, 'histCursor', items.length + 1)) {
        await this.render();
        return;
      }
      if (gesture === 'tap') {
        const picked = items[this.histCursor];
        if (picked) {
          // 한 줄로 잘린 말의 전문을 보여준다. 알림 화면을 그대로 쓴다.
          this.openNotif = {
            id: '',
            title: picked.kind === 'me' ? msg().myMessage : msg().aiReply,
            body: picked.full,
            kind: 'info',
            createdAt: '',
          };
          this.screen = 'notification';
        } else {
          // 마지막 칸: 진행 상황이 보이는 대화 화면으로.
          const s = this.sessions.find((x) => x.id === this.activeId);
          if (s) await (s.live ? this.open(s.id) : this.resume(s.id));
        }
        await this.render();
      }
      return;
    }

    // 알림 목록.
    if (this.screen === 'notifications') {
      if (gesture === 'doubleTap') return this.goHome();
      const count = this.shownNotifications().length;
      if (this.moveCursor(gesture, selectedIndex, 'notifCursor', count + (count > 0 ? 1 : 0))) {
        await this.render();
        return;
      }
      if (gesture === 'tap') {
        const n = this.shownNotifications()[this.notifCursor];
        if (n) await this.openNotification(n);
        else if (count > 0) await this.readAllNotifications();
      }
      return;
    }

    // 알림 하나를 펼친 화면.
    if (this.screen === 'notification') {
      const sender = messageSender(this.openNotif?.title);
      if (gesture === 'tap' && sender) {
        this.macReplyTo = sender;
        this.macReplyCursor = 0;
        this.screen = 'mac-reply';
        await this.render();
        return;
      }
      if (gesture === 'doubleTap' || gesture === 'tap') {
        // 대화 전문에서 왔으면 대화 목록으로, 알림에서 왔으면 알림 목록으로.
        this.screen = this.openNotif?.id ? 'notifications' : 'history';
        this.openNotif = null;
        await this.render();
      }
      return;
    }

    /*
     * 시스템: 탭으로 다시 읽고 더블탭으로 나간다.
     *
     * 스스로 갱신하지 않는다. top처럼 계속 새로 그리면 BLE로 화면을
     * 매번 보내 배터리를 먹고, 숫자가 쉬지 않고 흔들려 읽기 어렵다.
     * 지금 값을 보고 싶을 때 탭하면 된다.
     */
    if (this.screen === 'system') {
      if (gesture === 'doubleTap') return this.goHome();
      if (gesture === 'tap') await this.refreshSystem();
      return;
    }

    // 명령 목록: 골라서 탭하면 실행한다.
    if (this.screen === 'commands') {
      if (gesture === 'doubleTap') return this.goHome();
      if (this.moveCursor(gesture, selectedIndex, 'cmdCursor', this.shownSnippets().length)) {
        await this.render();
        return;
      }
      if (gesture === 'tap') {
        const s = this.shownSnippets()[this.cmdCursor];
        if (s) await this.runSnippet(s);
      }
      return;
    }

    // 실행 결과: 확인을 기다리는 중이면 탭이 실행이다.
    if (this.screen === 'command-result') {
      if (gesture === 'doubleTap') {
        this.cmdResult = undefined;
        this.screen = 'commands';
        await this.render();
        // 방금 돌린 결과가 오른쪽 카드(마지막 실행)에 보이도록 다시 읽는다.
        try {
          this.snippets = await agentCli.listSnippets();
          if (this.screen === 'commands') await this.render();
        } catch {
          // 못 읽어도 목록은 그대로 쓸 수 있다.
        }
        return;
      }
      if (gesture === 'tap' && this.cmdResult?.awaitingConfirm) {
        const s = this.snippets.find((x) => x.id === this.cmdResult?.snippetId);
        if (s) await this.runSnippet(s, true);
      }
      return;
    }

    // 홈 더블탭 선택지: 화면 꺼짐 · 종료하기 · 취소. 더블탭은 취소다.
    if (this.screen === 'home-menu') {
      if (gesture === 'doubleTap') return this.goHome();
      if (this.moveCursor(gesture, selectedIndex, 'homeMenuCursor', HOME_MENU.length)) {
        await this.render();
        return;
      }
      if (gesture !== 'tap') return;
      const choice = HOME_MENU[this.homeMenuCursor];
      if (choice === 'screenOff') {
        // 다시 켜면 홈이 보이게 먼저 홈으로 돌린다. 켜는 것은 여느 때처럼 아무 조작 한 번이다.
        this.screen = 'home';
        return this.sleep();
      }
      if (choice === 'exit') {
        // 이미 여기서 한 번 골랐으니 시스템 확인 창 없이 바로 나간다.
        // 타이머·구독을 풀고 화면 컨테이너를 닫는다(disconnect).
        this.log(msg().exiting, 'ok');
        await this.stop();
        return;
      }
      return this.goHome();
    }

    // 타이머·물: 누르면 폰에 조작을 보낸다.
    if (this.screen === 'phone') {
      if (gesture === 'doubleTap') return this.goHome();
      const actions = this.phone ? phoneActions(this.phone) : [];
      if (this.moveCursor(gesture, selectedIndex, 'phoneCursor', actions.length)) {
        await this.render();
        return;
      }
      if (gesture === 'tap') {
        const action = actions[this.phoneCursor];
        if (action) await this.runPhoneAction(action);
      }
      return;
    }

    // 맥 메뉴: 발표·자막·다음 회의·단축어.
    if (this.screen === 'mac') {
      if (gesture === 'doubleTap') return this.goHome();
      if (!this.macCaps) return;
      if (this.moveCursor(gesture, selectedIndex, 'macCursor', MAC_ITEMS.length)) {
        await this.render();
        return;
      }
      if (gesture === 'tap') {
        const item = MAC_ITEMS[this.macCursor];
        if (item) await this.openMacItem(item);
      }
      return;
    }

    // 발표: 아래 단추 줄(발표 중 이전·다음·끄기, 발표 전 시작·자료)을 위아래로 고르고 탭으로 실행한다.
    // 고른 자리가 남아 '다음'에 두면 탭만으로 계속 넘긴다. 끄기는 한 번 더 탭해야 실행한다.
    // 단추가 없으면(발표 자료 기능이 없는 맥·PC의 발표 전) 탭은 시작, 위아래는 이전·다음 쪽이다.
    if (this.screen === 'mac-present') {
      const actions = this.presentActions();
      if (gesture === 'doubleTap') {
        if (this.presentStopArmed) {
          this.presentStopArmed = false;
          return this.render();
        }
        return this.backToMac();
      }
      if (actions.length === 0) {
        if (gesture === 'up') return this.presentCommand('prev');
        if (gesture === 'down') return this.presentCommand('next');
        if (gesture === 'tap') return this.presentCommand('start');
        return;
      }
      if (gesture === 'up' || gesture === 'down') {
        const step = gesture === 'up' ? -1 : 1;
        this.presentCursor = Math.min(Math.max(this.presentCursor + step, 0), actions.length - 1);
        this.presentStopArmed = false;
        return this.render();
      }
      if (gesture === 'tap') {
        const action = actions[Math.min(this.presentCursor, actions.length - 1)];
        if (action === 'files') return this.openPresentFiles();
        if (action !== 'stop') return this.presentCommand(action);
        if (!this.presentStopArmed) {
          this.presentStopArmed = true;
          return this.render();
        }
        this.presentStopArmed = false;
        return this.presentCommand('stop');
      }
      return;
    }

    // 자막: 탭으로 켜고 끈다.
    if (this.screen === 'mac-captions') {
      if (gesture === 'doubleTap') return this.backToMac();
      if (gesture === 'tap') return this.toggleCaptions();
      return;
    }

    // 텔레프롬프터: 탭은 불러오기(원고 없을 때)·말 따라가기·시간대로 흘리기, 위·아래는 이전·다음 화면(옛 맥은 줄).
    // 쪽이 나뉜 원고에서 다음 쪽 원고로 넘어가면 맥이 발표 슬라이드도 넘긴다.
    if (this.screen === 'mac-prompter') {
      const paged = (this.macPrompter?.pages ?? 0) > 0;
      if (gesture === 'doubleTap') return this.backToMac();
      if (gesture === 'up') return paged ? this.prompterCommand('/prompter/page', { delta: -1 }) : this.prompterCommand('/prompter/prev');
      if (gesture === 'down') return paged ? this.prompterCommand('/prompter/page', { delta: 1 }) : this.prompterCommand('/prompter/next');
      if (gesture === 'tap') {
        if (!this.macPrompter?.hasScript) return this.prompterCommand('/prompter/load-clipboard');
        if (this.macPrompter.mode === 'timeline') return this.prompterCommand('/prompter/play', { on: !this.macPrompter.playing });
        // PC(win-agent)는 말 따라가기(받아쓰기)가 아직 없다. 탭은 다음 화면으로.
        if (agentCli.desktopAgent === 'win-agent') {
          return paged ? this.prompterCommand('/prompter/page', { delta: 1 }) : this.prompterCommand('/prompter/next');
        }
        return this.prompterCommand('/prompter/follow', { on: !this.macPrompter.following });
      }
      return;
    }

    // 다음 회의: 탭하면 다시 읽는다.
    if (this.screen === 'mac-meeting') {
      if (gesture === 'doubleTap') return this.backToMac();
      if (gesture === 'tap') return this.loadMeeting();
      return;
    }

    // 단축어: 탭하면 맥에서 돌린다.
    if (this.screen === 'mac-shortcuts') {
      if (gesture === 'doubleTap') return this.backToMac();
      const list = this.macShortcuts ?? [];
      if (this.moveCursor(gesture, selectedIndex, 'macShortcutCursor', list.length)) {
        await this.render();
        return;
      }
      if (gesture === 'tap') {
        const s = list[this.macShortcutCursor];
        if (s) await this.runMacShortcut(s);
      }
      return;
    }

    // 발표 자료: 탭하면 맥에서 열고 발표 리모컨으로 간다.
    if (this.screen === 'mac-present-files') {
      if (gesture === 'doubleTap') return this.backToMac();
      const files = this.macPresentFiles ?? [];
      if (this.moveCursor(gesture, selectedIndex, 'macPresentFileCursor', files.length)) {
        await this.render();
        return;
      }
      if (gesture === 'tap') {
        const file = files[this.macPresentFileCursor];
        if (file) await this.openPresentFile(file);
      }
      return;
    }

    // 문서(Pages·PDF): 위아래는 스크롤, 탭은 한 화면 아래로, 두 번 탭은 목록으로.
    if (this.screen === 'mac-document') {
      if (gesture === 'doubleTap') {
        this.macError = undefined;
        this.screen = 'mac-present-files';
        return this.render();
      }
      if (gesture === 'up' || gesture === 'down') return this.scrollDocument(gesture);
      if (gesture === 'tap') return this.scrollDocument('down', true);
      return;
    }

    // 답장 고르기: 탭하면 맥에서 보낸다. 마지막 줄은 취소.
    if (this.screen === 'mac-reply') {
      const replies = quickReplies();
      if (gesture === 'doubleTap') {
        this.screen = 'notification';
        await this.render();
        return;
      }
      if (this.moveCursor(gesture, selectedIndex, 'macReplyCursor', replies.length + 1)) {
        await this.render();
        return;
      }
      if (gesture !== 'tap') return;
      const text = replies[this.macReplyCursor];
      if (!text) {
        this.screen = 'notification';
        await this.render();
        return;
      }
      return this.sendReply(this.macReplyTo ?? '', text);
    }

    // 결과: 아무 탭이나 돌아간다. 도는 중에는 기다린다.
    if (this.screen === 'mac-result') {
      if (this.macResult?.state === 'running') return;
      if (gesture !== 'tap' && gesture !== 'doubleTap') return;
      if (this.macResultBack === 'mac-shortcuts' || this.macResultBack === 'notifications') {
        this.screen = this.macResultBack;
        if (this.screen === 'notifications') this.openNotif = null;
        await this.render();
        return;
      }
      return this.backToMac();
    }

    // 설정: 음성 토글 + 로고 토글 + 화면 꺼짐 시간 세 칸.
    if (this.screen === 'settings') {
      if (gesture === 'doubleTap') return this.goHome();
      if (this.moveCursor(gesture, selectedIndex, 'setCursor', 3 + IDLE_CHOICES.length)) {
        await this.render();
        return;
      }
      if (gesture === 'tap') {
        if (this.setCursor === 2 + IDLE_CHOICES.length) {
          this.screen = 'menu-edit';
          this.menuEditCursor = 0;
          await this.render();
          return;
        }
        if (this.setCursor === 0) {
          await this.toggleVoice();
        } else if (this.setCursor === 1) {
          await this.toggleLogo();
        } else {
          const ms = IDLE_CHOICES[this.setCursor - 2];
          if (ms) {
            this.idleMs = ms;
            await this.saveSetting(STORE_IDLE, String(ms));
            this.log(msg().idleSet(ms / 1000), 'ok');
            // 새 시간으로 다시 세도록 타이머를 갱신한다.
            this.wake();
          }
        }
        await this.render();
      }
      return;
    }

    // 메뉴 편집: 항목을 고르면 그 항목의 조작으로, 마지막 줄은 기본값으로.
    if (this.screen === 'menu-edit') {
      if (gesture === 'doubleTap') {
        this.screen = 'settings';
        return this.render();
      }
      const count = this.menuConfig.order.length + 1;
      if (this.moveCursor(gesture, selectedIndex, 'menuEditCursor', count)) {
        await this.render();
        return;
      }
      if (gesture === 'tap') {
        const id = this.menuConfig.order[this.menuEditCursor];
        if (!id) {
          await this.saveMenu(null);
          this.log(msg().menuReset, 'ok');
          return this.render();
        }
        this.menuEditing = id;
        this.menuItemCursor = 0;
        this.screen = 'menu-item';
        await this.render();
      }
      return;
    }

    // 항목 하나: 위로·아래로는 그 자리에 남아 거듭 누를 수 있다.
    if (this.screen === 'menu-item') {
      const id = this.menuEditing;
      const back = async (): Promise<void> => {
        this.screen = 'menu-edit';
        this.menuEditCursor = id ? this.menuConfig.order.indexOf(id) : 0;
        await this.render();
      };
      if (!id || gesture === 'doubleTap') return back();
      if (this.moveCursor(gesture, selectedIndex, 'menuItemCursor', 4)) {
        await this.render();
        return;
      }
      if (gesture !== 'tap') return;
      if (this.menuItemCursor === 3) return back();
      const next =
        this.menuItemCursor === 0 ? toggleMenu(this.menuConfig, id) : moveMenu(this.menuConfig, id, this.menuItemCursor === 1 ? -1 : 1);
      if (!sameMenu(next, this.menuConfig)) await this.saveMenu(next);
      await this.render();
      return;
    }

    // 체크리스트 화면.
    if (this.screen === 'checklist') {
      if (gesture === 'doubleTap') {
        // 전역 목록은 홈 메뉴에서 열었으므로 홈으로 올라간다.
        if (this.checkGlobal) return this.goHome();
        this.screen = 'detail';
        await this.render();
        return;
      }
      // 리스트가 인덱스를 주면 그 항목이 선택된 것이다.
      // 커서만 옮기고 끝내면 탭해도 체크가 되지 않는다.
      const picked = selectedIndex ?? this.checkCursor;
      if (selectedIndex !== undefined) this.checkCursor = selectedIndex;
      else if (gesture === 'down') this.checkCursor += 1;
      else if (gesture === 'up') this.checkCursor = Math.max(this.checkCursor - 1, 0);

      if (gesture === 'tap') {
        this.checkCursor = picked;
        // 목록 끝 한 칸은 '완료 항목 치우기'다.
        if (this.checklist.length > 0 && picked >= this.shownChecklist().length) {
          this.checklist = this.checkGlobal
            ? await agentCli.clearDoneGlobalChecklist()
            : await agentCli.clearDoneChecklist(this.activeId);
          this.checkCursor = 0;
          this.log(msg().clearedDone, 'ok');
        } else {
          const item = this.checklist[this.checkCursor];
          if (item) {
            try {
              this.checklist = this.checkGlobal
                ? await agentCli.toggleGlobalChecklist(item.id)
                : await agentCli.toggleChecklist(this.activeId, item.id);
              this.log(`${item.done ? msg().todoUnchecked : msg().todoChecked}: ${item.text}`, 'ok');
            } catch (err) {
              this.log(msg().checkFailed((err as Error).message), 'error');
            }
          }
        }
      }
      await this.render();
      return;
    }

    // 결과 읽기: 위·아래로 쪽을 넘긴다. 마지막 쪽에서 탭하면 대화 화면으로.
    if (this.screen === 'reader') {
      const r = this.reader;
      if (!r || gesture === 'doubleTap') {
        this.reader = null;
        this.screen = 'detail';
        await this.render();
        return;
      }
      if (gesture === 'up') {
        if (r.page > 0) r.page -= 1;
      } else if (gesture === 'down' || gesture === 'tap') {
        if (r.page < r.pages.length - 1) r.page += 1;
        else if (gesture === 'tap') {
          this.reader = null;
          this.screen = 'detail';
        }
      }
      await this.render();
      return;
    }

    // Claude 명령: 골라 탭하면 그 세션에 보낸다. 맨 끝 칸은 할 일 목록.
    if (this.screen === 'slash') {
      if (gesture === 'doubleTap') {
        this.slashConfirm = '';
        this.screen = 'detail';
        await this.render();
        return;
      }
      const items = this.shownSlash();
      const before = this.slashCursor;
      if (this.moveCursor(gesture, selectedIndex, 'slashCursor', items.length + 1)) {
        this.slashConfirm = '';
        await this.render();
        return;
      }
      if (this.slashCursor !== before) this.slashConfirm = '';
      if (gesture !== 'tap') return;
      const picked = items[this.slashCursor];
      if (!picked) return this.openChecklist();
      if (picked.confirm && this.slashConfirm !== picked.name) {
        this.slashConfirm = picked.name;
        await this.render();
        return;
      }
      this.slashConfirm = '';
      try {
        await this.send(`/${picked.name}`);
        this.log(msg().slashSent(picked.name), 'ok');
      } catch (err) {
        this.log(msg().slashFailed((err as Error).message), 'error');
        this.screen = 'detail';
        await this.render();
      }
      return;
    }

    // 상세(대화) 화면. 한 단계 위는 대화 목록이다.
    if (gesture === 'doubleTap') {
      await this.backToHistory();
      return;
    }

    // 위·아래는 마지막 답을 끝까지 읽는다. 대화 화면은 첫 줄만 보인다.
    if (gesture === 'up' || gesture === 'down') {
      await this.openReader();
      return;
    }

    if (gesture === 'tap') {
      const s = this.sessions.find((x) => x.id === this.activeId);
      // 종료된 세션은 이어가기, 살아있으면 Claude 명령(맨 끝에 할 일)으로 간다.
      if (s && !s.live) {
        await this.resume(s.id);
      } else {
        this.slashCursor = 0;
        this.slashConfirm = '';
        this.screen = 'slash';
        await this.render();
      }
    }
  }

  /** 대화 화면에서 그 세션의 대화 목록으로 올라간다. */
  private async backToHistory(): Promise<void> {
    this.detailStop?.();
    this.detailStop = undefined;
    this.setSpinning(false);

    // 세션이 없어졌으면 목록까지 올라간다.
    if (!this.activeId || !this.sessions.some((s) => s.id === this.activeId)) {
      return this.goHome();
    }
    await this.openHistory(this.activeId);
  }

  /** 할 일 목록 화면으로 간다. */
  async openChecklist(global = false): Promise<void> {
    this.checkGlobal = global;
    try {
      this.checklist = global
        ? await agentCli.getGlobalChecklist()
        : await agentCli.getChecklist(this.activeId);
    } catch (err) {
      this.log(msg().loadTodosFailed((err as Error).message), 'error');
      this.checklist = [];
    }
    this.checkCursor = 0;
    this.screen = 'checklist';
    await this.render();
  }

  /** 폰에서 할 일을 추가한다. 여러 줄이면 줄마다 항목이 된다. */
  async addChecklist(text: string): Promise<void> {
    // 세션을 보고 있지 않으면 전역 목록에 넣는다.
    this.checklist = this.activeId
      ? await agentCli.addChecklist(this.activeId, text)
      : await agentCli.addGlobalChecklist(text);
    this.wake();
    await this.render();
  }

  get items(): ChecklistItem[] {
    return this.checklist;
  }

  // --- 동작 ---

  /**
   * 고른 답을 보낸다. 서버가 받은 뒤에만 화면에서 내린다 — 먼저 내리면 보내기가 실패했을 때
   * 서버는 계속 기다리는데 안경에서는 요청이 사라져 다시 답할 길이 없었다.
   */
  private async decidePermission(choice: (typeof PERMISSION_CHOICES)[number]): Promise<void> {
    const p = this.pending;
    if (!p || this.deciding) return;
    this.deciding = true;
    try {
      await agentCli.resolvePermission(p.sessionId, p.id, choice.behavior);
      this.log(msg().logPermissionDecided(msg()[choice.label], p.toolName), choice.behavior === 'allow' ? 'ok' : 'warn');
      if (this.pending?.id === p.id) this.pending = null;
      this.permError = '';
      this.permCursor = 0;
      if (choice.always) {
        try {
          await agentCli.setPolicy(p.sessionId, 'auto-approve');
          this.log(msg().autoApproved, 'warn');
        } catch (err) {
          this.log(msg().permFailed((err as Error).message), 'error');
        }
      }
    } catch (err) {
      if (err instanceof AgentCliError && err.code === 'permission_not_found') {
        // 웹에서 먼저 답했거나 세션이 다시 떴다. 이 요청은 끝났다.
        if (this.pending?.id === p.id) this.pending = null;
        this.permError = '';
      } else {
        // 요청은 그대로 두고 오류를 권한 화면에 띄운다. 다시 고르면 된다.
        this.permError = (err as Error).message;
      }
      this.log(msg().permFailed((err as Error).message), 'error');
    } finally {
      this.deciding = false;
    }
    await this.render();
    // 같은 세션에 다음 요청이 기다리고 있을 수 있다.
    void this.refresh();
  }

  async toggleVoice(): Promise<void> {
    const next = !this.glasses.isVoiceEnabled;
    this.glasses.setVoiceEnabled(next);
    this.log(msg().voiceLog(next), 'ok');
    await this.saveSetting(STORE_VOICE, next ? '1' : '0');
    if (next) this.glasses.speak(msg().speakVoiceOn);
    await this.render();
  }

  /**
   * 홈 옆의 DEV 로고를 켜고 끈다.
   *
   * 끄면 목록이 화면 폭을 다 쓴다. 세션 제목이 길 때 쓸모가 있다.
   */
  async toggleLogo(): Promise<void> {
    this.showLogo = !this.showLogo;
    this.log(msg().logoLog(this.showLogo), 'ok');
    await this.saveSetting(STORE_LOGO, this.showLogo ? '1' : '0');
    await this.render();
  }

  async open(id: string): Promise<void> {
    this.detailStop?.();
    this.activeId = id;
    this.screen = 'detail';
    this.lines = [];
    this.feed = [];
    this.status = '';
    this.doneIds.delete(id);
    this.notice = null;

    const s = this.sessions.find((x) => x.id === id);
    this.lastReply = '';
    try {
      for (const e of await agentCli.getHistory(id, 40)) {
        this.collectReply(e);
        const line = this.toLine(e);
        if (line) this.lines.push(line);
        const fed = this.toFeed(e);
        if (fed) this.feed.push(fed);
      }
    } catch (err) {
      this.log(msg().historyLoadFailed((err as Error).message), 'error');
    }

    if (s?.live) {
      let poll: ReturnType<typeof setInterval> | undefined;
      const stopStream = agentCli.streamSession(id, (e) => void this.handleEvent(e), (m) => {
        this.log(m, 'error');
        // 실시간 연결이 막힌 웹뷰다. 진행·권한을 주기적으로 읽어 메운다.
        if (poll) return;
        poll = setInterval(() => void this.pollDetail(id), DETAIL_POLL_MS);
        (poll as { unref?: () => void }).unref?.();
      });
      this.detailStop = () => {
        stopStream();
        clearInterval(poll);
      };
    }
    await this.render();
  }

  /**
   * 실시간 연결 없이 대화 화면을 맞춘다. 기록을 다시 읽고, 세션 상태와 권한 요청은
   * 세션 목록에서 가져온다(refresh → syncPending).
   */
  private async pollDetail(id: string): Promise<void> {
    if (this.stopped || this.screen !== 'detail' || this.activeId !== id) return;
    try {
      const events = await agentCli.getHistory(id, 40);
      if (this.screen !== 'detail' || this.activeId !== id) return;
      const lines: typeof this.lines = [];
      const feed: typeof this.feed = [];
      for (const e of events) {
        const line = this.toLine(e);
        if (line) lines.push(line);
        const fed = this.toFeed(e);
        if (fed) feed.push(fed);
      }
      this.lines = lines;
      this.feed = feed;
      await this.refresh();
      const s = this.sessions.find((x) => x.id === id);
      if (s?.status === 'busy' || s?.status === 'waiting') this.status = s.status;
      else if (this.status === 'busy' || this.status === 'waiting') this.status = 'done';
      this.setSpinning(this.status === 'busy');
      await this.render();
    } catch {
      // 다음 주기에 다시 읽는다.
    }
  }

  async resume(id: string, deleteOriginal = false): Promise<void> {
    // render()를 거치지 않고 직접 그린다. 그러면 화면은 켜지는데
    // 무조작 타이머는 걸리지 않아, 그대로 켜진 채 남는다.
    this.wake();
    try {
      await this.glasses.showText(msg().resuming);
      const { session, deletedOriginal } = await agentCli.resumeSession(id, deleteOriginal);
      this.log(deletedOriginal ? msg().resumedDeleted : msg().resumed, 'ok');
      this.sessions = await agentCli.listSessions();
      await this.open(session.id);
    } catch (err) {
      const why = err instanceof Error ? err.message : msg().resumeFailed;
      this.log(why, 'error');
      this.wake();
      await this.glasses.showText(`${msg().resumeFailed}\n\n${clamp(why, 200)}`);
    }
  }

  /**
   * 폰 UI의 '뒤로'. 홈으로 올라간다.
   *
   * 화면이 여러 단계로 깊어졌으므로 한 단계씩 올리는 대신 최상위로 보낸다.
   * 폰에서는 안경 화면이 어디까지 들어가 있는지 보이지 않기 때문이다.
   */
  async backToList(): Promise<void> {
    await this.goHome();
  }

  /** 폰 UI에서 프롬프트를 보낼 때. 안경도 그 세션 화면으로 따라간다. */
  async send(prompt: string): Promise<void> {
    // 조용히 버리면 보낸 줄 안다. 폰 화면이 까닭을 띄우게 던진다.
    if (!this.activeId) throw new Error(msg().sendNoSession);
    await agentCli.sendInput(this.activeId, prompt);
    this.status = 'busy';
    // 폰에서 보냈어도 진행 상황은 안경에서 본다.
    this.wake();
    if (this.screen !== 'detail') {
      this.screen = 'detail';
      this.notice = null;
      this.doneIds.delete(this.activeId);
    }
    this.activity = '';
    this.setSpinning(true);
    await this.render();
  }

  get currentSessionId(): string {
    return this.activeId;
  }

  get isDetail(): boolean {
    return this.screen === 'detail';
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.detailStop?.();
    this.stopMacStream();
    this.eventStop?.();
    this.lifecycleStop?.();
    clearInterval(this.pollTimer);
    this.phoneStopped = true;
    clearInterval(this.phoneTimer);
    for (const stop of this.watchers.values()) stop();
    this.watchers.clear();
    this.setSpinning(false);
    await this.glasses.disconnect();
  }
}
