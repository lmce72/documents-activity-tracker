/** Native lifecycle and WebView signals must agree before mobile recording resumes. */
export class MobileActivity {
  visible = true;
  focused = true;
  nativeActive: boolean | null = null;
  nativePaused = false;
  frozen = false;

  background(multiWindow: boolean): boolean {
    if (!this.visible || this.frozen || this.nativeActive === false) return true;
    // Android onPause can mean a still-visible DeX window. onStop/hidden always wins.
    return !multiWindow && (!this.focused || this.nativePaused);
  }
}
