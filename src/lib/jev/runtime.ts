/** Only a build-time configured HTTPS endpoint can receive public input. Never read it from URL parameters. */
export function classificationBase(dev: boolean, configured: unknown): string | null {
  if (dev) return '';
  if (typeof configured !== 'string' || !configured.trim()) return null;
  try {
    const url = new URL(configured.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}
