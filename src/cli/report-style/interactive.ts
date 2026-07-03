// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
// CSS chunk for the static report HTML — extracted from
// src/cli/report-style.ts (file-length cap split).

export const STYLE_INTERACTIVE = `  /* button-triggered effects on the LCD */
  @keyframes pet-wiggle {
    0%, 100% { transform: translate(0,0) rotate(0); }
    20% { transform: translate(-2px, -2px) rotate(-2deg); }
    40% { transform: translate(2px, -1px) rotate(2deg); }
    60% { transform: translate(-1px, 1px) rotate(-1deg); }
    80% { transform: translate(2px, 0) rotate(1deg); }
  }
  .pet-portrait.wiggle {
    animation:
      pet-wiggle 0.55s ease-in-out 1,
      pet-idle 3.6s ease-in-out infinite 0.55s,
      pet-blink 5.2s ease-in-out infinite;
  }
  .heart-burst {
    position: absolute;
    pointer-events: none;
    inset: 0;
    overflow: visible;
  }
  .heart-burst span {
    position: absolute;
    bottom: 30%;
    left: 50%;
    font-size: 24px;
    color: var(--accent);
    opacity: 0;
    animation: heart-rise 1.4s ease-out forwards;
    text-shadow: 0 2px 8px rgba(255,111,168,0.5);
  }
  @keyframes heart-rise {
    0% { transform: translate(-50%, 0) scale(0.5); opacity: 0; }
    20% { opacity: 1; }
    100% { transform: translate(calc(-50% + var(--dx, 0px)), -120px) scale(1.1); opacity: 0; }
  }
  .bubble.flash {
    animation: bubble-flash 0.35s ease-out;
  }
  @keyframes bubble-flash {
    0% { background: rgba(255,255,255,0.45); }
    50% { background: rgba(255,255,255,0.85); }
    100% { background: rgba(255,255,255,0.45); }
  }
  @media (prefers-reduced-motion: reduce) {
    .pet-portrait.wiggle, .heart-burst span, .bubble.flash { animation: none; }
  }
  .btn-glyph {
    font-family: var(--pixel-font);
    font-size: 9px;
    color: rgba(255,255,255,0.85);
    text-shadow: 1px 1px 0 rgba(0,0,0,0.18);
  }

  /* --- tabs ------------------------------------------------------------ */
  .tab-nav {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: var(--panel-shadow);
    position: sticky;
    top: 1.5rem;
    z-index: 10;
    backdrop-filter: saturate(160%) blur(10px);
  }
  .tab-btn {
    flex: 1 1 auto;
    min-width: 90px;
    padding: 0.65rem 0.9rem;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--ink-soft);
    font: inherit;
    font-weight: 700;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    letter-spacing: 0.02em;
  }
  .tab-btn:hover { background: var(--bg-3); color: var(--ink); }
  .tab-btn[aria-selected="true"] {
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: white;
    box-shadow: 0 2px 8px rgba(255,111,168,0.35);
  }
  .tab-btn[aria-selected="true"] .pill {
    background: rgba(255,255,255,0.3);
    color: white;
    box-shadow: none;
  }
  .tab-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .tab-content {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }
  .tab-content[hidden] { display: none; }

  /* --- panels (right column, all collapsible) -------------------------- */
  .panels { display: flex; flex-direction: column; gap: 1.25rem; }
  details.panel {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 0;
    box-shadow: var(--panel-shadow);
    transition: transform 0.2s ease, box-shadow 0.2s ease;
    overflow: hidden;
  }
  details.panel:hover {
    transform: translateY(-1px);
    box-shadow: 0 1px 0 rgba(255,255,255,0.9) inset, 0 10px 28px rgba(255,111,168,0.12), 0 4px 10px rgba(180,92,255,0.08);
  }
  details.panel > summary {
    list-style: none;
    cursor: pointer;
    padding: 1.25rem 1.75rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    user-select: none;
  }
  details.panel > summary::-webkit-details-marker { display: none; }
  details.panel > summary::after {
    content: "›";
    margin-left: auto;
    font-size: 22px;
    line-height: 0.7;
    color: var(--accent);
    transition: transform 0.2s ease;
    font-weight: 700;
  }
  details.panel[open] > summary::after { transform: rotate(90deg); }
  details.panel > summary h2 {
    font-family: var(--display-font);
    font-size: 13px;
    font-weight: 700;
    margin: 0;
    color: var(--accent);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  details.panel > summary h2::before {
    content: "";
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    box-shadow: 0 0 8px var(--accent-soft);
  }
  details.panel > .panel-body {
    padding: 0 1.75rem 1.5rem;
  }
  details.panel > .panel-body > :first-child { margin-top: 0; }
  .panel p { margin: 0.25rem 0; }
  .muted { color: var(--ink-soft); }
  .small { font-size: 0.85em; }

  /* key-value list (used by genesis + progression detail) */
  .kv-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-top: 0.5rem;
  }
  .kv-row {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: 0.75rem;
    padding: 0.4rem 0;
    border-bottom: 1px dashed var(--border);
    font-size: 14px;
  }
  .kv-row:last-child { border-bottom: 0; }
  .kv-k {
    color: var(--ink-soft);
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .kv-v { color: var(--ink); }
  blockquote.genesis-soul {
    margin: 0.5rem 0;
    padding: 0.85rem 1.2rem;
    background: linear-gradient(135deg, var(--accent-soft), var(--bg-3));
    border-left: 3px solid var(--accent);
    border-radius: 0 10px 10px 0;
    color: var(--ink);
    font-style: italic;
    font-size: 15px;
    line-height: 1.5;
  }
  pre {
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.85rem 1rem;
    overflow-x: auto;
    font-size: 12px;
    line-height: 1.55;
    margin: 0.5rem 0;
  }
  pre code {
    border: 0;
    background: transparent;
    padding: 0;
    font-size: inherit;
  }

  /* stats grid */
  .stat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 0.75rem;
  }
  .stat {
    padding: 0.85rem 1rem;
    background:
      linear-gradient(180deg, var(--bg-3) 0%, var(--bg-2) 100%);
    border-radius: 12px;
    border: 1px solid var(--border);
    box-shadow: 0 1px 0 rgba(255,255,255,0.6) inset, 0 1px 2px rgba(0,0,0,0.03);
    transition: transform 0.15s ease;
  }
  .stat:hover { transform: translateY(-1px); }
  .stat-v {
    font-family: var(--display-font);
    font-size: 22px;
    font-weight: 700;
    color: var(--ink);
    letter-spacing: -0.01em;
    line-height: 1.1;
  }
  .stat-k {
    font-size: 12px;
    font-weight: 500;
    color: var(--ink-soft);
    margin-top: 0.4rem;
    letter-spacing: 0.02em;
  }

  /* chart */
  .chart {
    display: flex;
    align-items: end;
    gap: 10px;
    height: 180px;
    padding: 0.5rem 0 0;
  }
  .bar {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    justify-content: end;
    gap: 6px;
    height: 100%;
  }
  .bar-fill {
    width: 100%;
    background: linear-gradient(180deg, var(--accent) 0%, var(--accent-2) 100%);
    border-radius: 6px 6px 2px 2px;
    min-height: 6px;
    box-shadow: 0 2px 4px rgba(255,111,168,0.25);
    transition: height 0.5s ease;
  }
  .bar-count {
    font-family: var(--display-font);
    font-weight: 700;
    font-size: 13px;
    text-align: center;
    color: var(--ink);
  }
  .bar-label {
    font-size: 11px;
    text-align: center;
    color: var(--ink-soft);
    font-weight: 500;
  }

`;
