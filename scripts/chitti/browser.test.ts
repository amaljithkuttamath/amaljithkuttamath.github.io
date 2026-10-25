import { expect, it, vi } from "vitest";
import { openSignIn } from "./browser.mjs";
const url =
  "https://auth.openai.com/api/accounts/authorize?state=example&client_id=issued";
it.each([
  ["darwin", "open", [url]],
  ["linux", "xdg-open", [url]],
  ["win32", "rundll32.exe", ["url.dll,FileProtocolHandler", url]],
])(
  "opens official sign-in with fixed arguments on %s",
  async (platform, command, args) => {
    const run = vi.fn(async () => {});
    expect(await openSignIn(url, run, platform)).toBe(true);
    expect(run).toHaveBeenCalledWith(command, args, {
      timeout: 10000,
      windowsHide: true,
    });
  },
);
it.each([
  "not a URL",
  "file:///tmp/anything",
  "https://auth.openai.com.evil.example/api/accounts/authorize",
  "https://auth.openai.com/other",
  "javascript:alert(1)",
])("refuses non-sign-in targets: %s", async (target) => {
  const run = vi.fn();
  expect(await openSignIn(target, run)).toBe(false);
  expect(run).not.toHaveBeenCalled();
});
it("leaves the manual link available when browser opening fails", async () => {
  expect(
    await openSignIn(url, vi.fn().mockRejectedValue(new Error("No browser"))),
  ).toBe(false);
});
