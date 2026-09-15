/**
 * agent-cli(맥의 터미널/Claude Code CLI 제어기)와 통신한다.
 *
 * 지금은 같은 네트워크의 agent-cli에 직접 붙는다.
 * 나중에 외부 서버를 거치게 되면 baseUrl만 그쪽으로 바꾸면 되도록,
 * 이 파일 밖에서는 접속 경로를 알지 못하게 했다.
 */

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
}

export class AgentCliError extends Error {}

function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!url) throw new AgentCliError('주소가 비어 있습니다.');
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

  configure(conn: Connection): void {
    const before = `${this.baseUrl}|${this.apiKey}`;
    this.baseUrl = normalizeBaseUrl(conn.baseUrl);
    this.apiKey = conn.apiKey.trim();

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

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.baseUrl) throw new AgentCliError('agent-cli 주소가 설정되지 않았습니다.');

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
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
    } catch {
      // 네트워크 자체가 안 되면 원인을 구체적으로 알려준다.
      throw new AgentCliError(`접속 실패: ${this.baseUrl}\n같은 와이파이인지, agent-cli가 켜져 있는지 확인하세요.`);
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
      const err = (body as { error?: { message?: string } }).error;
      if (res.status === 401) throw new AgentCliError('API 키가 맞지 않습니다.');
      throw new AgentCliError(err?.message ?? `요청 실패 (${res.status})`);
    }
    return body as T;
  }

  /** 서버가 설정됐는지 본다. 인증 없이 호출할 수 있다. */
  async authStatus(): Promise<AuthStatus> {
    return this.request<AuthStatus>('/auth/status');
  }

  async login(username: string, password: string, label = '안경'): Promise<string> {
    const { token } = await this.request<{ token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password, label }),
    });
    return token;
  }

  async setup(username: string, password: string): Promise<string> {
    const { token } = await this.request<{ token: string }>('/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
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
        if (!opened) onError?.('실시간 연결 실패');
      };
      return () => es.close();
    } catch {
      onError?.('실시간 연결을 지원하지 않습니다.');
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
  streamEvents(onChange: (topic: 'checklist' | 'notifications') => void): () => void {
    const url = `${this.baseUrl}/events${
      this.apiKey ? `?token=${encodeURIComponent(this.apiKey)}` : ''
    }`;

    try {
      const es = new EventSource(url);

      es.addEventListener('changed', (e) => {
        try {
          const { topic } = JSON.parse((e as MessageEvent).data) as { topic: string };
          if (topic === 'checklist' || topic === 'notifications') onChange(topic);
        } catch {
          // 하나가 깨져도 스트림은 이어간다.
        }
      });

      return () => es.close();
    } catch {
      return () => undefined;
    }
  }
}

export const agentCli = new AgentCliClient();
