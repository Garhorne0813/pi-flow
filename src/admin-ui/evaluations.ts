export function evaluationsHTML() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi-Eval · Evaluation Studio</title><style>
:root{font-family:system-ui,sans-serif;color:#18302e;background:#f3f6f5}*{box-sizing:border-box}body{margin:0}header,main{max-width:1100px;margin:auto;padding:24px}header{display:flex;gap:20px;align-items:center;flex-wrap:wrap}h1{font-size:26px;margin:0}h2{font-size:20px}nav{display:flex;gap:8px;flex-wrap:wrap}a{color:#176253}section{background:white;border:1px solid #d7e2de;border-radius:12px;padding:22px;margin:18px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:16px}label{display:block;margin:12px 0;font-weight:600}input,select,textarea,button{font:inherit;border:1px solid #9cafaa;border-radius:6px;padding:10px}input,select,textarea{display:block;width:100%;margin-top:6px;background:white;color:inherit}textarea{font-family:monospace;min-height:160px;resize:vertical}button{cursor:pointer;background:#eaf4ef;color:#17473a;margin:4px}button.primary{background:#176253;color:white}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible{outline:3px solid #e89c3d;outline-offset:3px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f8f7;padding:16px;max-height:600px;overflow:auto}#status{position:sticky;top:0;background:#e4efe9;padding:12px;z-index:1}small{font-weight:normal;color:#526863}table{width:100%;border-collapse:collapse}td,th{text-align:left;border-bottom:1px solid #ddd;padding:10px}button.danger{color:#a62727}.row{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.metric{font-size:22px}footer{padding:24px;color:#526863}@media(max-width:600px){header,main{padding:12px}section{padding:14px}td,th{padding:6px;font-size:13px}}
</style></head><body><header><h1>Pi-Eval <small>Evaluation Studio</small></h1><nav aria-label="页面导航"><a href="#datasets">数据集</a><a href="#run">运行评测</a><a href="#jobs">作业与报告</a><a href="#compare">基线对比</a><a href="/admin/ui">Agent 控制台</a></nav></header><main>
<div id="status" role="status" aria-live="polite">请连接账户以管理个人评测。</div>
<section aria-labelledby="connection-title"><h2 id="connection-title">连接账户</h2><label>访问 Token<input id="token" type="password" autocomplete="off"></label><button id="connect" class="primary">连接</button><small>Token 仅保存在当前页面内存中。仅展示本人数据。</small></section>
<section id="datasets"><h2>数据集 · 草稿与不可变版本</h2><div class="grid"><label>选择数据集<select id="suite"><option value="">新建数据集</option></select></label><label>名称<input id="name" maxlength="100" value="我的评测集"></label></div><label>描述<input id="description" maxlength="2000"></label><label>用例 JSON 数组<textarea id="cases" spellcheck="false">[{"caseId":"hello","inputs":"Hello","graders":[{"id":"answer","type":"contains","value":"Hello"}],"mocks":{}}]</textarea></label><small>单轮文本；最多 100 个用例，250KB。可配置 graders、reference、mocks、passThreshold、tags、timeoutMs。</small><div class="row"><button id="save" class="primary">保存草稿</button><button id="publish">发布版本</button><button id="new">新建数据集</button><button id="delete" class="danger">删除数据集</button><span id="revision"></span></div><label>已发布版本<select id="version"></select></label><div class="row"><button id="version-prev">上一页版本</button><button id="version-next">下一页版本</button><button id="show-version">查看冻结用例</button></div><pre id="version-detail" hidden></pre><div class="row"><button id="suite-prev">上一页数据集</button><button id="suite-next">下一页数据集</button></div></section>
<section id="run"><h2>运行评测</h2><div class="grid"><label>目标 Agent<select id="agent"></select></label><label>执行 Profile<select id="profile"><option value="mocked">Mock 工具隔离</option></select></label><label>重复次数<input id="repeat" type="number" min="1" max="3" value="1"></label><label>Token 总上限<input id="tokens" type="number" min="100" max="1000000" value="20000"></label><label>成本上限（USD 估计）<input id="cost" type="number" min="0.001" max="10" step="0.001" value="1"></label><label>最长时间（秒）<input id="duration" type="number" min="1" max="900" value="900"></label><label>目标模型请求上限<input id="model-calls" type="number" min="1" max="100" step="1" value="100"></label><label>Judge 请求上限<input id="judge-calls" type="number" min="0" max="100" value="0"></label></div><p>允许：用例定义的 read / ls / grep / find Mock，且须符合 Agent 权限和实时工具策略。拒绝：生产文件、MCP、Bash、联网、写入、子 Agent、用户 Token。Judge 使用平台批准的模型配置。</p><div class="row"><button id="agent-prev">上一页 Agent</button><button id="agent-next">下一页 Agent</button></div><button id="start" class="primary">启动评测</button></section>
<section id="jobs"><h2>作业与逐用例报告</h2><div class="row"><button id="refresh">刷新作业</button><button id="cancel" class="danger">取消所选作业</button></div><label>选择作业<select id="job"></select></label><div id="metrics" class="grid" aria-live="polite"></div><details><summary>完整报告与用量</summary><pre id="report">暂无报告</pre></details><h3>用例详情</h3><label>选择用例<select id="case-run"></select></label><pre id="case-detail">输入、参考答案、最终回答、真实工具轨迹、评分及错误将在此显示。</pre><button id="case-prev">上一页用例</button><button id="case-next">下一页用例</button><div class="row"><button id="job-prev">上一页作业</button><button id="job-next">下一页作业</button></div></section>
<section id="compare"><h2>基线对比</h2><div class="grid"><label>Baseline<input id="baseline" list="baseline-options" placeholder="选择或输入 Job ID"><datalist id="baseline-options"></datalist></label><label>Candidate<input id="candidate" list="candidate-options" placeholder="选择或输入 Job ID"><datalist id="candidate-options"></datalist></label></div><button id="compare-button" class="primary">比较与回归 Gate</button><pre id="comparison">选择相同 Suite 版本的作业进行配对比较。</pre></section>
</main><footer>Pi-Flow 原生评测 · Mock 隔离 · 估计用量不等于供应商账单</footer><script type="module">
const $ = id => document.getElementById(id);
let token = '', draft = null, suiteOffset = 0, jobOffset = 0, caseOffset = 0;
let agentOffset = 0, versionOffset = 0, caseRows = [], monitor = false, accountGeneration = 0, pollingFailed = false;
const status = text => { $('status').textContent = text; };
const show = (id, data) => { $(id).textContent = JSON.stringify(data, null, 2); };
function staleAccount() { const error = new Error('账户已切换'); error.staleAccount = true; return error; }
function handleError(error) { if (!error.staleAccount) status(error.message); }
async function api(path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) {
  if (!token) throw Error('请先连接账户');
  const generation = accountGeneration, credential = token;
  try {
    const r = await fetch('/api/v1' + path, { method, headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = r.status === 204 ? undefined : await r.json();
    if (generation !== accountGeneration) throw staleAccount();
    if (!r.ok) { const error = new Error(data.error?.code || String(r.status)); error.status = r.status; throw error; }
    return data;
  } catch (error) { if (generation !== accountGeneration) throw staleAccount(); throw error; }
}
function options(id, rows, label, empty) {
  const select = $(id), old = select.value;
  select.replaceChildren();
  if (empty) { const o = document.createElement('option'); o.value = ''; o.textContent = empty; select.append(o); }
  for (const row of rows) {
    const o = document.createElement('option');
    o.value = row.id ?? row.jobId ?? String(row.version); o.textContent = label(row); select.append(o);
  }
  if ([...select.options].some(o => o.value === old)) select.value = old;
}
function action(id, fn) { $(id).addEventListener('click', () => Promise.resolve().then(fn).catch(handleError)); }
async function suites() { const offset = suiteOffset, generation = accountGeneration; const rows = await api('/evals/suites?limit=50&offset=' + offset); if (generation !== accountGeneration || offset !== suiteOffset) return; options('suite', rows, s => s.name, '新建数据集'); }
async function agents() {
  const offset = agentOffset, generation = accountGeneration;
  const data = await api('/agents?limit=50&offset=' + offset);
  if (offset !== agentOffset || generation !== accountGeneration) return;
  options('agent', data.items ?? data, a => a.name ?? a.config?.name ?? a.id);
}
let suiteLoad = 0;
const versionLabel = v => '版本 ' + v.version + ' · ' + v.specDigest.slice(0, 12);
async function versions() {
  const id = draft?.id, generation = suiteLoad, offset = versionOffset;
  if (!id) return;
  options('version', [], () => '');
  const rows = await api('/evals/suites/' + id + '/versions?limit=100&offset=' + offset);
  if (generation !== suiteLoad || offset !== versionOffset || id !== draft?.id) return;
  options('version', rows, versionLabel);
}
async function loadSuite() {
  const generation = ++suiteLoad, id = $('suite').value;
  draft = null; versionOffset = 0;
  $('revision').textContent = id ? '正在加载草稿…' : '新草稿';
  options('version', [], () => '', null); $('version-detail').hidden = true; $('version-detail').textContent = '';
  const controls = ['save', 'publish', 'start', 'show-version', 'version-prev', 'version-next'];
  for (const control of controls) $(control).disabled = Boolean(id);
  if (!id) {
    $('name').value = '新数据集'; $('description').value = ''; $('cases').value = $('cases').defaultValue;
    return;
  }
  try {
    const next = await api('/evals/suites/' + id);
    const rows = await api('/evals/suites/' + id + '/versions?limit=100&offset=0');
    if (generation !== suiteLoad || id !== $('suite').value) return;
    draft = next; $('name').value = draft.name; $('description').value = draft.description;
    $('cases').value = JSON.stringify(draft.cases, null, 2);
    $('revision').textContent = '草稿 revision ' + draft.draftRevision;
    options('version', rows, versionLabel);
  } finally { if (generation === suiteLoad) for (const control of controls) $(control).disabled = false; }
}
async function jobs() {
  const offset = jobOffset, generation = accountGeneration;
  const rows = await api('/evals/jobs?limit=50&offset=' + offset);
  if (generation !== accountGeneration || offset !== jobOffset) return;
  const label = j => j.state + ' · ' + j.request.agentId + ' · ' + j.jobId;
  options('job', rows, label);
  // Inputs keep a selection across pages and also accept a known historical Job ID.
  for (const id of ['baseline', 'candidate']) {
    options(id + '-options', rows, label);
    if (!$(id).value && rows.length) $(id).value = rows[0].jobId;
  }
}
let detailGeneration = 0, detailKey = '', detailsPending;
const currentDetailKey = () => JSON.stringify([accountGeneration, $('job').value, caseOffset]);
function clearDetails() {
  caseRows = []; options('case-run', [], () => ''); $('metrics').replaceChildren();
  $('report').textContent = '暂无报告'; $('case-detail').textContent = '暂无用例详情';
}
function details() {
  const key = currentDetailKey();
  if (detailsPending && detailKey === key) return detailsPending;
  if (detailKey !== key) clearDetails();
  detailKey = key;
  const generation = ++detailGeneration;
  const pending = loadDetails(generation, key).finally(() => { if (detailsPending === pending) detailsPending = undefined; });
  detailsPending = pending;
  return pending;
}
async function loadDetails(generation, key) {
  const id = $('job').value, offset = caseOffset;
  if (!id) return;
  try {
    const report = await api('/evals/jobs/' + id + '/report');
    if (generation !== detailGeneration || key !== currentDetailKey()) return;
    const rows = await api('/evals/jobs/' + id + '/cases?limit=50&offset=' + offset);
    if (generation !== detailGeneration || key !== currentDetailKey()) return;
    // Publish one consistent report/case view only after both requests are current.
    show('report', report); $('metrics').replaceChildren();
    for (const [label, value] of [['状态', report.state], ['通过 / 总数', report.passed + ' / ' + report.denominators.total], ['执行错误率', report.executionErrorRate], ['评分错误率', report.gradingErrorRate], ['加权通过率', report.passRate ?? '—'], ['加权均分', report.avgScoreOnGraded ?? '—']]) {
      const d = document.createElement('div'); d.textContent = label + ': ' + value; $('metrics').append(d);
    }
    caseRows = rows; options('case-run', rows.map(r => ({ ...r, id: r.caseRunId })), r => r.caseId + ' #' + r.repeatIndex + ' · ' + r.state); caseDetail();
  } catch (error) { if (generation === detailGeneration && key === currentDetailKey()) throw error; }
}
function caseDetail() { const r = caseRows.find(r => r.caseRunId === $('case-run').value); if (r) show('case-detail', r); }
let startPendingGeneration, startAttempt;
action('connect', async () => {
  monitor = false; const generation = ++accountGeneration; ++suiteLoad; ++detailGeneration; draft = null;
  token = $('token').value; $('token').value = ''; startPendingGeneration = undefined; startAttempt = undefined; $('start').disabled = false;
  for (const id of ['agent','job','baseline-options','candidate-options']) options(id, [], () => '');
  suiteOffset = jobOffset = caseOffset = agentOffset = versionOffset = 0;
  $('baseline').value = $('candidate').value = ''; $('comparison').textContent = '选择相同 Suite 版本的作业进行配对比较。';
  options('suite', [], () => '', '新建数据集'); clearDetails(); await loadSuite();
  await agents(); if (generation !== accountGeneration) return; await suites(); if (generation !== accountGeneration) return; await jobs(); if (generation !== accountGeneration) return; await details(); if (generation !== accountGeneration) return; monitor = true; status('已连接 · 仅本人数据');
});
$('suite').addEventListener('change', () => loadSuite().catch(handleError));
action('new', async () => { $('suite').value = ''; await loadSuite(); });
action('save', async () => {
  const body = { name: $('name').value, description: $('description').value, cases: JSON.parse($('cases').value) };
  if (draft) body.revision = draft.draftRevision;
  draft = await api('/evals/suites' + (draft ? '/' + draft.id : ''), body, draft ? 'PATCH' : 'POST');
  await suites(); $('suite').value = draft.id; await loadSuite(); status('草稿已保存');
});
action('publish', async () => { if (!draft) throw Error('请先保存草稿'); await api('/evals/suites/' + draft.id + '/versions', { revision: draft.draftRevision }); await loadSuite(); status('不可变版本已发布'); });
action('delete', async () => { if (!draft) throw Error('请先选择数据集'); await api('/evals/suites/' + draft.id, undefined, 'DELETE'); draft = null; await suites(); await loadSuite(); status('数据集已删除；历史版本与报告保留'); });
action('show-version', async () => {
  if (!draft || !$('version').value) throw Error('请先发布版本');
  const id = draft.id, version = $('version').value, generation = suiteLoad;
  const data = await api('/evals/suites/' + id + '/versions/' + version + '?limit=100');
  if (generation !== suiteLoad || id !== draft?.id || version !== $('version').value) return;
  show('version-detail', data); $('version-detail').hidden = false;
});
action('start', async () => {
  const generation = accountGeneration;
  if (startPendingGeneration === generation) return;
  if (!draft || !$('version').value) throw Error('请先选择已发布版本');
  const maxModelCalls = Number($('model-calls').value);
  if (!Number.isInteger(maxModelCalls) || maxModelCalls < 1 || maxModelCalls > 100) throw Error('目标模型请求上限须为 1 至 100 的整数');
  const body = { suiteId: draft.id, suiteVersion: Number($('version').value), agentId: $('agent').value, repeat: Number($('repeat').value), executionProfile: 'mocked', limits: { maxTokens: Number($('tokens').value), maxModelCalls, maxDurationSeconds: Number($('duration').value), maxCostEstimateUsd: Number($('cost').value), maxJudgeCalls: Number($('judge-calls').value) } };
  const request = JSON.stringify(body);
  if (!startAttempt || startAttempt.generation !== generation || startAttempt.request !== request) startAttempt = { generation, request, key: crypto.randomUUID() };
  startPendingGeneration = generation; $('start').disabled = true;
  try {
    const j = await api('/evals/jobs', body, 'POST', { 'Idempotency-Key': startAttempt.key });
    if (generation !== accountGeneration) return;
    jobOffset = 0; await jobs(); if (generation !== accountGeneration) return;
    $('job').value = j.jobId; caseOffset = 0; await details(); if (generation !== accountGeneration) return;
    startAttempt = undefined; status('评测已排队：' + j.jobId);
  } finally { if (startPendingGeneration === generation) { startPendingGeneration = undefined; $('start').disabled = false; } }
});
action('refresh', async () => { await jobs(); await details(); monitor = true; pollingFailed = false; status('作业已刷新'); });
$('job').addEventListener('change', () => { caseOffset = 0; details().catch(handleError); });
$('case-run').addEventListener('change', caseDetail);
action('cancel', async () => { if (!$('job').value) throw Error('请选择作业'); await api('/evals/jobs/' + $('job').value + '/cancel', {}); await jobs(); await details(); status('取消请求已持久化'); });
action('compare-button', async () => {
  const data = await api('/evals/compare', { baselineJobId: $('baseline').value, candidateJobId: $('candidate').value });
  show('comparison', data); status(data.comparable ? (data.gate ? '回归 Gate 通过' : '发现回归或错误') : '不可直接比较：' + data.warnings.join(', '));
});
for (const [id, kind, direction] of [['suite-prev', 'suite', -1], ['suite-next', 'suite', 1], ['job-prev', 'job', -1], ['job-next', 'job', 1], ['case-prev', 'case', -1], ['case-next', 'case', 1], ['agent-prev', 'agent', -1], ['agent-next', 'agent', 1], ['version-prev', 'version', -1], ['version-next', 'version', 1]]) action(id, async () => {
  if (kind === 'suite') { suiteOffset = Math.max(0, suiteOffset + 50 * direction); await suites(); await loadSuite(); }
  else if (kind === 'job') { jobOffset = Math.max(0, jobOffset + 50 * direction); await jobs(); caseOffset = 0; await details(); }
  else if (kind === 'case') { caseOffset = Math.max(0, caseOffset + 50 * direction); await details(); }
  else if (kind === 'agent') { agentOffset = Math.max(0, agentOffset + 50 * direction); await agents(); }
  else { versionOffset = Math.max(0, versionOffset + 100 * direction); await versions(); }
});
setInterval(() => {
  const generation = accountGeneration;
  if (monitor && document.visibilityState === 'visible') details().then(() => { if (generation !== accountGeneration) return; if (pollingFailed) { pollingFailed = false; status('自动刷新已恢复'); } }).catch(e => {
    if (generation !== accountGeneration || e.staleAccount) return;
    if (e.status === 401 || e.status === 403) { monitor = false; status(e.message); }
    else { pollingFailed = true; status('刷新暂时失败，将自动重试：' + e.message); }
  });
}, 2000);
</script></body></html>`;
}
