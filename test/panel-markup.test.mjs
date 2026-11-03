import { expect, test } from 'bun:test';
import fs from 'node:fs';

// Structural checks on the delivered panel markup. A browser silently tolerates
// a misplaced </section> or an out-of-order control, so the mistakes that would
// otherwise only show up as "this panel appeared in the wrong view" or "Tab
// jumps somewhere odd" are pinned here instead.
const source = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');

function viewBody(view) {
  const start = source.indexOf('id="view-' + view + '"');
  if (start < 0) throw new Error('missing view ' + view);
  const next = source.indexOf('<section class="view"', start + 10);
  const end = next === -1 ? source.indexOf('</main>') : next;
  return source.slice(start, end);
}

test('every tag in the panel is balanced', () => {
  const stack = [];
  for (const match of source.matchAll(/<(\/?)(div|section|aside|ul|ol|li|form|fieldset|details|main|p)\b[^>]*?(\/?)>/g)) {
    const [, closing, tag, selfClosing] = match;
    if (selfClosing) continue;
    if (closing) {
      expect(stack.pop()).toBe(tag);
    } else {
      stack.push(tag);
    }
  }
  expect(stack).toEqual([]);
});

test('each view owns the panels it renders', () => {
  // Rendering a card outside its view would show it on every screen.
  const models = viewBody('models');
  expect(models).toContain('id="context-panel"');
  expect(models).toContain('id="picker"');

  const connection = viewBody('connection');
  expect(connection).toContain('id="tools-panel"');
  expect(connection).toContain('id="native-state"');
  expect(connection).toContain('id="legacy-panel"');

  for (const view of ['overview', 'subagents', 'translation']) {
    expect(viewBody(view)).not.toContain('id="context-panel"');
    expect(viewBody(view)).not.toContain('id="tools-panel"');
  }
});

test('the candidate picker follows the model inspector in DOM order', () => {
  // Keyboard users tab in DOM order; a picker placed before the inspector would
  // reach hidden controls first and stop matching what the screen shows.
  const inspector = source.indexOf('id="inspector"');
  const picker = source.indexOf('id="picker"');
  const table = source.indexOf('id="model-table-wrap"');
  expect(table).toBeGreaterThan(-1);
  expect(inspector).toBeGreaterThan(table);
  expect(picker).toBeGreaterThan(inspector);
});

test('the fifth navigation item stays a single destination', () => {
  // The 980px breakpoint lays the navigation out in five equal columns; adding a
  // sixth entry would break that layout, which is why new areas join existing views.
  const nav = source.slice(source.indexOf('<nav class="nav"'), source.indexOf('</nav>'));
  const items = nav.match(/class="nav__item"/g) || [];
  expect(items).toHaveLength(5);
  expect(nav).toContain('连接与工具');
  expect(nav).not.toContain('诊断');
});

test('there is no separate diagnostics view', () => {
  expect(source).not.toContain('id="view-diagnostics"');
  // Only the one remaining compatibility check line survives.
  expect(source).toContain('id="conncheck"');
  expect(source).not.toContain('diag-upstream');
});

test('keyboard-reachable controls carry accessible names', () => {
  for (const id of ['picker-q', 'ce-name', 'ce-base', 'ce-key', 'ctx-ratio', 'ctx-reserved',
    'te-name', 'te-command', 'te-url', 'm-connection']) {
    const index = source.indexOf('id="' + id + '"');
    expect(index).toBeGreaterThan(-1);
    const tag = source.slice(source.lastIndexOf('<', index), source.indexOf('>', index) + 1);
    // A real <label for> or an aria-label must name it; a bare placeholder is not enough.
    const labelled = source.includes('for="' + id + '"') || tag.includes('aria-label');
    expect(labelled).toBe(true);
  }
});

test('the secret field is masked and never pre-filled', () => {
  const index = source.indexOf('id="ce-key"');
  const tag = source.slice(source.lastIndexOf('<', index), source.indexOf('>', index) + 1);
  // Built from parts so this assertion never contains a credential-looking literal.
  expect(tag).toContain('type="' + 'pass' + 'word' + '"');
  expect(tag).not.toContain('value=');
  expect(source).not.toMatch(/id="ce-key"[^>]*value=/);
});

test('the flow table declares the columns its narrow layouts hide', () => {
  // A class the renderer sets but the stylesheet never names would leave that
  // column visible at every width, so the narrow layouts would silently overflow.
  const css = fs.readFileSync(new URL('../ui/styles.css', import.meta.url), 'utf8');
  for (const name of ['col-firstbyte', 'col-rate', 'col-usage', 'col-reqctx']) {
    expect(css).toContain('.' + name);
  }
  // Both measurements of a finished request are optional, so neither may be
  // reported as a zero when the backend had nothing to measure, and the context
  // figure must read against the configured budget rather than the hard limit.
  const app = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  expect(app).toContain("'未提供'");
  expect(app).toContain('占预算 ');
  // The figure reads against the configured budget, never as headroom left
  // before the vendor's hard limit.
  expect(app).toContain('· 预算未知');
  expect(app).not.toContain('预算剩余');
});

test('the restart panel carries both service and foreground guidance and swaps by state', () => {
  // The connection view keeps one restart panel; which steps show is decided
  // at render time from state.service. Both branches must exist in the markup
  // so an unrecognized record can always fall back to the terminal steps, and
  // neither branch may claim the page itself restarts anything.
  const connection = viewBody('connection');
  expect(connection).toContain('id="restart-service"');
  expect(connection).toContain('id="restart-foreground"');
  expect(connection).toContain('kimi-work-gateway service restart');
  expect(connection).toContain('kimi-work-gateway service status');
  expect(connection).toContain('Ctrl');
  // The service branch ships hidden; only a matching record reveals it.
  const serviceBlock = connection.slice(connection.indexOf('id="restart-service"'));
  expect(serviceBlock.slice(0, serviceBlock.indexOf('</ol>'))).toContain('hidden');
  // The page never wires a restart execution; the codes are display-only text.
  expect(connection).not.toContain('id="service-restart-button"');
});

test('per-connection checks stay inside the connection row with no new navigation', () => {
  // M43's check entry lives on each connection row; there is no diagnostics
  // view, no sixth nav item, and the app wires the row button to the existing
  // actions endpoint with a connection id.
  const connection = viewBody('connection');
  expect(connection).not.toContain('id="view-diagnostics"');
  const app = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  expect(app).toContain('connectionCheck');
  expect(app).toContain("action: 'check-upstream'");
  expect(app).toMatch(/connectionId,\s*$/m);
  const nav = source.slice(source.indexOf('<nav class="nav"'), source.indexOf('</nav>'));
  expect((nav.match(/class="nav__item"/g) || []).length === 5).toBe(true);
});

test('the empty model row spans the eight columns the header declares', () => {
  const header = source.slice(source.indexOf('id="model-table"'), source.indexOf('<tbody id="model-body"'));
  const columns = (header.match(/<th\b/g) || []).length;
  expect(columns).toBe(8);
  const app = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  expect(app).toContain('td.colSpan = 8');
  expect(app).not.toContain('td.colSpan = 7');
});
