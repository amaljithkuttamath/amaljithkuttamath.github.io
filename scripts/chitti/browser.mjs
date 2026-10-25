import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
/**
 * @param {string} url
 * @param {(file: string, args: string[], options: {timeout: number, windowsHide: boolean}) => Promise<unknown>} run
 * @param {string} platform
 */
export async function openSignIn(
  url,
  run = execute,
  platform = process.platform,
) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (
    target.origin !== "https://auth.openai.com" ||
    target.pathname !== "/api/accounts/authorize"
  )
    return false;
  const command =
    platform === "darwin"
      ? "open"
      : platform === "win32"
        ? "rundll32.exe"
        : "xdg-open";
  const args =
    platform === "win32"
      ? ["url.dll,FileProtocolHandler", target.href]
      : [target.href];
  try {
    await run(command, args, { timeout: 10_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
