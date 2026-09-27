/**
 * 스마트 안경 어댑터 인터페이스.
 *
 * glasses-ui는 이 인터페이스만 알고 동작한다. G2든 Ray-Ban Display든
 * 커스텀 기기든, 여기에 맞추면 같은 UI 로직을 그대로 쓴다.
 *
 * 나누는 기준은 하나다.
 *   본체는 **무엇을** 보여줄지 정한다.
 *   어댑터는 **어떻게** 그릴지 정한다.
 *
 * 그래서 본체는 글자가 아니라 뜻을 넘긴다. 완료를 '[x]'로 쓸지 초록
 * 체크 아이콘으로 그릴지는 어댑터가 자기 화면 사정을 보고 정한다.
 */

/** 사용자가 취한 동작. 기기별 이벤트를 이 넷으로 환원한다. */
export type Gesture = 'tap' | 'doubleTap' | 'up' | 'down';

export interface GestureEvent {
  gesture: Gesture;
  /**
   * 목록에서 선택된 항목의 위치.
   * 기기가 자체적으로 커서를 관리하면 그 값이 들어오고,
   * 아니면 undefined가 와서 glasses-ui가 직접 센다.
   */
  selectedIndex?: number;
}

/**
 * 항목이 놓인 상태.
 *
 * 본체는 이 값만 정하고 글자를 고르지 않는다. 단색 기기는 글자로,
 * 풀컬러 기기는 아이콘과 색으로 옮긴다.
 *
 * waiting과 pending은 일부러 나눠 뒀다. G2에서는 둘 다 '!'로 보이지만
 * 뜻이 달라서, 합쳐 버리면 색을 쓸 수 있는 기기에서 되돌릴 수 없다.
 */
export type ItemState =
  | 'done' // 끝남
  | 'todo' // 아직 안 함
  | 'running' // 작업 중
  | 'waiting' // 사용자 응답을 기다리는 중
  | 'pending' // 권한 요청이 쌓여 있음
  | 'offline' // 연결이 끊김
  | 'idle' // 붙어는 있고 노는 중
  | 'unread' // 안 읽음
  | 'read'; // 읽음

/**
 * 화면에 뜨는 한 줄.
 *
 * 문자열 대신 이걸 넘기면 어댑터가 자기 방식으로 그릴 수 있다.
 * 상태가 없는 줄(액션 항목 등)은 text만 채운다.
 */
export interface Item {
  text: string;
  state?: ItemState;
  /** 눈에 띄게 하거나 죽인다. 기기에 따라 굵기·밝기·색으로 나타난다. */
  emphasis?: 'normal' | 'strong' | 'dim';
}

/** 문자열이나 Item 중 아무거나 받는다. 옮겨가는 동안 둘 다 쓴다. */
export type ItemLike = string | Item;

/** 어떤 형태로 왔든 Item으로 맞춘다. */
export function toItem(v: ItemLike): Item {
  return typeof v === 'string' ? { text: v } : v;
}

/**
 * 기기가 신고하는 화면 규격.
 *
 * 본체는 이 값을 보고 몇 줄을 보낼지 정도만 정한다. 글자를 자르는 일은
 * 어댑터가 한다. 화면 폭을 아는 쪽이 자르는 게 맞다.
 */
export interface Caps {
  /** 텍스트 격자 기기의 칸 수. 픽셀 기반 기기는 비운다. */
  cols?: number;
  rows?: number;
  /** 단색인지 풀컬러인지. */
  color: 'mono' | 'full';
  /** 아이콘을 그릴 수 있나. */
  icons: boolean;
  /** 이미지를 띄울 수 있나. */
  images: boolean;
}

/** 안경 한 대를 다루는 어댑터. */
/** 홈 화면에 그릴 것. 어떻게 그릴지는 어댑터가 정한다(showHome). */
export interface HomeView {
  /** 상태 표시줄 왼쪽. 화면 이름 같은 고정 문구. */
  title: string;
  /**
   * 상태 표시줄 오른쪽. 연결 상태·시각·작업 중 수처럼 자주 바뀌는 값.
   *
   * 자주 바뀌는 값은 메뉴가 아니라 여기 둔다. 메뉴 글자가 바뀌면 목록을
   * 다시 세워야 하고, 그러면 선택이 첫 항목으로 돌아간다.
   */
  status: string;
  /** 메뉴. meta는 오른쪽에 붙는 짧은 값이며 드물게 바뀌는 것만 넣는다. */
  items: ReadonlyArray<{ label: string; meta?: string }>;
  /** 로고. 없으면 로고 자리를 비운다. */
  logo?: readonly string[];
  /** 게이지. ratio는 0~1. 없으면 게이지 줄을 그리지 않는다. */
  gauges?: ReadonlyArray<{ label: string; ratio: number; text: string }>;
}

