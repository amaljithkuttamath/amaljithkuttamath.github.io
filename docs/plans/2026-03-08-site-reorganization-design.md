# Site Reorganization Design

## Problem

- 5 nav items for limited content — writing has 1 post, projects page is dense
- About page is thin — no skills, no timeline, no quick assessment
- Home page project links go to generic /projects, not individual items
- Hover/active states were inconsistent (now fixed, rules in CLAUDE.md)

## Design

### Feature 1: Unified Work Page (`/work`)

Merge `/projects` and `/writing` into a single `/work` page.

- Flat list of all items — projects, articles, playground
- Each item: title, one-line description, tags
- Projects expand inline with details (problem, approach, stack, outcome)
- Articles link to their full page
- Playground entry links to `/playground`
- No categories/branches — tags provide visual grouping
- Old routes (`/projects`, `/writing`) redirect or remove

### Feature 2: Simplified Nav

`home · work · playground · about`

- 4 items instead of 5
- Playground stays standalone — it's the strongest differentiator
- "work" covers all professional output

### Feature 3: Enhanced About Page

Add to existing bio:

- **Skills grid**: grouped by domain (AI/ML, Data, Cloud, Languages), scannable
- **Career timeline**: compact — role · company · one line per position
- **Education**: keep existing
- **Resume link**: link to `/resume.pdf` in public/
- **Contact CTA**: keep existing

### Feature 4: Improved Home Page Links

- "Recent work" section links directly to individual items
- Article links go to `/work/understanding-llms`
- Project links go to `/work#project-slug` anchors
- Playground card stays as-is

### Feature 5: SEO Hardening

- Add `@astrojs/sitemap` integration
- Add `robots.txt` to `public/`
- Add Article JSON-LD schema to blog posts
- Add ProfilePage JSON-LD to about page
- Verify unique title + description on every page

## Migration

- `/writing/understanding-llms` moves to `/work/understanding-llms`
- `/writing` and `/projects` pages removed
- `/work` becomes the new combined page
- Update all internal links
