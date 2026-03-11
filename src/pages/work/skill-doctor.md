---
layout: ../../layouts/Post.astro
title: "I Built a Tool to Fix Claude Code Skills"
date: "2026-03-10"
description: "I audited my own Claude Code skills and found problems in every one. So I built a plugin to do the audit for anyone."
tags: ["claude-code", "skills", "tooling"]
repo: "https://github.com/amaljithkuttamath/skill-doctor"
---

I've been using Claude Code daily for months. I built 5 custom skills: session management, content engine, growth tracking, outreach, session closing. They worked. I thought they were solid.

Then Claude Code shipped new skills features, and I started seeing developers talk about capabilities I'd never used. Dynamic context injection. Argument modes. Tool restrictions. I went through my own skills with a checklist.

---

## What was wrong

`session-opener` made 3 tool calls at startup that should have been `!command` dynamic injections. Zero round trips instead of three.

`session-closer` had no `disable-model-invocation` flag. Claude could auto-trigger it mid-conversation, writing to three files unprompted.

All 5 skills duplicated the same Project Context block already in CLAUDE.md. Thousands of unnecessary tokens loaded every session.

None of them restricted tool access. `session-opener` only reads files but had access to Write, Edit, Bash, and everything else.

---

## Why I built it

I looked for existing tools to catch this. Anthropic's `quick_validate.py` checks YAML frontmatter. Community `skill-reviewer` does a single-pass best practices check. Repello and Cisco have security scanners for malicious content. Important, but different problem.

None of them answered the question I actually had: *are my skills well-built?*

So I built [skill-doctor](https://github.com/amaljithkuttamath/skill-doctor).

---

## How it works

Three commands. That's the whole interface.

<div style="display: grid; gap: 1rem; margin: 1.5rem 0 2rem;">

<div style="border-left: 2px solid var(--accent-color); padding: 1.25rem 1.5rem; background: rgba(255,255,255,0.02); border-radius: 0 8px 8px 0;">
  <code style="font-size: var(--text-body); color: var(--accent-color); background: none; padding: 0;">/skill-doctor</code>
  <p style="margin: 0.5rem 0 0; font-size: var(--text-small); color: var(--fg-muted); line-height: 1.65;">Reads all your skills, agents, and CLAUDE.md. Scores against a best-practices checklist. Run as <code>checkup</code> for a report, or <code>consult</code> to map findings to your actual pain points.</p>
</div>

<div style="border-left: 2px solid var(--accent-color); padding: 1.25rem 1.5rem; background: rgba(255,255,255,0.02); border-radius: 0 8px 8px 0;">
  <code style="font-size: var(--text-body); color: var(--accent-color); background: none; padding: 0;">/skill-doctor:treat</code>
  <p style="margin: 0.5rem 0 0; font-size: var(--text-small); color: var(--fg-muted); line-height: 1.65;">Builds upgraded versions in a staging directory. Test with <code>cc --plugin-dir</code>, say "migrate" to apply. Originals are backed up.</p>
</div>

<div style="border-left: 2px solid var(--accent-color); padding: 1.25rem 1.5rem; background: rgba(255,255,255,0.02); border-radius: 0 8px 8px 0;">
  <code style="font-size: var(--text-body); color: var(--accent-color); background: none; padding: 0;">/skill-doctor:rollback</code>
  <p style="margin: 0.5rem 0 0; font-size: var(--text-small); color: var(--fg-muted); line-height: 1.65;">Restores your originals if anything breaks.</p>
</div>

</div>

### What it checks

| Check | What it catches |
|-------|----------------|
| Frontmatter completeness | Missing `allowed-tools`, `disable-model-invocation` |
| Dynamic injection | Tool calls that should be `!command` |
| Argument support | Multi-mode skills without `$ARGUMENTS` |
| Files & progressive disclosure | SKILL.md too large, not using the three-level system |
| Skill-scoped hooks | Pre/post actions that should be hooks, not instructions |
| Overlap detection | Multiple skills triggering on the same keywords |
| CLAUDE.md audit | Workflows in CLAUDE.md that should be skills |
| Agent wiring | Agents referencing missing skills, or skills that should be agent-backed |
| Model override | Opus used for tasks sonnet could handle |
| Context isolation | Skills that should run in `context: fork` |
| Description triggers | Vague descriptions that won't auto-invoke |
| Security | XML in frontmatter, reserved names, hardcoded secrets |

---

## Install

```bash
claude plugin marketplace add amaljithkuttamath/skill-doctor
claude plugin install skill-doctor@skill-doctor-marketplace
```

No dependencies. Works standalone. Optionally integrates with [Context7](https://context7.com) for latest docs and [skill-creator](https://github.com/anthropics/skills) for format validation.

v1.0. [Issues and feature requests welcome.](https://github.com/amaljithkuttamath/skill-doctor/issues)