/** 알림 갈래. 서버의 Notification.kind와 같다. */
export type NoticeKind = 'done' | 'error' | 'permission' | 'info';

/** 알림 목록에 그릴 것(showNotifications). */
export interface NotificationsView {
  title: string;
  /** 새 알림 수와 시각. */
  status: string;
  /** 알림 한 줄. read로 안 읽은 것을 가른다. meta는 경과 시간. */
  rows: ReadonlyArray<{ kind: NoticeKind; read: boolean; title: string; meta: string }>;
  /** 안 읽은 알림 수(갈래별). */
  counts: ReadonlyArray<{ kind: NoticeKind; label: string; count: number }>;
  unread: number;
  /** 목록 끝에 붙는 동작 줄. 알림이 없으면 없다. */
  action?: string;
  hint: string;
  /** 안내 줄 오른쪽. 기호 읽는 법 같은 것. */
  legend: string;
}

/** 알림 하나의 내용(showNotification). */
export interface NotificationView {
  title: string;
  status: string;
  kind: NoticeKind;
  /** 갈래 이름. 오류·완료 등. */
  label: string;
  heading: string;
  body: string;
  hint: string;
}

/** 새 알림 팝업(showNotice). */
export interface NoticeView {
  kind: NoticeKind;
  /** 어디서 온 알림인지. 에이전트·할 일·오류 등. */
  label: string;
  title: string;
  body: string;
  /** 닫히는 때와 닫는 법. */
  closeHint: string;
}

/** 대화에 오간 것 한 줄. 누가(나·AI·도구) 했는지로 기호를 고른다. */
export type LineKind = 'me' | 'ai' | 'tool' | 'error' | 'info';

/** 대화 목록(showHistory). 주고받은 말을 훑고 맨 아래에서 대화로 들어간다. */
export interface HistoryView {
  title: string;
  status: string;
  /** 주고받은 말. 나와 AI만. */
  rows: ReadonlyArray<{ kind: 'me' | 'ai'; text: string }>;
  /** 목록 끝에 붙는 동작 줄(대화 이어서 보기). */
  action: string;
  /** 세션 정보. 고른 줄과 상관없이 보여줄 수 있는 것. */
  info: { state: ItemState; label: string; rows: ReadonlyArray<{ label: string; value: string }> };
  hint: string;
}

/** 진행 중 대화(showLive). */
export interface LiveView {
  title: string;
  status: string;
  /** 최근에 오간 것. 오래된 것부터. */
  lines: ReadonlyArray<{ kind: LineKind; text: string }>;
  /** 지금 하는 일. 쉬고 있으면 없다. tick은 도는 기호를 고르는 데 쓴다. */
  activity?: { text: string; elapsed: string; tick: number };
  /** 쉴 때 보여줄 말. 대기·종료됨과 탭으로 할 수 있는 일. */
  idle: string;
  hint: string;
  /** 안내 줄 오른쪽. 턴 수와 비용. */
  meta: string;
}

/** 권한 요청(showPermission). 거부가 맨 앞이다. */
export interface PermissionView {
  title: string;
  status: string;
  tool: string;
  /** 무엇을 하려는지. 명령·파일 경로 등. */
  summary: string;
  choices: ReadonlyArray<{ kind: 'deny' | 'once' | 'always'; label: string }>;
  /** 카드 오른쪽 안내. 더블탭이 거부라는 것. */
  hint: string;
}

/** 할 일 화면(showChecklist). 전역 목록과 세션 목록이 같이 쓴다. */
export interface ChecklistView {
  title: string;
  /** 완료 수와 시각. */
  status: string;
  items: ReadonlyArray<{ done: boolean; text: string }>;
  /** 목록 끝에 붙는 동작 줄(완료 항목 치우기). 할 일이 없으면 없다. */
  action?: string;
  progress: { done: number; total: number };
  hint: string;
  /** 안내 줄 오른쪽. 어디서 추가하는지. */
  note: string;
}

/**
 * 시스템 화면(showSystem). 고르는 목록이 아니라 한눈에 보는 계기판이다.
 *
 * 못 구한 값은 null로 둔다. -1이나 0을 그대로 보여주면 오해한다.
 */
