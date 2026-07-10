// Self-contained admin dashboard — single HTML page with inline JS.
// No build step, no CDN deps; served as a static string from the Worker.

export const adminPage = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>天枢授权管理</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e2e8f0; min-height: 100vh; padding: 20px; }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  .subtitle { color: #94a3b8; font-size: 0.85rem; margin-bottom: 20px; }
  .login { max-width: 400px; margin: 80px auto; }
  .login input { width: 100%; padding: 10px 14px; border: 1px solid #334155; border-radius: 8px; background: #1e293b; color: #e2e8f0; font-size: 14px; margin-bottom: 12px; }
  .login button { width: 100%; padding: 10px; border: none; border-radius: 8px; background: #3b82f6; color: white; font-size: 14px; cursor: pointer; }
  .login button:hover { background: #2563eb; }
  .panel { display: none; }
  .toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
  .toolbar input, .toolbar select { padding: 8px 12px; border: 1px solid #334155; border-radius: 6px; background: #1e293b; color: #e2e8f0; font-size: 13px; }
  .toolbar input { flex: 1; min-width: 120px; }
  .batch-bar { display: none; gap: 8px; align-items: center; margin-bottom: 10px; padding: 8px 12px; background: #1e293b; border-radius: 6px; }
  .batch-bar.show { display: flex; }
  .batch-bar span { font-size: 13px; color: #94a3b8; }
  .btn { padding: 8px 14px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; }
  .btn-blue { background: #3b82f6; color: white; }
  .btn-blue:hover { background: #2563eb; }
  .btn-red { background: #ef4444; color: white; }
  .btn-red:hover { background: #dc2626; }
  .btn-green { background: #22c55e; color: white; }
  .btn-green:hover { background: #16a34a; }
  .btn-sm { padding: 4px 10px; font-size: 12px; border-radius: 4px; }
  .btn-gray { background: #334155; color: #e2e8f0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 10px; border-bottom: 2px solid #334155; color: #94a3b8; font-weight: 600; font-size: 12px; text-transform: uppercase; }
  td { padding: 8px 10px; border-bottom: 1px solid #1e293b; }
  tr:hover td { background: #1e293b; }
  .code { font-family: 'SF Mono', Monaco, monospace; font-size: 12px; color: #93c5fd; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .badge-active { background: #166534; color: #86efac; }
  .badge-revoked { background: #991b1b; color: #fca5a5; }
  .badge-full { background: #854d0e; color: #fde68a; }
  .modal-bg { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 100; justify-content: center; align-items: center; }
  .modal-bg.show { display: flex; }
  .modal { background: #1e293b; border-radius: 12px; padding: 24px; width: 420px; }
  .modal h2 { font-size: 1.1rem; margin-bottom: 16px; }
  .modal label { display: block; font-size: 12px; color: #94a3b8; margin: 10px 0 4px; }
  .modal input, .modal select { width: 100%; padding: 8px 12px; border: 1px solid #334155; border-radius: 6px; background: #0f1117; color: #e2e8f0; font-size: 13px; }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px; }
  .toast { position: fixed; bottom: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; font-size: 13px; z-index: 200; opacity: 0; transition: opacity 0.3s; }
  .toast.show { opacity: 1; }
  .toast-ok { background: #166534; color: #86efac; }
  .toast-err { background: #991b1b; color: #fca5a5; }
  .stats { display: flex; gap: 16px; margin-bottom: 16px; }
  .stat { background: #1e293b; border-radius: 8px; padding: 12px 18px; }
  .stat-val { font-size: 1.5rem; font-weight: 700; }
  .stat-label { font-size: 11px; color: #94a3b8; text-transform: uppercase; }
  .expire-tag { font-size: 11px; color: #94a3b8; }
  .expire-tag.perp { color: #22c55e; }
  .seq { color: #64748b; font-size: 12px; text-align: center; }
  input[type=checkbox] { accent-color: #3b82f6; width: 15px; height: 15px; cursor: pointer; }
</style>
</head>
<body>

<div class="login" id="loginView">
  <h1>🔐 天枢授权管理</h1>
  <p class="subtitle">输入管理密钥访问控制台</p>
  <input type="password" id="tokenInput" placeholder="Admin Token" onkeydown="if(event.key==='Enter')doLogin()">
  <button onclick="doLogin()">登录</button>
</div>

<div class="panel" id="adminPanel">
  <h1>天枢授权管理</h1>
  <p class="subtitle">激活码生成、查看、吊销管理</p>

  <div class="stats" id="stats"></div>

  <div class="toolbar">
    <input type="text" id="searchInput" placeholder="搜索码 / 备注 / 设备ID..." oninput="renderCodes()">
    <select id="filterStatus" onchange="renderCodes()">
      <option value="">全部状态</option>
      <option value="active">正常</option>
      <option value="revoked">已吊销</option>
      <option value="full">已满</option>
    </select>
    <button class="btn btn-blue" onclick="showGenModal()">+ 生成激活码</button>
    <button class="btn btn-gray btn-sm" onclick="loadCodes()">刷新</button>
  </div>

  <div class="batch-bar" id="batchBar">
    <input type="checkbox" id="selectAll" onchange="toggleSelectAll(this.checked)">
    <span id="batchCount">已选 0 个</span>
    <button class="btn btn-red btn-sm" onclick="batchAction(true)">批量吊销</button>
    <button class="btn btn-green btn-sm" onclick="batchAction(false)">批量恢复</button>
  </div>

  <div style="overflow-x:auto">
    <table>
      <thead>
        <tr>
          <th style="width:36px"><input type="checkbox" id="selectAllHead" onchange="toggleSelectAll(this.checked)"></th>
          <th style="width:36px">#</th>
          <th>激活码</th>
          <th>等级</th>
          <th>设备</th>
          <th>有效期</th>
          <th>备注</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody id="codesBody"></tbody>
    </table>
  </div>
</div>

<div class="modal-bg" id="genModal">
  <div class="modal">
    <h2>生成激活码</h2>
    <label>类型</label>
    <!-- 试用码:有效期从首次激活起算,强制单设备,一台设备一生一次。 -->
    <select id="genKind" onchange="onGenKindChange()">
      <option value="normal">正式码 (固定到期日/永久)</option>
      <option value="trial">试用码 (激活后 N 天)</option>
    </select>
    <label>数量</label>
    <input type="number" id="genCount" value="1" min="1" max="500">
    <label id="genDevicesLabel">设备上限 (每码可绑几台)</label>
    <input type="number" id="genDevices" value="2" min="1" max="50">
    <label>等级</label>
    <!-- 双层模式:桌面端任何验签通过的许可证即 Pro(Basic 无需许可证),
         tier 仅作未来更多层级的扩展位,当前只签发 pro。 -->
    <select id="genTier">
      <option value="pro">pro</option>
    </select>
    <label id="genDaysLabel">有效期天数 (留空=永久)</label>
    <input type="number" id="genDays" placeholder="如 365">
    <label>备注 (可选)</label>
    <input type="text" id="genNote" placeholder="如 user@example.com">
    <div class="modal-actions">
      <button class="btn btn-gray btn-sm" onclick="closeGenModal()">取消</button>
      <button class="btn btn-blue btn-sm" onclick="doGenerate()">生成</button>
    </div>
  </div>
</div>

<div class="modal-bg" id="devicesModal">
  <div class="modal" style="width:520px">
    <h2 id="devicesTitle">设备绑定</h2>
    <table>
      <thead><tr><th>设备 ID</th><th>激活时间</th><th>最后心跳</th><th>状态</th></tr></thead>
      <tbody id="devicesBody"></tbody>
    </table>
    <div class="modal-actions">
      <button class="btn btn-gray btn-sm" onclick="document.getElementById('devicesModal').classList.remove('show')">关闭</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let TOKEN = '';
let codes = [];
let selected = new Set();

function api(method, path, body) {
  const opts = { method, headers: { 'Authorization': 'Bearer ' + TOKEN } };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  return fetch('/admin/api' + path, opts).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.status);
    return data;
  });
}

function doLogin() {
  TOKEN = document.getElementById('tokenInput').value.trim();
  if (!TOKEN) return;
  api('GET', '/codes').then(data => {
    codes = data.codes || [];
    document.getElementById('loginView').style.display = 'none';
    document.getElementById('adminPanel').style.display = 'block';
    renderStats();
    renderCodes();
  }).catch(err => {
    showToast('登录失败: ' + err.message, 'err');
    TOKEN = '';
  });
}

function loadCodes() {
  api('GET', '/codes').then(data => {
    codes = data.codes || [];
    selected.clear();
    renderStats();
    renderCodes();
    showToast('已刷新', 'ok');
  }).catch(err => showToast(err.message, 'err'));
}

function renderStats() {
  const active = codes.filter(c => !c.revoked).length;
  const revoked = codes.filter(c => c.revoked).length;
  const totalDev = codes.reduce((s, c) => s + c.usedCount, 0);
  document.getElementById('stats').innerHTML =
    statCard(codes.length, '总码数') +
    statCard(active, '正常') +
    statCard(revoked, '已吊销') +
    statCard(totalDev, '已绑设备');
}

function statCard(val, label) {
  return '<div class="stat"><div class="stat-val">' + val + '</div><div class="stat-label">' + label + '</div></div>';
}

function getFiltered() {
  const q = document.getElementById('searchInput').value.toLowerCase();
  const sf = document.getElementById('filterStatus').value;
  return codes.filter(c => {
    if (q && !c.code.toLowerCase().includes(q) && !(c.note || '').toLowerCase().includes(q)) return false;
    if (sf === 'active' && c.revoked) return false;
    if (sf === 'revoked' && !c.revoked) return false;
    if (sf === 'full' && c.usedCount < c.maxActivations) return false;
    return true;
  });
}

function renderCodes() {
  const filtered = getFiltered();
  document.getElementById('codesBody').innerHTML = filtered.map((c, i) => {
    const full = c.usedCount >= c.maxActivations;
    const status = c.revoked
      ? '<span class="badge badge-revoked">已吊销</span>'
      : full
        ? '<span class="badge badge-full">已满</span>'
        : '<span class="badge badge-active">正常</span>';
    const lic = c.licenseExpires
      ? '<span class="expire-tag">' + new Date(c.licenseExpires).toLocaleDateString('zh-CN') + (c.trialDays ? ' · 试用' : '') + '</span>'
      : c.trialDays
        ? '<span class="expire-tag">试用 ' + c.trialDays + ' 天 (未激活)</span>'
        : '<span class="expire-tag perp">永久</span>';
    const action = c.revoked
      ? '<button class="btn btn-green btn-sm" onclick="toggleRevoke(\\'' + c.code + '\\',false)">恢复</button>'
      : '<button class="btn btn-red btn-sm" onclick="toggleRevoke(\\'' + c.code + '\\',true)">吊销</button>';
    const checked = selected.has(c.code) ? 'checked' : '';
    return '<tr>' +
      '<td style="text-align:center"><input type="checkbox" data-code="' + c.code + '" ' + checked + ' onchange="onRowCheck(this)"></td>' +
      '<td class="seq">' + (i + 1) + '</td>' +
      '<td class="code">' + c.code + '</td>' +
      '<td>' + c.tier + '</td>' +
      '<td><a href="#" onclick="showDevices(\\'' + c.code + '\\');return false" style="color:#93c5fd">' + c.usedCount + '/' + c.maxActivations + '</a></td>' +
      '<td>' + lic + '</td>' +
      '<td style="font-size:12px;color:#94a3b8">' + esc(c.note || '') + '</td>' +
      '<td>' + status + '</td>' +
      '<td>' + action + ' <button class="btn btn-gray btn-sm" onclick="copyCode(\\'' + c.code + '\\')">复制</button></td>' +
      '</tr>';
  }).join('');
  updateBatchBar();
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function onRowCheck(cb) {
  const code = cb.getAttribute('data-code');
  if (cb.checked) selected.add(code); else selected.delete(code);
  updateBatchBar();
}

function toggleSelectAll(on) {
  const filtered = getFiltered();
  if (on) { filtered.forEach(c => selected.add(c.code)); }
  else { filtered.forEach(c => selected.delete(c.code)); }
  renderCodes();
}

function updateBatchBar() {
  const bar = document.getElementById('batchBar');
  const cnt = selected.size;
  if (cnt > 0) {
    bar.classList.add('show');
    document.getElementById('batchCount').textContent = '已选 ' + cnt + ' 个';
  } else {
    bar.classList.remove('show');
  }
  const filtered = getFiltered();
  const allChecked = filtered.length > 0 && filtered.every(c => selected.has(c.code));
  const cbHead = document.getElementById('selectAllHead');
  if (cbHead) cbHead.checked = allChecked;
  const cbBar = document.getElementById('selectAll');
  if (cbBar) cbBar.checked = allChecked;
}

function batchAction(revoke) {
  const list = Array.from(selected);
  if (list.length === 0) return;
  const label = revoke ? '吊销' : '恢复';
  if (!confirm('确认批量' + label + ' ' + list.length + ' 个激活码？')) return;
  Promise.all(list.map(code => api('PATCH', '/codes/' + code, { revoked: revoke })))
    .then(() => {
      list.forEach(code => {
        const idx = codes.findIndex(c => c.code === code);
        if (idx >= 0) codes[idx] = { ...codes[idx], revoked: revoke ? 1 : 0 };
      });
      selected.clear();
      renderStats();
      renderCodes();
      showToast('已批量' + label + ' ' + list.length + ' 个码', 'ok');
    })
    .catch(err => showToast(err.message, 'err'));
}

function showDevices(code) {
  api('GET', '/codes/' + code + '/devices').then(data => {
    document.getElementById('devicesTitle').textContent = code + ' — 设备绑定';
    document.getElementById('devicesBody').innerHTML = (data.devices || []).map(d =>
      '<tr><td class="code">' + d.deviceId + '</td>' +
      '<td>' + (d.activatedAt ? new Date(d.activatedAt).toLocaleString('zh-CN') : '-') + '</td>' +
      '<td>' + (d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString('zh-CN') : '-') + '</td>' +
      '<td>' + (d.revoked ? '<span class="badge badge-revoked">已撤</span>' : '<span class="badge badge-active">正常</span>') + '</td></tr>'
    ).join('') || '<tr><td colspan=4 style="color:#94a3b8;text-align:center">无设备绑定</td></tr>';
    document.getElementById('devicesModal').classList.add('show');
  }).catch(err => showToast(err.message, 'err'));
}

function toggleRevoke(code, revoke) {
  const label = revoke ? '吊销' : '恢复';
  if (!confirm('确认' + label + '激活码 ' + code + '？')) return;
  api('PATCH', '/codes/' + code, { revoked: revoke }).then(() => {
    const idx = codes.findIndex(c => c.code === code);
    if (idx >= 0) codes[idx] = { ...codes[idx], revoked: revoke ? 1 : 0 };
    renderStats();
    renderCodes();
    showToast('已' + label + ' ' + code, 'ok');
  }).catch(err => showToast(err.message, 'err'));
}

function copyCode(code) {
  navigator.clipboard.writeText(code).then(() => showToast('已复制 ' + code, 'ok'));
}

function showGenModal() {
  document.getElementById('genModal').classList.add('show');
}
function closeGenModal() {
  document.getElementById('genModal').classList.remove('show');
}

function onGenKindChange() {
  const trial = document.getElementById('genKind').value === 'trial';
  document.getElementById('genDaysLabel').textContent = trial ? '试用天数 (从激活起算)' : '有效期天数 (留空=永久)';
  document.getElementById('genDays').placeholder = trial ? '如 10' : '如 365';
  // 试用码强制单设备（服务端同样强制），禁用输入避免误解
  const dev = document.getElementById('genDevices');
  dev.disabled = trial;
  if (trial) dev.value = '1';
  document.getElementById('genDevicesLabel').textContent = trial ? '设备上限 (试用码固定 1 台)' : '设备上限 (每码可绑几台)';
}

function doGenerate() {
  const trial = document.getElementById('genKind').value === 'trial';
  const count = parseInt(document.getElementById('genCount').value) || 1;
  const devices = parseInt(document.getElementById('genDevices').value) || 1;
  const tier = document.getElementById('genTier').value;
  const daysRaw = document.getElementById('genDays').value.trim();
  const note = document.getElementById('genNote').value.trim();
  if (trial && !daysRaw) { showToast('试用码必须填试用天数', 'err'); return; }
  const body = trial
    ? { count, tier, trialDays: parseInt(daysRaw), note }
    : { count, maxActivations: devices, tier, licenseDays: daysRaw ? parseInt(daysRaw) : null, note };
  api('POST', '/codes', body).then(data => {
    closeGenModal();
    if (data.codes && data.codes.length > 0) {
      navigator.clipboard.writeText(data.codes.join('\\n'));
      showToast('生成 ' + data.codes.length + ' 个码，已复制到剪贴板', 'ok');
    }
    loadCodes();
  }).catch(err => showToast(err.message, 'err'));
}

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (type === 'ok' ? 'toast-ok' : 'toast-err');
  setTimeout(() => t.classList.remove('show'), 3000);
}
</script>
</body>
</html>`;