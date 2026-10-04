/**
 * agent-cli(맥의 터미널/Claude Code CLI 제어기)와 통신한다.
 *
 * 지금은 같은 네트워크의 agent-cli에 직접 붙는다.
 * 나중에 외부 서버를 거치게 되면 baseUrl만 그쪽으로 바꾸면 되도록,
 * 이 파일 밖에서는 접속 경로를 알지 못하게 했다.
 */

import type { PhoneStatus, PhoneTimerAction } from './phone.js';
import { msg } from './i18n.js';

import type { ExtAgent } from './mac.js';

export interface SessionInfo {
  id: string;
  workspaceId: string;
  cwd: string;
  title?: string;
  status: 'starting' | 'idle' | 'busy' | 'waiting' | 'closed';
  turns: number;
  totalCostUsd: number;
  lastActivityAt: string;
  pending: Array<{ id: string; toolName: string; summary: string }>;
  live: boolean;
}

/** 서버가 쌓아두는 알림. 완료·오류를 나중에 다시 볼 수 있다. */
/**
 * 맥의 지금 상태. top·ps를 안경에서 읽을 수 있게 줄인 값이다.
 *
 * 숫자를 못 구하면 -1이나 0이 온다. 화면을 오류로 바꾸는 대신 그 칸만
 * 비우는 편이 낫다.
 */
export interface SysSummary {
  cpuPercent: number;
  memUsedGB: number;
  memTotalGB: number;
  load: number[];
  uptime: string;
  host: string;
  os: string;
}

/** 미리 등록해 둔 명령. 안경에서는 골라 실행만 한다. */
export interface Snippet {
  id: string;
  label: string;
  command: string;
  kind: 'once' | 'cron';
  everyMinutes?: number;
  lastRunAt?: string;
  lastExitCode?: number;
}

/** 명령을 한 번 돌린 결과. */
export interface RunResult {
  output: string;
  exitCode: number;
  timedOut: boolean;
  tookMs: number;
  /** 되돌릴 수 없어 보이는 이유. 막혔을 때 함께 온다. */
  risks?: { reason: string; destructive: boolean }[];
}

/** 프로세스 한 줄. CPU 많이 쓰는 순서로 온다. */
export interface SysProc {
  pid: number;
  cpu: number;
  mem: number;
  name: string;
}

export interface Notification {
  id: string;
  title: string;
  body: string;
  kind: 'done' | 'error' | 'permission' | 'info';
  sessionId?: string;
  createdAt: string;
  readAt?: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
  doneAt?: string;
}

export interface SessionEvent {
  type: string;
  sessionId: string;
  at: string;
  [key: string]: unknown;
}

export interface Connection {
  /** 예: http://192.168.0.10:4000 */
  baseUrl: string;
  /** 로그인 토큰 또는 예전 API 키. */
  apiKey: string;
}

export interface AuthStatus {
  configured: boolean;
  username: string;
  /**
   * key면 아이디 없이 접속 키 하나로 들어온다. 폰의 Relay 앱이 안경앱의
   * 서버일 때다(127.0.0.1). relay-service는 이 값을 주지 않는다.
   */
  mode?: 'key';
}

/** 요청 하나를 기다리는 최대 시간. relay는 agent 중계에 30초를 두지만 폰 화면은 그보다 짧게 끊는다. */
const REQUEST_TIMEOUT_MS = 15_000;

export class AgentCliError extends Error {
  /**
   * HTTP 상태. 401이면 로그인이 풀린 것이다. 접속 실패처럼 응답이 없으면 없다.
   * code는 서버가 준 오류 코드(no_agent, license_required 등). 문구는 언어마다
   * 달라지므로 화면이 갈래를 나눌 때는 이걸 본다.
   */
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
  }
}