export interface SystemView {
  title: string;
  /** 언제 읽었는지. 스스로 갱신하지 않으므로 값이 얼마나 오래됐는지 알려야 한다. */
  status: string;
  /** 못 읽었으면 없다. 그때는 notice를 띄운다. */
  summary?: {
    /** 0~100 */
    cpu: number | null;
    mem: { used: number; total: number } | null;
    load: readonly number[];
    uptime: string;
  };
  /** CPU를 많이 쓰는 순서. */
  procs: ReadonlyArray<{ name: string; cpu: number | null }>;
  /** 읽는 중이거나 못 읽었을 때 알려 줄 말. */
  notice?: string;
  hint: string;
  /** 안내 줄 오른쪽. 호스트 이름. */
  note: string;
}

/** 등록한 명령 목록(showCommands). */
export interface CommandsView {
  title: string;
  status: string;
  /** cron은 예약 주기(분). 직접 실행하는 명령은 없다. */
  rows: ReadonlyArray<{ label: string; cron?: number }>;
  counts: { once: number; cron: number };
  /** 가장 최근에 돈 명령. 한 번도 돌지 않았으면 없다. */
  last?: { label: string; exitCode: number; ago: string };
  hint: string;
  /** 안내 줄 오른쪽. 어디서 등록하는지. */
  note: string;
}

/** 명령 실행 결과(showCommandResult). */
export interface CommandResultView {
  title: string;
  status: string;
  /** confirm은 되돌릴 수 없어 보여 아직 실행하지 않은 상태다. */
  state: 'running' | 'done' | 'failed' | 'confirm';
  command: string;
  /** done은 출력, failed는 실패 이유, confirm은 걱정되는 까닭. */
  lines: readonly string[];
  hint: string;
  note: string;
}

/** 세션 화면에 그릴 것. 어떻게 그릴지는 어댑터가 정한다(showSessions). */
export interface SessionsView {
  /** 상태 표시줄 왼쪽. */
  title: string;
  /** 상태 표시줄 오른쪽. 작업·승인 수와 시각처럼 자주 바뀌는 값. */
  status: string;
  /**
   * 세션 한 줄. 목록을 스크롤해도 앱에 이벤트가 오지 않아 "고른 세션"의
   * 자세한 내용을 옆에 띄울 수 없다. 그래서 한 줄에 필요한 것을 담는다.
   * meta는 경과 시간처럼 짧은 값.
   */
  rows: ReadonlyArray<{ state: ItemState; title: string; meta: string }>;
  /** 상태별 개수. 고른 줄과 상관없이 보여줄 수 있는 요약이다. */
  counts: ReadonlyArray<{ state: ItemState; label: string; count: number }>;
  /** 아래 안내 줄. 왼쪽은 조작, 오른쪽은 전체 수. */
  hint: string;
  total: string;
}

export interface GlassesAdapter {
  /** 사람이 읽을 기기 이름. 로그와 화면에 쓴다. */
  readonly name: string;

  /**
   * 화면 규격. 없으면 G2와 같다고 본다.
   * 기존 어댑터를 안 고쳐도 되게 선택 사항으로 둔다.
   */
  readonly caps?: Caps;

  /**
   * 홈 옆에 띄울 로고. 기기마다 화면 크기와 폰트가 달라 어댑터가 갖는다.
   * 없으면 로고 없이 목록이 화면을 다 쓴다.
   */
  readonly logo?: readonly string[];

  /** 연결하고 화면을 쓸 준비를 한다. 실패하면 throw한다. */
  connect(): Promise<void>;

  /** 전체 화면 텍스트를 보여준다. */
  showText(content: string): Promise<void>;

  /**
   * 목록 화면.
   *
   * 항목 수와 길이 제한은 기기마다 다르므로 어댑터가 알아서 자른다.
   * side를 주면 목록을 좁히고 오른쪽에 그 내용을 함께 띄운다.
   *
   * 항목은 Item으로 오지만, 예전처럼 문자열을 받아도 동작한다.
   */
  showList(
    header: string,
    items: readonly ItemLike[],
    side?: readonly ItemLike[],
  ): Promise<void>;

  /**
   * 홈 화면을 기기에 맞게 꾸며 그린다. 없으면 본체가 showList로 그린다.
   *
   * 목록 하나로는 밝기·영역·게이지를 줄 수 없어 따로 둔다. 무엇을 얼마나
   * 꾸밀지는 기기 화면을 아는 어댑터가 정한다.
   */
  showHome?(view: HomeView): Promise<void>;

  /** 세션 화면을 기기에 맞게 꾸며 그린다. 없으면 본체가 showList로 그린다. */
  showSessions?(view: SessionsView): Promise<void>;

