'use strict';

// 0.91.0 — the SSS design system, part two: the stylesheet.
//
// One file, served once, cached hard. Every rule below earns its place by
// being used on more than one page; anything page-specific stays in that
// page's own module.
//
// The organising idea, and the reason this is not Tabler: border, fill, radius
// and shadow each say "separate object", and spending all four on every block
// is what made every SSS page read as a flat list of equally important things.
// Here a panel gets a hairline and a radius, a row gets neither, and the only
// element that lifts off the page is the one that needs to.

const tokens = require('./tokens');

function stylesheet(skin) {
  return `
:root { ${tokens.variables(skin)} ${tokens.FONTS} }

*, *::before, *::after { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

a { color: var(--accent); }
a:hover { color: var(--accent-hover); }

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* ---------------------------------------------------------------- shell */
.app { display: grid; grid-template-columns: var(--rail-w) 1fr; min-height: 100vh; }

.rail {
  background: var(--surface); border-right: 1px solid var(--line);
  display: flex; flex-direction: column; align-items: center;
  gap: 4px; padding: 14px 0; position: sticky; top: 0; height: 100vh;
}
.rail-mark {
  width: 38px; height: 38px; display: grid; place-items: center;
  background: var(--accent); color: var(--accent-ink);
  font-family: var(--font-cond); font-weight: 700; font-size: 15px;
  letter-spacing: .06em; text-decoration: none;
  clip-path: polygon(10% 0, 100% 0, 90% 100%, 0 100%);
  margin-bottom: 12px;
}
.rail-btn {
  position: relative; width: 44px; height: 44px;
  display: grid; place-items: center;
  border: 0; background: transparent; color: var(--ink-3);
  border-radius: var(--r); cursor: pointer; text-decoration: none;
}
.rail-btn:hover { color: var(--ink); background: var(--surface-2); }
.rail-btn[aria-current="page"] { color: var(--ink); background: var(--accent-soft); }
.rail-btn[aria-current="page"]::before {
  content: ""; position: absolute; left: -14px; top: 10px; bottom: 10px;
  width: 3px; background: var(--accent);
}
.rail-btn svg { width: 21px; height: 21px; }
.rail-spacer { flex: 1; }
.rail-tip {
  position: absolute; left: 52px; white-space: nowrap;
  background: var(--raised); border: 1px solid var(--line-strong);
  padding: 3px 8px; border-radius: var(--r-sm);
  font-size: 12px; color: var(--ink); opacity: 0; pointer-events: none;
  transition: opacity .12s ease; z-index: 30;
}
.rail-btn:hover .rail-tip, .rail-btn:focus-visible .rail-tip { opacity: 1; }

.main { display: flex; flex-direction: column; min-width: 0; }

.topbar {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  padding: 0 var(--pad); min-height: 60px;
  border-bottom: 1px solid var(--line); background: var(--surface);
  position: sticky; top: 0; z-index: 20;
}
.topbar h1 {
  margin: 0; font-family: var(--font-cond); font-weight: 700;
  font-size: 21px; letter-spacing: .04em; text-transform: uppercase;
}
.topbar h1 small { color: var(--ink-3); font-weight: 600; font-size: inherit; }
.topbar .right { margin-left: auto; display: flex; align-items: center; gap: 10px; }

.wrap { max-width: 1060px; margin: 0 auto; width: 100%; padding: 26px var(--pad) 40px; }

/* ----------------------------------------------------------- step rail */
.steprail {
  display: flex; padding: 0 var(--pad); background: var(--surface);
  border-bottom: 1px solid var(--line); overflow-x: auto;
}
.step {
  position: relative; flex: 1 1 0; min-width: 132px;
  display: flex; align-items: center; gap: 9px;
  padding: 13px 8px 13px 0; border: 0; background: transparent;
  cursor: pointer; text-align: left; color: var(--ink-3);
  font-family: var(--font-body); text-decoration: none;
}
.step:hover { color: var(--ink-2); }
.step-num {
  flex: none; width: 26px; height: 26px; display: grid; place-items: center;
  font-family: var(--font-cond); font-weight: 700; font-size: 14px;
  border: 1px solid var(--line-strong); color: inherit;
  clip-path: polygon(14% 0, 100% 0, 86% 100%, 0 100%);
}
.step-label {
  display: block; font-family: var(--font-cond); font-weight: 600;
  font-size: 15px; letter-spacing: .07em; text-transform: uppercase; line-height: 1.1;
}
.step-sub { display: block; font-size: 11px; color: var(--ink-3); }
.step::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: -1px;
  height: 2px; background: var(--line);
}
.step[data-state="done"] { color: var(--ink-2); }
.step[data-state="done"] .step-num { border-color: var(--ok); color: var(--ok); }
.step[data-state="done"]::after { background: var(--ok); }
.step[data-state="now"] { color: var(--ink); }
.step[data-state="now"] .step-num { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.step[data-state="now"]::after { background: var(--accent); height: 3px; }

/* ------------------------------------------------------------- panels */
.panel {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-lg); margin-bottom: 16px; overflow: hidden;
}
.panel-head {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 18px; border-bottom: 1px solid var(--line);
}
.panel-head h2, .panel-head h3 {
  margin: 0; font-family: var(--font-cond); font-weight: 700;
  font-size: 17px; letter-spacing: .06em; text-transform: uppercase;
}
.panel-head p { margin: 2px 0 0; font-size: 12px; color: var(--ink-3); }
.panel-body { padding: 18px; }
.panel-body > * + * { margin-top: 16px; }
.panel-foot {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 12px 18px; border-top: 1px solid var(--line); background: var(--surface-2);
}

.lede { margin-bottom: 22px; }
.lede h2 {
  margin: 0 0 4px; font-family: var(--font-cond); font-weight: 700;
  font-size: 30px; letter-spacing: .02em; text-wrap: balance;
}
.lede p { margin: 0; color: var(--ink-2); max-width: 62ch; }

.grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
.grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }

/* --------------------------------------------------------- primitives */
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 9px; border-radius: 999px;
  font-size: 11px; font-weight: 600; letter-spacing: .03em; white-space: nowrap;
}
.chip::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.chip.plain::before { display: none; }
.chip[data-tone="ok"] { color: var(--ok); background: var(--ok-soft); }
.chip[data-tone="warn"] { color: var(--warn); background: var(--warn-soft); }
.chip[data-tone="info"] { color: var(--info); background: var(--info-soft); }
.chip[data-tone="bad"] { color: var(--bad); background: var(--bad-soft); }
.chip[data-tone="off"] { color: var(--ink-3); background: var(--surface-2); }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  padding: 9px 16px; border-radius: var(--r); cursor: pointer;
  font-family: var(--font-body); font-size: 13px; font-weight: 600;
  border: 1px solid transparent; white-space: nowrap; text-decoration: none;
}
.btn.primary { background: var(--accent); color: var(--accent-ink); }
.btn.primary:hover { background: var(--accent-hover); color: var(--accent-ink); }
.btn.primary:active { background: var(--accent-active); }
.btn.ghost { border-color: var(--line-strong); background: transparent; color: var(--ink); }
.btn.ghost:hover { border-color: var(--ink-3); color: var(--ink); }
.btn.danger { border-color: var(--bad); color: var(--bad); background: transparent; }
.btn.danger:hover { background: var(--bad-soft); }
.btn.sm { padding: 5px 11px; font-size: 12px; }
.btn:disabled { opacity: .4; cursor: default; }

.icon-btn {
  width: 34px; height: 34px; display: grid; place-items: center;
  border: 1px solid var(--line-strong); background: transparent;
  color: var(--ink-2); border-radius: var(--r); cursor: pointer;
}
.icon-btn:hover:not(:disabled) { color: var(--ink); border-color: var(--ink-3); }
.icon-btn:disabled { opacity: .35; cursor: default; }

.seg { display: inline-flex; border: 1px solid var(--line-strong); border-radius: var(--r); overflow: hidden; }
.seg button, .seg a {
  border: 0; background: transparent; color: var(--ink-2); text-decoration: none;
  font-family: var(--font-body); font-size: 12px; font-weight: 600;
  padding: 6px 12px; cursor: pointer;
}
.seg [aria-pressed="true"], .seg [aria-current="true"] { background: var(--raised); color: var(--ink); }

label.f { display: block; }
label.f > span {
  display: block; font-size: 11px; font-weight: 600; letter-spacing: .09em;
  text-transform: uppercase; color: var(--ink-3); margin-bottom: 5px;
}
input.t, select.t, textarea.t {
  width: 100%; padding: 9px 11px;
  background: var(--ground); color: var(--ink);
  border: 1px solid var(--line-strong); border-radius: var(--r);
  font-family: var(--font-body); font-size: 13px;
}
input.t.mono, textarea.t.mono { font-family: var(--font-mono); font-size: 12px; }
.hint { font-size: 12px; color: var(--ink-3); margin-top: 6px; }
.hint strong { color: var(--ink-2); }

.sw { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; }
.sw input { position: absolute; opacity: 0; width: 0; height: 0; }
.sw i {
  width: 38px; height: 21px; flex: none; border-radius: 999px;
  background: var(--line-strong); position: relative; transition: background .15s ease;
}
.sw i::after {
  content: ""; position: absolute; top: 3px; left: 3px;
  width: 15px; height: 15px; border-radius: 50%; background: #fff;
  transition: transform .15s ease;
}
.sw input:checked + i { background: var(--ok); }
.sw input:checked + i::after { transform: translateX(17px); }
.sw input:focus-visible + i { outline: 2px solid var(--accent); outline-offset: 2px; }
.sw b { font-weight: 600; }
.sw small { display: block; color: var(--ink-3); font-weight: 400; }

/* rows: text is a block stack, never inline spans that run together */
.rows { display: flex; flex-direction: column; }
.row { display: flex; align-items: center; gap: 12px; padding: 11px 18px; border-top: 1px solid var(--line); }
.rows .row:first-child { border-top: 0; }
.row:hover { background: var(--surface-2); }
.row-main { min-width: 0; flex: 1; }
.row-name { display: block; font-weight: 600; line-height: 1.35; }
.row-sub { display: block; font-size: 12px; color: var(--ink-3); line-height: 1.4; }
.row-tags { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 3px; }

.drag { color: var(--ink-3); cursor: grab; flex: none; padding: 4px; border-radius: var(--r-sm); background: none; border: 0; }
.drag:hover { color: var(--ink); background: var(--raised); }
.row.dragging { opacity: .35; }
.row.over { box-shadow: inset 0 2px 0 var(--accent); }
.row.over-below { box-shadow: inset 0 -2px 0 var(--accent); }

.tile {
  width: 62px; height: 35px; flex: none; border-radius: var(--r-sm);
  background: var(--raised); overflow: hidden; display: grid; place-items: center;
  font-family: var(--font-cond); font-weight: 700; font-size: 11px;
  letter-spacing: .06em; color: #fff; object-fit: cover;
}
img.tile { display: block; }

.stat { padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--r); background: var(--surface-2); }
.stat b { display: block; font-family: var(--font-cond); font-weight: 700; font-size: 30px; line-height: 1; font-variant-numeric: tabular-nums; }
.stat span { display: block; font-size: 11px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; color: var(--ink-3); margin-top: 6px; }
.stat em { font-style: normal; font-size: 12px; color: var(--ink-3); }

/* severity stripe — state read before any number */
.stripe { border-left: 3px solid var(--line); padding-left: 12px; }
.stripe[data-tone="ok"] { border-left-color: var(--ok); }
.stripe[data-tone="warn"] { border-left-color: var(--warn); }
.stripe[data-tone="bad"] { border-left-color: var(--bad); }
.stripe[data-tone="info"] { border-left-color: var(--info); }

.note { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: var(--r); font-size: 13px; }
.note[data-tone="ok"] { background: var(--ok-soft); color: var(--ok); }
.note[data-tone="warn"] { background: var(--warn-soft); color: var(--warn); }
.note[data-tone="bad"] { background: var(--bad-soft); color: var(--bad); }
.note[data-tone="info"] { background: var(--info-soft); color: var(--info); }
.note b { display: block; }
.note span { color: var(--ink-2); }

/* collapsible group — closed <details> still submits its inputs, which a
   disabled fieldset does not; that difference has cost this project two bugs */
.fold { border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); margin-bottom: 12px; }
.fold > summary { display: flex; align-items: center; gap: 12px; padding: 14px 18px; cursor: pointer; list-style: none; }
.fold > summary::-webkit-details-marker { display: none; }
.fold > summary::before {
  content: ""; flex: none; width: 8px; height: 8px;
  border-right: 2px solid var(--ink-3); border-bottom: 2px solid var(--ink-3);
  transform: rotate(-45deg); transition: transform .15s ease;
}
.fold[open] > summary::before { transform: rotate(45deg); }
.fold h3 { margin: 0; font-family: var(--font-cond); font-weight: 700; font-size: 17px; letter-spacing: .06em; text-transform: uppercase; }
.fold summary p { margin: 1px 0 0; font-size: 12px; color: var(--ink-3); }
.fold-body { padding: 0 18px 18px; }

/* team picker */
.teams { display: grid; grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); gap: 10px; }
.team {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 9px 10px; border: 1px solid var(--line); border-radius: var(--r);
  background: var(--surface-2); cursor: pointer; text-align: left;
  font-family: var(--font-body); font-size: 13px; color: var(--ink);
}
.team:hover { border-color: var(--line-strong); }
.team[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); }
.team[aria-pressed="true"] .team-name { font-weight: 600; }
.crest { width: 28px; height: 28px; flex: none; border-radius: 50%; object-fit: contain; background: var(--raised); }
.team-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* sticky action bar */
.actions {
  position: sticky; bottom: 0; z-index: 10;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 12px var(--pad); background: var(--surface); border-top: 1px solid var(--line);
}
.actions .spacer { flex: 1; }
.saved { font-size: 12px; color: var(--ink-3); }
.saved b { color: var(--ok); font-weight: 600; }

/* tables */
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th {
  text-align: left; font-family: var(--font-cond); font-weight: 600;
  font-size: 12px; letter-spacing: .09em; text-transform: uppercase;
  color: var(--ink-3); padding: 9px 12px; border-bottom: 1px solid var(--line);
}
.tbl td { padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: middle; }
.tbl tr:hover td { background: var(--surface-2); }
.tbl-wrap { overflow-x: auto; }
.mono, .text-mono { font-family: var(--font-mono); font-size: 12px; }
.tabular { font-variant-numeric: tabular-nums; }

.urlbox { display: flex; gap: 8px; }
.urlbox input { flex: 1; min-width: 0; }

/* auth pages */
.auth { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
.auth-card { width: 100%; max-width: 420px; }
.auth-brand { display: flex; align-items: center; gap: 10px; justify-content: center; margin-bottom: 18px; }

@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
@media (max-width: 820px) {
  .app { grid-template-columns: 1fr; }
  .rail { position: static; height: auto; flex-direction: row; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--line); }
  .rail-mark { margin: 0 8px 0 0; }
  .rail-spacer { flex: none; }
  .rail-btn[aria-current="page"]::before { left: 10px; right: 10px; top: auto; bottom: -14px; width: auto; height: 3px; }
  .rail-tip { display: none; }
  .lede h2 { font-size: 24px; }
  .step-sub { display: none; }
}
`;
}

module.exports = { stylesheet };
