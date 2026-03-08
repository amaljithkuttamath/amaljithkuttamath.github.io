# Portfolio Site — amaljithkuttamath.github.io

## Stack

- Astro 5, static output, deployed to GitHub Pages
- No frameworks — vanilla JS only (no React, no Vue)
- D3.js loaded via CDN for playground visualizations
- Fonts: Inter (sans), Newsreader (serif), JetBrains Mono (mono)

## Commands

- `npm run dev` — dev server at localhost:4321
- `npm run build` — production build to `dist/`
- `npm run preview` — preview production build

## Site Structure

- Nav: `home · work · playground · about`
- `/` — landing page: hero, featured playground card, recent work items
- `/work` — combined projects + writing, flat list with tags
- `/playground` — interactive microGPT trainer (standalone)
- `/about` — bio, skills grid, career timeline, education, resume link, contact
- `/work/understanding-llms` — article (markdown, uses Post.astro layout)

## Design System Rules

### Interaction

- Hover always brightens toward `--accent-color`. Never fade, never dim.
- Active nav item: `--fg` color + 1px underline below
- Card hover: `border-color` shifts to `--accent-color`, `background` to `--bg-elevated`
- Underlined links (prose/about): both text color and underline color shift to `--accent-color`
- All transitions: `var(--duration) var(--ease)` — 0.15s cubic-bezier(0.23, 1, 0.32, 1)

### Typography

- Headings: `--font-serif` (Newsreader), weight 500, negative letter-spacing
- Body text: `--font-sans` (Inter)
- Labels, tags, meta, dates: `--font-mono` (JetBrains Mono), uppercase, `--text-label` size
- Muted text: `--fg-muted` only. Never hardcode gray values.

### Spacing

- Between page sections: `--space-3xl` (6rem)
- Card/component internal padding: `--space-md` to `--space-lg`
- Always use the defined spacing scale. No magic pixel values.

### Components

- List items: flex row, `border-bottom: 1px solid var(--fg-faint)`, title left, meta right
- Expandable content: `<details>` element with `fadeIn` animation
- Cards: `--bg-elevated` background, `--fg-faint` border, `--radius-md` corners
- Tags: `--font-mono`, `--text-tag` size, lowercase, pill shape (`border-radius: 100px`)

### Color

- Use CSS custom properties exclusively. No raw color values in components.
- Dark mode is default. Light mode via `prefers-color-scheme: light`.
- Accent color: warm brown (`--accent-color`)
- Background hierarchy: `--bg` < `--bg-elevated` < `--bg-hover`

## SEO Rules

- Every page must have a unique `<title>` and `<meta name="description">`
- JSON-LD structured data on every page (Person on home, Article on posts, ProfilePage on about)
- Canonical URLs on every page
- OG and Twitter meta tags on every page
- `robots.txt` in public/
- Sitemap via Astro sitemap integration
- Semantic HTML: use `<article>`, `<nav>`, `<main>`, `<header>`, `<footer>`, `<section>`
- All external links: `target="_blank" rel="noopener noreferrer"`
- All images must have `alt` text
- Skip-link for accessibility

## Code Conventions

- Styles: scoped `<style>` per component, global rules in `src/styles/global.css`
- Use `:global()` only when child elements are created by JS at runtime
- No CSS-in-JS. No Tailwind. Plain CSS with custom properties.
- Keep playground JS inline (`<script is:inline>`) — it needs runtime DOM access
- Layouts in `src/layouts/`, pages in `src/pages/`
