/**
 * 안경 UI 본체.
 *
 * 서버의 세션 상태를 안경 화면으로 옮기고, 안경 제스처를 서버 명령으로 옮긴다.
 * 기기에 대해서는 GlassesAdapter 인터페이스만 알고 있어, 안경 종류가 늘어나도
 * 이 파일은 그대로 둔다.
 */

import {
  agentCli,
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
  | 'notifications'
  | 'notification'
  | 'checklist'
  | 'system'
  | 'commands'
  | 'command-result'
  | 'settings';

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

export function timeAgo(iso: string | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return '';
  const min = Math.floor((now - t) / 60_000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간`;
  const day = Math.floor(hour / 24);
  return day === 1 ? '어제' : `${day}일`;
}

const MENU = [
  { label: '에이전트', screen: 'sessions' as const },
  { label: '알림 보기', screen: 'notifications' as const },
  { label: '체크 보기', screen: 'checklist' as const },
  { label: '시스템', screen: 'system' as const },
  { label: '명령', screen: 'commands' as const },
  { label: '설정', screen: 'settings' as const },
];

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

  lines.push('', `${Math.round(ms / 1000)}초 후 닫힘 · 탭: 닫기`);
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
  if (!sys) {
    return { header: '시스템 · 더블탭 뒤로', items: ['읽는 중…'] };
  }

  // 못 구한 값은 칸을 비운다. -1이나 0을 그대로 보여주면 오해한다.
  const cpu = sys.cpuPercent >= 0 ? `CPU ${Math.round(sys.cpuPercent)}%` : 'CPU —';
  const mem =
    sys.memTotalGB > 0
      ? `MEM ${sys.memUsedGB.toFixed(1)}/${Math.round(sys.memTotalGB)}G`
      : 'MEM —';
  const load = sys.load.length > 0 ? `로드 ${sys.load[0].toFixed(1)}` : '';

  const items = [[cpu, mem].join('  '), [load, sys.uptime ? `가동 ${sys.uptime}` : '']
    .filter(Boolean)
    .join(' · ')].filter(Boolean);

  if (procs.length === 0) {
    items.push('', '프로세스를 읽지 못했습니다');
    return { header: '시스템 · 더블탭 뒤로', items };
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

  return { header: `${sys.host || '시스템'} · 더블탭 뒤로`, items };
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
  if (!r) return '결과가 없습니다\n\n더블탭: 뒤로';

  /*
   * 줄을 아낀다.
   *
   * 화면은 288px, 한 줄 27px이라 열 줄이 전부다. 머리말과 이름 사이에
   * 빈 줄까지 넣으면 본문에 두세 줄밖에 남지 않아 결과를 못 읽는다.
   * 머리말에 갈래를, 이름에 무엇을 돌렸는지 담아 두 줄로 끝낸다.
   */
  const lines = [
    `${r.awaitingConfirm ? '! 확인 필요' : '* 실행 결과'} · ${clampWidth(r.label, 24)}`,
    '',
  ];

  // 줄마다 폭에 맞춰 자른다. 원래 줄바꿈은 살린다 — 표 꼴로 나오는
  // 출력(ps·df)은 줄이 곧 뜻이라 이어 붙이면 읽을 수 없다.
  const body = r.text.split('\n').slice(0, RESULT_ROWS);
  for (const line of body) {
    lines.push(clampWidth(line.replace(/\t/g, ' '), RESULT_COLS));
  }
  if (r.text.split('\n').length > RESULT_ROWS) {
    lines.push('…(폰에서 전문 보기)');
  }

  lines.push('', r.awaitingConfirm ? '탭: 실행 · 더블탭: 취소' : '더블탭: 뒤로');
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
  { label: '거부', behavior: 'deny' as const, always: false },
  { label: '허용 (이번만)', behavior: 'allow' as const, always: false },
  { label: '허용 (이 세션 계속)', behavior: 'allow' as const, always: true },
];

const STORE_VOICE = 'voice.enabled';
const STORE_IDLE = 'screen.idleMs';
const STORE_LOGO = 'home.logo';

export interface GlassesUIHooks {
  /** 화면 밖으로 알릴 일. 폰 UI가 로그로 보여준다. */
  onLog?: (text: string, level?: 'info' | 'ok' | 'warn' | 'error') => void;
  /** 세션 목록이 바뀌었을 때. 폰 UI 미러링에 쓴다. */
  onSessionsChanged?: (sessions: SessionInfo[], cursor: number) => void;
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
  private pending: { id: string; toolName: string; summary: string } | null = null;
  private permCursor = 0;
  private permShownAt = 0;
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
  /**
   * 마지막 실행 결과. 결과 화면에서 보여준다.
   *
   * 확인이 필요해 막힌 경우도 여기 담는다 — 무엇 때문에 막혔는지
   * 보여주고 한 번 더 탭하면 실행한다.
   */
  private cmdResult?: {
    label: string;
    text: string;
    /** 참이면 아직 실행하지 않았고, 탭하면 실행한다. */
    awaitingConfirm?: boolean;
    snippetId?: string;
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
    agentCli.onConnectionChange(() => this.watchServerData());
    // 쓰는 중에 토큰이 폐기되거나 만료되면 안경에도 알린다. 로그인 전의
    // 401(아직 토큰이 없음)에는 이미 '폰에서 인증' 안내가 떠 있다.
    agentCli.onUnauthorized(() => {
      if (!this.loggedIn) return;
      this.loggedIn = false;
      void this.glasses.showText('로그인이 풀렸습니다.\n\n폰에서 다시 로그인해 주세요.').catch(() => undefined);
    });
    this.watchServerData();

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
        this.log(`조작 처리 오류: ${err.message}`, 'error');
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

    // 켜진 채로 두지 않도록 처음부터 무조작 타이머를 돌린다.
    this.wake();

    // 인증 전에는 아무것도 못 읽는다. 홈에 0만 뜨면 고장처럼 보이므로
    // 접속을 확인하고 나서 요약을 채운다.
    try {
      await agentCli.listNotifications();
    } catch {
      await this.glasses.showText('연결 중…\n\n폰에서 인증을 마쳐 주세요.');
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
    const before = this.sessions.map((s) => s.id).join(',');
    this.sessions = await agentCli.listSessions();
    const after = this.sessions.map((s) => s.id).join(',');

    // 세션이 줄었으면 커서를 목록 안으로 되돌린다.
    if (this.cursor > this.sessions.length - 1) {
      this.cursor = Math.max(this.sessions.length - 1, 0);
    }
    this.watchLive();
    this.hooks.onSessionsChanged?.(this.sessions, this.cursor);

    // 목록이 그대로면 다시 그리지 않는다.
    // 주기적 갱신마다 리스트를 재생성하면 커서가 튀어 조작이 끊긴다.
    if (before === after && this.screen === 'sessions' && !this.notice && !this.pending) return;
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
    return (
      {
        busy: '작업 중',
        waiting: '승인 대기',
        idle: '대기',
        starting: '준비 중',
        closed: '종료됨',
      }[raw] ?? raw
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
      notifications: this.unread > 0 ? `${this.unread} new` : '',
      checklist: this.checklist.length > 0 ? `${done} / ${this.checklist.length}` : '',
      commands: this.snippets.length > 0 ? String(this.snippets.length) : '',
    };

    const status = [
      busy > 0 ? `작업 ${busy}` : '',
      this.sseDown ? '○ offline' : '● online',
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
      items: MENU.map((m) => ({ label: m.label, meta: meta[m.screen] ?? '' })),
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
    const rows = this.sessions.map((s) => ({
      state: this.statusOf(s),
      title: s.title || '새 대화',
      meta: timeAgo(s.lastActivityAt),
    }));
    const count = (...states: string[]) => rows.filter((r) => states.includes(r.state)).length;
    const busy = count('running');
    const approvals = count('pending', 'waiting');

    return {
      title: '$ relay ~/agents',
      status: [busy > 0 ? `작업 ${busy}` : '', approvals > 0 ? `◆ 승인 ${approvals}` : '', clock()]
        .filter(Boolean)
        .join('   '),
      rows,
      counts: [
        { state: 'running', label: '작업 중', count: busy },
        { state: 'pending', label: '승인 요청', count: approvals },
        { state: 'idle', label: '대기', count: count('idle', 'done') },
        { state: 'offline', label: '종료', count: count('offline') },
      ],
      hint: '● 열기    ●● 뒤로',
      total: `세션 ${rows.length}개`,
    };
  }

  /**
   * 알림 목록에 그릴 것.
   *
   * 목록 끝의 '모두 읽음 처리' 줄은 예전과 같은 자리(마지막)에 둔다.
   * 탭 처리가 그 자리를 동작으로 읽는다.
   */
  private notificationsView(): NotificationsView {
    const rows = this.notifications.map((n) => ({
      kind: n.kind,
      read: Boolean(n.readAt),
      title: n.title,
      meta: timeAgo(n.createdAt),
    }));
    const unreadOf = (k: NoticeKind) => rows.filter((r) => r.kind === k && !r.read).length;
    return {
      title: '$ relay ~/inbox',
      status: [this.unread > 0 ? `● 새 ${this.unread}` : '', clock()].filter(Boolean).join('   '),
      rows,
      counts: [
        { kind: 'error', label: '오류', count: unreadOf('error') },
        { kind: 'permission', label: '권한', count: unreadOf('permission') },
        { kind: 'done', label: '완료', count: unreadOf('done') },
        { kind: 'info', label: '정보', count: unreadOf('info') },
      ],
      unread: this.unread,
      action: rows.length > 0 ? '모두 읽음 처리' : undefined,
      hint: '● 열기    ●● 뒤로',
      legend: '채움 = 안 읽음',
    };
  }

  /**
   * 알림 하나의 내용. 대화 기록의 전문을 볼 때도 이 화면을 쓴다(id가 빈 알림).
   */
  private notificationView(n: Notification | null): NotificationView {
    const kind: NoticeKind = n?.kind ?? 'info';
    const ago = n?.createdAt ? timeAgo(n.createdAt) : '';
    return {
      title: n?.id ? '$ relay ~/inbox' : '$ relay ~/history',
      status: [ago ? (ago === '방금' ? ago : `${ago} 전`) : '', clock()].filter(Boolean).join('   '),
      kind,
      label: { done: '완료', error: '오류', permission: '권한', info: '정보' }[kind],
      heading: n?.title ?? '알림',
      body: n?.body?.trim() || '(내용 없음)',
      hint: '● 닫기    ●● 뒤로',
    };
  }

  /**
   * 할 일 화면에 그릴 것. 목록 끝의 '완료 항목 치우기' 줄은 예전과 같은
   * 자리(마지막)에 둔다. 탭 처리가 그 자리를 동작으로 읽는다.
   */
  private checklistView(): ChecklistView {
    const done = this.checklist.filter((i) => i.done).length;
    const s = this.sessions.find((x) => x.id === this.activeId);
    return {
      title: this.checkGlobal ? '$ ~/todo' : `$ ~/${s?.title || '새 대화'}/todo`,
      status: [`${done} / ${this.checklist.length}`, clock()].join('   '),
      items: this.checklist.map((i) => ({ done: i.done, text: i.text })),
      action: this.checklist.length > 0 ? '완료 항목 치우기' : undefined,
      progress: { done, total: this.checklist.length },
      hint: '● 체크    ●● 뒤로',
      note: '폰·웹에서 추가',
    };
  }

  /** 시스템 화면에 그릴 것. 못 구한 값(-1·0)은 null로 바꿔 넘긴다. */
  private systemScreenView(): SystemView {
    const sys = this.sys;
    const at = this.sysReadAt;
    // 탭해서 다시 읽어도 같은 분이면 달라진 게 없어 보인다. 초까지 적는다.
    const read = at ? `읽음 ${clock(at)}:${String(at.getSeconds()).padStart(2, '0')}` : '';
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
      notice: sys ? undefined : this.sysError ?? '읽는 중…',
      hint: '● 새로 읽기    ●● 뒤로',
      note: (sys?.host ?? '').replace(/\.local$/, ''),
    };
  }

  /** 세션 상태를 사람 말로. 상태 표시줄과 카드에 쓴다. */
  private sessionStateLabel(s: SessionInfo | undefined): string {
    if (s && !s.live) return '종료됨';
    if (this.pending) return '승인 대기';
    return this.statusText(this.status || s?.status || 'idle');
  }

  /** 대화 목록에 그릴 것. 오른쪽 카드는 세션 정보라 고른 줄과 상관없다. */
  private historyView(s: SessionInfo | undefined): HistoryView {
    const ago = s?.lastActivityAt ? timeAgo(s.lastActivityAt) : '';
    return {
      title: `$ ~/${s?.title || '새 대화'}`,
      status: clock(),
      rows: this.historyItems().map((h) => ({
        kind: h.kind,
        text: h.full.replace(/\n/g, ' ').trim() || '(내용 없음)',
      })),
      action: '대화 이어서 보기',
      info: {
        state: s ? this.statusOf(s) : 'idle',
        label: this.sessionStateLabel(s),
        rows: [
          { label: '턴', value: String(s?.turns ?? 0) },
          { label: '비용', value: `$${(s?.totalCostUsd ?? 0).toFixed(2)}` },
          { label: '폴더', value: s?.cwd ? (s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? '') : '' },
          { label: '활동', value: ago ? (ago === '방금' ? ago : `${ago} 전`) : '' },
        ],
      },
      hint: '● 전문 보기    ●● 뒤로',
    };
  }

  /** 진행 중 대화에 그릴 것. 하는 일이 바뀌거나 도는 기호가 돌 때 글자만 고친다. */
  private liveView(s: SessionInfo | undefined): LiveView {
    const closed = Boolean(s && !s.live);
    const busy = !closed && this.status === 'busy';
    const secs = this.activityAt ? Math.max(0, Math.floor((Date.now() - this.activityAt) / 1000)) : 0;
    return {
      title: `$ ~/${s?.title || '새 대화'}`,
      status: [this.sessionStateLabel(s), clock()].join('   '),
      lines: this.feed.slice(-6),
      activity: busy
        ? {
            text: [this.activity || '작업 중', this.activityDetail].filter(Boolean).join('  '),
            elapsed: this.activityAt ? (secs < 60 ? `${secs}초` : `${Math.floor(secs / 60)}분`) : '',
            tick: this.tick,
          }
        : undefined,
      idle: closed ? '종료됨  ·  탭하면 이어가기' : `${this.sessionStateLabel(s)}  ·  탭하면 할 일`,
      hint: closed ? '● 이어가기    ●● 뒤로' : '● 할 일    ●● 뒤로',
      meta: s ? `턴 ${s.turns}  ·  $${s.totalCostUsd.toFixed(2)}` : '',
    };
  }

  /** 권한 요청에 그릴 것. 선택지 순서는 PERMISSION_CHOICES와 같다(거부가 맨 앞). */
  private permissionView(p: { toolName: string; summary: string }): PermissionView {
    const s = this.sessions.find((x) => x.id === this.activeId);
    return {
      title: `$ ~/${s?.title || '새 대화'}`,
      status: ['◆ 권한 요청', clock()].join('   '),
      tool: p.toolName,
      summary: p.summary.replace(/\n/g, ' ').trim(),
      choices: PERMISSION_CHOICES.map((c) => ({
        kind: c.behavior === 'deny' ? 'deny' : c.always ? 'always' : 'once',
        label: c.label,
      })),
      hint: '더블탭 = 거부',
    };
  }

  private summary(): string {
    const busy = this.sessions.filter((s) => s.live && s.status === 'busy').length;
    const done = this.checklist.filter((i) => i.done).length;
    return [
      `세션 ${busy}/${this.sessions.length}`,
      `알림 ${this.unread}`,
      `체크 ${done}/${this.checklist.length}`,
    ].join(' · ');
  }

  /**
   * 대화 기록에서 목록에 보여줄 항목만 고른다.
   *
   * 상세 화면과 같은 변환(toLine)을 쓴다. 도구 호출·오류까지 전부 넣으면
   * 목록이 길어져 정작 주고받은 말을 찾기 어려우므로 여기서는 빼고,
   * 고르면 그 전문을 보여준다.
   */
  private historyItems(): { line: string; full: string; kind: 'me' | 'ai' }[] {
    const out: { line: string; full: string; kind: 'me' | 'ai' }[] = [];
    for (const e of this.history) {
      if (e.type !== 'user' && e.type !== 'assistant') continue;
      const full = String(e.text ?? '');
      const who = e.type === 'user' ? '나' : 'AI';
      out.push({
        line: `${who}> ${clamp(full.replace(/\n/g, ' ').trim() || '(내용 없음)', 34)}`,
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
      this.log(`화면 복구 실패: ${(err as Error).message}`, 'warn');
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
    if (n.kind === 'permission') return '* 권한';
    if (n.kind === 'error') return '* 오류';

    /*
     * 에이전트 일인지는 세션이 붙어 있는지로 본다.
     *
     * kind만 보면 안 된다. 외부 훅도 done을 보낼 수 있어서, 남의
     * 서비스가 보낸 성공 알림이 에이전트 작업으로 보였다.
     */
    if (n.sessionId) return '* 에이전트';

    // 서버가 할 일 변경에 붙이는 제목이다.
    if (n.title.startsWith('할 일') || n.title.startsWith('완료한 할 일')) return '* 할 일';
    return '* 알림';
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
    if (this.screenOff) return;
    try {
      // 1) 권한 요청이 최우선. 사용자가 답해야 작업이 진행된다.
      if (this.pending) {
        const p = this.pending;
        this.permShownAt = Date.now();
        if (this.glasses.showPermission) {
          await this.glasses.showPermission(this.permissionView(p));
          return;
        }
        await this.glasses.showList(`권한: ${clamp(p.toolName, 30)}`, [
          ...PERMISSION_CHOICES.map((c) => c.label),
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
            closeHint: `${Math.round(this.noticeMs / 1000)}초 후 닫힘  ·  탭: 닫기`,
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
          MENU.map((m) => m.label),
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
        const items: Item[] = this.sessions.map((s) => ({
          text: s.title || '새 대화',
          state: this.statusOf(s),
        }));
        if (items.length === 0) items.push({ text: '(연결된 세션이 없습니다)' });
        const busy = this.sessions.filter((s) => s.live && s.status === 'busy').length;
        const parts = [`세션 ${this.sessions.length}`];
        if (busy > 0) parts.push(`작업중 ${busy}`);
        await this.glasses.showList(`${parts.join(' · ')} · 더블탭 뒤로`, items);
        return;
      }

      // 5) 한 세션의 대화 기록.
      if (this.screen === 'history') {
        const s = this.sessions.find((x) => x.id === this.activeId);
        if (this.glasses.showHistory) {
          await this.glasses.showHistory(this.historyView(s));
          return;
        }
        const items = this.historyItems().map((h) => h.line);
        // 리스트는 비어 있으면 만들 수 없다.
        if (items.length === 0) items.push('(주고받은 기록이 없습니다)');
        // 진행 상황을 보거나 말을 거는 자리는 항상 맨 아래에 둔다.
        items.push('> 대화 이어서 보기');
        await this.glasses.showList(`${clamp(s?.title || '세션', 30)} · 더블탭 뒤로`, items);
        return;
      }

      // 6) 알림 목록.
      if (this.screen === 'notifications') {
        if (this.glasses.showNotifications) {
          await this.glasses.showNotifications(this.notificationsView());
          return;
        }
        const items: Item[] = this.notifications.map((n) => ({
          text: n.title,
          state: n.readAt ? 'read' : 'unread',
        }));
        if (items.length === 0) items.push({ text: '(알림이 없습니다)' });
        else items.push({ text: '모두 읽음 처리' });
        await this.glasses.showList(
          `알림 ${this.unread}/${this.notifications.length} · 더블탭 뒤로`,
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
            clamp(n?.title ?? '알림', 46),
            `─ ${this.notifTime(n)} · 더블탭 뒤로`,
            '',
            clamp(n?.body || '(내용 없음)', 320),
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
      if (this.screen === 'commands') {
        if (this.snippets.length === 0) {
          await this.glasses.showList('명령 · 더블탭 뒤로', [
            '등록된 명령이 없습니다',
            '웹에서 먼저 등록하세요',
          ]);
          return;
        }
        await this.glasses.showList(
          `명령 ${this.cmdCursor + 1}/${this.snippets.length} · 더블탭 뒤로`,
          this.snippets.map((x, i) => ({
            text: x.kind === 'cron' ? `${x.label} (예약)` : x.label,
            state: i === this.cmdCursor ? 'running' : undefined,
          })),
        );
        return;
      }

      // 10) 실행 결과.
      if (this.screen === 'command-result') {
        await this.glasses.showText(resultView(this.cmdResult));
        return;
      }

      // 11) 설정.
      if (this.screen === 'settings') {
        await this.glasses.showList('설정 · 더블탭 뒤로', [
          this.glasses.isVoiceEnabled ? '음성: 켜짐' : '음성: 꺼짐',
          this.showLogo ? 'DEV 로고: 켜짐' : 'DEV 로고: 꺼짐',
          // 펌웨어가 앞쪽 공백을 지워 들여쓰기로는 정렬이 안 맞는다.
          // 고른 값과 아닌 값 모두 보이는 문자를 앞에 둔다.
          ...IDLE_CHOICES.map(
            (ms) => `${this.idleMs === ms ? '*' : '-'} 화면 꺼짐: ${ms / 1000}초`,
          ),
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
        const items: Item[] = this.checklist.map((i) => ({
          text: i.text,
          state: i.done ? 'done' : 'todo',
        }));
        // 비어 있으면 리스트를 만들 수 없으므로 안내를 항목으로 넣는다.
        if (items.length === 0) items.push({ text: '(폰에서 할 일을 추가하세요)' });
        else items.push({ text: '완료 항목 치우기' });
        const label = this.checkGlobal ? '전역 할 일' : '할 일';
        await this.glasses.showList(
          `${label} ${done}/${this.checklist.length} · 더블탭 뒤로`,
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
      const head = s ? clamp(s.title || '새 대화', 46) : '세션';

      let status: string;
      if (s && !s.live) {
        status = '종료됨 · 탭하면 이어가기';
      } else if (this.status === 'busy') {
        // 가만히 있는 화면은 멈춘 것처럼 보인다.
        status = `${SPINNER[this.tick % SPINNER.length]} ${this.activity || '작업 중'}`;
      } else {
        status = `${this.statusText(this.status || s?.status || '')} · 탭 할일 · 더블탭 뒤로`;
      }

      await this.glasses.showText(
        [head, `─ ${status}`, '', clamp(this.lines.slice(-6).join('\n'), 360)].join('\n'),
      );
    } catch (err) {
      // 화면 갱신 실패가 glasses-ui를 멈추면 안 된다.
      this.log(`화면 표시 오류: ${(err as Error).message}`, 'error');
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
        return { kind: 'info', text: '여기부터 이어서' };
      default:
        return null;
    }
  }

  /** 이벤트 한 건을 화면에 보여줄 짧은 줄로 바꾼다. */
  private toLine(e: SessionEvent): string | null {
    const text = (k: string): string => String(e[k] ?? '');
    switch (e.type) {
      case 'user':
        return `나: ${clamp(text('text').split('\n')[0] ?? '', 60)}`;
      case 'assistant':
        // 긴 답변이 화면을 다 먹으면 진행 상황이 묻힌다.
        return clamp(text('text').split('\n')[0] ?? '', 90);
      case 'tool_use':
        return `> ${text('name')}`;
      case 'stderr':
        return `오류: ${clamp(text('text'), 60)}`;
      case 'resumed':
        return '── 여기부터 이어서 ──';
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
      this.activity = '생각 중';
      this.activityDetail = '';
      this.activityAt = Date.now();
    }

    if (e.type === 'permission_request') {
      this.pending = {
        id: String(e.requestId),
        toolName: String(e.toolName),
        summary: String(e.summary ?? ''),
      };
      this.permCursor = 0;
      // 답해야 진행되는 일이므로 화면을 깨운다.
      this.wake();
      this.glasses.speak(`권한 요청, ${e.toolName}`);
      this.log(`권한 요청: ${e.toolName}`, 'warn');
      await this.render();
      return;
    }

    if (e.type === 'permission_resolved') {
      if (this.pending?.id === e.requestId) this.pending = null;
      await this.render();
      return;
    }

    if (e.type === 'turn_complete') {
      const result = String(e.result ?? '');
      const failed = e.isError === true;
      this.status = failed ? '오류' : '완료';
      this.setSpinning(false);
      this.doneIds.add(String(e.sessionId ?? this.activeId));
      // 결과를 보여줘야 하므로 깨운다.
      this.wake();
      this.glasses.speak(failed ? '작업 중 오류가 발생했습니다.' : `작업 완료. ${result}`);
      this.log(failed ? `오류: ${result}` : `완료: ${result}`, failed ? 'error' : 'ok');
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
      this.glasses.speak(failed ? '작업 중 오류가 발생했습니다.' : `작업 완료. ${result}`);
      this.log(`[${s?.title ?? '세션'}] ${failed ? '오류' : '완료'}: ${result}`, failed ? 'error' : 'ok');

      // 서버에 남겨 나중에 '알림 보기'에서 다시 볼 수 있게 한다.
      // 화면에 한 번 띄우고 마는 팝업은 놓치면 그만이다.
      try {
        const saved = await agentCli.addNotification({
          title: `${failed ? '오류' : '완료'}: ${s?.title || '새 대화'}`,
          body: result,
          kind: failed ? 'error' : 'done',
          sessionId: id,
        });
        this.unread += 1;
        // 방금 내가 남긴 알림이다. 아래에서 팝업을 직접 띄우므로
        // 되돌아온 SSE가 같은 것을 한 번 더 띄우지 않게 눌러둔다.
        if (saved?.id) this.lastSeenNotifId = saved.id;
      } catch (err) {
        this.log(`알림 저장 실패: ${(err as Error).message}`, 'warn');
      }

      // 목록·홈에 있을 때만 팝업을 띄운다. 대화 화면에서는 이미 보고 있다.
      //
      // showNotice로 띄운다. 직접 넣으면 스스로 걷는 타이머가 걸리지
      // 않아 탭할 때까지 화면이 굳는다.
      if (this.screen === 'home' || this.screen === 'sessions') {
        this.showNotice({
          title: s?.title || '새 대화',
          text: failed ? `오류: ${result}` : result,
          label: '에이전트',
          kind: failed ? 'error' : 'done',
        });
      }
      await this.render();
      return;
    }

    if (e.type === 'permission_request') {
      this.activeId = id;
      this.pending = {
        id: String(e.requestId),
        toolName: String(e.toolName),
        summary: String(e.summary ?? ''),
      };
      this.permCursor = 0;
      this.wake();
      this.glasses.speak(`권한 요청, ${e.toolName}`);
      this.log(`[${s?.title ?? '세션'}] 권한 요청: ${e.toolName}`, 'warn');
      await this.render();
    }
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
      | 'notifCursor'
      | 'histCursor'
      | 'checkCursor'
      | 'cmdCursor',
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
      // 다 지웠다. null이 아닌 빈 값으로 둬야 다음에 오는 알림을
      // 첫 조회가 아니라 새 알림으로 본다.
      if (this.lastSeenNotifId !== null) this.lastSeenNotifId = '';
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

    // 할 일 화면에서 할 일이 바뀐 알림은 띄우지 않는다. 서버가 할 일
    // 변경마다 알림을 남기는데, 안경에서 체크하면 방금 한 일이 팝업으로
    // 떠서 체크한 목록을 덮었다. 목록에 이미 보이는 변화다.
    if (this.screen === 'checklist' && /^(완료한 )?할 일/.test(newest.title)) return;

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
      this.sysError = '시스템 상태를 읽지 못했습니다';
      this.log(`시스템 상태를 읽지 못했습니다: ${sys.reason}`, 'warn');
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
    this.cmdResult = { label: s.label, text: '실행 중…', snippetId: s.id };
    await this.render();

    try {
      const res = await agentCli.runSnippet(s.id, confirm);

      if (res.needsConfirm) {
        const why = (res.risks ?? []).map((r) => `· ${r.reason}`).join('\n');
        this.cmdResult = {
          label: s.label,
          text: `${why || '되돌릴 수 없는 명령입니다.'}\n\n그래도 실행할까요?`,
          awaitingConfirm: true,
          snippetId: s.id,
        };
        this.glasses.speak('확인이 필요합니다');
        await this.render();
        return;
      }

      const r = res.result;
      const head = r?.timedOut ? '(시간 초과) ' : r?.exitCode ? `(종료 ${r.exitCode}) ` : '';
      this.cmdResult = {
        label: s.label,
        text: head + (r?.output?.trim() || '(출력 없음)'),
        snippetId: s.id,
      };
      this.log(`[${s.label}] 종료 ${r?.exitCode ?? '?'} (${r?.tookMs ?? 0}ms)`, 'ok');
    } catch (err) {
      this.cmdResult = { label: s.label, text: `실패: ${(err as Error).message}`, snippetId: s.id };
      this.log(`[${s.label}] 실행 실패: ${(err as Error).message}`, 'error');
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
        this.log(`세션 목록을 읽지 못했습니다: ${(err as Error).message}`, 'warn');
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
        this.log(`알림을 읽지 못했습니다: ${(err as Error).message}`, 'warn');
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
        this.log(`명령 목록을 읽지 못했습니다: ${(err as Error).message}`, 'warn');
      }
      await this.render();
      return;
    }
    if (target === 'settings') {
      this.screen = 'settings';
      this.setCursor = 0;
      await this.render();
    }
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
      this.log(`대화 기록을 읽지 못했습니다: ${(err as Error).message}`, 'warn');
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
      this.log('알림을 모두 읽음 처리했습니다.', 'ok');
    } catch (err) {
      this.log(`읽음 처리 실패: ${(err as Error).message}`, 'error');
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
      this.cursor = Math.min(Math.max(selectedIndex, 0), Math.max(this.sessions.length - 1, 0));
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
      if (this.moveCursor(gesture, selectedIndex, 'menuCursor', MENU.length)) {
        await this.render();
        return;
      }
      // 최상위라 더블탭으로 갈 곳이 없다. 대신 화면을 바로 끈다.
      // 무조작 타이머를 기다리지 않고 끄고 싶을 때 쓴다. 다시 켜는 건
      // 여느 때처럼 아무 조작 한 번이다.
      if (gesture === 'doubleTap') return this.sleep();
      if (gesture === 'tap') await this.openMenu(MENU[this.menuCursor]?.screen);
      return;
    }

    if (this.screen === 'sessions') {
      if (gesture === 'doubleTap') return this.goHome();
      if (this.moveCursor(gesture, selectedIndex, 'cursor', this.sessions.length)) {
        this.hooks.onSessionsChanged?.(this.sessions, this.cursor);
        await this.render();
        return;
      }
      if (gesture === 'tap') {
        const target = this.sessions[this.cursor];
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
      const items = this.historyItems();
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
            title: picked.line.split('>')[0] === '나' ? '내 메시지' : 'AI 응답',
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
      const count = this.notifications.length;
      if (this.moveCursor(gesture, selectedIndex, 'notifCursor', count + (count > 0 ? 1 : 0))) {
        await this.render();
        return;
      }
      if (gesture === 'tap') {
        const n = this.notifications[this.notifCursor];
        if (n) await this.openNotification(n);
        else if (count > 0) await this.readAllNotifications();
      }
      return;
    }

    // 알림 하나를 펼친 화면.
    if (this.screen === 'notification') {
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
      if (this.moveCursor(gesture, selectedIndex, 'cmdCursor', this.snippets.length)) {
        await this.render();
        return;
      }
      if (gesture === 'tap') {
        const s = this.snippets[this.cmdCursor];
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
        return;
      }
      if (gesture === 'tap' && this.cmdResult?.awaitingConfirm) {
        const s = this.snippets.find((x) => x.id === this.cmdResult?.snippetId);
        if (s) await this.runSnippet(s, true);
      }
      return;
    }

    // 설정: 음성 토글 + 로고 토글 + 화면 꺼짐 시간 세 칸.
    if (this.screen === 'settings') {
      if (gesture === 'doubleTap') return this.goHome();
      if (this.moveCursor(gesture, selectedIndex, 'setCursor', 2 + IDLE_CHOICES.length)) {
        await this.render();
        return;
      }
      if (gesture === 'tap') {
        if (this.setCursor === 0) {
          await this.toggleVoice();
        } else if (this.setCursor === 1) {
          await this.toggleLogo();
        } else {
          const ms = IDLE_CHOICES[this.setCursor - 2];
          if (ms) {
            this.idleMs = ms;
            await this.saveSetting(STORE_IDLE, String(ms));
            this.log(`화면 꺼짐: ${ms / 1000}초`, 'ok');
            // 새 시간으로 다시 세도록 타이머를 갱신한다.
            this.wake();
          }
        }
        await this.render();
      }
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
        if (this.checklist.length > 0 && picked >= this.checklist.length) {
          this.checklist = this.checkGlobal
            ? await agentCli.clearDoneGlobalChecklist()
            : await agentCli.clearDoneChecklist(this.activeId);
          this.checkCursor = 0;
          this.log('완료한 할 일을 치웠습니다.', 'ok');
        } else {
          const item = this.checklist[this.checkCursor];
          if (item) {
            try {
              this.checklist = this.checkGlobal
                ? await agentCli.toggleGlobalChecklist(item.id)
                : await agentCli.toggleChecklist(this.activeId, item.id);
              this.log(`${item.done ? '해제' : '완료'}: ${item.text}`, 'ok');
            } catch (err) {
              this.log(`체크 실패: ${(err as Error).message}`, 'error');
            }
          }
        }
      }
      await this.render();
      return;
    }

    // 상세(대화) 화면. 한 단계 위는 대화 목록이다.
    if (gesture === 'doubleTap') {
      await this.backToHistory();
      return;
    }

    if (gesture === 'tap') {
      const s = this.sessions.find((x) => x.id === this.activeId);
      // 종료된 세션은 이어가기, 살아있으면 할 일 목록으로 간다.
      if (s && !s.live) {
        await this.resume(s.id);
      } else {
        await this.openChecklist();
      }
    }
  }

  /** 대화 화면에서 그 세션의 대화 목록으로 올라간다. */
  private async backToHistory(): Promise<void> {
    this.detailStop?.();
    this.detailStop = undefined;
    this.setSpinning(false);
    this.pending = null;

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
      this.log(`할 일 불러오기 실패: ${(err as Error).message}`, 'error');
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

  private async decidePermission(choice: (typeof PERMISSION_CHOICES)[number]): Promise<void> {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.permCursor = 0;

    try {
      await agentCli.resolvePermission(this.activeId, p.id, choice.behavior);
      this.log(`권한 ${choice.label}: ${p.toolName}`, choice.behavior === 'allow' ? 'ok' : 'warn');
      if (choice.always) {
        await agentCli.setPolicy(this.activeId, 'auto-approve');
        this.log('이 세션은 앞으로 자동 승인됩니다.', 'warn');
      }
    } catch (err) {
      this.log(`권한 처리 실패: ${(err as Error).message}`, 'error');
    }
    await this.render();
  }

  async toggleVoice(): Promise<void> {
    const next = !this.glasses.isVoiceEnabled;
    this.glasses.setVoiceEnabled(next);
    this.log(`음성 알림 ${next ? '켜짐' : '꺼짐'}`, 'ok');
    await this.saveSetting(STORE_VOICE, next ? '1' : '0');
    if (next) this.glasses.speak('음성 알림을 켰습니다');
    await this.render();
  }

  /**
   * 홈 옆의 DEV 로고를 켜고 끈다.
   *
   * 끄면 목록이 화면 폭을 다 쓴다. 세션 제목이 길 때 쓸모가 있다.
   */
  async toggleLogo(): Promise<void> {
    this.showLogo = !this.showLogo;
    this.log(`DEV 로고 ${this.showLogo ? '켜짐' : '꺼짐'}`, 'ok');
    await this.saveSetting(STORE_LOGO, this.showLogo ? '1' : '0');
    await this.render();
  }

  async open(id: string): Promise<void> {
    this.detailStop?.();
    this.activeId = id;
    this.screen = 'detail';
    this.lines = [];
    this.feed = [];
    this.pending = null;
    this.status = '';
    this.doneIds.delete(id);
    this.notice = null;

    const s = this.sessions.find((x) => x.id === id);
    try {
      for (const e of await agentCli.getHistory(id, 40)) {
        const line = this.toLine(e);
        if (line) this.lines.push(line);
        const fed = this.toFeed(e);
        if (fed) this.feed.push(fed);
      }
    } catch (err) {
      this.log(`이력 불러오기 실패: ${(err as Error).message}`, 'error');
    }

    if (s?.live) {
      this.detailStop = agentCli.streamSession(id, (e) => void this.handleEvent(e), (m) =>
        this.log(m, 'error'),
      );
    }
    await this.render();
  }

  async resume(id: string, deleteOriginal = false): Promise<void> {
    // render()를 거치지 않고 직접 그린다. 그러면 화면은 켜지는데
    // 무조작 타이머는 걸리지 않아, 그대로 켜진 채 남는다.
    this.wake();
    try {
      await this.glasses.showText('대화를 이어가는 중…');
      const { session, deletedOriginal } = await agentCli.resumeSession(id, deleteOriginal);
      this.log(deletedOriginal ? '대화를 이어갑니다. 원본은 삭제했습니다.' : '대화를 이어갑니다.', 'ok');
      this.sessions = await agentCli.listSessions();
      await this.open(session.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '이어가기 실패';
      this.log(msg, 'error');
      this.wake();
      await this.glasses.showText(`이어가기 실패\n\n${clamp(msg, 200)}`);
    }
  }

  /**
   * 폰 UI의 '뒤로'. 홈으로 올라간다.
   *
   * 화면이 여러 단계로 깊어졌으므로 한 단계씩 올리는 대신 최상위로 보낸다.
   * 폰에서는 안경 화면이 어디까지 들어가 있는지 보이지 않기 때문이다.
   */
  async backToList(): Promise<void> {
    this.pending = null;
    await this.goHome();
  }

  /** 폰 UI에서 프롬프트를 보낼 때. 안경도 그 세션 화면으로 따라간다. */
  async send(prompt: string): Promise<void> {
    if (!this.activeId) return;
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
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.detailStop?.();
    this.eventStop?.();
    this.lifecycleStop?.();
    clearInterval(this.pollTimer);
    for (const stop of this.watchers.values()) stop();
    this.watchers.clear();
    this.setSpinning(false);
    await this.glasses.disconnect();
  }
}
