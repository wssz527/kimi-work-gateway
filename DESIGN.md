---
name: Kimi Work 网关控制面板
description: A calibrated instrument plate for choosing the native subagent target — state is read as line form, not colour.
colors:
  ground-dark: "#0b0c0d"
  plate-dark: "#111213"
  plate-raised-dark: "#17181a"
  plate-sunk-dark: "#0d0e0f"
  rule-dark: "#2a2c2e"
  rule-strong-dark: "#45484b"
  bone-dark: "#eae6dd"
  bone-2-dark: "#b3aea4"
  bone-3-dark: "#8b877f"
  bone-dim-dark: "#807c74"
  bone-off-dark: "#6c6862"
  sodium: "#f0c352"
  alert-dark: "#e8736b"
  ground-light: "#dfe1e0"
  plate-light: "#eceeec"
  plate-raised-light: "#f5f7f5"
  plate-sunk-light: "#e3e5e3"
  rule-light: "#b2b6b3"
  rule-strong-light: "#797e7a"
  bone-light: "#141615"
  bone-2-light: "#414543"
  bone-3-light: "#565b57"
  bone-dim-light: "#636864"
  bone-off-light: "#747975"
  sodium-light: "#7b5605"
  alert-light: "#9d2f27"
  emission-405: "#9a8bf2"
  emission-436: "#6e8ef6"
  emission-486: "#4fc9e0"
  emission-546: "#6fd08a"
  emission-589: "#f0c352"
  emission-615: "#ef8a4c"
  emission-656: "#e0605a"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.022em"
  heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  micro:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.14em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, Courier New, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.01em"
rounded:
  none: "0px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "10px"
  lg: "18px"
  xl: "28px"
  rail: "232px"
components:
  button-primary:
    backgroundColor: "{colors.plate-dark}"
    textColor: "{colors.bone-dark}"
    rounded: "{rounded.none}"
    padding: "7px 11px 7px 15px"
    height: "34px"
  button-primary-hover:
    backgroundColor: "{colors.plate-raised-dark}"
    textColor: "{colors.bone-dark}"
    rounded: "{rounded.none}"
    padding: "7px 11px 7px 15px"
    height: "34px"
  button-outline:
    backgroundColor: "{colors.plate-dark}"
    textColor: "{colors.bone-dark}"
    rounded: "{rounded.none}"
    padding: "7px 15px"
    height: "34px"
  button-quiet:
    backgroundColor: "{colors.plate-dark}"
    textColor: "{colors.bone-3-dark}"
    rounded: "{rounded.none}"
    padding: "7px 6px"
    height: "34px"
  model-row:
    backgroundColor: "{colors.plate-dark}"
    textColor: "{colors.bone-2-dark}"
    rounded: "{rounded.none}"
    padding: "9px 10px 9px 8px"
    height: "46px"
  model-row-selected:
    backgroundColor: "{colors.plate-sunk-dark}"
    textColor: "{colors.bone-dark}"
    rounded: "{rounded.none}"
    padding: "9px 10px 9px 8px"
    height: "46px"
  search-input:
    backgroundColor: "{colors.plate-sunk-dark}"
    textColor: "{colors.bone-dark}"
    rounded: "{rounded.none}"
    padding: "0 30px 0 31px"
    height: "32px"
  binding-register:
    backgroundColor: "{colors.plate-dark}"
    textColor: "{colors.bone-dark}"
    rounded: "{rounded.none}"
    padding: "14px 0 15px"
  effort-option:
    backgroundColor: "{colors.plate-dark}"
    textColor: "{colors.bone-2-dark}"
    rounded: "{rounded.none}"
    padding: "4px 11px"
    height: "28px"
  effort-option-selected:
    backgroundColor: "{colors.plate-dark}"
    textColor: "{colors.bone-dark}"
    rounded: "{rounded.none}"
    padding: "4px 11px"
    height: "28px"
---

# Kimi Work 网关控制面板

## Overview

**Creative North Star: "The Working Plate"**

The panel is one instrument plate calibrated against a single off-centre rail. It is not a settings dashboard. There is one continuum, one rail, one binding strip, and the whole surface is read the way you read a spectrograph: by line form, not by colour.

The product's one hard truth is that a saved choice and an adopted runtime are different facts. Most control panels blur them into a single "current setting" row. Here they sit as two registers on the same horizontal rule, with a verdict between them, so the difference is structural rather than explained.

**Key Characteristics:**
- Colour survives only as seven hairline emission lines (405/436/486/546/589/615/656 nm) used for measurement, never decoration.
- State is carried by line height, dash, doubling, capping, and strike-through — not hue.
- Structure is drawn, not boxed: 1px hairlines, corner registration ticks, ruled groups.
- One grotesque at one size, ranked by tracking and ink; monospace only for identifiers, URLs, numbers, and timestamps.
- Square corners everywhere. No radii, no pills, no cards.

## Colors

Restrained by construction: neutral charcoal continuum plus bone type, with a single sodium accent for the current target and one alert tone for blocked/failed. Everything else is line work.

### Primary
- **Sodium** (`#f0c352` dark / `#7b5605` light): the saved target, the primary action's doubled rule, the active nav tick, and the current section marker. Never used for emphasis of prose.

### Secondary
- **Emission spectrum** (`--e405` … `--e656`): seven hairlines that index the model catalogue and the context-window calibration band. Their only job is to make rows and ticks locatable. They are never used for state.

