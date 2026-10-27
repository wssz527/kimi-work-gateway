---
version: 1
slug: "ui-index-html"
primary_target: "ui/index.html"
related_targets: []
---

# Local control panel — Kimi Work gateway

Scope: the standalone local web panel served by `panel --config <file>` (route `/`), single page, no other routes.
Mode: Operate. The visitor is mid-task and must leave with a correct belief about what is actually in force.

## Audience and job

Audience: one person on their own Mac/Windows desktop, running Kimi Work with a third-party model gateway, who wants native subagents to run on a chosen model and effort. They are technically fluent, distrust marketing copy, and will read a state word literally.

Job: see whether the gateway, the configuration, and the native runtime are actually in a usable state; find a model among the configured catalogue; draft a subagent target (inherit or a forced model + effort); apply it; and afterwards know whether that choice is merely saved or genuinely adopted by the runtime.

Constraints carried from PRODUCT.md: never invent models, prices, or usage; the main model is chosen in Kimi Work's own menu and is out of scope; credentials never reach the DOM; configuration that is not ready blocks saving and must offer the restart path; an already-running Kimi is never killed; every operation has a truthful intermediate state.

## Content and proof

Real API contract only (`/api/state`, `/api/subagents`, `/api/actions`). Nothing is mocked: while the backend is absent the page must show its own unreachable state honestly. Proof is the separation of saved target and adopted runtime, expressed structurally rather than asserted in prose.

## Chosen direction and memorable moment

The panel is a working plate calibrated against one off-centre rail: colour survives only as hairline emission lines standing on a banded charcoal continuum, and state is carried in line form (height, dash, doubling, strike) rather than hue. The memorable moment is the binding strip: the saved target and the runtime's adopted target sit as two registers on the same horizontal rule, and the verdict between them is decided by line form, so "saved" and "in force" can never be confused.

## Unresolved decisions

System light/dark follows the OS by default with an explicit override; no brand identity exists for this tool and none is being introduced. Windows desktop acceptance is scheduled separately by the user.

## Direction contract

THESIS: This surface is a calibrated instrument plate, not a settings dashboard. It refuses the category default of a stack of same-size status cards with a coloured pill per state: here the page has one rail, one continuum, and one binding strip, and a state is read as a mark's form. What it must prove is that a saved choice and an adopted runtime are different facts, visible at a glance, without reading a sentence.

OWN-WORLD: A charcoal continuum (banded, procedural, four steps of near-black) with bone type; colour exists only as seven hairline emission lines (405 violet, 436 indigo, 486 cyan, 546 green, 589 sodium, 615 orange, 656 deep red) used as measurement, never as decoration. Structure is drawn, not boxed: 1px hairlines, corner registration ticks, uppercase micro-labels at 0.16em, one grotesque at one size ranked by tracking and ink. Controls are ruled rows and outline rectangles with squared corners; the primary action is a doubled hairline with a filled arrow. Icons are one authored 16px stroke set at 1.25.

STORY: The visitor understands, in order: the gateway is up and how many models it carries; the configuration file is ready or not; which model and effort is saved; which model and effort the native runtime actually adopted; and whether those two agree. Then they search the catalogue, draft a target, and apply — or restore inherit. They leave knowing that a draft is not saved, that saved is not adopted, and exactly which action closes the gap.

FIRST VIEWPORT: At 1440 the page is one plate. A 232px off-centre rail runs down the left, carrying identity, the gateway readout, the configuration line, the runtime line, and the operation console; a landing tick marks the current section. To its right, the top register is the binding strip: `已保存` on the left register, `实际采用` on the right register, both set on the same rule, with the verdict word between them; under it sits a continuous context-window calibration band spanning the full width, with the saved target marked on it. Below, the subagent plate: mode segmented as two ruled options, an effort readout board, then the model catalogue — a searchable list of ruled rows, each with its emission tick, protocol, context, tools and reasoning. The apply bar is pinned at the plate's foot with the primary doubled-line action on the right.

FORM: Direction 6 of 7 grounded candidates (assigned), seed key 4e6c22b7. Raised by the hand it beat, named lines: from the design annual (declined on audience identification) — **registration discipline**: every plate corner carries a crosshair tick and every value sits in a tabular column, so measurement, not mood, holds the grid; from the boarding pass and gate board (declined on product clarity) — **rerank in place**: when the saved target changes, its mark slides along the calibration band and holds a lit state until noticed, and no row is removed and re-created.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
