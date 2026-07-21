// schemas.ts — the tool schemas exposed to the model, plus the always-on
// core tool-name set. TOOL_SCHEMAS is the full menu the dispatcher understands;
// schemasForSources()/subAgentSchemasFor() (in ./sources) select subsets of it
// per active-source selection. RETURN_FINDINGS_SCHEMA is the sub-agent's
// terminal tool, kept out of TOOL_SCHEMAS so it only appears inside a delegation.

import type { ToolSchema } from './providers';

// ── Tool schemas exposed to the model ────────────────────────────────────
export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'find_series',
    description:
      'Search for a data series across ALL your active databases in one call. Returns matches as ' +
      '{id, name, source}. Pass the chosen id verbatim to fetch_series — it routes to the right ' +
      'source automatically (plain codes like SH.DYN.MORT, "owid:<slug>", and "imf:<code>" all go ' +
      'through the same fetch tool). This is the single entry point for finding what to fetch — you ' +
      'do not choose a database first, the results tell you which source has the series.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "child mortality", "co2 emissions", "inflation forecast"' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_countries',
    description:
      'List countries/aggregates. filter="all" for real countries, "oecd" for OECD members, ' +
      'or a region name substring (e.g. "Sub-Saharan Africa", "Europe"). Returns ISO3 ids and names.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'all | oecd | region name substring' },
      },
    },
  },
  {
    name: 'fetch_series',
    description:
      'Fetch time-series data for ONE series id from find_series — the single fetch tool. It ROUTES ' +
      'automatically by the id: plain World Bank codes (e.g. SH.DYN.MORT), "owid:<slug>", and ' +
      '"imf:<code>" each go to their own source. Returns rows of {country, iso3, year, value, ' +
      'indicator}. Give `countries` (ISO3 codes, or loose names like "UK"/"Korea" which are resolved ' +
      'for you; one aggregate like ["WLD"] works too) for named countries/regions, or OMIT countries ' +
      'for EVERY country — World Bank is batched internally, so never build the full country list ' +
      'yourself. IMF series include projection years beyond today — say "IMF projection" when you use ' +
      'them. Pass the id verbatim from find_series.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'Series id from find_series, verbatim: a plain World Bank code (e.g. "SH.DYN.MORT"), ' +
            '"owid:<slug>", or "imf:<code>".',
        },
        countries: {
          type: 'array',
          items: { type: 'string' },
          description:
            'ISO3 codes or loose names, e.g. ["IND","CHN","BRA"] or ["UK"]; one aggregate like ' +
            '["WLD"] works too. Omit for every country (World Bank batches internally).',
        },
        year_start: { type: 'number' },
        year_end: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write an intermediate artifact to the virtual filesystem (visible to the user). ' +
      'Set derived=true when the content is model-derived — anything produced by an llm() ' +
      'call inside execute_js (labels, classifications, summaries), not fetched from a data ' +
      'source. Derived files are labelled "model-derived" and must never be cited as data.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'e.g. plan.md, indicator_shortlist.json' },
        content: { type: 'string' },
        derived: {
          type: 'boolean',
          description:
            'true if this content was produced via llm() (model-derived, not fetched). ' +
            'Marks the file model-derived so it is never mistaken for fetched data.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a previously written artifact from the virtual filesystem.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'execute_js',
    description:
      'Run JavaScript against the data you already fetched, to compute a ranking/reduction/' +
      'comparison/aggregate — instead of reasoning through the numbers by hand. Your code ' +
      'receives one argument, `rows`, an array of {country, iso3, year, value, indicator} objects ' +
      '(the combined result of every fetch call so far, across all sources; filter by the ' +
      '`indicator` field when you have data from more than one). Whatever your ' +
      'code returns is sent back to you as the result — return the exact ranked/computed array ' +
      'or object you need for the chart or the finding, not intermediate steps. Use this for ' +
      'anything that requires comparing across many rows: top-N by change, percentage change, ' +
      'filtering to the latest year per country, grouping by region, etc. Do not manually rank ' +
      'or diff more than a couple of countries in your own reasoning — write code instead.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'A JS function body (no wrapping function declaration) that uses `rows` and ends ' +
            'with a return statement, e.g. "const byCountry = {}; for (const r of rows) {...}; ' +
            'return Object.values(byCountry).sort(...).slice(0, 15);"',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'growth_stats',
    description:
      'Compute per-country change statistics over the data you already fetched: first/last value, ' +
      'absolute change, percent change, and CAGR, sorted by absolute change. One cheap call that ' +
      'replaces hand-written ranking code for "which countries grew/fell the most" questions and ' +
      'is a fast way to FIND the insight (outliers, surprising risers/fallers) before finishing.',
    parameters: {
      type: 'object',
      properties: {
        indicator_id: {
          type: 'string',
          description: 'Restrict to one indicator id (recommended when multiple were fetched).',
        },
      },
    },
  },
  {
    name: 'correlate',
    description:
      'Pearson correlation across countries between two already-fetched indicators, matched by ' +
      'country at one year (given, or the latest year both share). Use for "is X related to Y" ' +
      'questions and to strengthen findings with a relationship the chart alone does not show. ' +
      'Returns {r, n, year}. Both indicators must be fetched first.',
    parameters: {
      type: 'object',
      properties: {
        indicator_a: { type: 'string', description: 'First indicator id (as stored on rows, e.g. "SP.DYN.LE00.IN" or "owid:life-expectancy")' },
        indicator_b: { type: 'string', description: 'Second indicator id' },
        year: { type: 'number', description: 'Optional; defaults to latest shared year.' },
      },
      required: ['indicator_a', 'indicator_b'],
    },
  },
  {
    name: 'render_chart',
    description:
      'Render the final chart. Provide a spec with a chart type, title, axis labels, and series. ' +
      'Each series has a name and an array of [x, y] pairs (x = year for line/scatter, or category label for bar). ' +
      'Returns "rendered".',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['line', 'bar', 'scatter', 'grouped-bar'] },
        title: { type: 'string' },
        x_axis: { type: 'string' },
        y_axis: { type: 'string' },
        series: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              data: {
                type: 'array',
                items: { type: 'array', items: {} },
                description: 'Array of [x, y] pairs',
              },
            },
            required: ['name', 'data'],
          },
        },
      },
      required: ['type', 'title', 'series'],
    },
  },
  {
    name: 'finish',
    description:
      'Signal completion with the insight: the top-line result (with its concrete number) plus, ' +
      'when the data supports it, one sentence on what is genuinely notable — the outlier, the ' +
      'trend break, or what it implies. Max two sentences. No methodology, no caveats.',
    parameters: {
      type: 'object',
      properties: {
        one_line_finding: {
          type: 'string',
          description: 'The insight: 1-2 tight sentences with a concrete number, not a chart caption.',
        },
      },
      required: ['one_line_finding'],
    },
  },
  {
    name: 'finish_explanation',
    description:
      'End this turn with a prose explanation only, no chart. Use this when the user asked you ' +
      'to explain, describe, interpret, or summarize data you already have in words, rather than ' +
      'asking for a new or different chart. Do not call render_chart in a turn that ends with ' +
      'this tool.',
    parameters: {
      type: 'object',
      properties: {
        explanation: { type: 'string', description: 'The prose answer to the user\'s question.' },
      },
      required: ['explanation'],
    },
  },
  {
    name: 'save_to_dashboard',
    description:
      'Pin the chart you rendered THIS turn to a saved dashboard (a cited, client-side collection ' +
      'of charts the user can revisit). Use ONLY when the user asks to save, pin, or add the chart ' +
      'to a dashboard — never on your own initiative. Creates the dashboard if the title does not ' +
      'exist yet. It carries the chart, its rows, and its citations over intact. Refuses cleanly if ' +
      'no chart was rendered this turn.',
    parameters: {
      type: 'object',
      properties: {
        dashboard_title: {
          type: 'string',
          description: 'Which dashboard to pin into (created if absent). Defaults to a title from the question.',
        },
        tile_title: {
          type: 'string',
          description: 'Label for this pinned chart. Defaults to the chart title.',
        },
      },
    },
  },
  {
    name: 'edit_dashboard',
    description:
      'Change a SAVED dashboard when the user asks to (rename it or a tile, remove or reorder a ' +
      'tile, or refresh its data from source). ONE tool, one action per call — use ONLY on an ' +
      'explicit user request to edit a dashboard, never on your own. Reference a tile by its exact ' +
      'title (preferred) or its 1-based position; the tool lists the dashboard\'s tiles if the ' +
      'reference is ambiguous or missing.',
    parameters: {
      type: 'object',
      properties: {
        dashboard_title: {
          type: 'string',
          description: 'Which saved dashboard to edit (matched by title).',
        },
        action: {
          type: 'string',
          enum: ['rename_dashboard', 'rename_tile', 'remove_tile', 'move_tile', 'refresh_dashboard'],
          description:
            'rename_dashboard (needs new_title) · rename_tile (needs a tile ref + new_title) · ' +
            'remove_tile (needs a tile ref) · move_tile (needs a tile ref + direction) · ' +
            'refresh_dashboard (re-fetches every tile\'s series from source).',
        },
        new_title: {
          type: 'string',
          description: 'The new name, for rename_dashboard / rename_tile.',
        },
        tile_title: {
          type: 'string',
          description: 'Tile reference by exact title (case-insensitive fallback), for the tile actions.',
        },
        tile_index: {
          type: 'number',
          description: '1-based tile position, an alternative to tile_title.',
        },
        direction: {
          type: 'string',
          enum: ['up', 'down'],
          description: 'Which way to move the tile, for move_tile.',
        },
      },
      required: ['dashboard_title', 'action'],
    },
  },
  {
    name: 'delegate_source',
    description:
      'Delegate ONE database\'s part of the question to a focused sub-agent, and get back a short ' +
      'distilled summary (the sub-agent\'s fetched rows merge into your data automatically, with ' +
      'their citations intact — you never see the raw rows). Offered only when more than one ' +
      'database is active. Use it ONLY for questions that genuinely span multiple databases: ' +
      'delegate each source\'s slice, then combine the summaries. For anything one database ' +
      'answers on its own, use the direct fetch/compute tools — delegation spends extra model ' +
      'calls. Call it once per source (you may call it a few times, one source each).',
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'The database to delegate to — its name or id (e.g. "Our World in Data", "owid", "IMF", "World Bank").',
        },
        question: {
          type: 'string',
          description: 'The focused, single-source sub-question, e.g. "life expectancy for G7 countries since 1960".',
        },
      },
      required: ['source', 'question'],
    },
  },
];

// The sub-agent's terminal tool — hands a distilled text summary back to the
// main agent and ends the sub-agent loop. Kept OUT of TOOL_SCHEMAS (and thus
// out of every main-loop schema set); it exists only inside a delegation.
export const RETURN_FINDINGS_SCHEMA: ToolSchema = {
  name: 'return_findings',
  description:
    'Finish this sub-agent and return a SHORT distilled summary (a few sentences: the key ' +
    'numbers and what they show) to the main agent. Your fetched rows are already merged back ' +
    'with their citations — do not paste raw rows here. Call this once you have what the ' +
    'sub-question needs.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'The distilled text summary for the main agent.' },
    },
    required: ['summary'],
  },
};

// Source-agnostic tools: control flow, computation over already-fetched rows,
// and country lookup. Always available regardless of which databases are on.
export const CORE_TOOL_NAMES = [
  'find_series', 'fetch_series', 'list_countries', 'execute_js', 'growth_stats', 'correlate',
  'render_chart', 'finish', 'finish_explanation', 'write_file', 'read_file', 'save_to_dashboard',
  'edit_dashboard',
];
