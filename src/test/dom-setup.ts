// jsdom stubs for browser APIs the Astryx components call. Production code
// never imports this file; vitest loads it before every test file and it does
// nothing in the default node environment.
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
  g.IntersectionObserver ||= NoopObserver;
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
  const el = window.HTMLElement.prototype as HTMLElement & Record<string, unknown>;
  if (!el.showPopover) {
    el.showPopover = function (this: HTMLElement) {
      this.dataset.popoverOpen = "";
      this.dispatchEvent(Object.assign(new Event("toggle"), { newState: "open", oldState: "closed" }));
    };
    el.hidePopover = function (this: HTMLElement) {
      delete this.dataset.popoverOpen;
      this.dispatchEvent(Object.assign(new Event("toggle"), { newState: "closed", oldState: "open" }));
    };
    el.togglePopover = function (this: HTMLElement, force?: boolean) {
      const open = force ?? !("popoverOpen" in this.dataset);
      if (open) this.showPopover();
      else this.hidePopover();
      return open;
    };
  }
  // jsdom hides every [popover] (no :popover-open support); show the ones
  // the stub above has opened so role queries see open menus and listboxes.
  const style = document.createElement("style");
  style.textContent = "[popover][data-popover-open] { display: block !important; }";
  document.head.appendChild(style);
  const proto = window.Element.prototype as Element & Record<string, unknown>;
  proto.scrollIntoView ||= function () {};
  proto.scrollBy ||= function () {};
  proto.scrollTo ||= function () {};
  proto.animate ||= function () {
    return {
      finished: Promise.resolve(),
      cancel() {},
      finish() {},
      play() {},
      pause() {},
      addEventListener() {},
      removeEventListener() {},
      onfinish: null,
    };
  };
  proto.getAnimations ||= () => [];
}
