---
name: Kimi Work 网关控制面板
description: A light model workbench — white surfaces, cool-grey rules, one blue action accent, and an inspector that keeps the catalogue in view.
colors:
  neutral-bg: "#f4f6f8"
  surface: "#ffffff"
  surface-sunk: "#f7f8fa"
  surface-hover: "#f1f4f7"
  surface-active: "#e9eff7"
  rule: "#e2e6ec"
  rule-strong: "#cfd6df"
  rule-input: "#c4ccd7"
  ink: "#17202b"
  ink-2: "#45505e"
  ink-3: "#626d7c"
  ink-4: "#636d7a"
  blue: "#1a63bd"
  blue-fill: "#1a63bd"
  blue-fill-hover: "#17589f"
  blue-soft: "#e8f0fb"
  blue-rule: "#bcd6f5"
  ok: "#1f7a4d"
  warn: "#8a5708"
  warn-soft: "#fdf3e0"
  bad: "#b02a2a"
  bad-soft: "#fbeaea"
  bad-fill: "#b02a2a"
  bad-fill-hover: "#9d2323"
  focus: "#1a63bd"
  neutral-bg-dark: "#14171b"
  surface-dark: "#1b1f24"
  surface-sunk-dark: "#191d22"
  surface-hover-dark: "#23282e"
  surface-active-dark: "#243040"
  rule-dark: "#2c3238"
  rule-strong-dark: "#3a424a"
  rule-input-dark: "#48515b"
  ink-dark: "#eef1f4"
  ink-2-dark: "#c0c8d1"
  ink-3-dark: "#9aa4b0"
  ink-4-dark: "#8a93a1"
  blue-dark: "#5fa3f0"
  blue-fill-dark: "#2569b5"
  blue-fill-hover-dark: "#2b76c9"
  blue-soft-dark: "#1c2c40"
  blue-rule-dark: "#2c4a6d"
  ok-dark: "#64c894"
  warn-dark: "#e0ac57"
  warn-soft-dark: "#2d2415"
  bad-dark: "#f08b84"
  bad-soft-dark: "#321d1d"
  bad-fill-dark: "#b02a2a"
  bad-fill-hover-dark: "#c23434"
  focus-dark: "#6fb0f5"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "24px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.022em"
  heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 650
    lineHeight: 1.35
    letterSpacing: "-0.012em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "14.5px"
    fontWeight: 650
    lineHeight: 1.35
    letterSpacing: "-0.012em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  body-small:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "12.5px"
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: "normal"
  label-small:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, Courier New, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.01em"
rounded:
  fine: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  pill: "999px"
spacing:
  micro: "4px"
  tight: "8px"
  block: "12px"
  section: "18px"
  page: "28px"
  control: "32px"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "5px 13px"
    height: "32px"
  button-hover:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "5px 13px"
    height: "32px"
  button-primary:
    backgroundColor: "{colors.blue-fill}"
    textColor: "#ffffff"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "5px 13px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.blue-fill-hover}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "5px 13px"
    height: "32px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink-3}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "5px 8px"
    height: "32px"
  button-danger:
    backgroundColor: "{colors.bad-fill}"
    textColor: "#ffffff"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "5px 13px"
    height: "32px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    typography: "{typography.body-small}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
    height: "34px"
  nav-item-current:
    backgroundColor: "{colors.blue-soft}"
    textColor: "{colors.blue}"
    typography: "{typography.body-small}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
    height: "34px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "5px 9px"
    height: "32px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "18px 20px 20px"
  inspector:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "16px 18px 18px"
    width: "344px"
  table-head:
    backgroundColor: "{colors.surface-sunk}"
    textColor: "{colors.ink-3}"
    typography: "{typography.label-small}"
    padding: "8px 12px"
  model-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-2}"
    typography: "{typography.label-small}"
    padding: "9px 12px"
  model-row-editing:
    backgroundColor: "{colors.blue-soft}"
    textColor: "{colors.ink}"
    typography: "{typography.label-small}"
    padding: "9px 12px"
  tag:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-2}"
    typography: "{typography.label-small}"
    rounded: "{rounded.pill}"
    padding: "1px 7px"
  tag-saved:
    backgroundColor: "{colors.blue-soft}"
    textColor: "{colors.blue}"
    typography: "{typography.label-small}"
    rounded: "{rounded.pill}"
    padding: "1px 7px"
  choice:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "11px 13px 12px"
  choice-checked:
    backgroundColor: "{colors.blue-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "11px 13px 12px"
  fact-cell:
    backgroundColor: "{colors.surface}"
    padding: "11px 13px 12px"
  banner-warn:
    backgroundColor: "{colors.warn-soft}"
    textColor: "{colors.warn}"
    rounded: "{rounded.md}"
    padding: "9px 12px"
  banner-bad:
    backgroundColor: "{colors.bad-soft}"
    textColor: "{colors.bad}"
    rounded: "{rounded.md}"
    padding: "9px 12px"
  empty-state:
    backgroundColor: "{colors.surface-sunk}"
    textColor: "{colors.ink-3}"
    rounded: "{rounded.md}"
    padding: "26px 20px 28px"
