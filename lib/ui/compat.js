'use strict';

// 0.92.0 — the migration layer.
//
// Nine pages of admin markup are written in Tabler's vocabulary: .card,
// .form-control, .btn-primary, .row/.col-md-6, .badge, .datagrid. Rewriting
// all of it in one release would be a very large diff with no way to review it
// safely, and leaving it on Tabler would mean half the product looked like the
// new design and half did not — which is worse than either.
//
// So the legacy class names are mapped onto the new tokens. Every existing page
// gets the new palette, type, spacing and controls without its markup changing
// at all, and pages can then be rewritten in the native vocabulary one at a
// time with no visible jump when each one lands.
//
// This is a bridge and it is meant to shrink. A class that no page uses any
// more should be deleted from here; when the file is empty, the migration is
// finished.
//
// Only the classes actually present in this codebase are implemented — the
// list came from grepping every class attribute in lib/ and addon.js, not from
// reimplementing Bootstrap. Anything not in that list is not supported, on
// purpose: a half-complete framework clone is a liability.

function compatCss() {
  return `
/* ---------------------------------------------------------------- layout */
.container-xl, .container-fluid, .container-tight { width: 100%; margin: 0 auto; }
.container-tight { max-width: 480px; }

.row { display: flex; flex-wrap: wrap; margin-left: -6px; margin-right: -6px; }
.row > [class*="col-"] { padding-left: 6px; padding-right: 6px; min-width: 0; }
.row.g-0 { margin: 0; } .row.g-0 > [class*="col-"] { padding: 0; }
.row.g-2 { row-gap: 8px; } .row.g-3 { row-gap: 12px; }
.row-cards { row-gap: 12px; }

.col-auto { flex: 0 0 auto; width: auto; max-width: 100%; }
.col { flex: 1 1 0; min-width: 0; }
.col-12 { flex: 0 0 100%; max-width: 100%; }
.col-6 { flex: 0 0 50%; max-width: 50%; }
@media (min-width: 576px) {
  .col-sm-4 { flex: 0 0 33.3333%; max-width: 33.3333%; }
  .col-sm-6 { flex: 0 0 50%; max-width: 50%; }
}
@media (min-width: 768px) {
  .col-md-1 { flex: 0 0 8.3333%; max-width: 8.3333%; }
  .col-md-2 { flex: 0 0 16.6667%; max-width: 16.6667%; }
  .col-md-3 { flex: 0 0 25%; max-width: 25%; }
  .col-md-4 { flex: 0 0 33.3333%; max-width: 33.3333%; }
  .col-md-5 { flex: 0 0 41.6667%; max-width: 41.6667%; }
  .col-md-6 { flex: 0 0 50%; max-width: 50%; }
  .col-md-7 { flex: 0 0 58.3333%; max-width: 58.3333%; }
  .col-md-8 { flex: 0 0 66.6667%; max-width: 66.6667%; }
}
@media (min-width: 992px) {
  .col-lg-3 { flex: 0 0 25%; max-width: 25%; }
  .col-lg-4 { flex: 0 0 33.3333%; max-width: 33.3333%; }
  .col-lg-5 { flex: 0 0 41.6667%; max-width: 41.6667%; }
  .col-lg-7 { flex: 0 0 58.3333%; max-width: 58.3333%; }
  .col-lg-8 { flex: 0 0 66.6667%; max-width: 66.6667%; }
}
@media (min-width: 1200px) { .col-xl-3 { flex: 0 0 25%; max-width: 25%; } }
@media (max-width: 767.98px) { [class*="col-md-"], [class*="col-lg-"] { flex: 0 0 100%; max-width: 100%; } }

/* ----------------------------------------------------------------- cards */
.card {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-lg); margin-bottom: 16px; overflow: hidden;
}
.card-header {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 18px; border-bottom: 1px solid var(--line);
}
.card-title {
  margin: 0; font-family: var(--font-cond); font-weight: 700;
  font-size: 17px; letter-spacing: .06em; text-transform: uppercase;
}
.card-body { padding: 18px; }
.card-footer {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 12px 18px; border-top: 1px solid var(--line); background: var(--surface-2);
}
.card-md .card-body { padding: 22px; }
.card-table { margin: 0; }

.page-header { margin-bottom: 20px; }
.page-title {
  margin: 0; font-family: var(--font-cond); font-weight: 700;
  font-size: 28px; letter-spacing: .02em; text-wrap: balance;
}
.page-pretitle {
  font-size: 11px; font-weight: 600; letter-spacing: .12em;
  text-transform: uppercase; color: var(--ink-3);
}
.page-body { padding: 0; }
h1, h2, h3 { font-family: var(--font-cond); letter-spacing: .02em; }
h3.card-title, .card-title { letter-spacing: .06em; }

/* ----------------------------------------------------------------- forms */
.form-label {
  display: block; font-size: 11px; font-weight: 600; letter-spacing: .09em;
  text-transform: uppercase; color: var(--ink-3); margin-bottom: 5px;
}
.form-control, .form-select {
  width: 100%; padding: 9px 11px;
  background: var(--ground); color: var(--ink);
  border: 1px solid var(--line-strong); border-radius: var(--r);
  font-family: var(--font-body); font-size: 13px;
}
.form-control::placeholder { color: var(--ink-3); }
.form-control-sm, .form-select-sm { padding: 5px 8px; font-size: 12px; }
.form-control:focus-visible, .form-select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
textarea.form-control { min-height: 90px; }
.form-hint { font-size: 12px; color: var(--ink-3); margin-top: 6px; }
.form-check { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.form-check-inline { display: inline-flex; margin-right: 14px; }
.form-check-label { cursor: pointer; }
.form-check-description { display: block; font-size: 12px; color: var(--ink-3); }
.form-check-input { accent-color: var(--accent); width: 16px; height: 16px; flex: none; margin: 0; }

/* switches keep their meaning: on is a state, not an accent */
.form-switch { align-items: flex-start; }
.form-switch .form-check-input {
  appearance: none; -webkit-appearance: none;
  width: 38px; height: 21px; border-radius: 999px;
  background: var(--line-strong); position: relative; cursor: pointer;
  transition: background .15s ease; border: 0;
}
.form-switch .form-check-input::after {
  content: ""; position: absolute; top: 3px; left: 3px;
  width: 15px; height: 15px; border-radius: 50%; background: #fff;
  transition: transform .15s ease;
}
.form-switch .form-check-input:checked { background: var(--ok); }
.form-switch .form-check-input:checked::after { transform: translateX(17px); }

.input-group { display: flex; align-items: stretch; }
.input-group > .form-control, .input-group > .form-select { border-radius: var(--r) 0 0 var(--r); }
.input-group > :not(:first-child) { margin-left: -1px; }
.input-group > :last-child:not(.form-control) {
  border-radius: 0 var(--r) var(--r) 0; border: 1px solid var(--line-strong);
  display: flex; align-items: center; padding: 0 11px; background: var(--surface-2);
}
.input-group-text { color: var(--ink-3); font-size: 12px; }
.input-group-flat > .form-control { border-right: 0; }

/* --------------------------------------------------------------- buttons */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  padding: 9px 16px; border-radius: var(--r); cursor: pointer;
  font-family: var(--font-body); font-size: 13px; font-weight: 600;
  border: 1px solid var(--line-strong); background: transparent; color: var(--ink);
  white-space: nowrap; text-decoration: none;
}
.btn:hover { border-color: var(--ink-3); color: var(--ink); }
.btn-sm { padding: 5px 11px; font-size: 12px; }
.btn-primary, .btn-danger, .btn-warning, .btn-success { border-color: transparent; color: #fff; }
.btn-primary { background: var(--accent); }
.btn-primary:hover { background: var(--accent-hover); color: #fff; }
.btn-danger { background: var(--bad); }
.btn-warning { background: var(--warn); color: #10151d; }
.btn-success { background: var(--ok); }
.btn-outline-primary { border-color: var(--accent); color: var(--accent); }
.btn-outline-primary:hover { background: var(--accent-soft); color: var(--accent); }
.btn-outline-danger { border-color: var(--bad); color: var(--bad); }
.btn-outline-danger:hover { background: var(--bad-soft); color: var(--bad); }
.btn-outline-secondary { border-color: var(--line-strong); color: var(--ink-2); }
.btn-outline-info { border-color: var(--info); color: var(--info); }
.btn-outline-info:hover { background: var(--info-soft); color: var(--info); }
.btn-link { border: 0; background: none; color: var(--accent); padding: 0; }
.btn:disabled, .btn.disabled { opacity: .4; cursor: default; }
.btn-close {
  border: 0; background: none; color: var(--ink-3); cursor: pointer;
  font-size: 18px; line-height: 1; padding: 0 4px; text-decoration: none;
}
.btn-close::before { content: "\\00d7"; }

/* ---------------------------------------------------------------- tables */
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th {
  text-align: left; font-family: var(--font-cond); font-weight: 600;
  font-size: 12px; letter-spacing: .09em; text-transform: uppercase;
  color: var(--ink-3); padding: 9px 12px; border-bottom: 1px solid var(--line);
}
.table td { padding: 10px 12px; border-bottom: 1px solid var(--line); }
.table-vcenter td, .table-vcenter th { vertical-align: middle; }
.table tbody tr:hover td { background: var(--surface-2); }
.table-responsive { overflow-x: auto; }

.datagrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; }
.datagrid-title { font-size: 11px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; color: var(--ink-3); }
.datagrid-content { margin-top: 2px; }

/* --------------------------------------------------------- badges, alerts */
.badge {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 9px; border-radius: 999px;
  font-size: 11px; font-weight: 600; letter-spacing: .03em; white-space: nowrap;
  background: var(--surface-2); color: var(--ink-2);
}
.bg-green-lt { background: var(--ok-soft); color: var(--ok); }
.bg-red-lt { background: var(--bad-soft); color: var(--bad); }
.bg-orange-lt, .bg-yellow-lt { background: var(--warn-soft); color: var(--warn); }
.bg-blue-lt, .bg-azure-lt { background: var(--info-soft); color: var(--info); }
.bg-secondary-lt, .bg-dark-lt { background: var(--surface-2); color: var(--ink-3); }
.bg-red { background: var(--bad); color: #fff; }
.bg-dark { background: var(--raised); color: var(--ink); }

.alert {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 12px 14px; border-radius: var(--r); font-size: 13px;
  border: 1px solid var(--line); background: var(--surface-2); margin-bottom: 14px;
}
.alert-info { background: var(--info-soft); border-color: transparent; color: var(--info); }
.alert-success { background: var(--ok-soft); border-color: transparent; color: var(--ok); }
.alert-warning { background: var(--warn-soft); border-color: transparent; color: var(--warn); }
.alert-danger { background: var(--bad-soft); border-color: transparent; color: var(--bad); }
.alert strong { color: inherit; }
.alert-dismissible { padding-right: 36px; position: relative; }
.alert-dismissible .btn-close { position: absolute; top: 8px; right: 10px; }

.avatar {
  display: inline-grid; place-items: center; width: 34px; height: 34px;
  border-radius: 50%; background: var(--raised); color: var(--ink);
  font-weight: 600; font-size: 13px; flex: none;
}
.avatar-sm { width: 26px; height: 26px; font-size: 11px; }

details > summary { cursor: pointer; }

/* ------------------------------------------------------------- utilities */
.d-none { display: none !important; }
.d-block { display: block !important; }
.d-inline { display: inline !important; }
.d-inline-block { display: inline-block !important; }
.d-flex { display: flex !important; }
.d-inline-flex { display: inline-flex !important; }
.flex-row { flex-direction: row !important; }
.flex-column { flex-direction: column !important; }
.flex-wrap { flex-wrap: wrap !important; }
.flex-fill { flex: 1 1 auto !important; }
.align-items-start { align-items: flex-start !important; }
.align-items-center { align-items: center !important; }
.align-items-end { align-items: flex-end !important; }
.align-items-baseline { align-items: baseline !important; }
.align-self-start { align-self: flex-start !important; }
.justify-content-between { justify-content: space-between !important; }
.gap-1 { gap: 4px !important; } .gap-2 { gap: 8px !important; } .gap-3 { gap: 12px !important; }

.m-0 { margin: 0 !important; }
.mb-0 { margin-bottom: 0 !important; } .mb-1 { margin-bottom: 4px !important; }
.mb-2 { margin-bottom: 8px !important; } .mb-3 { margin-bottom: 14px !important; }
.mb-4 { margin-bottom: 20px !important; }
.mt-1 { margin-top: 4px !important; } .mt-2 { margin-top: 8px !important; }
.mt-3 { margin-top: 14px !important; } .mt-4 { margin-top: 20px !important; }
.my-2 { margin-top: 8px !important; margin-bottom: 8px !important; }
.my-4 { margin-top: 20px !important; margin-bottom: 20px !important; }
.me-1 { margin-right: 4px !important; } .me-2 { margin-right: 8px !important; } .me-3 { margin-right: 14px !important; }
.ms-1 { margin-left: 4px !important; } .ms-2 { margin-left: 8px !important; } .ms-3 { margin-left: 14px !important; }
.ms-auto { margin-left: auto !important; }
.p-2 { padding: 8px !important; }
.pb-2 { padding-bottom: 8px !important; } .pt-3 { padding-top: 14px !important; }
.ps-3 { padding-left: 14px !important; }
.px-2 { padding-left: 8px !important; padding-right: 8px !important; }
.py-2 { padding-top: 8px !important; padding-bottom: 8px !important; }
.py-3 { padding-top: 14px !important; padding-bottom: 14px !important; }
.py-4 { padding-top: 20px !important; padding-bottom: 20px !important; }
.py-5 { padding-top: 28px !important; padding-bottom: 28px !important; }

.w-1 { width: 1%; } .w-100 { width: 100% !important; } .h-100 { height: 100% !important; }
.text-start { text-align: left !important; }
.text-center { text-align: center !important; }
.text-end { text-align: right !important; }
.text-nowrap { white-space: nowrap !important; }
.text-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.text-uppercase { text-transform: uppercase !important; }
.text-decoration-none { text-decoration: none !important; }
.text-secondary { color: var(--ink-3) !important; }
.text-primary { color: var(--accent) !important; }
.text-success { color: var(--ok) !important; }
.text-danger { color: var(--bad) !important; }
.text-warning { color: var(--warn) !important; }
.text-white { color: #fff !important; }
.text-reset { color: inherit !important; }
.small, small { font-size: 12px; }
.fs-3 { font-size: 20px; }
.fw-normal { font-weight: 400 !important; }
.fw-medium { font-weight: 500 !important; }
.fw-semibold { font-weight: 600 !important; }
.fw-bold { font-weight: 700 !important; }
.border { border: 1px solid var(--line) !important; }
.border-top { border-top: 1px solid var(--line) !important; }
.border-bottom { border-bottom: 1px solid var(--line) !important; }
.border-start { border-left: 1px solid var(--line) !important; }
.border-info { border-color: var(--info) !important; }
.border-warning { border-color: var(--warn) !important; }
.rounded { border-radius: var(--r) !important; }
.rounded-start { border-radius: var(--r) 0 0 var(--r) !important; }
.overflow-hidden { overflow: hidden !important; }
.min-w-0 { min-width: 0 !important; }
.text-break { overflow-wrap: anywhere; }
@media print { .d-print-none { display: none !important; } }
@media (min-width: 768px) { .d-md-none { display: none !important; } .d-md-flex { display: flex !important; } }
@media (max-width: 767.98px) { .d-none.d-md-flex { display: none !important; } }
/* ------------------------------------------- second pass: what the audit found
   Reviewing the migration by diffing every class used in lib/ and addon.js
   against everything the stylesheets define turned up seventy that nothing
   styled any more — they had been coming from tabler.min.css. Page-local
   classes (each page ships its own <style>) are excluded; these are the ones
   that were genuinely about to render unstyled. */

.display-6 { font-family: var(--font-cond); font-size: 34px; font-weight: 700; line-height: 1.1; }
h1 { font-size: 28px; } h2 { font-size: 22px; } h3 { font-size: 18px; } h4 { font-size: 16px; }
.h1 { font-size: 28px; font-weight: 700; } .h3 { font-size: 18px; font-weight: 700; }
.h4 { font-size: 16px; font-weight: 700; }
.subheader { font-size: 11px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; color: var(--ink-3); }
.fst-italic { font-style: italic !important; }
.gap-4 { gap: 18px !important; }
.card-actions { margin-left: auto; display: flex; gap: 8px; align-items: center; }
.datagrid-item { min-width: 0; }
.table-sm td, .table-sm th { padding: 6px 9px; }
.input-group-sm > .form-control, .input-group-sm > .form-select { padding: 5px 8px; font-size: 12px; }
.object-fit-cover { object-fit: cover; }
.ratio { position: relative; width: 100%; }
.ratio::before { content: ""; display: block; padding-top: 56.25%; }
.ratio > * { position: absolute; inset: 0; width: 100%; height: 100%; }

.btn-icon { padding: 7px; width: 34px; height: 34px; }
.btn-info { background: var(--info); border-color: transparent; color: #10151d; }
.btn-outline-success { border-color: var(--ok); color: var(--ok); }
.btn-outline-success:hover { background: var(--ok-soft); color: var(--ok); }
.btn-ghost-secondary { border-color: transparent; color: var(--ink-3); }
.btn-ghost-secondary:hover { border-color: var(--line-strong); color: var(--ink); }
.link-primary { color: var(--accent); }
.link-secondary { color: var(--ink-3); }
.alert-link { color: inherit; font-weight: 600; text-decoration: underline; }
.alert-secondary { background: var(--surface-2); border-color: var(--line); color: var(--ink-2); }

/* progress — a real control, not decoration: it reports warm/scan progress */
.progress { height: 8px; border-radius: 999px; background: var(--line); overflow: hidden; }
.progress-sm { height: 5px; }
.progress-bar { height: 100%; background: var(--accent); transition: width .2s ease; }

/* selectgroup: Tabler's card-style radio group, used by the promotion wizard */
.form-selectgroup { display: flex; flex-wrap: wrap; gap: 8px; }
.form-selectgroup-item { display: block; }
.form-selectgroup-input { position: absolute; opacity: 0; width: 0; height: 0; }
.form-selectgroup-label {
  display: block; padding: 8px 13px; cursor: pointer;
  border: 1px solid var(--line-strong); border-radius: var(--r);
  background: var(--surface-2); color: var(--ink-2); font-size: 13px;
}
.form-selectgroup-input:checked + .form-selectgroup-label {
  border-color: var(--accent); background: var(--accent-soft); color: var(--ink);
}
.form-selectgroup-input:focus-visible + .form-selectgroup-label { outline: 2px solid var(--accent); outline-offset: 2px; }

.status-dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  background: var(--ink-3); margin-right: 6px; flex: none;
}
.status-dot-animated { background: var(--ok); animation: sss-pulse 1.6s ease-in-out infinite; }
@keyframes sss-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

.collapse:not(.show) { display: none; }
.d-lg-inline-block { display: inline-block; }
@media (min-width: 992px) { .pt-lg-3 { padding-top: 14px !important; } }
@media (min-width: 768px) { .order-md-last { order: 99; } }

`;
}

module.exports = { compatCss };
