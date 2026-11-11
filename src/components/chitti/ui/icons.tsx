import type { SVGProps } from "react";

/**
 * Chitti's line glyphs: one 24px grid, 1.5 stroke, currentColor. Decorative:
 * the control around them carries the accessible name.
 */
type Glyph = (props: SVGProps<SVGSVGElement>) => React.JSX.Element;
const glyph =
  (...paths: string[]): Glyph =>
  (props) => (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );

export const UndoIcon = glyph("M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11");
export const RedoIcon = glyph("m15 14 5-5-5-5", "M20 9H9.5a5.5 5.5 0 0 0 0 11H13");
export const SteerIcon = glyph("M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z");
export const StepsIcon = glyph("M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01");
export const ShareIcon = glyph("M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7", "m16 6-4-4-4 4", "M12 2v13");
export const DownloadIcon = glyph("M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5", "M12 15V3");
export const PinIcon = glyph("M12 17v5", "M9 10.76V6h6v4.76l2.5 3.74H6.5Z", "M8 2h8");
export const PlusIcon = glyph("M12 5v14", "M5 12h14");
export const SettingsIcon = glyph(
  "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z",
);
export const DashboardIcon = glyph("M3 3h7v9H3Z", "M14 3h7v5h-7Z", "M14 12h7v9h-7Z", "M3 16h7v5H3Z");
export const SparkIcon = glyph("M12 3v4", "M12 17v4", "M3 12h4", "M17 12h4", "m6 6 2.5 2.5", "m15.5 15.5 2.5 2.5", "m6 18 2.5-2.5", "m15.5 8.5 2.5-2.5");
export const SendIcon = glyph("M5 12h14", "m13 6 6 6-6 6");
export const ChartIcon = glyph("M3 3v18h18", "m7 15 4-4 3 3 5-6");
export const ContextIcon = glyph("M4 5h16v10H4Z", "M8 19h8", "M12 15v4");
export const RefreshIcon = glyph("M21 12a9 9 0 1 1-2.64-6.36L21 8", "M21 3v5h-5");
export const ExpandIcon = glyph("M15 3h6v6", "M9 21H3v-6", "M21 3l-7 7", "M3 21l7-7");
export const CloseIcon = glyph("M6 6l12 12", "M18 6 6 18");
export const MenuIcon = glyph("M4 7h16", "M4 12h16", "M4 17h16");
export const BackIcon = glyph("m15 18-6-6 6-6");
export const StopIcon = glyph("M7 7h10v10H7Z");
export const UpIcon = glyph("M12 19V5", "m6 11 6-6 6 6");
export const FullscreenIcon = glyph("M8 3H3v5", "M16 3h5v5", "M8 21H3v-5", "M16 21h5v-5");
export const SearchIcon = glyph("M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z", "m20 20-3.5-3.5");
export const CheckIcon = glyph("m5 12 4.5 4.5L19 7");
export const MoreIcon = glyph("M5 12h.01", "M12 12h.01", "M19 12h.01");