---

# Design System: Kimi Work 网关控制面板

## Overview

**Creative North Star: "The Model Bench"**

This is a workbench, not a dashboard. It belongs to one person sitting at their own machine, mid-task, deciding whether their gateway and model catalogue will actually hold up. The surface is a light system-settings shell: white plates on a cool-grey ground, hairline boundaries, one restrained blue reserved for the action that commits. Nothing on the page is decoration; every element either states a fact, takes a value, or shows the result of a real call.

The second organising idea is that the catalogue stays put while you edit. Opening a model is not a modal and not a page change: the table narrows, a 344px inspector appears beside it, and the row you are editing stays visible under a blue tint with a 2px left bar. You never lose the thing in front of you while you change it. The same discipline governs truthfulness: a saved value and a runtime-adopted value are two labelled columns, and a verdict strip names the difference between them in words.

Deliberately absent: the previous instrument-panel/spectrum world (emission lines, sodium accent, calibration bands, zero-corner geometry) and the generic admin dashboard (hero metric tiles, gradient cards, coloured pills for every state). The user rejected the former, and this build replaces it rather than recolours it.

**Key Characteristics:**
- Default light: white panels on a cool-grey ground, 1px rules, 6/8/12px radii, no heavy borders.
- One blue action accent; green/amber/red appear only as a 7px dot plus a word, or as a tinted whole-block background.
- The catalogue table is the centre of gravity; the inspector opens beside it, never over it.
- Platform UI sans at 14px body with a 13px supporting tier, a 12.5px control tier and a 12px floor; tabular numerals and monospace for identifiers and measurements.
- Saved and adopted are structurally separate facts, never one "current" cell.

## Colors

A cool, low-chroma working palette: paper white, three strengths of grey rule, four steps of ink, one blue in four roles, and three semantic tones that are never used as decoration.

### Primary
- **Work Blue** (`#1a63bd`): accent ink — the current nav item's text and tint, focus rings, the saved tag's text, links, and the left bar of the row being edited.
- **Work Blue Fill** (`#1a63bd`) and its hover (`#17589f`): the committing action's fill, always carrying white label text. Separate from accent ink so dark mode can lift one without washing out the other.
- **Blue Soft** (`#e8f0fb`): the tint behind the current nav item, the saved/subagent tag, the checked choice, the editing row, and text selection.
- **Blue Rule** (`#bcd6f5`): the hairline that holds the saved tag's blue tint apart from neutral tags.

### Secondary
- **Settled Green** (`#1f7a4d`): a healthy gateway, a ready config, a successful check, a success toast icon.
- **Pending Amber** (`#8a5708`): restart-pending configuration, a draft that differs from what is saved, a diagnostic that has not run. Its tint (`#fdf3e0`) fills the whole warning banner and the pending-diff block.
- **Failed Red** (`#b02a2a`): a refused save, an unreachable upstream, a model in use that cannot be deleted, an invalid effort identifier. Its tint (`#fbeaea`) fills error banners, inline error lists and the delete-confirmation row. The solid red button uses its own fill token, so dark mode keeps white text legible instead of painting white on the light error ink.

### Neutral
- **Ground** (`#f4f6f8`) and **Plate** (`#ffffff`): every view is white plates on this ground. **Sunk** (`#f7f8fa`) is a recessed block inside a plate (table head, chip, empty state, verdict strip); **Hover** (`#f1f4f7`) and **Active** (`#e9eff7`) are pointer states only.
- **Rule** (`#e2e6ec`), **Rule Strong** (`#cfd6df`), **Rule Input** (`#c4ccd7`): the same hairline in three strengths — structural divider, interactive edge (tag border, inspector outline, dashed empty state, panel edge at rest), and field stroke. The field stroke is the only one dark enough to carry a control boundary on white.
- **Ink** (`#17202b`): values, headings, table IDs. **Ink 2** (`#45505e`): table body, nav labels. **Ink 3** (`#626d7c`): ledes, labels, hints. **Ink 4** (`#636d7a`): the quietest readable tier — timestamps, captions, disabled text. Nothing below this is used for text.

