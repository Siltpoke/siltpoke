// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
// CSS chunk for the static report HTML — extracted from
// src/cli/report-style.ts (file-length cap split).

export const STYLE_BASE = `
  @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&family=Quicksand:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;700&family=Noto+Sans+JP:wght@400;500;700&family=Noto+Sans+KR:wght@400;500;700&display=swap');

  :root {
    --shell-pink: #ffc0d8;
    --shell-pink-dk: #f48fb1;
    --shell-shadow: #c46a91;
    --shell-glow: rgba(255, 192, 216, 0.45);
    --lcd-bg: #d4e5b8;
    --lcd-bg-dk: #a3c084;
    --lcd-edge: #6b8c4f;
    --lcd-ink: #1f3010;
    --lcd-ink-soft: #4a5d36;
    --pixel-font: 'Press Start 2P', monospace;
    --display-font: 'Quicksand', 'Noto Sans SC', 'Noto Sans JP', 'Noto Sans KR', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    --bg: #fff7fb;
    --bg-2: #ffffff;
    --bg-3: #fef0f6;
    --ink: #2c1f33;
    --ink-soft: #7a6a82;
    --accent: #ff6fa8;
    --accent-2: #b45cff;
    --accent-soft: #ffe2ed;
    --border: #fce0eb;
    --good: #1cae5e;
    --warn: #e3811d;
    --bad: #ed4862;
    --panel-shadow: 0 1px 0 rgba(255,255,255,0.9) inset, 0 6px 18px rgba(255,111,168,0.08), 0 2px 4px rgba(180,92,255,0.05);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1a1320;
      --bg-2: #261b2e;
      --bg-3: #2e2238;
      --ink: #f7e8f0;
      --ink-soft: #b09cb8;
      --shell-pink: #e07ba8;
      --shell-pink-dk: #b85587;
      --shell-shadow: #6b2c50;
      --shell-glow: rgba(224, 123, 168, 0.3);
      --accent-soft: #3a2236;
      --border: #3e2538;
      --panel-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 6px 18px rgba(0,0,0,0.4);
    }
  }
  * { box-sizing: border-box; }
  html { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: var(--display-font);
    font-size: 15px;
    font-weight: 500;
    line-height: 1.55;
    background:
      radial-gradient(ellipse at top left, rgba(255,111,168,0.08), transparent 50%),
      radial-gradient(ellipse at bottom right, rgba(180,92,255,0.06), transparent 50%),
      var(--bg);
    color: var(--ink);
    padding: 2.5rem 1.5rem 4rem;
    min-height: 100vh;
  }
  .wrap {
    max-width: 1240px;
    margin: 0 auto;
    display: grid;
    grid-template-columns: minmax(300px, 380px) 1fr;
    gap: 2rem;
    align-items: start;
  }
  @media (max-width: 960px) {
    .wrap { grid-template-columns: 1fr; }
    .left-col { position: static !important; max-width: 380px; margin: 0 auto; width: 100%; }
    .shell { position: static !important; }
  }
  .left-col {
    position: sticky;
    top: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }
  .mode-strip { display: flex; justify-content: center; }
  .mode-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 6px 14px;
    border-radius: 999px;
    font-weight: 700;
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    border: 1px solid var(--border);
    background: var(--bg-2);
    color: var(--ink);
    box-shadow: 0 2px 4px rgba(0,0,0,0.04);
    cursor: help;
  }
  .mode-badge::before {
    content: "●";
    color: var(--ink-soft);
    font-size: 10px;
  }
  .mode-badge.mode-project::before { color: var(--good); }
  .mode-badge.mode-global::before { color: var(--accent); }

  /* --- shell (tamagotchi body) ----------------------------------------- */
  .shell {
    filter: drop-shadow(0 20px 30px var(--shell-glow));
  }
  .shell-loop {
    width: 36px;
    height: 22px;
    margin: 0 auto -10px;
    border: 6px solid var(--shell-pink-dk);
    border-bottom: 0;
    border-radius: 18px 18px 0 0;
    box-shadow: inset -1px 1px 0 rgba(255,255,255,0.35);
    position: relative;
    z-index: 0;
  }
  .shell-body {
    background:
      radial-gradient(ellipse at 30% 18%, rgba(255,255,255,0.55), transparent 50%),
      linear-gradient(180deg, var(--shell-pink) 0%, var(--shell-pink-dk) 100%);
    border-radius: 44px;
    padding: 2rem 1.5rem 2rem;
    box-shadow:
      0 14px 0 var(--shell-shadow),
      inset 0 3px 0 rgba(255,255,255,0.55),
      inset 0 -8px 0 rgba(0,0,0,0.12),
      inset 6px 0 14px rgba(255,255,255,0.18),
      inset -6px 0 14px rgba(0,0,0,0.08);
    position: relative;
    overflow: hidden;
  }
  .shell-body::after {
    content: "";
    position: absolute;
    top: 14%;
    left: 18%;
    width: 22%;
    height: 14%;
    background: radial-gradient(ellipse, rgba(255,255,255,0.55) 0%, transparent 70%);
    border-radius: 50%;
    pointer-events: none;
  }
  .shell-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    padding: 0 0.5rem;
    position: relative;
    z-index: 1;
  }
  .shell-dots { display: flex; gap: 6px; }
  .shell-dots span {
    width: 7px; height: 7px; border-radius: 50%;
    background: rgba(0,0,0,0.22);
    box-shadow: inset 1px 1px 1px rgba(255,255,255,0.4);
  }
  .shell-brand {
    font-family: var(--pixel-font);
    font-size: 7px;
    color: rgba(255,255,255,0.7);
    letter-spacing: 0.18em;
    text-shadow: 1px 1px 0 rgba(0,0,0,0.15);
  }

  /* --- LCD screen ------------------------------------------------------- */
  .lcd-frame {
    padding: 6px;
    border-radius: 22px;
    background: linear-gradient(180deg, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.1) 100%);
    box-shadow:
      inset 0 2px 4px rgba(0,0,0,0.3),
      0 2px 0 rgba(255,255,255,0.4);
  }
  .lcd {
    background: linear-gradient(180deg, var(--lcd-bg) 0%, var(--lcd-bg-dk) 100%);
    border-radius: 16px;
    padding: 1.5rem 1.1rem 1.1rem;
    position: relative;
    overflow: hidden;
    box-shadow:
      inset 0 0 0 2px var(--lcd-edge),
      inset 0 6px 14px rgba(0,0,0,0.18);
    color: var(--lcd-ink);
  }
  .scanlines {
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(
      0deg,
      transparent 0,
      transparent 2px,
      rgba(0,0,0,0.05) 2px,
      rgba(0,0,0,0.05) 3px
    );
    pointer-events: none;
    border-radius: inherit;
  }
  @keyframes pet-idle {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-3px); }
  }
  @keyframes pet-blink {
    0%, 92%, 100% { opacity: 1; }
    94%, 96% { opacity: 0.15; }
  }
  .pet-portrait {
    font-family: var(--pixel-font);
    font-size: 20px;
    line-height: 1.5;
    white-space: pre;
    text-align: center;
    margin: 0.25rem 0 1rem;
    color: var(--lcd-ink);
    text-shadow: 1px 1px 0 var(--lcd-edge);
    letter-spacing: 0.04em;
    animation: pet-idle 3.6s ease-in-out infinite, pet-blink 5.2s ease-in-out infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .pet-portrait { animation: none; }
  }
  .pet-name {
    text-align: center;
    margin-bottom: 0.25rem;
    color: var(--lcd-ink);
    font-weight: 700;
    font-size: 17px;
    letter-spacing: 0.01em;
  }
  .pet-mood {
    text-align: center;
    font-size: 24px;
    margin-bottom: 0.5rem;
    color: var(--lcd-ink);
    letter-spacing: 0.02em;
  }
  .bubble {
    background: rgba(255,255,255,0.45);
    border: 1px solid rgba(255,255,255,0.6);
    border-radius: 14px;
    padding: 0.75rem 1rem;
    margin: 0.75rem -0.25rem 1rem;
    font-size: 13.5px;
    line-height: 1.5;
    text-align: center;
    color: var(--lcd-ink);
    font-weight: 500;
    min-height: 3.2em;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: inset 0 1px 2px rgba(255,255,255,0.7), 0 1px 2px rgba(0,0,0,0.05);
  }
  .bubble-quote {
    color: var(--lcd-ink-soft);
    font-family: var(--pixel-font);
    font-size: 14px;
    margin: 0 0.2rem;
  }
  .meters { display: flex; flex-direction: column; gap: 0.55rem; margin: 1rem 0 0.75rem; }
  .meter-row {
    display: grid;
    grid-template-columns: 56px 1fr 88px;
    gap: 0.6rem;
    align-items: center;
  }
  .meter-label {
    font-family: var(--pixel-font);
    font-size: 8px;
    color: var(--lcd-ink-soft);
    letter-spacing: 0.05em;
  }
  .meter {
    height: 12px;
    background: rgba(0,0,0,0.18);
    border-radius: 6px;
    overflow: hidden;
    position: relative;
    box-shadow: inset 0 1px 2px rgba(0,0,0,0.25);
  }
  .fill {
    height: 100%;
    background: linear-gradient(180deg, var(--lcd-ink-soft) 0%, var(--lcd-ink) 100%);
    border-radius: 6px;
    box-shadow: 0 1px 0 rgba(255,255,255,0.2) inset;
    transition: width 0.6s ease;
  }
  .meter-val {
    font-family: var(--pixel-font);
    font-size: 9px;
    text-align: right;
    color: var(--lcd-ink);
    letter-spacing: 0.02em;
  }
  .titles {
    text-align: center;
    font-family: var(--pixel-font);
    font-size: 7px;
    color: var(--lcd-ink-soft);
    margin-top: 0.75rem;
    letter-spacing: 0.08em;
    line-height: 1.6;
  }
  .shell-buttons {
    display: flex;
    justify-content: space-around;
    margin-top: 1.5rem;
    padding: 0 0.5rem;
    position: relative;
    z-index: 1;
  }
  .btn {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 0;
    padding: 0;
    background:
      radial-gradient(circle at 35% 30%, rgba(255,255,255,0.55), transparent 55%),
      linear-gradient(180deg, var(--shell-pink) 0%, var(--shell-pink-dk) 100%);
    box-shadow:
      0 4px 0 var(--shell-shadow),
      inset 0 1px 0 rgba(255,255,255,0.5),
      inset 0 -2px 0 rgba(0,0,0,0.15);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    user-select: none;
    transition: transform 0.08s ease, box-shadow 0.08s ease;
    font: inherit;
    color: inherit;
  }
  .btn:hover { transform: translateY(-1px); }
  .btn:active, .btn.pressed {
    transform: translateY(3px);
    box-shadow:
      0 1px 0 var(--shell-shadow),
      inset 0 1px 0 rgba(255,255,255,0.5),
      inset 0 -2px 0 rgba(0,0,0,0.15);
  }
  .btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

`;