### Neutral
- **Continuum** (`#0b0c0d` ground → `#17181a` raised): four steps of near-black in dark; the same four steps inverted to a neutral ash in light (`#dfe1e0` → `#f5f7f5`). The light theme is deliberately cool-neutral, not cream.
- **Bone** (`#eae6dd` / `#141615`): body ink. `bone-2` for secondary, `bone-3` for labels, `bone-dim` for quieter metadata (still ≥4.5:1), `bone-off` for disabled affordances only.
- **Rules** (`#2a2c2e` / `#b2b6b3`): every divider is a hairline; `rule-strong` marks interactive edges.

### Named Rules

**The Emission-Only Rule.** Colour may not encode state. If a mark needs to say "pending", "adopted", "blocked", or "conflicting", it says it in line form. Hue is reserved for identity (which model) and for the single accent (which target).

**The Two-Register Rule.** A saved value and an observed value never share one cell. If they must appear near each other, they are separated by a rule and a verdict word.

## Typography

One family carries everything: the platform UI sans. Monospace is a measurement tool, not a costume — it appears only where a value is an identifier, a URL, a number, or a timestamp.

### Hierarchy
- **Display** (26px, 600, −0.022em): the single page title.
- **Heading** (16px, 600): plate and column titles.
- **Body** (14px, 400, 1.55): lede and explanatory copy, capped at 58–62ch.
- **Label** (12px): control text, hints, values in rows.
- **Micro** (11px, 500, 0.14em uppercase): section labels and readout captions. Never below 11px.
- **Mono** (12px, `max(11px, 0.86em)`): ids, URLs, token counts, timestamps, verdicts of measured values.

### Named Rules

**The 11px Floor.** Functional text never goes below 11px; only non-interactive legal smallprint may. The band tags and readout captions sit exactly on the floor.

**The Tracking-Not-Size Rule.** Rank within the micro tier comes from tracking (0.14em) and ink, not from shrinking the type.

## Layout

Two compositions, decided structurally rather than by fluid type.

**≥1180px:** a 232px off-centre rail (identity, section nav, gateway, configuration, runtime, session, appearance) against a plate that runs to 1240px. The plate stacks: header → binding strip → work grid (target plate + 314px runtime column).

**≤900px:** the rail collapses to a status band — identity and appearance on one line, section nav on the next, gateway and configuration as two compact states. The target plate enters the first viewport. **≤640px:** the registers go two-up with the verdict spanning above them, model rows become tick + identity + flags with a mono meta line, and the calibration readouts stack to one column so no value truncates.

Spacing is a single rhythm: 18px between plates, 22px inside plates, 28px at the page edge; more space above a heading than below it.

## Elevation & Depth

There is no elevation system. Structure is drawn with 1px rules and registration ticks; nothing floats. The two exceptions are the toast (a single soft-shadow layer, no border) and the SVG band, which uses a vertical gradient to read as a lit plate rather than a filled box.

**The Drawn-Not-Boxed Rule.** If a boundary is needed, it is a hairline. Never a border plus a shadow on the same element.

## Shapes

Squared corners only (`0` radius). The only curved elements are the authored 16px stroke icons and the small search clear glyph. Ticks, caps, and doubled rules are 1px–3px wide marks, never rounded.

## Components

### Buttons
Outline (1px `rule-strong`), primary (a doubled rule via inset ring on sodium, with the plate showing between the lines), and quiet (text with underline on hover). All share 34px height, 12px text, squared corners, and a 1px downward press.

### Model Row
A ruled row: a 3px emission tick at the wavelength bucket, the id in mono, a secondary line with the display name and output budget, then context, protocol, and capability flags right-aligned in tabular columns. Selected rows recess to the sunken plate and the tick turns sodium with a doubled shadow. Non-capable models keep their tick at 35% and swap the flags for a struck "不可用于子代理".

### Binding Registers
The signature component. Three cells on one rule: saved (left), verdict (centre, recessed, with the state mark), adopted (right). The verdict's mark is one of seven authored 22px line forms — solid, dashed, half, struck, doubled, capped, conflicting — and the word beside it names the fact, never the mood.

### Calibration Band
An SVG field spanning the plate, plotting every model's context window linearly on a shared axis, with ticks at each model's emission wavelength. The saved target is a doubled sodium line with a cap; the draft is a dashed grey line; the runtime-adopted model is a solid bone line with a cap. Marks slide to their new x on state change and hold. Readouts below repeat the same three facts in tabular numbers so the graphic is never the only source.

### Search Field
Sunken 32px field with a leading stroke icon, sodium caret, sodium focus border (no outline ring, since the field is the ring), and an inline clear button.

### Effort Options
Ruled chips with a leading 1px mark; the checked state gains a sodium border and the mark doubles. "自动" uses a dashed mark and names the model's declared default when there is one.

## Do's and Don'ts

### Do:
- Carry every state in line form first; add the word second.
- Keep the saved register and the adopted register physically separate, always.
- Use mono only for identifiers, URLs, numbers, and timestamps.
- Keep the calibration band honest: every mark must correspond to a real catalogue value.
- Let the rail carry system facts; let the plate carry the task.

### Don't:
- Don't tint a state green/amber/red. Hue is for identity and the one accent.
- Don't show the policy as if it were the runtime's observation.
- Don't add a card, a pill, a radius, or a drop shadow to create hierarchy.
- Don't decorate with stripes, grids, or grain; a texture must come from a measuring tool that is actually present.
- Don't render the panel key, any credential, or raw configuration anywhere in the DOM.