The dark theme re-points the same token names (`neutral-bg-dark` … `focus-dark`); it is a second mapping, not an inverted filter. Only the ink and fill pairs move independently: `blue-dark` lightens to `#5fa3f0` while its fill darkens to `#2569b5`.

### Named Rules

**The One Blue Rule.** Blue marks committing actions, the current view, focus, links, and the saved state. Headings and decorative marks stay neutral; a toolbar and its editor can each have a committing action.

**The Dot-and-Word Rule.** A state is a 7px dot plus a word ("运行中", "待重启", "未检查"). Tint is allowed only as a whole-block background (banner, note, diff, error list) or as a text colour on an error string — never as a row wash that leaves the word unread.

**The Two-Blues Rule.** Accent ink and accent fill are separate tokens. In dark mode ink lifts for legibility while the fill stays dark enough for white label text. Never paint white text on the accent ink.

## Typography

**Display Font:** the platform UI sans (`-apple-system`, `Segoe UI`, `PingFang SC`, `Microsoft YaHei`, `Noto Sans SC`, Roboto, Arial).
**Body Font:** the same stack at 14px.
**Label/Mono Font:** `ui-monospace` / `SFMono-Regular` / Menlo / Consolas for identifiers, URLs, numbers and timestamps.

**Character:** System type is a contract here, not a style choice — this is a local settings tool on the user's own machine, and it should read like the OS it lives in, in Chinese first. Rank comes from weight, size and ink step, never from a display face.

### Hierarchy
- **Display** (650, 24px, 1.2, −0.022em): the single view title in the top bar; 21px at ≤560px. `text-wrap: balance`.
- **Heading** (650, 15px, 1.35, −0.012em): panel titles ("运行状态", "子代理目标", "推理流量").
- **Title** (650, 14.5px): the inspector's own title, one step below a panel, because it lives inside the workbench rather than beside it.
- **Body** (400, 14px, 1.55): lede and explanatory copy; panel descriptions cap at 62ch, hints at 78ch.
- **Body Small** (400, 13px, 1.5): banners, nav labels, choice titles, diagnostic states, the gate lede.
- **Label** (500, 12.5px): buttons, fields, table body cells, panel actions, choice notes.
- **Label Small** (400, 12px): nav counts, tags, chips, table heads, field hints, timestamps, banner text.
- **Mono** (400, 12px, −0.01em): model IDs, URLs, token/context counts, durations, verdict values, config file names. Inline `code` uses the same face inside a 4px-radius sunk chip with a hairline; `kbd` adds a 2px bottom edge so a key reads as pressable.

### Named Rules

**The 12px Floor Rule.** No functional text goes below 12px. 12px is the label, tag, hint and mono tier; a value that will not fit is renamed or wrapped, never shrunk.

**The Tabular Rule.** `font-variant-numeric: tabular-nums` is set on the body, so context sizes, durations, counts and request times line up in columns. Monospace marks a string as an identifier; tabular numerals keep figures comparable.

## Layout

A two-column shell: a 232px sticky rail (`100dvh`, 20px/14px/16px padding, 22px stack gap) against one working surface. The surface is capped at 1180px, padded 28px at the page edge and 48px at the bottom, with an 18px gap between panels. The rail carries identity, the four views with the model count, the gateway readout and the appearance picker; the surface carries the task.

Every view follows the same beat: top bar (title, one-line lede, sync time, refresh) → optional banners → panels. Panels are 1px-ruled 12px-radius plates with an 18/20/20px pad, a head row that wraps at narrow widths, and an optional action row separated by a hairline.

The overview uses a hairline fact grid — four cells separated by 1px gaps over the rule colour — for gateway, catalogue, runtime and config. The models view is the workbench proper: toolbar (search, segmented filter, count, primary "新增模型") above a `1fr` table; when the inspector opens the grid becomes `1fr 344px`, the inspector sticks to `top: 16px`, and the table keeps its scroll position.

Responsive behaviour is structural, not fluid:

