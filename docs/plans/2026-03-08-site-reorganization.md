# Site Reorganization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reorganize the portfolio site from 5 nav sections to 4 (home, work, playground, about), merge writing+projects into a unified work page, enhance about page, fix home page links, and harden SEO.

**Architecture:** Astro static site. Pages in `src/pages/`, layouts in `src/layouts/`, global styles in `src/styles/global.css`. All design rules in `CLAUDE.md`. No frameworks, no tests — verify with `npx astro build`.

**Tech Stack:** Astro 5, vanilla CSS, vanilla JS, `@astrojs/sitemap`

---

### Task 1: Create the Work Page

**Files:**
- Create: `src/pages/work/index.astro`
- Reference: `src/pages/projects.astro` (data source — copy project data from here)
- Reference: `src/pages/index.astro:4-8` (pattern for loading markdown posts)

**Step 1: Create `src/pages/work/index.astro`**

Combine the project data from `projects.astro` (the `branches` array, flattened — no branches) with markdown posts from `work/*.md`. Each item is a `<details>` expandable with title, description, tags. Articles have a link to their full page instead of inline details. Playground gets an entry that links out.

```astro
---
import Base from '../../layouts/Base.astro';

const allPosts = import.meta.glob('./*.md', { eager: true }) as Record<string, any>;
const posts = Object.entries(allPosts)
  .map(([path, mod]) => ({ ...mod, url: '/work/' + path.replace('./', '').replace('.md', '') }))
  .sort((a, b) => new Date(b.frontmatter.date).getTime() - new Date(a.frontmatter.date).getTime());

const formatDate = (date: string) =>
  new Date(date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

const projects = [
  {
    title: 'Healthcare RAG Pipeline',
    desc: 'A retrieval system that helps clinicians query medical records and PubMed literature in natural language.',
    tags: ['RAG', 'vertex ai', 'langchain', 'llamaindex'],
    details: {
      problem: 'Clinicians need fast, accurate answers from medical records and research papers. Manual search across PubMed and internal records is slow and error-prone.',
      approach: 'Retrieval-augmented generation pipeline on Google Cloud Vertex AI. Documents are chunked, embedded with multi-modal indexing, and stored for vector retrieval. Gemini Pro generates answers grounded in retrieved context.',
      stack: 'Vertex AI, Gemini Pro, LangChain, LlamaIndex, Python',
      outcome: 'Serves oncology-specific queries with domain-aware re-ranking. Handles 10,000+ daily queries across medical records and PubMed.',
    },
  },
  {
    title: 'Medical Knowledge Graph',
    desc: 'A graph connecting diseases, drugs, treatments, and clinical trials — making relationships between medical concepts searchable.',
    tags: ['neo4j', 'elasticsearch', 'embeddings'],
    details: {
      problem: 'Medical knowledge is scattered across databases, papers, and records. Relationships between entities (drug → treats → disease → has trial) are lost in flat storage.',
      approach: 'Graph schema in Neo4j mapping diseases, treatments, drugs, clinical trials, and expert opinions as nodes and edges. Elasticsearch for full-text and vector search. Multi-modal embeddings for cross-format querying.',
      stack: 'Neo4j, Elasticsearch, Python, sentence-transformers',
      outcome: 'Powers the retrieval layer of the RAG pipeline. Enables queries across text, structured data, and metadata in a single interface.',
    },
  },
  {
    title: 'Drug Safety Sentiment Analysis',
    desc: 'Reads medical expert opinions and flags potential safety signals for pharmaceutical products.',
    tags: ['NLP', 'classification', 'healthcare'],
    details: {
      problem: 'Pharmaceutical safety teams need to catch early warning signs in expert opinion records before adverse events escalate.',
      approach: 'Fine-tuned transformer classifiers on domain-specific medical language. Detects sentiment shifts in expert opinions per drug per condition over time.',
      stack: 'PyTorch, Hugging Face Transformers, spaCy, Python',
      outcome: 'Surfaces drugs with increasing negative sentiment for safety review. Feeds directly into existing pharmacovigilance workflows.',
    },
  },
  {
    title: 'NL-to-Insights',
    desc: 'Ask a question in plain English about your inventory, get back a chart.',
    tags: ['RAG', 'GPT', 'plotly'],
    details: {
      problem: "Warehouse managers need inventory analytics but can't write SQL. Analysts become bottlenecks for routine data questions.",
      approach: 'Natural language → SQL translation via GPT-3.5 Turbo. Queries execute against inventory and sales databases. Results render as interactive Plotly charts.',
      stack: 'GPT-3.5 Turbo, Plotly, PostgreSQL, Python, FastAPI',
      outcome: 'Used for demand forecasting across 5,000+ SKUs. Eliminated analyst dependency for standard inventory queries.',
    },
  },
  {
    title: 'EDI Pipelines',
    desc: 'Over 50 data pipelines moving business data between ERP systems, warehouses, and reporting tools.',
    tags: ['azure', 'databricks', 'ETL'],
    details: {
      problem: 'Business partners exchange data via EDI — a standardized-in-theory format that varies wildly in practice. Data needs cleaning, transformation, and routing to downstream systems.',
      approach: 'Azure Data Factory orchestrates ingestion and routing. Databricks handles transformation, schema normalization, and quality checks.',
      stack: 'Azure Data Factory, Databricks, Azure Data Lake, Python, SQL',
      outcome: 'Processed over 2TB of transaction data. Connected ERP systems, warehouses, and reporting tools into a single pipeline.',
    },
  },
  {
    title: 'Predictive Maintenance',
    desc: 'Sensor data from industrial equipment, turned into early warnings before machines break down.',
    tags: ['signal processing', 'time series', 'python'],
    details: {
      problem: "Unplanned machine downtime is expensive. Sensor data exists but isn't used for proactive maintenance.",
      approach: 'Signal processing pipeline: ingest raw sensor data, clean and featurize, train models for anomaly detection and time-to-failure prediction.',
      stack: 'Python, scikit-learn, Azure Data Lake, Power BI',
      outcome: '90%+ anomaly detection accuracy. 95% time-to-failure prediction accuracy. KPI dashboards reduced machine downtime by 50%.',
    },
  },
];
---

<Base title="Work — Amaljith Kuttamath" description="AI/NLP projects, data engineering, and technical writing.">
  <div class="page-header animate-in">
    <h1>Work</h1>
    <p class="subtitle">Projects, writing, and things I've built.</p>
  </div>

  <div class="work-list animate-in animate-in-delay-1">
    <!-- Articles -->
    {posts.map((post) => (
      <a href={post.url} class="work-item work-item-link">
        <div class="work-item-head">
          <h3>{post.frontmatter.title}</h3>
          <time class="mono">{formatDate(post.frontmatter.date)}</time>
        </div>
        {post.frontmatter.description && <p>{post.frontmatter.description}</p>}
        <div class="tags">
          <span class="tag">article</span>
        </div>
      </a>
    ))}

    <!-- Playground -->
    <a href="/playground" class="work-item work-item-link">
      <div class="work-item-head">
        <h3>microGPT Playground</h3>
        <span class="mono">interactive</span>
      </div>
      <p>Train a GPT live in your browser — watch attention, embeddings, and loss evolve in real time.</p>
      <div class="tags">
        <span class="tag">interactive</span>
        <span class="tag">d3.js</span>
        <span class="tag">transformers</span>
      </div>
    </a>

    <!-- Projects -->
    {projects.map((item) => (
      <details class="work-item work-item-expandable" id={item.title.toLowerCase().replace(/\s+/g, '-')}>
        <summary>
          <div class="work-item-head">
            <h3>{item.title}</h3>
          </div>
          <p>{item.desc}</p>
          <div class="tags">
            {item.tags.map((t) => <span class="tag">{t}</span>)}
          </div>
        </summary>
        <div class="work-item-details">
          <div class="detail-row">
            <span class="detail-label">Problem</span>
            <span class="detail-value">{item.details.problem}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Approach</span>
            <span class="detail-value">{item.details.approach}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Stack</span>
            <span class="detail-value detail-stack">{item.details.stack}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Outcome</span>
            <span class="detail-value">{item.details.outcome}</span>
          </div>
        </div>
      </details>
    ))}
  </div>
</Base>

<style>
  .work-list {
    display: flex;
    flex-direction: column;
  }

  .work-item {
    padding: var(--space-md) 0;
    border-bottom: 1px solid var(--fg-faint);
  }

  .work-item:first-child {
    border-top: 1px solid var(--fg-faint);
  }

  .work-item-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }

  .work-item h3 {
    font-family: var(--font-sans);
    font-size: var(--text-item-title);
    font-weight: 500;
    margin: 0;
    color: var(--fg);
    transition: color var(--duration) var(--ease);
  }

  .work-item p {
    font-size: var(--text-small);
    color: var(--fg-muted);
    margin: 0.25rem 0 0.5rem;
    line-height: 1.55;
  }

  /* Link items (articles, playground) */
  .work-item-link {
    display: block;
    text-decoration: none;
    color: var(--fg);
  }

  .work-item-link:hover h3 {
    color: var(--accent-color);
  }

  /* Expandable items (projects) */
  .work-item-expandable summary {
    list-style: none;
    cursor: pointer;
  }

  .work-item-expandable summary::-webkit-details-marker {
    display: none;
  }

  .work-item-expandable:hover h3 {
    color: var(--accent-color);
  }

  .work-item-details {
    border-left: 1px solid var(--fg-faint);
    margin-top: 0.5rem;
    padding-left: 1rem;
    padding-bottom: 0.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    animation: fadeIn 0.2s var(--ease);
  }

  @media (max-width: 640px) {
    .work-item-head {
      flex-direction: column;
      gap: 0.125rem;
    }
  }
</style>
```

