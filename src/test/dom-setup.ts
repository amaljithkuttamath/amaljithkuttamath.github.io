// jsdom stubs for the browser APIs Chitti's components call (ResizeObserver
// for the chart host, matchMedia for reduced motion, <dialog> modality,
// scrollIntoView). Production code never imports this file; vitest loads it
// before every test file and it does nothing in the default node environment.
if (typeof window !== "undefined" && typeof document !== "undefined") {
  const g = globalThis as Record<string, unknown>;
  class NoopObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  g.ResizeObserver ||= NoopObserver;
  if (!window.matchMedia)
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  const dialog = window.HTMLDialogElement?.prototype;
  if (dialog && !dialog.showModal) {
    dialog.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    dialog.show = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    dialog.close = function (this: HTMLDialogElement, value?: string) {
      if (!this.hasAttribute("open")) return;
      this.removeAttribute("open");
      if (value !== undefined) this.returnValue = value;
      this.dispatchEvent(new Event("close"));
    };
  }
  const proto = window.Element.prototype as Element & Record<string, unknown>;
  proto.scrollIntoView ||= function () {};
}
