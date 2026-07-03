// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
// CSS chunk for the static report HTML — extracted from
// src/cli/report-style.ts (file-length cap split).

export const STYLE_PANELS = `  /* tables */
  table { width: 100%; border-collapse: collapse; }
  th, td {
    text-align: left;
    padding: 0.65rem 0.75rem;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
    font-size: 14px;
  }
  th {
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    color: var(--accent);
    letter-spacing: 0.08em;
    border-bottom: 2px solid var(--accent-soft);
  }
  tr:last-child td { border-bottom: 0; }
  table.dense td, table.dense th { padding: 0.45rem 0.6rem; }
  table.dense td { font-size: 13.5px; }
  code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.85em;
    padding: 0.1em 0.4em;
    background: var(--bg-3);
    border-radius: 4px;
    border: 1px solid var(--border);
  }

  /* severities */
  .sev-high { color: var(--bad); font-weight: 700; }
  .sev-medium { color: var(--warn); font-weight: 600; }
  .sev-low { color: var(--accent-2); }
  .sev-info { color: var(--ink-soft); }

  .verdict-forwarded { color: var(--good); font-weight: 700; }
  .verdict-dismissed { color: var(--bad); font-weight: 600; }
  .verdict-acked { color: var(--ink-soft); }
  tr.skipped td { color: var(--ink-soft); font-style: italic; }

  /* config panel under shell */
  .cfg-panel { font-size: 13.5px; }
  .cfg-panel > .panel-body { padding-top: 0.25rem; }
  .cfg-grid {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0.75rem 0;
  }
  .cfg-row {
    display: grid;
    grid-template-columns: 72px 1fr 40px;
    gap: 0.6rem;
    align-items: center;
  }
  .cfg-row .cfg-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ink-soft);
    font-weight: 600;
  }
  .cfg-row input[type="text"],
  .cfg-row select {
    grid-column: 2 / span 2;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: 13px;
  }
  .cfg-row input[type="text"]:focus,
  .cfg-row select:focus {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .cfg-dial input[type="range"] {
    appearance: none;
    -webkit-appearance: none;
    background: transparent;
    height: 18px;
    margin: 0;
  }
  .cfg-dial input[type="range"]::-webkit-slider-runnable-track {
    height: 6px;
    background: var(--accent-soft);
    border-radius: 3px;
  }
  .cfg-dial input[type="range"]::-moz-range-track {
    height: 6px;
    background: var(--accent-soft);
    border-radius: 3px;
  }
  .cfg-dial input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: linear-gradient(180deg, var(--accent), var(--accent-2));
    margin-top: -5px;
    box-shadow: 0 1px 3px rgba(255,111,168,0.4);
    cursor: pointer;
  }
  .cfg-dial input[type="range"]::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: linear-gradient(180deg, var(--accent), var(--accent-2));
    border: 0;
    box-shadow: 0 1px 3px rgba(255,111,168,0.4);
    cursor: pointer;
  }
  .cfg-val {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    text-align: right;
    color: var(--ink);
    font-size: 13px;
  }
  .cfg-divider {
    height: 1px;
    background: var(--border);
    margin: 0.25rem 0;
  }
  .cfg-diff {
    margin-top: 0.75rem;
    padding: 0.75rem;
    background: var(--bg-3);
    border: 1px dashed var(--border);
    border-radius: 10px;
  }
  .cfg-diff.has-changes {
    border-style: solid;
    border-color: var(--accent);
    background: linear-gradient(135deg, var(--accent-soft), var(--bg-3));
  }
  .cfg-diff-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }
  .cfg-diff-json {
    margin: 0.5rem 0 0;
    font-size: 11px;
    line-height: 1.5;
    max-height: 200px;
    overflow: auto;
  }
  .cfg-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .cfg-apply, .cfg-reset {
    padding: 0.4rem 0.8rem;
    border: 0;
    border-radius: 8px;
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    transition: transform 0.08s ease;
  }
  .cfg-apply {
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: white;
    box-shadow: 0 1px 3px rgba(255,111,168,0.4);
  }
  .cfg-apply:hover { transform: translateY(-1px); }
  .cfg-apply:active { transform: translateY(1px); }
  .cfg-apply:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .cfg-reset {
    background: transparent;
    color: var(--ink-soft);
    border: 1px solid var(--border);
  }
  .cfg-reset:hover { background: var(--bg-2); }
  .cfg-toast {
    color: var(--good);
    font-weight: 700;
    font-size: 12px;
  }

  /* floating action toast — feed/play/tease feedback */
  .xp-toast {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    padding: 12px 22px;
    border-radius: 999px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    box-shadow: 0 8px 24px rgba(0,0,0,0.12);
    font-weight: 700;
    font-size: 14px;
    z-index: 999;
    animation: toast-pop 0.25s ease-out;
  }
  .xp-toast.good { color: var(--good); border-color: var(--good); }
  .xp-toast.warn { color: var(--warn); border-color: var(--warn); }
  .xp-toast.info { color: var(--ink-soft); }
  @keyframes toast-pop {
    0% { transform: translate(-50%, 20px); opacity: 0; }
    100% { transform: translate(-50%, 0); opacity: 1; }
  }

  /* joined token columns inside recent calls */
  .token-joined th:nth-child(5),
  .token-joined th:nth-child(6),
  .token-joined th:nth-child(7) { white-space: nowrap; }
  .tok-cell {
    font-variant-numeric: tabular-nums;
    font-size: 12.5px;
    white-space: nowrap;
  }
  .tok-in { color: var(--accent-2); font-weight: 600; }
  .tok-out { color: var(--accent); font-weight: 600; }
  .tok-cache { color: var(--ink-soft); }
  .cost-cell {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    white-space: nowrap;
  }

  /* inboxes / docs */
  details.inbox, details.doc {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 0.75rem 1rem;
    margin: 0.75rem 0;
    background:
      linear-gradient(180deg, var(--bg-3) 0%, var(--bg-2) 100%);
    transition: border-color 0.15s ease;
  }
  details.inbox:hover, details.doc:hover { border-color: var(--accent-soft); }
  details.inbox[open], details.doc[open] { border-color: var(--accent-soft); }
  details summary {
    cursor: pointer;
    font-weight: 600;
    font-size: 14px;
    color: var(--ink);
    padding: 0.25rem 0;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  details summary::-webkit-details-marker { display: none; }
  details summary::before {
    content: "›";
    font-size: 22px;
    line-height: 0.8;
    color: var(--accent);
    transition: transform 0.2s ease;
    font-weight: 700;
  }
  details[open] summary::before { transform: rotate(90deg); }
  .pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    padding: 2px 8px;
    background: linear-gradient(180deg, var(--accent), var(--accent-2));
    color: white;
    border-radius: 12px;
    font-weight: 700;
    font-size: 11px;
    box-shadow: 0 1px 4px rgba(255,111,168,0.4);
  }
  .inbox-path { margin-left: auto; }
  .inbox-name { font-weight: 700; font-size: 15px; color: var(--ink); }
  .doc-title { font-weight: 700; font-size: 14px; }

  /* rendered markdown body inside docs */
  .md {
    font-family: var(--display-font);
    font-size: 15px;
    line-height: 1.6;
    padding: 0.75rem 0.25rem 0.25rem;
    color: var(--ink);
  }
  .md h1, .md h2, .md h3, .md h4 {
    font-family: var(--display-font);
    font-weight: 700;
    line-height: 1.3;
    color: var(--ink);
    margin: 1.25rem 0 0.5rem;
  }
  .md h1 { font-size: 22px; }
  .md h2 { font-size: 18px; color: var(--accent); }
  .md h3 { font-size: 15px; }
  .md h4 { font-size: 13px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.06em; }
  .md p { margin: 0.5rem 0; }
  .md code { font-size: 0.88em; }
  .md pre {
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.85rem 1rem;
    overflow-x: auto;
    font-size: 13px;
    line-height: 1.5;
  }
  .md pre code { border: 0; background: transparent; padding: 0; }
  .md blockquote {
    border-left: 3px solid var(--accent);
    margin: 0.75rem 0;
    padding: 0.5rem 1rem;
    background: var(--accent-soft);
    border-radius: 0 8px 8px 0;
    color: var(--ink);
    font-style: italic;
  }
  .md table { font-size: 13.5px; margin: 0.5rem 0; }
  .md table th, .md table td { padding: 0.5rem 0.7rem; }
  .md ul, .md ol { margin: 0.4rem 0 0.6rem 1.5rem; padding: 0; }
  .md li { margin: 0.2rem 0; }
  .md a { color: var(--accent); text-decoration: none; border-bottom: 1px dashed var(--accent-soft); }
  .md a:hover { border-bottom-style: solid; }
  .md hr { border: 0; border-top: 1px dashed var(--border); margin: 1.5rem 0; }
  .md strong { color: var(--ink); font-weight: 700; }
  .md em { color: var(--ink-soft); }

  /* footer */
  footer {
    text-align: center;
    margin: 3rem auto 0;
    max-width: 1240px;
    padding-top: 1.5rem;
    border-top: 1px dashed var(--border);
    font-size: 12px;
  }
`;
