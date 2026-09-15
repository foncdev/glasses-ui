/**
 * 작업 완료 음성 알림.
 *
 * G2에는 스피커가 없다. 소리는 폰에서 난다(Web Speech API).
 * WebView에 따라 speechSynthesis가 없거나 막혀 있을 수 있으므로
 * 없으면 조용히 넘어간다 — 알림이 없다고 앱이 멈추면 안 된다.
 */

export class Speaker {
  private enabled = true;
  private available = typeof window !== 'undefined' && 'speechSynthesis' in window;
  /** 같은 말을 연달아 반복하지 않기 위해 마지막 문장을 기억한다. */
  private last = '';

  get isAvailable(): boolean {
    return this.available;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.stop();
  }

  /** 짧게 읽어준다. 긴 결과는 앞부분만 읽는다. */
  speak(text: string, lang = 'ko-KR'): void {
    if (!this.enabled || !this.available) return;
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean || clean === this.last) return;
    this.last = clean;

    try {
      // 이전 발화가 남아 있으면 끊고 새로 읽는다.
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(clean.slice(0, 220));
      u.lang = lang;
      u.rate = 1.05;
      window.speechSynthesis.speak(u);
    } catch {
      // TTS 실패는 무시한다. 화면 표시가 본체다.
    }
  }

  stop(): void {
    if (!this.available) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      // 무시한다.
    }
  }
}

export const speaker = new Speaker();
