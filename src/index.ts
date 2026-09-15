/**
 * glasses-ui — agent-cli와 스마트 안경 사이를 잇는 계층.
 *
 * agent-cli는 맥의 터미널과 Claude Code CLI를 제어하고,
 * 여기서 그 상태를 안경으로 옮기고 안경 입력을 명령으로 되돌린다.
 *
 * 화면 전환과 제스처 매핑은 전부 이쪽에 있다. `glasses/`는 이걸 Even Hub
 * 앱으로 포장하는 껍데기다. 안경 종류는 GlassesAdapter 구현으로 늘린다.
 * 지금은 G2 하나다.
 */

export { GlassesUI, type GlassesUIHooks } from './core/glasses-ui.js';
export {
  agentCli,
  AgentCliClient,
  AgentCliError,
  type Connection,
  type SessionEvent,
  type SessionInfo,
} from './core/agent-cli.js';
export { clamp, type Gesture, type GestureEvent, type GlassesAdapter } from './core/glasses.js';

// 기본 제공 어댑터
export { G2Adapter } from './adapters/g2.js';