function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!url) throw new AgentCliError(msg().errEmptyAddress);
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  // 포트를 생략하면 매니저 기본 포트를 붙인다.
  if (!/:\d+/.test(url.replace(/^https?:\/\//i, ''))) url = `${url}:4000`;
  return url.replace(/\/+$/, '');
}

export class AgentCliClient {
  private baseUrl = '';
  private apiKey = '';

  /**
   * 접속 정보가 바뀌면 알린다.
   *
   * 스트림은 baseUrl과 토큰을 만들 때 한 번 박는다. 로그인 전에 만든
   * 것은 빈 주소를 보고 있어 쓸모가 없으므로, 정보가 정해지면 다시
   * 붙어야 한다.
   */
  private onConfigured?: () => void;

  /**
   * 401을 받았는지. 받았으면 접속 정보가 바뀔 때까지 주기 갱신을 멈춘다.
   *
   * 폰이 로그인 화면에 머무는 동안에도 안경은 5초마다 알림·할 일·세션을
   * 읽었다. 토큰이 없으니 전부 401이라, relay 로그에 '인증 실패'가 끝없이
   * 쌓였다.
   */
  private unauthorized = false;
  private unauthorizedListeners: Array<() => void> = [];

  configure(conn: Connection): void {
    const before = `${this.baseUrl}|${this.apiKey}`;
    this.baseUrl = normalizeBaseUrl(conn.baseUrl);
    this.apiKey = conn.apiKey.trim();
    // 접속 정보가 바뀌었다(로그인·서버 변경). 다시 두드려 본다.
    if (`${this.baseUrl}|${this.apiKey}` !== before) this.unauthorized = false;

    // 같은 값으로 다시 부르는 경우가 있다. 그때까지 스트림을 끊지 않는다.
    if (`${this.baseUrl}|${this.apiKey}` !== before) this.onConfigured?.();
  }

  /** 접속 정보가 바뀔 때 부를 함수를 건다. */
  onConnectionChange(fn: () => void): void {
    this.onConfigured = fn;
  }

  get connection(): Connection {
    return { baseUrl: this.baseUrl, apiKey: this.apiKey };
  }

  get isConfigured(): boolean {
    return this.baseUrl.length > 0;
  }

  /** 주기 갱신을 해도 되는지. 401을 받은 뒤로는 접속 정보가 바뀔 때까지 아니다. */
  get canPoll(): boolean {
    return !this.unauthorized;
  }

  /**
   * 로그인이 풀렸을 때(401) 부를 함수를 건다. 한 번 풀릴 때 한 번 부른다.
   * 로그인·초기 설정 요청의 401(비밀번호 틀림)은 세지 않는다.
   */
  onUnauthorized(fn: () => void): () => void {
    this.unauthorizedListeners.push(fn);
    return () => {
      this.unauthorizedListeners = this.unauthorizedListeners.filter((f) => f !== fn);
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.baseUrl) throw new AgentCliError(msg().errNotConfigured);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        // 응답이 없으면 기다리지 않는다. 폰 화면의 연결 버튼이 요청이 끝날
        // 때까지 꺼져 있어서, 서버가 멈추면 버튼도 몇 분씩 눌리지 않았다.
        // 오래 걸리는 명령 실행(runSnippet)은 이 길을 타지 않는다.
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...init,
        headers: {
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          // 서버가 개인 인증으로 바뀌어 Bearer를 쓴다.
          // x-api-key도 같이 보내 예전 설정과 호환된다.
          ...(this.apiKey
            ? { Authorization: `Bearer ${this.apiKey}`, 'x-api-key': this.apiKey }
            : {}),
          ...init.headers,
        },
      });
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') {
        throw new AgentCliError(msg().errTimeout(REQUEST_TIMEOUT_MS / 1000, this.baseUrl));
      }
      // 네트워크 자체가 안 되면 원인을 구체적으로 알려준다.
      throw new AgentCliError(msg().errConnect(this.baseUrl));
    }

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      // JSON이 아니면 빈 객체로 둔다.
    }

    if (!res.ok) {
      const err = (body as { error?: { message?: string; code?: string } }).error;
      // 401이면 서버 문구를 먼저 쓴다. 로그인 실패면 '아이디 또는 비밀번호가
      // 올바르지 않습니다'가 온다. 예전에는 늘 'API 키가 맞지 않습니다'라
      // 계정으로 로그인하는데 키를 물어보는 것처럼 보였다.
      if (res.status === 401) {
        if (!path.startsWith('/auth/') && !this.unauthorized) {
          this.unauthorized = true;
          for (const fn of this.unauthorizedListeners) fn();
        }
        throw new AgentCliError(err?.message ?? msg().errLoggedOut, 401);
      }
      throw new AgentCliError(err?.message ?? msg().errRequest(res.status), res.status, err?.code);
    }
    return body as T;
  }

  // --- 확장 에이전트(mac-agent) ---
  //
  // relay-service의 /ext 통로로 붙은 에이전트. 서버는 이름으로 나눠 넘기기만 한다.

  /** 붙어 있는 확장 에이전트와 각자의 기능 목록. */
  async listExt(): Promise<ExtAgent[]> {
    const { agents } = await this.request<{ agents: ExtAgent[] }>('/ext');
    return agents ?? [];
  }

  /**
   * mac-agent의 경로를 부른다. path는 /present/state처럼 에이전트 쪽 경로다.
   * 본문을 주면 POST. 단축어처럼 오래 걸리는 것은 timeoutMs를 늘린다
   * (relay는 30초에 끊고, mac-agent는 25초가 넘으면 '도는 중'으로 먼저 답한다).
   */
  mac<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    return this.request<T>(`/ext/mac-agent${path}`, {
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  }

  /**
   * mac-agent의 SSE를 받는다. 이름 붙은 이벤트(state·caption)를 그대로 넘긴다.
   * 열리기 전에 끊기면 onError로 알린다 — 부른 쪽은 폴링으로 물러선다.
   */
  streamMac(
    path: string,
    types: string[],
    onEvent: (type: string, data: unknown) => void,
    onError?: (message: string) => void,
  ): () => void {
    const url = `${this.baseUrl}/ext/mac-agent${path}${
      this.apiKey ? `?token=${encodeURIComponent(this.apiKey)}` : ''
    }`;
    try {
      const es = new EventSource(url);
      let opened = false;
      es.onopen = () => {
        opened = true;
      };
      for (const type of types) {
        es.addEventListener(type, (e) => {
          try {
            onEvent(type, JSON.parse((e as MessageEvent).data));
          } catch {
            // 깨진 프레임은 버린다.
          }
        });
      }
      es.onerror = () => {
        if (!opened) onError?.(msg().errStream);
      };
      return () => es.close();
    } catch {
      onError?.(msg().errStreamUnsupported);
      return () => undefined;
    }
  }

  /** 서버가 설정됐는지 본다. 인증 없이 호출할 수 있다. */
  async authStatus(): Promise<AuthStatus> {
    return this.request<AuthStatus>('/auth/status');
  }

  async login(username: string, password: string, label = msg().deviceLabel): Promise<string> {
    const { token } = await this.request<{ token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password, label }),
    });
    return token;
  }

  /** code는 relay-service 시작 로그에 찍힌 설정 코드다. 없으면 서버가 403으로 거절한다. */
  async setup(username: string, password: string, code: string): Promise<string> {
    const { token } = await this.request<{ token: string }>('/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ username, password, code }),
    });
    return token;
  }

  async health(): Promise<{ ok: boolean }> {
    return this.request('/health');
  }

  async listSessions(): Promise<SessionInfo[]> {
    const { sessions } = await this.request<{ sessions: SessionInfo[] }>('/sessions');
    return sessions;
  }

  async getSession(id: string): Promise<SessionInfo> {
    const { session } = await this.request<{ session: SessionInfo }>(`/sessions/${id}`);
    return session;
  }

  async getHistory(id: string, limit = 40): Promise<SessionEvent[]> {
    const { events } = await this.request<{ events: SessionEvent[] }>(
      `/sessions/${id}/history?limit=${limit}`,
    );
    return events;
  }

  /**
   * 종료된 세션의 대화를 이어간다. 새 세션이 만들어져 돌아온다.
   * deleteOriginal을 주면 이어간 뒤 원본 기록을 지운다 (되돌릴 수 없음).
   */
  async resumeSession(
    id: string,
    deleteOriginal = false,
  ): Promise<{ session: SessionInfo; deletedOriginal: boolean }> {
    return this.request<{ session: SessionInfo; deletedOriginal: boolean }>(
      `/sessions/${id}/resume`,
      { method: 'POST', body: JSON.stringify({ deleteOriginal }) },
    );
  }

  /** 접속 직후 폰 로그에 띄우는 서버 상태. 안경에는 쓰지 않는다. */
  async motd(): Promise<{ lines: string[] }> {
    return this.request<{ lines: string[] }>('/motd');
  }

  // --- 알림 ---
  //
  // 서버가 쌓아둔다. 안경에서 한 번 놓쳐도 다시 볼 수 있다.

  // --- 시스템 상태 ---
  //
  // terminal-agent가 갖고 있다. 터미널을 만들지 않고도 읽을 수 있다.

  /** 폰(Relay 앱)의 타이머·물 마시기. 폰에 붙어 있을 때만 있다. */
  async phoneStatus(): Promise<PhoneStatus> {
    return this.request<PhoneStatus>('/phone/status');
  }

  /** 폰의 타이머를 조작한다. start에 minutes(60·30·15)를 주면 그 길이로 새로 시작한다. */
  async phoneTimer(action: PhoneTimerAction, minutes?: number): Promise<PhoneStatus> {
    return this.request<PhoneStatus>('/phone/timer', {
      method: 'POST',
      body: JSON.stringify(minutes ? { action, minutes } : { action }),
    });
  }

  /** 물 한 잔을 세거나 뺀다. */
  async phoneWater(action: 'drink' | 'undo'): Promise<PhoneStatus> {
    return this.request<PhoneStatus>('/phone/water', { method: 'POST', body: JSON.stringify({ action }) });
  }

  async sysSummary(): Promise<SysSummary> {
    return this.request<SysSummary>('/sys/summary');
  }

  async sysProcs(n = 8): Promise<SysProc[]> {
    const { procs } = await this.request<{ procs: SysProc[] }>(`/sys/procs?n=${n}`);
    return procs;
  }

  // --- 등록한 명령 ---

  async listSnippets(): Promise<Snippet[]> {
    const { items } = await this.request<{ items: Snippet[] }>('/snippets');
    return items;
  }

  /**
   * 등록한 명령을 실행한다.
   *
   * 되돌릴 수 없어 보이는 명령은 서버가 409로 막는다. 그때는
   * needsConfirm이 참으로 와서, 부르는 쪽이 사용자에게 묻고 confirm을
   * 실어 다시 부른다.
   */
  async runSnippet(
    id: string,
    confirm = false,
  ): Promise<{ result?: RunResult; needsConfirm?: boolean; risks?: RunResult['risks'] }> {
    const res = await fetch(`${this.baseUrl}/snippets/${id}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey
          ? { Authorization: `Bearer ${this.apiKey}`, 'x-api-key': this.apiKey }
          : {}),
      },
      body: JSON.stringify({ confirm }),
    });

    const text = await res.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    // 409는 오류가 아니라 "확인이 필요하다"는 답이다.
    if (res.status === 409) {
      return { needsConfirm: true, risks: body.risks as RunResult['risks'] };
    }
    if (!res.ok) {
      const err = body.error as { message?: string } | undefined;
      throw new AgentCliError(err?.message ?? msg().errRun(res.status));
    }
    return { result: body as unknown as RunResult };
  }

  async listNotifications(): Promise<{ items: Notification[]; unread: number }> {
    return this.request<{ items: Notification[]; unread: number }>('/notifications');
  }

  async addNotification(input: {
    title: string;
    body?: string;
    kind?: Notification['kind'];
    sessionId?: string;
  }): Promise<Notification> {
    const { item } = await this.request<{ item: Notification }>('/notifications', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return item;
  }

  async readNotification(id: string): Promise<number> {
    const { unread } = await this.request<{ unread: number }>(`/notifications/${id}/read`, {
      method: 'POST',
      body: '{}',
    });
    return unread;
  }

  async readAllNotifications(): Promise<void> {
    await this.request('/notifications/read-all', { method: 'POST', body: '{}' });
  }

  async clearReadNotifications(): Promise<{ items: Notification[]; unread: number }> {
    return this.request<{ items: Notification[]; unread: number }>('/notifications/clear-read', {
      method: 'POST',
      body: '{}',
    });
  }

  // --- 전역 체크리스트 (세션과 무관) ---

  async getGlobalChecklist(): Promise<ChecklistItem[]> {
    const { items } = await this.request<{ items: ChecklistItem[] }>('/checklist');
    return items;
  }

  async addGlobalChecklist(text: string): Promise<ChecklistItem[]> {
    const { items } = await this.request<{ items: ChecklistItem[] }>('/checklist', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    return items;
  }

  async toggleGlobalChecklist(itemId: string): Promise<ChecklistItem[]> {
    const { items } = await this.request<{ items: ChecklistItem[] }>(
      `/checklist/${itemId}/toggle`,
      { method: 'POST', body: '{}' },
    );
    return items;
  }

  async clearDoneGlobalChecklist(): Promise<ChecklistItem[]> {
    const { items } = await this.request<{ items: ChecklistItem[] }>('/checklist/clear-done', {
      method: 'POST',
      body: '{}',
    });
    return items;
  }

  // --- 세션별 체크리스트 ---

  async getChecklist(id: string): Promise<ChecklistItem[]> {
    const { items } = await this.request<{ items: ChecklistItem[] }>(
      `/sessions/${id}/checklist`,
    );
    return items;
  }

  /** 여러 줄을 보내면 줄마다 항목이 된다. */
  async addChecklist(id: string, text: string): Promise<ChecklistItem[]> {
    const { items } = await this.request<{ items: ChecklistItem[] }>(
      `/sessions/${id}/checklist`,
      { method: 'POST', body: JSON.stringify({ text }) },
    );
    return items;
  }

  async toggleChecklist(id: string, itemId: string): Promise<ChecklistItem[]> {
    const { items } = await this.request<{ items: ChecklistItem[] }>(
      `/sessions/${id}/checklist/${itemId}/toggle`,
      { method: 'POST', body: '{}' },
    );
    return items;
  }

  async clearDoneChecklist(id: string): Promise<ChecklistItem[]> {
    const { items } = await this.request<{ items: ChecklistItem[] }>(
      `/sessions/${id}/checklist/clear-done`,
      { method: 'POST', body: '{}' },
    );
    return items;
  }

  async sendInput(id: string, prompt: string): Promise<void> {
    await this.request(`/sessions/${id}/input`, {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    });
  }

  /** 세션의 권한 정책을 바꾼다. auto-approve면 더는 묻지 않는다. */
  async setPolicy(
    id: string,
    policyMode: 'ask-risky' | 'ask-all' | 'auto-approve',
  ): Promise<void> {
    await this.request(`/sessions/${id}/policy`, {
      method: 'POST',
      body: JSON.stringify({ policyMode }),
    });
  }

  async resolvePermission(id: string, requestId: string, behavior: 'allow' | 'deny'): Promise<void> {
    await this.request(`/sessions/${id}/permissions`, {
      method: 'POST',
      body: JSON.stringify({ requestId, behavior }),
    });
  }

  /**
   * 세션 이벤트를 구독한다. 반환값을 호출하면 끊는다.
   *
   * WebView에서 EventSource가 막히는 경우가 있어, 실패하면 폴링으로 물러선다.
   */
  streamSession(
    sessionId: string,
    onEvent: (event: SessionEvent) => void,
    onError?: (message: string) => void,
  ): () => void {
    // EventSource는 헤더를 못 붙이므로 쿼리로 넘긴다.
    const url = `${this.baseUrl}/sessions/${sessionId}/stream${
      this.apiKey ? `?token=${encodeURIComponent(this.apiKey)}` : ''
    }`;

    const types = [
      'status',
      'session',
      'user',
      'assistant',
      'thinking',
      'tool_use',
      'tool_result',
      'permission_request',
      'permission_resolved',
      'turn_complete',
      'stderr',
      'closed',
    ];

    try {
      const es = new EventSource(url);
      let opened = false;
      es.onopen = () => {
        opened = true;
      };
      for (const type of types) {
        es.addEventListener(type, (e) => {
          try {
            onEvent(JSON.parse((e as MessageEvent).data) as SessionEvent);
          } catch {
            // 깨진 프레임은 버린다.
          }
        });
      }
      es.onerror = () => {
        if (!opened) onError?.(msg().errStream);
      };
      return () => es.close();
    } catch {
      onError?.(msg().errStreamUnsupported);
      return () => undefined;
    }
  }

  /**
   * 서버가 들고 있는 자료(체크리스트·알림)가 바뀌면 알려준다.
   *
   * 무엇이 바뀌었는지만 온다. 내용은 받은 쪽이 다시 읽는다. 웹에서 할
   * 일을 더하면 안경도 곧바로 안다.
   *
   * 서버가 이 경로를 모르면(옛 버전) 조용히 아무 일도 하지 않는다.
   * 그때는 부르는 쪽의 주기 갱신이 대신 메운다.
   */
  streamEvents(
    onChange: (topic: 'checklist' | 'notifications') => void,
    onDown?: (down: boolean) => void,
  ): () => void {
    const url = `${this.baseUrl}/events${
      this.apiKey ? `?token=${encodeURIComponent(this.apiKey)}` : ''
    }`;

    try {
      const es = new EventSource(url);

      // 서버는 붙자마자 hello를 보낸다. 그게 오면 스트림이 산 것이다.
      // onopen만으로는 부족하다 — G2 웹뷰에서 연결은 열리고 본문이
      // 오지 않는 경우가 있어, 실제 프레임을 받아야 살았다고 본다.
      es.addEventListener('hello', () => onDown?.(false));

      es.addEventListener('changed', (e) => {
        onDown?.(false);
        try {
          const { topic } = JSON.parse((e as MessageEvent).data) as { topic: string };
          if (topic === 'checklist' || topic === 'notifications') onChange(topic);
        } catch {
          // 하나가 깨져도 스트림은 이어간다.
        }
      });

      // 웹뷰가 SSE를 막거나 인증이 틀리면 여기로 온다. 부르는 쪽이
      // 폴링을 촘촘히 돌려 메우게 알려준다. EventSource는 스스로
      // 다시 붙으려 하므로 닫지는 않는다.
      es.onerror = () => onDown?.(true);

      return () => es.close();
    } catch {
      // EventSource 자체가 없는 웹뷰다. 폴링만으로 가야 한다.
      onDown?.(true);
      return () => undefined;
    }
  }
}

export const agentCli = new AgentCliClient();