- **≤1180px** — the workbench collapses to one column and the inspector becomes a normal block below the table (no longer sticky).
- **≤980px** — the rail turns into a top band: brand, a horizontally scrolling nav, and a footer with the appearance picker; the gateway readout and nav counts are hidden; the surface padding becomes 18px 16px with a 40px bottom.
- **≤760px** — facts 4→2 columns, saved/adopted and mode choices stack to one, field rows and diagnostics go single-column, the top bar and panel heads stack, the segmented filter fills the width, and the model table drops 协议 and 输出.
- **≤560px** — nav becomes a 2-column grid with 40px rows, facts go to one column, metrics go 2 columns with the third spanning both, the table drops 能力 and 档位 (`col-actions` narrows to 68px), panel padding drops to 15/14/16px and the title to 21px.

The recent-request table is capped at 340px with a sticky head; the model table is not capped because the catalogue is the work. Spacing uses one short rhythm — 4 / 8 / 12 / 18 / 28px — with the control height fixed at 32px (27px for the small button) so rows and fields align across panels. The connection form is the one place that runs on a 16px group rhythm instead of 18px, because its field groups, environment block and pending diff are read as one sequence.

## Elevation & Depth

Depth is a hairline plus a whisper of shadow, not a float. Resting panels get `--shadow-1` (`0 1px 2px rgba(23,32,43,.06), 0 1px 1px rgba(23,32,43,.04)`) under a 1px rule — enough to separate white from near-white, never enough to look like a card stack. Only three things lift further: the inspector (`--shadow-2`, `0 8px 24px` + `0 2px 6px`), the toast, and the gate card. Dark mode swaps to pure-black shadows at higher opacity because tinted shadows go muddy on a dark ground.

### Shadow Vocabulary
- **Resting plate** (`0 1px 2px rgba(23,32,43,.06), 0 1px 1px rgba(23,32,43,.04)`): every panel, and the selected thumb inside the segmented filter.
- **Lifted plate** (`0 8px 24px rgba(23,32,43,.10), 0 2px 6px rgba(23,32,43,.06)`): the model inspector, toast, and gate card.
- **State halo** (`0 0 0 2px color-mix(in srgb, <tone> 20%, transparent)`): a 7px status dot's ring, so a green dot is legible on white without becoming a badge.
- **Editing bar** (`inset 2px 0 0 #1a63bd`): the left edge of the table row currently open in the inspector.

### Named Rules

**The One-Lift Rule.** A surface is either at rest (1px rule + shadow-1) or lifted (rule-strong + shadow-2) for as long as it is the thing being edited. Nothing carries a heavier shadow to look important.

## Shapes

Rounded, quietly. Four radii: **4px** for micro marks (`code`, `kbd`, checkbox, segmented thumb, search clear), **6px** for controls (button, field, nav item), **8px** for grouped blocks and messages (fact grid, banner, note, verdict strip, empty state, diagnostic card, choice, toast), **12px** for plates (panel, inspector, gate card). Tags and chips are full pills (`999px`), as is the state dot.

Hairline grids are the recurring silhouette: a `1px` gap over the rule colour makes a four-cell fact strip, a three-cell metric strip, and the saved/adopted pair read as ruled registers rather than as separate cards. Borders are `1px`, with two deliberate 2px exceptions: the bottom edge of `kbd` and the inset bar that marks the row under edit.

**The Nested-Radius Rule.** Use the 12/8/6/4px scale for plates, groups, controls and micro marks. Fields can sit directly in a plate when spacing already establishes the group; an extra wrapper is not required.

## Components

### Buttons
- **Shape:** 6px radius, 32px minimum height, 5px 13px padding, 12.5px/500 label, 6px icon gap.
- **Primary:** Work Blue fill, white label — one per action group ("新增模型", "保存目录", "保存目标", "保存连接"); the model toolbar and its editor each carry their own action.
- **Hover / Focus:** hover darkens the fill (`#17589f` light, `#2b76c9` dark) or, for neutral buttons, raises the edge to Ink 4; `:focus-visible` is a 2px Work Blue outline at 2px offset, globally, and fields additionally take a 3px 16% blue ring. Transitions are 120ms.
- **Quiet / Outline / Danger:** quiet is borderless Ink 3 for non-committing acts ("放弃修改"); outline is the same 32px control with a `rule-input` stroke for secondary acts ("重试", "查看连接设置", diagnostics); danger is a solid red fill reserved for confirmed deletion.

### Inputs / Fields
- **Style:** 32px, 6px radius, `rule-input` 1px stroke on white, 12.5px text, blue caret; select uses two 4px gradient chevrons and 26px right padding.
- **Focus:** border turns Work Blue and gains a 3px 16%-blue ring, replacing the outline.
- **Disabled:** sunk background, Ink 4 text, `not-allowed` cursor. Derived facts are not disabled inputs — protocol is shown as plain static mono text because it follows from the ID.
- **Errors:** an inline `.errors` block (bad tint, 1px 34% red rule, 12px red text) above the footer; the field keeps its own stroke.