  /** 알림 목록·내용·새 알림 팝업을 꾸며 그린다. 없으면 본체가 목록·글로 그린다. */
  showNotifications?(view: NotificationsView): Promise<void>;
  showNotification?(view: NotificationView): Promise<void>;
  showNotice?(view: NoticeView): Promise<void>;

  /** 대화 목록·진행 중 대화·권한 요청을 꾸며 그린다. 없으면 본체가 목록·글로 그린다. */
  showHistory?(view: HistoryView): Promise<void>;
  showLive?(view: LiveView): Promise<void>;
  showPermission?(view: PermissionView): Promise<void>;

  /** 할 일 화면을 꾸며 그린다. 없으면 본체가 목록으로 그린다. */
  showChecklist?(view: ChecklistView): Promise<void>;

  /** 시스템 화면을 꾸며 그린다. 없으면 본체가 showList로 그린다. */
  showSystem?(view: SystemView): Promise<void>;

  /** 명령 목록을 꾸며 그린다. 없으면 본체가 showList로 그린다. */
  showCommands?(view: CommandsView): Promise<void>;

  /** 명령 실행 결과를 꾸며 그린다. 없으면 본체가 showText로 그린다. */
  showCommandResult?(view: CommandResultView): Promise<void>;

  /** 제스처를 구독한다. 반환값을 호출하면 끊는다. */
  onGesture(handler: (event: GestureEvent) => void): () => void;

  /**
   * 앱이 앞으로 돌아오거나 뒤로 물러날 때 알려준다.
   *
   * 안경은 화면이 꺼지면 앱을 뒤로 물린다. 그 사이 화면 컨테이너가
   * 사라져, 돌아온 뒤 그리려 하면 조용히 실패한다. 그래서 복귀를
   * 알아야 화면을 다시 세울 수 있다.
   *
   * 이 신호가 없는 기기도 있으므로 선택 사항으로 둔다.
   */
  onLifecycle?(handler: (event: 'foreground' | 'background') => void): () => void;

  /**
   * 화면을 다시 세운다. 복귀 직후 한 번 부른다.
   *
   * 기기가 컨테이너를 들고 있는 방식은 어댑터만 안다. 본체는
   * "다시 세워라"만 말한다.
   */
  reattach?(): Promise<void>;

  /** 읽어준다. 기기에 스피커가 없으면 폰 등 다른 경로를 쓴다. */
  speak(text: string): void;

  /** 읽기를 멈춘다. */
  stopSpeaking(): void;

  /** 음성 알림을 켜고 끈다. */
  setVoiceEnabled(on: boolean): void;
  readonly isVoiceEnabled: boolean;

  /** 연결을 끊고 자원을 정리한다. */
  disconnect(): Promise<void>;
}

/** 문자열을 최대 길이로 자른다. 잘렸으면 표시한다. */
export function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * 한글·한자·전각 문자는 좁은 폰트에서 두 칸을 먹는다.
 * 글자 수로만 세면 한글 목록이 화면 밖으로 밀린다.
 */
function charWidth(c: string): number {
  const code = c.codePointAt(0) ?? 0;
  const wide =
    (code >= 0x1100 && code <= 0x115f) || // 한글 자모
    (code >= 0x2e80 && code <= 0xa4cf) || // 한중일 부수·한자
    (code >= 0xac00 && code <= 0xd7a3) || // 한글 음절
    (code >= 0xf900 && code <= 0xfaff) || // 한자 호환
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) || // 전각
    (code >= 0xffe0 && code <= 0xffe6);
  return wide ? 2 : 1;
}

/** 화면에서 차지하는 칸 수. */
export function displayWidth(s: string): number {
  let n = 0;
  for (const c of s) n += charWidth(c);
  return n;
}

/**
 * 화면 칸 수에 맞춰 자른다. 잘리면 끝에 …를 붙인다.
 *
 * clamp와 달리 글자 수가 아니라 폭을 센다. 격자 화면을 쓰는 기기가
 * 자기 cols에 맞출 때 쓴다.
 */
export function clampWidth(s: string, maxWidth: number): string {
  if (displayWidth(s) <= maxWidth) return s;

  // …도 한 칸을 먹으므로 자리를 남겨 둔다.
  const budget = maxWidth - 1;
  let out = '';
  let n = 0;
  for (const c of s) {
    const w = charWidth(c);
    if (n + w > budget) break;
    out += c;
    n += w;
  }
  return `${out}…`;
}
