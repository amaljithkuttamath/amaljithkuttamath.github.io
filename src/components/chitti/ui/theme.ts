import { defineTheme } from "@astryxdesign/core/theme";

/**
 * Chitti's one Astryx theme. Every colour, size, radius and duration the
 * workspace paints comes from these tokens; `chitti.css` only references them.
 *
 * Dark is the default ("deep field"): a blue-black canvas, translucent glass
 * surfaces split by 1px luminous hairlines, and an electric cyan → violet
 * accent reserved for the primary action, selection, focus and live states.
 * Light ("lab white") is the real counterpart: cool off-white canvas, ink
 * text and a deeper cyan/indigo accent. Each value is a [light, dark] pair.
 *
 * Contrast (WCAG 2.x, light / dark, against the canvas): text-primary
 * 17.3:1 / 17.3:1, text-secondary 7.2:1 / 8.4:1, text-accent 5.2:1 / 13.1:1,
 * on-accent over either gradient stop at least 5.6:1.
 */

const INK = "#0b1220";
const CANVAS: [string, string] = ["#f3f6fa", "#05070c"];

export const chittiTheme = defineTheme({
  name: "chitti",
  typography: {
    body: {
      family: "Inter",
      fallbacks: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    },
    heading: {
      family: "Inter",
      fallbacks: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      weight: "semibold",
    },
    code: {
      family: "JetBrains Mono",
      fallbacks: '"SF Mono", ui-monospace, Menlo, monospace',
    },
  },
  // 150–250ms, never springy: motion marks arrivals, not decoration.
  motion: { fast: 150, medium: 220, slow: 250, ratio: 0.8 },
  localTokens: {
    // Second stop of the accent gradient (cyan → violet).
    "--chitti-violet": ["#5b4fe0", "#8a7dff"],
    // Glass: the faint lift a panel gets over the canvas, and its hairline glow.
    "--chitti-glass": ["rgba(255, 255, 255, 0.78)", "rgba(18, 26, 42, 0.55)"],
    "--chitti-glass-strong": ["rgba(255, 255, 255, 0.94)", "rgba(12, 18, 31, 0.92)"],
    "--chitti-glow": ["rgba(11, 110, 153, 0.10)", "rgba(77, 226, 255, 0.10)"],
    "--chitti-grid": ["rgba(11, 18, 32, 0.045)", "rgba(148, 197, 255, 0.045)"],
  },
  tokens: {
    // ── Type: one scale, six sizes, nothing under 12px ──────────────────
    "--font-size-4xs": "0.75rem",
    "--font-size-3xs": "0.75rem",
    "--font-size-2xs": "0.75rem",
    "--font-size-xs": "0.75rem",
    "--font-size-sm": "0.75rem",
    "--font-size-base": "0.875rem",
    "--font-size-lg": "1rem",
    "--font-size-xl": "1.25rem",
    "--font-size-2xl": "1.5rem",
    "--font-size-3xl": "2rem",
    "--font-size-4xl": "2rem",
    "--font-size-5xl": "2rem",
    "--text-body-leading": "1.55",
    "--text-supporting-leading": "1.45",
    "--text-code-size": "0.75rem",
    "--text-heading-1-size": "2rem",
    "--text-heading-2-size": "1.25rem",
    "--text-heading-3-size": "1rem",
    "--text-heading-4-size": "0.875rem",
    "--text-heading-5-size": "0.875rem",
    "--text-heading-6-size": "0.75rem",

    // ── Shape: one radius scale, one control-height scale ───────────────
    "--radius-inner": "6px",
    "--radius-element": "10px",
    "--radius-container": "14px",
    "--radius-page": "20px",
    "--radius-chat": "20px",
    "--size-element-sm": "30px",
    "--size-element-md": "36px",
    "--size-element-lg": "44px",

    // ── Canvas and surfaces ─────────────────────────────────────────────
    "--color-background-body": CANVAS,
    "--color-background-surface": ["#ffffff", "#0b111d"],
    "--color-background-card": ["rgba(255, 255, 255, 0.82)", "rgba(16, 23, 38, 0.58)"],
    "--color-background-popover": ["#ffffff", "#0c1220"],
    "--color-background-muted": ["#e9eef5", "rgba(148, 197, 255, 0.06)"],
    "--color-background-inverted": [INK, "#e8eef7"],
    "--color-overlay": ["rgba(11, 18, 32, 0.45)", "rgba(2, 4, 8, 0.72)"],
    "--color-overlay-hover": ["rgba(11, 18, 32, 0.05)", "rgba(148, 197, 255, 0.07)"],
    "--color-overlay-pressed": ["rgba(11, 18, 32, 0.09)", "rgba(148, 197, 255, 0.12)"],
    "--color-neutral": ["rgba(11, 18, 32, 0.06)", "rgba(148, 197, 255, 0.08)"],
    "--color-tint-hover": [INK, "#e8eef7"],
    "--color-skeleton": ["#dfe6ef", "rgba(148, 197, 255, 0.10)"],
    "--color-track": ["#d7dee8", "rgba(148, 197, 255, 0.14)"],
    "--color-shadow": ["rgba(11, 18, 32, 0.10)", "rgba(0, 0, 0, 0.5)"],

    // Hairlines, not fills: borders carry the structure.
    "--color-border": ["rgba(11, 18, 32, 0.11)", "rgba(148, 197, 255, 0.13)"],
    "--color-border-emphasized": ["rgba(11, 18, 32, 0.24)", "rgba(148, 210, 255, 0.30)"],

    // ── Text and icons: neutral, high contrast ──────────────────────────
    "--color-text-primary": [INK, "#e8eef7"],
    "--color-text-secondary": ["#46536a", "#9aa8bd"],
    "--color-text-disabled": ["#8792a5", "#5b6779"],
    "--color-icon-primary": [INK, "#e8eef7"],
    "--color-icon-secondary": ["#46536a", "#9aa8bd"],
    "--color-icon-disabled": ["#8792a5", "#5b6779"],
    "--color-on-dark": "#f4f8fc",
    "--color-on-light": INK,

    // ── Accent: electric cyan (dark) / deep cyan (light) ────────────────
    "--color-accent": ["#0b6e99", "#4de2ff"],
    "--color-accent-muted": ["rgba(11, 110, 153, 0.12)", "rgba(77, 226, 255, 0.14)"],
    "--color-text-accent": ["#0b6e99", "#4de2ff"],
    "--color-icon-accent": ["#0b6e99", "#4de2ff"],
    "--color-on-accent": ["#ffffff", "#03131b"],
    "--focus-outline-color": ["#0b6e99", "#4de2ff"],
    "--focus-outline-offset": "2px",

    // ── Status ──────────────────────────────────────────────────────────
    "--color-info": ["#1d5fd1", "#7fb2ff"],
    "--color-info-muted": ["#e3edfd", "rgba(127, 178, 255, 0.14)"],
    "--color-on-info": ["#ffffff", "#04101f"],
    "--color-on-info-muted": ["#173f8a", "#b9d3ff"],
    "--color-text-info": ["#1d55b8", "#8fbcff"],
    "--color-success": ["#147a4b", "#4fd39a"],
    "--color-success-muted": ["#dff3e9", "rgba(79, 211, 154, 0.14)"],
    "--color-on-success": ["#ffffff", "#03160d"],
    "--color-on-success-muted": ["#0f5a37", "#9ee8c4"],
    "--color-text-success": ["#126b42", "#5fdca5"],
    "--color-warning": ["#b26a00", "#ffc35c"],
    "--color-warning-muted": ["#fbefd9", "rgba(255, 195, 92, 0.14)"],
    "--color-on-warning": ["#ffffff", "#1d1200"],
    "--color-on-warning-muted": ["#7a4900", "#ffd99a"],
    "--color-text-warning": ["#8f5600", "#ffc96e"],
    "--color-error": ["#c42f45", "#ff7a8c"],
    "--color-error-muted": ["#fbe3e6", "rgba(255, 122, 140, 0.14)"],
    "--color-on-error": ["#ffffff", "#1f0409"],
    "--color-on-error-muted": ["#8e1d2e", "#ffb3bd"],
    "--color-text-error": ["#b0283d", "#ff8b9b"],

    // Cyan and purple hues feed Badge/Token variants used for "live" marks.
    "--color-background-cyan": ["#dcf3fb", "rgba(77, 226, 255, 0.14)"],
    "--color-text-cyan": ["#075a7e", "#8beeff"],
    "--color-border-cyan": ["#9ed9ee", "rgba(77, 226, 255, 0.40)"],
    "--color-background-purple": ["#e9e6fd", "rgba(138, 125, 255, 0.16)"],
    "--color-text-purple": ["#4a3fc0", "#c2bbff"],
    "--color-background-gray": ["#e6ebf2", "rgba(148, 197, 255, 0.09)"],
    "--color-text-gray": ["#2a3447", "#c9d3e1"],
    "--color-border-gray": ["rgba(11, 18, 32, 0.14)", "rgba(148, 197, 255, 0.18)"],

    // Elevation is a hairline plus a soft drop, never a glow on content.
    "--shadow-low":
      "0 1px 2px light-dark(rgba(11,18,32,0.06), rgba(0,0,0,0.4)), inset 0 0 0 1px light-dark(transparent, rgba(148,197,255,0.05))",
    "--shadow-med":
      "0 8px 24px light-dark(rgba(11,18,32,0.10), rgba(0,0,0,0.5)), inset 0 0 0 1px light-dark(transparent, rgba(148,197,255,0.08))",
    "--shadow-high":
      "0 18px 48px light-dark(rgba(11,18,32,0.16), rgba(0,0,0,0.6)), inset 0 0 0 1px light-dark(transparent, rgba(148,197,255,0.10))",
  },
  components: {
    // The single primary action per view wears the accent gradient.
    button: {
      "variant:primary": {
        backgroundImage:
          "linear-gradient(120deg, var(--color-accent), var(--chitti-violet))",
        color: "var(--color-on-accent)",
        fontWeight: "600",
      },
    },
    card: {
      base: {
        backgroundColor: "var(--color-background-card)",
        borderColor: "var(--color-border)",
      },
    },
  },
});