### Tables
- **Style:** 12.5px body, 12px heads on a sunk sticky head, 9px 12px cells, 1px row rules, `tabular-nums` on numeric columns, row hover to `surface-hover`.
- **States:** the editing row takes a `blue-soft` wash plus a 2px inset Work Blue bar on its first cell; the row awaiting delete confirmation takes a `bad-soft` wash and swaps its actions for "确认删除 / 取消".
- **Column priority:** 协议 and 输出 drop first (760px), then 能力 and 档位 (560px); the ID cell and the actions never drop.

### Model Inspector (signature)
A 344px sticky plate beside the table: title + close, then a single-column form — ID (mono, with a derived-protocol hint), display name, static protocol, context/output pair, a bordered capability fieldset with three checkboxes and a caution that a declared capability does not create one, effort identifiers as mono text plus live chips, and a default-effort select. The footer holds 取消 / 保存目录, and a hint states that saving submits the whole catalogue and applies immediately. It rises 6px into place over 180ms and never covers the row it edits.

### Saved / Adopted Binding (signature)
Two equal columns split by a 1px rule: **已保存** (16px/600 value, model plus effort beneath) and **实际采用** (same structure, its own value and sub-line). Under both, one verdict strip — dot + bold word + explanatory sentence — states the relationship ("待准备", "已生效", "策略损坏"). The subagent view repeats the same pattern for the runtime facts, so the two places never say it differently.

### Fact Strip, Metrics and Diagnostics
The fact strip is four 1px-separated cells: 12px label, 13.5px/600 value with a state dot where the value is a state, 12px mono sub-line. Metrics use the same grid with 17px figures. Diagnostics are two sunk cards, each with a title, a dot+word state, a meta line that survives a missing result (min-height 34px), and its own outline button.

### Selection, Tags and Chips
Mode selection uses two bordered 8px cards with a drawn radio dot that fills solid blue when checked; the checked card also takes the blue tint. Capability tags are pills with a `rule-strong` hairline and the plate's own background, so they stay quiet inside a row; the saved/subagent tag is the only blue pill. Effort chips are sunk pills that turn red when the typed identifier is invalid.

### Connection Form
The one long form in the panel: fields and groups at a 16px rhythm, environment-variable status in a sunk 8px block with two dot+word lines, a pending-diff block in the amber tint that compares saved with active values, and an action row carrying a draft state, "填入当前生效值" and the primary save. It never shows a credential, only the variable name and whether it is present.

### Operation Bar, Toasts and Gate
A running operation shows a compact bar (dot, name, note, 34px indeterminate blue track) rather than a modal. Toasts sit bottom-centre, 8px radius, shadow-2, green check or red alert icon, and slide up 10px into place. The gate is a 460px card centred on the ground for key/session checks, with numbered steps in a 20px-indented list.

## Do's and Don'ts

### Do:
- **Do** keep **已保存** and **实际采用** in separate labelled columns with a verdict strip between the facts; they are different states of the world.
- **Do** let the edited row stay visible: inspector to the right, row tinted, 2px blue bar, table position unchanged.
- **Do** state every capability, effort and limit as a declared catalogue value, and say out loud that declaring vision does not grant it.
- **Do** use blue for committing actions in each action group, focus, links, the current view and the saved state.
- **Do** carry state as dot + word, with a tinted block when the whole message is the state (restart pending, save failed).
- **Do** keep the 32px control height and 12px text floor so dense tables and forms stay aligned and legible.
- **Do** show a truthful intermediate state for every operation (operation bar, busy button, disabled save, empty state).

### Don't:
- **Don't** merge saved and adopted into one "current model" row, or let a policy preview read as a runtime observation.
- **Don't** invent models, prices, request counts or capabilities; screenshot acceptance fixtures are not evidence of what a model can do.
- **Don't** put the model editor in a modal that hides the table, or navigate away from the list to edit a row.
- **Don't** tint a whole table row green/amber/red to encode state; red is reserved for errors and the delete confirmation.
- **Don't** use blue decoratively — headings, icons, borders and secondary buttons stay neutral.
- **Don't** shrink functional text below 12px, or set prose in monospace.
- **Don't** make dark the default or treat it as automatic unless the user picked 跟随系统; light is the shipped default.
- **Don't** render credentials, the panel key or raw configuration in the DOM, and don't imply the panel can restart the gateway.