**Step 2: Move the markdown article**

Move `src/pages/writing/understanding-llms.md` → `src/pages/work/understanding-llms.md`

Update the layout import path inside the markdown frontmatter — it uses `layout: ../../layouts/Post.astro` which will still be correct since the depth is the same (`pages/work/` vs `pages/writing/`).

**Step 3: Verify build**

Run: `npx astro build`
Expected: Build succeeds, `/work/` and `/work/understanding-llms/` exist in `dist/`

**Step 4: Commit**

```bash
git add src/pages/work/
git commit -m "feat: create unified work page combining projects and writing"
```

---

### Task 2: Update Nav

**Files:**
- Modify: `src/layouts/Base.astro:64-69` (nav links)

**Step 1: Replace nav links**

Change the nav-links div to:

```astro
<div class="nav-links">
  <a href="/" class:list={[{ active: currentPath === '/' }]}>home</a>
  <a href="/work" class:list={[{ active: currentPath.startsWith('/work') }]}>work</a>
  <a href="/playground" class:list={[{ active: currentPath === '/playground' || currentPath === '/playground/' }]}>playground</a>
  <a href="/about" class:list={[{ active: currentPath === '/about' || currentPath === '/about/' }]}>about</a>
</div>
```

**Step 2: Verify build**

Run: `npx astro build`
Expected: Build succeeds, nav shows 4 links on all pages

