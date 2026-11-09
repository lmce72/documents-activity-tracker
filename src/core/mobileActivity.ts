export type MobileActivitySignal =
  | 'startup' | 'poll' | 'window-focus' | 'window-blur'
  | 'visibility-visible' | 'visibility-hidden' | 'page-freeze' | 'page-resume'
  | 'pagehide' | 'pageshow' | 'capacitor-pause' | 'capacitor-resume'
  | 'capacitor-app-state' | 'capacitor-poll-state';

export interface MobileWebState {
  visible: boolean;
  focused: boolean;
}

/** Explicit lifecycle boundaries win over stale WebView/native polling results. */
export class MobileActivity {
  visible = true;
  focused = true;
  nativeActive: boolean | null = null;
  nativePaused = false;
  frozen = false;
  private observedSignal = false;

  update(signal: MobileActivitySignal, suspended: boolean, web: MobileWebState): void {
    const initial = !this.observedSignal;
    this.observedSignal = true;
    switch (signal) {
      case 'startup':
        if (initial) {
          this.visible = web.visible;
          this.focused = web.focused;
        } else {
          if (!web.visible) this.visible = false;
          if (!web.focused) this.focused = false;
        }
        break;
      case 'poll':
        // 轮询只能补充停止信号，不能撤销明确的退后台事件。
        // Polling may discover backgrounding, but cannot undo an explicit stop.
        if (!web.visible) this.visible = false;
        if (!web.focused) this.focused = false;
        break;
      case 'window-focus': this.focused = true; break;
      case 'window-blur': this.focused = false; break;
      case 'visibility-hidden':
      case 'pagehide': this.visible = false; break;
      case 'visibility-visible':
      case 'pageshow':
        this.visible = web.visible;
        this.focused = web.focused;
        break;
      case 'page-freeze': this.frozen = true; break;
      case 'page-resume':
        this.frozen = false;
        this.visible = web.visible;
        this.focused = web.focused;
        break;
      case 'capacitor-pause': this.nativePaused = true; break;
      case 'capacitor-resume':
        this.nativePaused = false;
        this.nativeActive = true;
        this.visible = web.visible;
        this.focused = web.focused;
        break;
      case 'capacitor-app-state':
        this.nativeActive = !suspended;
        if (!suspended) {
          this.nativePaused = false;
          this.visible = web.visible;
          this.focused = web.focused;
        }
        break;
      case 'capacitor-poll-state':
        // Android getState() can remain active between onPause and onStop.
        // A positive poll therefore cannot release pause or a previous native stop.
        if (suspended) this.nativeActive = false;
        else if (this.nativeActive === null) this.nativeActive = true;
        break;
    }
  }

  background(multiWindow: boolean): boolean {
    if (!this.visible || this.frozen || this.nativeActive === false) return true;
    // Android onPause can mean a still-visible DeX window. onStop/hidden always wins.
    return !multiWindow && (!this.focused || this.nativePaused);
  }
}
