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
} from './agent-cli.js';
import {
  clamp,
  type GestureEvent,
  type GlassesAdapter,
  type Item,
  type ItemState,
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
  | 'settings';

/** home에서 한 단계 아래로 내려갈 메뉴. 순서가 곧 커서 위치다. */
const MENU = [
  { label: '에이전트', screen: 'sessions' as const },
  { label: '알림 보기', screen: 'notifications' as const },
  { label: '체크 보기', screen: 'checklist' as const },
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
const NOTICE_MS = 6_000;

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
  private status = '';
  private pending: { id: string; toolName: string; summary: string } | null = null;
  private permCursor = 0;
  private permShownAt = 0;
  private doneIds = new Set<string>();
  private notice: { title: string; text: string; heading?: string } | null = null;
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

  /** SSE가 막혀 있는지. 막혀 있으면 폴링을 촘촘히 돈다. */
  private sseDown = false;
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
  private historyItems(): { line: string; full: string }[] {
    const out: { line: string; full: string }[] = [];
    for (const e of this.history) {
      if (e.type !== 'user' && e.type !== 'assistant') continue;
      const full = String(e.text ?? '');
      const who = e.type === 'user' ? '나' : 'AI';
      out.push({
        line: `${who}> ${clamp(full.replace(/\n/g, ' ').trim() || '(내용 없음)', 34)}`,
        full,
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
   * 알림 팝업을 띄우고, 시간이 지나면 스스로 걷는다.
   *
   * 걷을 때 화면을 다시 그려 원래 보던 곳으로 돌아간다. 그리지 않으면
   * 팝업 글자가 화면에 그대로 남는다.
   */
  private showNotice(notice: { title: string; text: string; heading?: string }): void {
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
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.sleep(), this.idleMs);
  }

  /** 화면을 비운다. 상태는 그대로 두고 표시만 끈다. */
  private async sleep(): Promise<void> {
    if (this.screenOff) return;
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
        await this.glasses.showList(`권한: ${clamp(p.toolName, 30)}`, [
          ...PERMISSION_CHOICES.map((c) => c.label),
          ...(p.summary ? [`  ${clamp(p.summary.replace(/\n/g, ' '), 60)}`] : []),
        ]);
        return;
      }

      // 2) 작업 완료·새 알림.
      if (this.notice) {
        await this.glasses.showText(
          [
            `* ${this.notice.heading ?? '작업 완료'}`,
            '',
            clamp(this.notice.title, 46),
            '',
            clamp(this.notice.text, 200),
            '',
            // 잠깐 뒤 스스로 사라진다. 탭은 먼저 치우는 수단일 뿐이라
            // "확인"이라고 하면 눌러야 하는 것처럼 보인다.
            '탭: 지금 닫기',
          ].join('\n'),
        );
        return;
      }

      // 4) 홈. 상단에 요약, 메뉴 옆에 서버 상태를 띄운다.
      if (this.screen === 'home') {
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

      // 8) 설정.
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
      this.activity = '';
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

    if (e.type === 'tool_use') this.activity = String(e.name ?? '');
    if (e.type === 'thinking') this.activity = '생각 중';

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
      if (this.screen === 'home' || this.screen === 'sessions') {
        this.notice = { title: s?.title || '새 대화', text: failed ? `오류: ${result}` : result };
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
    field: 'cursor' | 'menuCursor' | 'setCursor' | 'notifCursor' | 'histCursor' | 'checkCursor',
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

    this.wake();
    this.glasses.speak(newest.title);
    this.showNotice({
      title: newest.title,
      text: newest.body || newest.title,
      heading: '새 알림',
    });
  }

  /** 홈 상단 요약에 쓰는 값을 모은다. */
  private async refreshSummary(): Promise<void> {
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
      // 최상위라 더블탭으로 갈 곳이 없다.
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
    this.pending = null;
    this.status = '';
    this.doneIds.delete(id);
    this.notice = null;

    const s = this.sessions.find((x) => x.id === id);
    try {
      for (const e of await agentCli.getHistory(id, 40)) {
        const line = this.toLine(e);
        if (line) this.lines.push(line);
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
    try {
      await this.glasses.showText('대화를 이어가는 중…');
      const { session, deletedOriginal } = await agentCli.resumeSession(id, deleteOriginal);
      this.log(deletedOriginal ? '대화를 이어갑니다. 원본은 삭제했습니다.' : '대화를 이어갑니다.', 'ok');
      this.sessions = await agentCli.listSessions();
      await this.open(session.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '이어가기 실패';
      this.log(msg, 'error');
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