**Step 3: Commit**

```bash
git add src/layouts/Base.astro
git commit -m "feat: simplify nav to home/work/playground/about"
```

---

### Task 3: Update Home Page

**Files:**
- Modify: `src/pages/index.astro`

**Step 1: Update the home page**

- Change the glob path from `./writing/*.md` to `./work/*.md` (line 4)
- Change post URL generation from `/writing/` to `/work/` (line 6)
- Replace the two separate "Writing" and "Projects" sections with a single "Recent Work" section
- Link items directly: articles to `/work/slug`, projects to `/work#slug`
- Change "View all" link from `/writing` and `/projects` to `/work`

**Step 2: Verify build**

Run: `npx astro build`
Expected: Build succeeds, home page links point to `/work/` paths

**Step 3: Commit**

```bash
git add src/pages/index.astro
git commit -m "feat: update home page with unified work section and direct links"
```

---

### Task 4: Remove Old Pages

**Files:**
- Delete: `src/pages/projects.astro`
- Delete: `src/pages/writing/index.astro`
- Delete: `src/pages/writing/understanding-llms.md` (already moved in Task 1)
- Delete: `src/pages/writing/` directory (if empty)

**Step 1: Remove old files**

```bash
rm src/pages/projects.astro
rm -r src/pages/writing/
```

**Step 2: Verify build**

Run: `npx astro build`
Expected: Build succeeds. `/projects/` and `/writing/` no longer in `dist/`. `/work/` and `/work/understanding-llms/` exist.

**Step 3: Commit**

```bash
git add -u
git commit -m "chore: remove old projects and writing pages"
```

---

### Task 5: Enhance About Page

**Files:**
- Modify: `src/pages/about.astro`
- Modify: `src/styles/global.css:763-807` (about styles)

**Step 1: Rewrite about.astro**

Keep existing bio paragraphs. Add after them:

1. **Skills grid** — 4 groups: AI/ML, Data, Cloud, Languages. Each group: heading + comma-separated tools. Use `--font-mono` for tool names.
2. **Career timeline** — Compact list: role · company · one line. Most recent first. Entries: Sorcero, George Mason TraCCC, INECTA, RadianArc, TCS, ISRO.
3. **Education** — Keep existing paragraph.
4. **Resume link** — `<a href="/resume.pdf">Download resume (PDF)</a>`
5. **Contact CTA** — Keep existing.

**Step 2: Add styles to global.css**

Add after the existing about styles (line 807):

