---
version: 1
slug: "ui-index-html"
primary_target: "ui/index.html"
related_targets: []
---

# Local control panel — Kimi Work gateway

Scope: the standalone local web panel served by `panel --config <file>` (route `/`). One shell with four views — overview, models, subagents, connection & diagnostics — and no other routes.

Mode: Operate. The visitor is mid-task and must leave with a correct belief about what is actually in force.

## Audience and job

Audience: one person on their own Mac/Windows desktop, running Kimi Work with a third-party model gateway. They are technically fluent, distrust marketing copy, and read a state word literally.

Job: check that the gateway, catalogue and native runtime are usable; add, edit or remove models and declare their real capabilities and reasoning efforts; set the native subagent target and effort; edit the upstream connection and read diagnostics; and afterwards know whether a change is saved, pending a restart, or genuinely adopted.

Constraints carried from PRODUCT.md: never invent models, prices or usage; the main model is chosen in Kimi Work's own menu; credentials never reach the DOM; a configuration that is not ready blocks catalogue and subagent saves and must name the restart path; an already-running Kimi is never killed; every operation has a truthful intermediate state.

## Content and proof

Real API contract only (`/api/state`, `/api/models`, `/api/connection`, `/api/subagents`, `/api/actions`). Nothing is mocked: while the backend is absent the page shows its own unreachable state. Proof is structural — saved and adopted are two labelled columns, a pending restart is a banner comparing active with saved, and diagnostics are results of named checks with their timestamps, never claims about inference.

## Chosen direction and memorable moment

The panel is a model workbench: a quiet light system-settings shell, a catalogue you can actually edit, and a right-side inspector that edits one model without losing the table. The memorable moment is the catalogue row opening into the inspector while the rest of the list stays put — the workbench keeps your place while you change the thing in front of you.

## Unresolved decisions

Light is the default; dark is an explicit option and follows the system only when chosen. No brand identity exists for this tool and none is introduced. Windows desktop acceptance is scheduled separately by the user.

## Direction contract

THESIS: This is a workbench for a catalogue, not a dashboard about a system. It refuses the previous instrument-panel world (spectrum lines, calibration bands, dials, state-as-line-form) and refuses the generic admin dashboard (hero metrics, card grid, coloured pills for everything). What it must prove: a model's declared capabilities and efforts are the same facts the subagent can actually choose, and a saved change is not the same fact as a running one.

OWN-WORLD: A light, cool-grey workbench built from white surfaces, 1px hairlines, 8–12px radii and one clear blue for the primary action. Type is the platform UI sans at 14px with a 12.5px label tier and tabular numerals; monospace is reserved for identifiers, URLs, codes and measurements. Hierarchy comes from spacing and weight, not from colour blocks: neutral tags, one blue accent, and three semantic tones (green settled, amber pending, red failed) used only as a dot plus a word. Structure is a fixed left rail of four views against a single working surface; a catalogue table is the centre of gravity; editing happens in a right inspector alongside the table, stacking below it on narrow screens.

STORY: In order — the gateway is up and how many models it carries; whether the configuration is ready or waiting for a restart; which subagent target is saved and which one the runtime adopted; whether traffic is actually flowing (real counters); then the catalogue, where each row states protocol, limits, declared tools/reasoning/vision and declared efforts, and can be edited with a full-catalogue save; then the subagent choice, restricted to what the selected model declares; then the connection form, its environment-variable status, the restart instruction, and the two diagnostics with their last result.

FIRST VIEWPORT: At 1440 the shell is a 232px rail and a 1152px work surface. The rail carries the mark, the four views, the gateway readout and the appearance picker. The surface opens on 概览 with the page title, a hairline status panel of four labelled facts (gateway, catalogue, runtime, configuration), then the two-column saved/adopted panel with a single verdict line, then request counters and a compact recent-request table. No card grid, no dial, no gradient.

FORM: Direction 3 of 7 grounded candidates (assigned), seed key cb6aaf97 — 模型工作台. Raised by the hands it beat, named lines: from the network manager (declined on product scope) — **status as a labelled fact list**, where a state is a dot and a word in a row, never a coloured card; from the data-table editor (declined on rigidity) — **edit in place of context**, where the row stays visible while its inspector is open, so the operator never loses which model is being changed.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
