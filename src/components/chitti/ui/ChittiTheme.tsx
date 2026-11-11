import { useEffect, useState, type ReactNode } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { chittiTheme } from "./theme";

export type ColorMode = "light" | "dark";

/** The site toggle writes `data-theme="light"` on <html>; absent means dark. */
export function siteColorMode(root: HTMLElement = document.documentElement): ColorMode {
  return root.dataset.theme === "light" ? "light" : "dark";
}

/** Follows the site's light/dark toggle for as long as the component is mounted. */
export function useSiteColorMode(): ColorMode {
  const [mode, setMode] = useState<ColorMode>(() =>
    typeof document === "undefined" ? "dark" : siteColorMode(),
  );
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setMode(siteColorMode(root));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return mode;
}

/** Wraps the workspace in the Chitti theme, in the site's current colour mode. */
export function ChittiTheme({ children }: { children: ReactNode }) {
  const mode = useSiteColorMode();
  return (
    <Theme theme={chittiTheme} mode={mode}>
      {children}
    </Theme>
  );
}