```css
/* Skills grid */
.skills-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-lg) var(--space-xl);
  margin-bottom: var(--space-xl);
}

.skill-group h3 {
  font-family: var(--font-mono);
  font-size: var(--text-label);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--fg-muted);
  margin: 0 0 var(--space-sm) 0;
}

.skill-group p {
  font-family: var(--font-mono);
  font-size: var(--text-small);
  color: var(--fg);
  line-height: 1.7;
  margin: 0;
}

/* Career timeline */
.timeline {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin-bottom: var(--space-xl);
}

.timeline-item {
  display: grid;
  grid-template-columns: 8rem 1fr;
  gap: var(--space-md);
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--fg-faint);
  align-items: baseline;
}

.timeline-item:first-child {
  border-top: 1px solid var(--fg-faint);
}

.timeline-role {
  font-size: var(--text-small);
  font-weight: 500;
  color: var(--fg);
}

.timeline-company {
  font-family: var(--font-mono);
  font-size: var(--text-label);
  color: var(--fg-muted);
}

.timeline-desc {
  font-size: var(--text-small);
  color: var(--fg-muted);
  margin: 0;
}

.resume-link {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--font-mono);
  font-size: var(--text-small);
  color: var(--fg);
  text-decoration: underline;
  text-decoration-color: var(--fg-faint);
  text-underline-offset: 3px;
  transition: color var(--duration) var(--ease), text-decoration-color var(--duration) var(--ease);
}

.resume-link:hover {
  color: var(--accent-color);
  text-decoration-color: var(--accent-color);
}

@media (max-width: 640px) {
  .skills-grid {
    grid-template-columns: 1fr;
  }

  .timeline-item {
    grid-template-columns: 1fr;
    gap: 0.125rem;
  }
}
```

**Step 2: Verify build**

Run: `npx astro build`
Expected: Build succeeds, about page has all new sections

**Step 3: Commit**

```bash
git add src/pages/about.astro src/styles/global.css
git commit -m "feat: enhance about page with skills, timeline, and resume link"
```

---

### Task 6: SEO Hardening

**Files:**
- Modify: `astro.config.mjs` (add sitemap integration)
- Create: `public/robots.txt`
- Modify: `src/layouts/Post.astro` (add Article JSON-LD)
- Modify: `src/pages/about.astro` (add ProfilePage JSON-LD)

**Step 1: Install and configure sitemap**

```bash
npm install @astrojs/sitemap
```

Update `astro.config.mjs`:

```js
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://amaljithkuttamath.github.io',
  output: 'static',
  integrations: [sitemap()],
});
```

**Step 2: Create robots.txt**

```
User-agent: *
Allow: /

Sitemap: https://amaljithkuttamath.github.io/sitemap-index.xml
```

**Step 3: Add Article JSON-LD to Post.astro**

Add after the `<header>` in Post.astro:

```astro
<script type="application/ld+json" set:html={JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": frontmatter.title,
  "description": frontmatter.description,
  "datePublished": frontmatter.date,
  "author": {
    "@type": "Person",
    "name": "Amaljith Kuttamath",
    "url": "https://amaljithkuttamath.github.io"
  }
})} />
```

**Step 4: Add ProfilePage JSON-LD to about.astro**

Add a `<script type="application/ld+json">` block with `@type: ProfilePage` in the about page template, inside the Base component.

**Step 5: Verify build**

Run: `npx astro build`
Expected: Build succeeds. `dist/sitemap-index.xml` exists. `dist/robots.txt` exists.

**Step 6: Commit**

```bash
git add astro.config.mjs public/robots.txt src/layouts/Post.astro src/pages/about.astro package.json package-lock.json
git commit -m "feat: add sitemap, robots.txt, and structured data for SEO"
```

---

### Task 7: Clean Up CSS

**Files:**
- Modify: `src/styles/global.css`

**Step 1: Remove dead CSS**

Remove the git-tree styles (lines 340-470) and project-tile styles (lines 251-338) since those components no longer exist after the reorganization. Keep `.detail-row`, `.detail-label`, `.detail-value`, `.detail-stack` as they're reused by the work page.

**Step 2: Verify build**

Run: `npx astro build`
Expected: Build succeeds, no visual regressions

**Step 3: Commit**

```bash
git add src/styles/global.css
git commit -m "chore: remove unused git-tree and project-tile CSS"
```

---

### Task 8: Final Verification and Internal Link Audit

**Step 1: Check all internal links**

Search for any remaining references to `/writing` or `/projects` across all source files:

```bash
grep -r '/writing' src/ --include='*.astro' --include='*.md'
grep -r '/projects' src/ --include='*.astro' --include='*.md'
```

Fix any found references to point to `/work` or `/work/slug`.

**Step 2: Full build**

Run: `npx astro build`
Expected: Clean build, no warnings about missing pages

**Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: update all internal links to new /work routes"
```

**Step 4: Push**

```bash
git push origin main
```
