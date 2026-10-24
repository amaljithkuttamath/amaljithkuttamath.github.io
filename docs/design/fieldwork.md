# Fieldwork: the site as an inspectable body of work

The audience should meet Amal's actual tools and research before a services pitch.
The homepage asks what a language model is doing, then lets the reader inspect a
real tokenizer. Apps are instruments, lab entries are questions, Radar is a daily
observation, and About explains collaboration through concrete work.

Keep the existing Newsreader / Inter / JetBrains Mono families. Newsreader gets
room to speak in large complete headlines; Inter carries readable descriptions;
mono is reserved for actual labels, controls, and provenance. Keep graphite
#0b0d0c, paper #f6f8f7, foreground #e6e9e7 / #171b19, and status amber #d9a13b /
#9a6c14. Improve secondary-text contrast through the shared token.

Layout: a wide shared masthead on editorial pages, asymmetric opening spreads,
full-width project rows with small mechanism diagrams, and compact utilities.
Reading remains within 65–75 characters. App workspaces retain their functional
layout. Mobile becomes one column with full-width touch controls.

No decorative metrics, invented results, fake model outputs, or ornamental
charts. A conceptual schematic says it is a schematic. Loading/error states
must remain honest. Hover brightens to ink; motion is restrained and respects
reduced motion. Use the site's existing theme preference everywhere.

Radar lives at /radar in the main site. Its overview, evidence, full briefing,
and archive are different reading depths. Date-only report labels never become
invented timestamps, and provider names never come from a hardcoded default.

Navigation is deliberately limited to Work, Radar, About. Work is the homepage
and contains all tools and experiments. About owns research context and
collaboration. The retired Apps, Lab, and Build hubs redirect to relevant
sections; individual tools and experiments keep their original URLs.

The final opening is a live language workbench, not a passive tokenizer card.
It shows deterministic UTF-8 bit columns immediately and loads the real GPT-4o
vocabulary only on request. Large Inter display type and an inverted instrument
surface provide the primary visual contrast. Binary patterns encode actual byte
or token IDs; they are never represented as attention, confidence, or embeddings.


## Compact, functional revision

The first viewport must identify the work and offer project entry points before
the language demo. Replace the oversized metaphor headline with “AI agents and
model experiments.” Reduce headline, masthead, diagram, and demo height without
shrinking reading text. Use direct function descriptions; no slogans or sales copy.

Radar exposes the published observation index through a source/minimum-score
matrix. Counts are cumulative, selected records stay inspectable, and the same
filters transfer into the Evidence view. The matrix always describes the current
feed even when the reader opens a historical briefing. Month controls filter the
archive using real edition counts. About groups existing research repositories
by the questions they address. Interaction provides personality; labels explain
what controls do. Existing tool internals and routes remain unchanged.


## Visual research field

Replace the source/score matrix with one selectable mark per observation.
Group marks by source or by their published evidence score; dot size encodes
score. Category placement and intra-category spacing are layout only, not
semantic similarity, inferred relationships, or embeddings. No network edges.
Hover previews, clicking persists selection, arrow keys move spatially, and
previous/next buttons support dense groups on touch screens. Changing grouping
retains record identity. The source link stays visible while long descriptions
scroll within a bounded inspector. Regrouping motion respects reduced motion.
Desktop height is about 360px, below the previous matrix; mobile repacks in its
own coordinate space to retain readable category labels.


Radar's first view now names the three highest-evidence observations beside the field, including source type, score, and an existing source description when available. Rank uses the same score/date/title ordering as Evidence; the list action includes all ties at the displayed cutoff. Clicking a title or mark replaces this shortlist with details in the same bounded sidebar, with a keyboard-accessible return. Dot opacity reflects evidence score. Desktop and mobile panel dimensions remain unchanged.
