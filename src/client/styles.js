/**
 * Typography does the work: one large figure, small quiet labels, hairlines instead of boxes.
 * Color appears only as the brand hue (models, by strength) and the error state. Every color is
 * a DSH theme token, so dark mode follows.
 */
const fg = 'var(--dsw-alias-label-primary)';
const fg2 = 'var(--dsw-alias-label-secondary)';
const fg3 = 'color-mix(in srgb, var(--dsw-alias-label-secondary) 72%, transparent)';
const l2 = 'var(--dsw-alias-bg-layer-2)';
const overlay = 'var(--dsw-alias-bg-overlay)';
const line = 'var(--dsw-alias-border-l1)';
const brand = 'var(--dsw-alias-brand-primary, #4d6bfe)';
const warn = 'var(--dsw-alias-state-warn-primary)';
const err = 'var(--dsw-alias-state-error-primary)';
const mix = (c, p, into = 'transparent') => `color-mix(in srgb, ${c} ${p}%, ${into})`;
const nums = 'font-variant-numeric:tabular-nums;';

export const CSS = `
.us-page { --us-soft:${mix(fg, 14)}; height:100%; overflow:auto; color:${fg}; font-size:13px; line-height:1.5; -webkit-font-smoothing:antialiased; }
.us-inner { max-width:760px; margin:0 auto; padding:40px 40px 88px; display:flex; flex-direction:column; gap:20px; }
.us-body { display:flex; flex-direction:column; gap:40px; transition:opacity .2s; }
.us-stale { opacity:.55; }
.us-quiet { color:${fg3}; }
.us-pad { padding:14px 0; }
.us-err { color:${err}; }
.us-warn { color:${warn}; }
.us-mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; }
.us-strong { font-weight:560; }
.us-ellipsis { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.us-dot { display:inline-block; width:2.5px; height:2.5px; margin:0 7px; border-radius:50%; background:currentColor; opacity:.45; vertical-align:middle; }
.us-textbtn { padding:0; border:none; background:none; color:${fg2}; font:inherit; font-weight:500; cursor:pointer; }
.us-textbtn:hover { color:${fg}; }
.us-badge { margin-left:7px; padding:1px 6px; border-radius:5px; background:${l2}; color:${fg2}; font-size:11px; font-style:normal; font-weight:500; }

.us-top { display:flex; align-items:center; justify-content:space-between; gap:16px; }
.us-top h1 { margin:0; font-size:15px; font-weight:600; letter-spacing:-.01em; }
.us-ranges { display:flex; gap:2px; }
.us-ranges button { height:28px; padding:0 10px; border:none; border-radius:7px; background:none; color:${fg3}; font:inherit; font-size:12.5px; font-weight:500; cursor:pointer; transition:color .15s, background .15s; }
.us-ranges button:hover { color:${fg}; }
.us-ranges button.on { background:${l2}; color:${fg}; }
.us-chip { align-self:flex-start; display:inline-flex; align-items:center; gap:6px; height:26px; padding:0 9px 0 11px; border:none; border-radius:99px; background:${mix(brand, 12)}; color:${fg}; font:inherit; font-size:12.5px; font-weight:500; cursor:pointer; }
.us-chip svg { opacity:.6; }
.us-chip:hover svg { opacity:1; }

.us-hero { display:flex; flex-direction:column; gap:6px; }
.us-hero-label { color:${fg2}; font-size:13px; }
.us-hero-num { display:flex; align-items:baseline; gap:12px; }
.us-hero-num b { font-size:56px; font-weight:640; letter-spacing:-.045em; line-height:1.05; ${nums} }
.us-delta { color:${fg3}; font-size:13px; font-weight:500; ${nums} }
.us-facts { display:flex; flex-wrap:wrap; gap:14px 32px; margin-top:14px; }
.us-fact { display:flex; flex-direction:column; gap:1px; }
.us-fact b { font-size:17px; font-weight:600; letter-spacing:-.02em; ${nums} }
.us-fact span { color:${fg3}; font-size:12px; }
.us-fact.err b { color:${err}; }
.us-fact[title] { cursor:help; }

.us-chart { position:relative; width:100%; margin-top:-8px; }
.us-chart svg { display:block; overflow:visible; }
.us-chart g { transition:opacity .15s; }
.us-chart .us-dim { opacity:.35; }
.us-peak line { stroke:${line}; stroke-dasharray:3 4; }
.us-peak text { fill:${fg3}; font-size:11px; ${nums} }
.us-base { stroke:${line}; }
.us-tick { fill:${fg3}; font-size:11px; ${nums} }
.us-tick.on { fill:${fg}; }
.us-tip { position:absolute; top:-6px; transform:translate(-50%, -100%); min-width:196px; max-width:280px; padding:10px 12px; border-radius:12px; background:${overlay}; box-shadow:0 0 0 .5px ${line}, 0 12px 32px -10px rgba(0,0,0,.25); font-size:12px; pointer-events:none; z-index:2; }
.us-tip-head { display:flex; justify-content:space-between; gap:12px; margin-bottom:6px; color:${fg2}; }
.us-tip-head b { color:${fg}; font-weight:600; ${nums} }
.us-tip-row { display:flex; align-items:center; gap:8px; line-height:1.75; }
.us-tip-row i { width:7px; height:7px; flex:none; border-radius:2px; }
.us-tip-row span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.us-tip-row em { color:${fg3}; font-style:normal; ${nums} }
.us-tip-row b { min-width:44px; text-align:right; font-weight:600; ${nums} }
.us-tip-row.err { color:${err}; }

.us-section { display:flex; flex-direction:column; gap:6px; }
.us-section h2 { margin:0 0 2px; color:${fg2}; font-size:12.5px; font-weight:500; }
.us-tabs { display:flex; gap:20px; margin-bottom:2px; }
.us-tabs button { display:inline-flex; align-items:baseline; gap:6px; padding:0 0 6px; border:none; border-bottom:1.5px solid transparent; background:none; color:${fg3}; font:inherit; font-size:12.5px; font-weight:500; cursor:pointer; transition:color .15s, border-color .15s; }
.us-tabs button span { font-size:11.5px; opacity:.8; ${nums} }
.us-tabs button:hover { color:${fg}; }
.us-tabs button.on { color:${fg}; border-bottom-color:${fg}; }

.us-list { display:flex; flex-direction:column; border-top:1px solid ${line}; }
.us-row { position:relative; display:flex; align-items:center; gap:12px; width:100%; padding:11px 2px 12px; border:none; border-bottom:1px solid ${line}; background:none; color:inherit; font:inherit; text-align:left; }
.us-row.click { cursor:pointer; }
.us-row.click::before { content:''; position:absolute; inset:0 -10px; border-radius:8px; background:${fg}; opacity:0; transition:opacity .12s; pointer-events:none; }
.us-row.click:hover::before { opacity:.035; }
.us-row.on::before { opacity:.05; }
.us-mark { width:8px; height:8px; flex:none; border-radius:2.5px; }
.us-time { width:88px; flex:none; color:${fg3}; font-size:12px; white-space:nowrap; ${nums} }
.us-row-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.us-row-title { display:flex; align-items:baseline; gap:8px; min-width:0; white-space:nowrap; }
.us-row-title > .us-strong { overflow:hidden; text-overflow:ellipsis; }
.us-route { color:${fg3}; font-size:12px; }
.us-row-meta { color:${fg3}; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; ${nums} }
.us-row-value { display:flex; align-items:baseline; gap:8px; flex:none; }
.us-row-value b { font-size:14px; font-weight:600; letter-spacing:-.01em; ${nums} }
.us-row-value span { display:inline-flex; min-width:40px; justify-content:flex-end; color:${fg3}; font-size:12px; ${nums} }
.us-row-share { position:absolute; left:2px; right:2px; bottom:-1px; height:1px; pointer-events:none; }
.us-row-share i { display:block; height:100%; }
.us-row.err .us-time { color:${err}; }
.us-textbtn + .us-list, .us-list + .us-textbtn { margin-top:10px; align-self:flex-start; }

.us-notes { list-style:none; margin:-12px 0 0; padding:0; display:flex; flex-direction:column; gap:10px; }
.us-notes li { position:relative; display:flex; flex-direction:column; gap:1px; padding-left:16px; color:${fg}; font-size:13px; line-height:1.55; }
.us-notes li::before { content:''; position:absolute; left:2px; top:.62em; width:5px; height:5px; border-radius:50%; background:${warn}; }
.us-notes em { color:${fg3}; font-size:12px; font-style:normal; }
.us-inline { padding:0; border:none; background:none; color:inherit; font:inherit; font-weight:560; cursor:pointer; box-shadow:inset 0 -1px 0 ${mix(fg, 30)}; }
.us-inline:hover { box-shadow:inset 0 -1px 0 ${fg}; }

.us-section-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
.us-section-head h2 { margin:0 0 2px; }
.us-switch { display:flex; gap:14px; }
.us-switch button { padding:0; border:none; background:none; color:${fg3}; font:inherit; font-size:12.5px; font-weight:500; cursor:pointer; transition:color .15s; }
.us-switch button:hover, .us-switch button.on { color:${fg}; }
.us-board { position:relative; width:100%; padding-top:4px; }
.us-board svg { display:block; overflow:visible; }
.us-cell { transition:opacity .12s; }
.us-cell.empty { fill:${mix(fg, 6)}; }
.us-cell.on { stroke:${fg}; stroke-width:1.2; }
.us-board-tip { min-width:150px; }

.us-empty { display:flex; flex-direction:column; gap:4px; padding:40px 0; color:${fg2}; }
.us-empty b { color:${fg}; font-size:14px; font-weight:600; }
.us-foot { display:flex; flex-wrap:wrap; gap:10px; color:${fg3}; font-size:12px; }
.us-foot .us-textbtn { color:${fg2}; font-size:12px; }

@media (max-width: 640px) {
  .us-inner { padding:28px 20px 64px; }
  .us-hero-num b { font-size:42px; }
}
`;
