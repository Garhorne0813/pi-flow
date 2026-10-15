/** Embedded console styles; composed into the nonce-protected HTML shell. */
export const styles = String.raw`    :root { font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1e293b; background: #f5f7fb; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    button, input, textarea { font: inherit; }
    button { cursor: pointer; }
    button:disabled { cursor: not-allowed; opacity: .48; }
    .topbar { background: #111b35; color: #fff; padding: 18px clamp(18px, 3vw, 46px); display: flex; justify-content: space-between; align-items: center; gap: 20px; flex-wrap: wrap; }
    .brand { font-size: 19px; font-weight: 800; letter-spacing: -.5px; }
    .brand span { color: #90a9fd; font-weight: 500; margin-left: 12px; }
    .auth { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
    .auth input { width: 270px; background: #202e50; color: white; border: 1px solid #435475; }
    .auth input::placeholder { color: #a4b2cb; }
    .muted { color: #64748b; }
    .shell { max-width: 1510px; margin: 0 auto; padding: 30px clamp(16px, 3vw, 44px); }
    .intro { display: flex; justify-content: space-between; gap: 18px; align-items: end; margin-bottom: 26px; flex-wrap: wrap; }
    h1 { font-size: 29px; margin: 0 0 7px; letter-spacing: -.8px; color: #101d37; }
    .intro p { margin: 0; line-height: 1.6; }
    .layout { display: grid; grid-template-columns: 285px minmax(0,1fr); gap: 18px; align-items: start; }
    .panel { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; box-shadow: 0 5px 22px rgba(25,37,65,.045); overflow: hidden; }
    .panel-head { padding: 19px 20px; border-bottom: 1px solid #e9edf4; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    h2 { margin: 0; font-size: 16px; letter-spacing: -.2px; }
    h3 { font-size: 14px; margin: 0 0 12px; color: #172744; }
    .pad { padding: 20px; }
    .full { width: 100%; }
    input, textarea { padding: 10px 12px; border: 1px solid #d3dce9; border-radius: 9px; outline-offset: 2px; background: #fff; color: #17243b; min-width: 0; }
    input:focus, textarea:focus { outline: 2px solid #a0b4ff; border-color: #6479e9; }
    input:disabled, textarea:disabled { background: #f5f7fb; color: #64748b; }
    textarea { resize: vertical; min-height: 84px; line-height: 1.55; }
    label.field { display: block; font-weight: 650; font-size: 13px; margin-bottom: 6px; }
    label.field small { display: block; font-weight: 400; color: #64748b; margin-top: 4px; }
    .field-wrap { margin-bottom: 18px; }
    .field-wrap:last-child { margin-bottom: 0; }
    .grid2 { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 15px; }
    .grid3 { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 13px; }
    .section { border-top: 1px solid #e9edf4; padding: 22px 20px; }
    .section:first-child { border-top: none; }
    .section-note { font-size: 12px; color: #718096; margin: -5px 0 15px; line-height: 1.6; }
    .btn { padding: 10px 15px; border: 1px solid #d2dce9; border-radius: 9px; color: #253552; background: #fff; font-weight: 650; font-size: 13px; }
    .btn:hover:not(:disabled) { background: #edf2ff; }
    .primary { border-color: #405cf5; background: #405cf5; color: white; }
    .primary:hover:not(:disabled) { background: #304be0; }
    .danger { color: #b32635; background: #fff6f6; border-color: #ffd0d0; }
    .btn-sm { padding: 7px 10px; font-size: 12px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 9px; align-items: center; }
    .pill { font-size: 11px; font-weight: 700; padding: 4px 8px; border-radius: 100px; background: #edf1ff; color: #4056b4; }
    .pill.off { background: #f1f5f9; color: #778399; }
    .agent-list { max-height: 75vh; overflow: auto; padding: 10px; }
    .agent-item { display: block; width: 100%; text-align: left; border: 1px solid transparent; border-radius: 9px; padding: 12px; background: white; margin-bottom: 5px; }
    .agent-item:hover { background: #f7f9ff; }
    .agent-item.active { background: #eff3ff; border-color: #c7d4ff; }
    .agent-name { display: flex; align-items: center; justify-content: space-between; font-size: 13px; gap: 8px; font-weight: 700; }
    .agent-id { overflow-wrap:anywhere; font-size: 11px; font-weight: 450; margin-top: 6px; color: #8290a5; font-family: ui-monospace, monospace; }
    .choices { display: flex; flex-wrap: wrap; gap: 8px; }
    .choice { display: inline-flex; gap: 7px; align-items: center; border: 1px solid #dde4ee; padding: 8px 10px; border-radius: 9px; font-size: 12px; cursor: pointer; max-width: 100%; overflow-wrap: anywhere; }
    .choice:has(input:checked) { border-color: #94a9f7; background: #f1f4ff; }
    .choice input { accent-color: #405cf5; }
    .detail-row { display: flex; justify-content: space-between; gap: 10px; border-bottom: 1px solid #edf0f5; padding: 12px 0; font-size: 12px; }
    .detail-row span { color: #64748b; }
    .detail-row strong { text-align: right; overflow-wrap: anywhere; font-size: 12px; }
    .note { font-size: 12px; line-height: 1.6; color: #64748b; }
    .note a { color: #405cf5; }
    .message { margin: 0 0 16px; padding: 12px 14px; border-radius: 9px; font-size: 13px; line-height: 1.5; display: none; white-space: pre-wrap; overflow-wrap: anywhere; }
    .message.show { display: block; background: #eaf8f1; color: #176943; }
    .message.error { display: block; background: #fff0ef; color: #9b2230; }
    .empty { color: #8996a9; text-align: center; padding: 30px 14px; font-size: 13px; line-height: 1.6; }
    .footer-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 10px; padding: 18px 20px; border-top: 1px solid #edf0f5; background: #fbfcfe; }
    code { font-size: 11px; overflow-wrap: anywhere; }
    @media(max-width:1150px) { .layout { grid-template-columns: 260px minmax(0,1fr); } .side-detail { grid-column: 2; } }
    @media(max-width:750px) { .layout { display:block; } .layout > .panel { margin-bottom: 16px; } .agent-list { max-height: 260px; } .grid2, .grid3 { grid-template-columns: 1fr; } .auth input { width: 200px; } }
    .side-detail { grid-column:2; }
    .editor-tabs { padding:16px 20px 0; margin-bottom:0 !important; }
    .editor-tabs button:focus-visible, .agent-item:focus-visible { outline:3px solid #405cf5; outline-offset:2px; }
    .agent-group { border-bottom:1px solid #e2e8f0; padding:8px 2px; }
    .agent-group h3 { padding:8px 10px; margin:0; overflow-wrap:anywhere; }
    .review { padding:20px; border-top:1px solid #e2e8f0; background:#f5f7fb; }
    .review pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:360px; overflow:auto; font-size:12px; }
    @media(max-width:750px) { .side-detail { grid-column:auto; } }
    [hidden] { display:none !important; }
    .tabs { display:flex; gap:8px; flex-wrap:wrap; margin:0 0 22px; }
    .tabs .active { background:#111b35; color:white; border-color:#111b35; }
    .console-grid { display:grid; grid-template-columns:minmax(0,1.4fr) minmax(300px,1fr); gap:20px; align-items:start; }
    .resource-list { display:grid; gap:14px; }
    .resource-card { background:white; border:1px solid #e2e8f0; border-radius:12px; padding:20px; overflow-wrap:anywhere; }
    .resource-card .toolbar { margin-top:14px; }
    .resource-card h3 { margin:0; }
    .resource-card p { white-space:pre-wrap; }
    .summary { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; margin-bottom:20px; }
    .summary .resource-card strong { font-size:26px; display:block; margin-top:8px; }
    select { font:inherit; padding:10px 12px; border:1px solid #d3dce9; border-radius:9px; background:white; color:#17243b; max-width:100%; }
    .config-table { width:100%; border-collapse:collapse; font-size:13px; }
    .config-table td { padding:12px 0; border-bottom:1px solid #edf0f5; overflow-wrap:anywhere; }
    .config-table td:last-child { text-align:right; }
    @media(max-width:850px) { .console-grid { grid-template-columns:1fr; } .summary { grid-template-columns:1fr; } }
`;
