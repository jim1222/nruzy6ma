// 記帳小幫手手機版。邏輯照電腦版 bookkeeping_reply_helper.py 移植，資料結構完全一樣，
// 匯出的 JSON 可以直接放回電腦版的「記帳客戶資料」資料夾使用。
'use strict';

const STORAGE_KEY = 'bookkeeping-helper-v1';
const GREETING_OPTIONS = ['你好', '早上好', '下午好'];
const DEADLINE_WARNING_DAYS = 3;
const DEFAULT_INTRO = '麻煩提供這次所需資料，謝謝您的配合。';
const OPTION_TYPE_ICONS = { fixed: '📄', checklist: '☑️', pickup: '🚚' };
const OPTION_TYPE_LABELS = { fixed: '固定文字', checklist: '可勾選清單', pickup: '取件提醒' };
const PICKUP_VARS = ['{公司}', '{地址}', '{日期}', '{星期}'];
// JS 的 getDay() 是 0=星期日，跟 Python weekday() 的 0=星期一不同
const WEEKDAY_CHARS = ['日', '一', '二', '三', '四', '五', '六'];
const AVATAR_PALETTE = ['#FF93B3', '#B9A6FF', '#7FDDB8', '#7FCBEE', '#FFB366'];

// ───────────────────────── 小工具 ─────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function clone(data) { return JSON.parse(JSON.stringify(data)); }

function uid() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function pad(n) { return String(n).padStart(2, '0'); }
function isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayIso() { return isoDate(new Date()); }
function currentMonthKey(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
function daysInMonth(year, month) { return new Date(year, month, 0).getDate(); }

function parseIso(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((text || '').trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getMonth() === +m[2] - 1 ? d : null;
}

function daysFromToday(date) {
  const now = new Date();
  const a = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const b = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((b - a) / 86400000);
}

function weekdayOf(month, day) {
  return WEEKDAY_CHARS[new Date(new Date().getFullYear(), month - 1, day).getDay()];
}

// 「2026-10-22」→「10/22（四）」，手機上比 ISO 格式好讀
function friendlyDate(text) {
  const d = parseIso(text);
  if (!d) return text || '';
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAY_CHARS[d.getDay()]}）`;
}

function companyLabel(company) {
  const code = company['編號'] || '';
  return `${code}${company['名稱'] || ''}`;
}

function avatarColor(seed) {
  let h = 0;
  for (const ch of (seed || '?')) h += ch.codePointAt(0);
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

// ───────────────────────── 焙子（家裡的倉鼠）─────────────────────────
// 勾完成時隨機跳一句（跟電腦版 CHEERS 同樣的話）
const CHEERS = ['吱吱～完成一件了！🐹', '焙子說：好棒！🌻', '辛苦了～焙子幫你拍拍 🐹', '吱～又搞定一件！🌻'];
function cheer() { toast(CHEERS[Math.floor(Math.random() * CHEERS.length)]); }

// 沒有資料時顯示睡覺的焙子（art/sleep.png，跟電腦版同一張圖）
const SLEEP_IMG = '<img class="sleep-art" src="art/sleep.png" alt="">';
function emptyArtHtml(text) {
  return `<div class="empty-art">${SLEEP_IMG}<p>${text}</p></div>`;
}

let toastTimer = null;
function toast(text, duration = 1800) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// iOS 網頁裡不能用 confirm()，刪除類按鈕改成「按第一次變紅字確認，3 秒內再按一次才真的執行」
let confirmState = { key: null, timer: null };
function confirmTwice(button, key, action) {
  if (confirmState.key === key) {
    clearTimeout(confirmState.timer);
    confirmState = { key: null, timer: null };
    action();
    return;
  }
  clearTimeout(confirmState.timer);
  document.querySelectorAll('.confirming').forEach(el => {
    el.classList.remove('confirming');
    el.textContent = el.dataset.origText;
  });
  button.dataset.origText = button.textContent;
  button.textContent = button.dataset.confirmText || '再按一次確定';
  button.classList.add('confirming');
  confirmState = {
    key,
    timer: setTimeout(() => {
      button.classList.remove('confirming');
      button.textContent = button.dataset.origText;
      confirmState = { key: null, timer: null };
    }, 3000),
  };
}

// ───────────────────────── 資料 ─────────────────────────
// 客戶資料不放在網頁程式碼裡（GitHub repo 是公開的），全部從雲端來；
// 手機這份 localStorage 只是離線時用的備份。
function emptyState() {
  return { companies: [], settings: { '開頭本文': DEFAULT_INTRO }, todos: [], reminderShownDate: '' };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.companies)) {
        data.settings = Object.assign({ '開頭本文': DEFAULT_INTRO }, data.settings || {});
        data.todos = Array.isArray(data.todos) ? data.todos : [];
        delete data.seedVersion;
        return data;
      }
    }
  } catch (e) { /* 讀不到就等雲端 */ }
  return emptyState();
}

let storageWarned = false;
function saveLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    localStorage.setItem(SYNC_KEY, JSON.stringify(sync));
  } catch (e) {
    if (!storageWarned) {
      storageWarned = true;
      toast('⚠️ 資料存不進手機，請從主畫面的圖示開啟');
    }
  }
}

// 每次修改都走這裡：先存手機當離線備份，再上傳雲端
function save() {
  saveLocal();
  pushToCloud();
}

let state = loadState();

// ───────────────────────── 雲端同步 ─────────────────────────
// 跟電腦版 CloudSync 同一套規則（見 bookkeeping_reply_helper.py）：整份資料帶版本號 rev 上傳，
// 雲端的 rev 已經變了代表另一台改過，雲端會拒絕並回傳最新版。
const SYNC_URL = 'https://script.google.com/macros/s/AKfycbxOqVBOVb3cJETBQzIFc7MIKfdP3U_gTH-3iLes2u1uLCF80wtstWroJtiLlY0WL-zy/exec';
const SYNC_KEY = 'bookkeeping-helper-sync';
const SYNC_POLL_MS = 20000;
// ?ns=test 只給測試用，資料會寫到雲端的測試檔
const SYNC_NS = /^[a-z0-9_-]{1,20}$/.test(new URLSearchParams(location.search).get('ns') || '')
  ? new URLSearchParams(location.search).get('ns') : 'main';

function loadSync() {
  try {
    const data = JSON.parse(localStorage.getItem(SYNC_KEY) || '{}');
    return {
      key: data.key || '', rev: data.rev || 0, pending: !!data.pending,
      offlineEdits: !!data.offlineEdits, sent: Array.isArray(data.sent) ? data.sent : [],
      name: data.name || '',
      agreed: data.agreed || null,
    };
  } catch (e) {
    return { key: '', rev: 0, pending: false, offlineEdits: false, sent: [], name: '', agreed: null };
  }
}

function hashText(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return h >>> 0;
}

// 上傳送出去了、但還沒收到回應 App 就被關掉（或網路斷掉）時，雲端那份新版本其實是這支手機
// 自己傳的。連續改好幾樣時，前一次上傳可能比後一次晚才到雲端，所以每一次「送出但還沒收到
// 回應」的上傳都要記著，雲端那份是其中任何一次就接著用，不要誤判成另一台改過而丟掉修改。
function adoptOwnPush(result) {
  const hash = hashText(stableStringify(result.data));
  if (!sync.sent.some(s => result.rev === s.baseRev + 1 && s.hash === hash)) return false;
  sync.rev = result.rev;
  sync.sent = sync.sent.filter(s => s.baseRev >= result.rev);
  sync.offlineEdits = false;
  if (stableStringify(result.data) === stableStringify(cloudPayload())) {
    sync.pending = false;
    saveLocal();
    setSyncStatus('ok', '☁️ 已同步');
  } else {
    pushToCloud();
  }
  return true;
}

let sync = loadSync();
const syncRun = { busy: false, pushAgain: false, lastPull: 0, status: '' };

function setSyncStatus(kind, text) {
  syncRun.status = kind;
  const el = $('#sync-status');
  if (!el) return;
  el.textContent = text;
  el.className = `sync-status ${kind}`;
}

async function cloudRequest(payload, key = sync.key) {
  const url = `${SYNC_URL}?key=${encodeURIComponent(key)}&ns=${SYNC_NS}`;
  // body 用純文字字串，fetch 會送 text/plain，Apps Script 才不會卡在跨網域預檢
  const resp = payload === undefined
    ? await fetch(url, { cache: 'no-store' })
    : await fetch(SYNC_URL, { method: 'POST', body: JSON.stringify(Object.assign({ key, ns: SYNC_NS }, payload)) });
  const result = await resp.json();
  if (!result.ok && !result.conflict) throw new Error(result.error || 'cloud error');
  return result;
}

async function runSync(kind, payload) {
  syncRun.busy = true;
  setSyncStatus('busy', '同步中…');
  let result;
  try {
    result = await cloudRequest(payload);
  } catch (e) {
    syncRun.busy = false;
    // App 被關掉時中斷的請求不算「離線」，不然下次打開會被誤判成要她選資料
    if (syncRun.unloading) return;
    if (sync.pending) { sync.offlineEdits = true; saveLocal(); }
    setSyncStatus('offline', sync.pending ? '⚠️ 離線，稍後上傳' : '⚠️ 離線');
    return;
  }
  // 處理結果放在 try 外面：程式自己的錯誤不能被當成「離線」吞掉
  syncRun.busy = false;
  if (kind === 'pull') handlePull(result);
  else handlePush(result);
}

function pullFromCloud(minInterval = 0) {
  if (!sync.key || syncRun.busy || Date.now() - syncRun.lastPull < minInterval) return Promise.resolve();
  syncRun.lastPull = Date.now();
  return runSync('pull');
}

function pushToCloud(force = false) {
  if (!sync.key) return;
  sync.pending = true;
  saveLocal();
  if (syncRun.busy) { syncRun.pushAgain = true; return; }
  const data = cloudPayload();
  sync.sent = [...sync.sent, { baseRev: sync.rev, hash: hashText(stableStringify(data)) }].slice(-10);
  saveLocal();
  runSync('push', { baseRev: sync.rev, data, force });
}

function handlePull(result) {
  if (adoptOwnPush(result)) return;
  if (result.data === null || result.data === undefined) {
    sync.rev = result.rev;
    pushToCloud();
    return;
  }
  if (result.rev === sync.rev) {
    if (sync.pending) pushToCloud();
    else setSyncStatus('ok', '☁️ 已同步');
    return;
  }
  if (sync.pending) {
    // 改完馬上關掉 App 時，上傳其實可能已經成功、只是手機沒來得及記下新版本號；
    // 雲端內容跟手機上一模一樣就是這種情況，不用問她
    if (stableStringify(result.data) === stableStringify(cloudPayload())) {
      sync.rev = result.rev;
      sync.pending = false;
      sync.offlineEdits = false;
      saveLocal();
      setSyncStatus('ok', '☁️ 已同步');
      return;
    }
    openConflictSheet(result);
    return;
  }
  applyRemote(result);
}

function cloudPayload() {
  const { reminderShownDate, ...data } = state;
  return data;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function handlePush(result) {
  if (result.ok) {
    sync.rev = result.rev;
    sync.pending = false;
    sync.offlineEdits = false;
    sync.sent = [];
    saveLocal();
    if (syncRun.pushAgain) { syncRun.pushAgain = false; pushToCloud(); }
    else setSyncStatus('ok', '☁️ 已同步');
    return;
  }
  syncRun.pushAgain = false;
  if (adoptOwnPush(result)) return;
  if (sync.offlineEdits) {
    openConflictSheet(result);
    return;
  }
  applyRemote(result);
  toast('另一台裝置剛更新過，已換成最新資料，剛才的修改請再做一次 🙏', 4000);
}

let pendingRemote = null;
function applyRemote(result) {
  // 表單開著的時候先不換資料，表單手上拿的是舊的公司物件，換掉後按儲存會改到舊物件
  pendingRemote = result;
  if ($('#sheet-root').children.length) {
    setTimeout(() => { if (pendingRemote === result) applyRemote(result); }, 1000);
    return;
  }
  pendingRemote = null;
  const data = result.data || {};
  state.companies = data.companies || [];
  state.settings = Object.assign({ '開頭本文': DEFAULT_INTRO }, data.settings || {});
  state.todos = data.todos || [];
  sync.rev = result.rev;
  sync.pending = false;
  sync.offlineEdits = false;
  sync.sent = [];
  saveLocal();
  if (!findCompany(ui.companyId)) {
    ui.companyId = state.companies[0]?.id || null;
    ui.genIndex = null;
    ui.output = '';
  }
  render();
  setSyncStatus('ok', '☁️ 已同步');
}

function openConflictSheet(result) {
  if ($('#sheet-root').children.length) {
    setTimeout(() => openConflictSheet(result), 1000);
    return;
  }
  openSheet({
    title: '☁️ 雲端資料不一致',
    body: `<p style="margin:0 0 10px">這支手機離線時改過資料，電腦（或另一台裝置）也改過。要留下哪一份呢？</p>
      <p class="hint" style="margin:0">選「用雲端的」的話，這支手機離線時的修改會不見。</p>`,
    footer: '<button class="btn ghost" id="use-cloud">用雲端的</button><button class="btn primary" id="use-local">用這支手機的</button>',
    onMount(overlay) {
      overlay.querySelector('#use-local').addEventListener('click', () => {
        closeSheet();
        pushToCloud(true);
      });
      overlay.querySelector('#use-cloud').addEventListener('click', () => {
        closeSheet();
        applyRemote(result);
      });
    },
  });
}

function findCompany(id) { return state.companies.find(c => c.id === id) || null; }

// 移植自電腦版 collect_reminder_items()
function collectReminderItems() {
  const today = todayIso();
  const monthKey = currentMonthKey();
  const todos = state.todos.filter(t => !t['完成'] && t['日期'] === today);
  const deadlines = [];
  const monthly = [];
  for (const company of state.companies) {
    const name = companyLabel(company);
    for (const d of company['截止日期'] || []) {
      if (d['完成']) continue;
      const due = parseIso(d['日期']);
      if (!due) continue;
      const daysLeft = daysFromToday(due);
      if (daysLeft <= DEADLINE_WARNING_DAYS) {
        deadlines.push({ 公司: name, 標題: d['標題'] || '', 日期: d['日期'], 剩餘天數: daysLeft });
      }
    }
    const progress = (company['月度進度'] || {})[monthKey] || {};
    for (const task of company['月度待辦'] || []) {
      if (!progress[task]) monthly.push({ 公司: name, 項目: task });
    }
  }
  deadlines.sort((a, b) => a['剩餘天數'] - b['剩餘天數']);
  return { todos, deadlines, monthly };
}

// ───────────────────────── 畫面狀態 ─────────────────────────
const now = new Date();
const ui = {
  tab: 'todo',
  companyId: state.companies[0]?.id || null,
  genIndex: null,
  greeting: GREETING_OPTIONS[0],
  checks: {},
  output: '',
  dates: {
    todo: { m: now.getMonth() + 1, d: now.getDate() },
    deadline: { m: now.getMonth() + 1, d: now.getDate() },
    pickup: { m: now.getMonth() + 1, d: now.getDate() },
  },
  cal: { y: now.getFullYear(), m: now.getMonth() + 1, day: isoDate(now) },
  welcomeStep: 1,
  agreeChecks: [false, false, false, false],
};

function pickedIso(key) {
  const { m, d } = ui.dates[key];
  return `${new Date().getFullYear()}-${pad(m)}-${pad(d)}`;
}

function selectedCompany() {
  let company = findCompany(ui.companyId);
  if (!company && state.companies.length) {
    company = state.companies[0];
    ui.companyId = company.id;
  }
  return company;
}

// ───────────────────────── 修改標記 ─────────────────────────
// 改過的項目記下「誰、什麼時候改的」，對方勾「已看過」就刪掉。格式跟電腦版一樣。
const UNNAMED = '未命名';
function newMark() {
  const d = new Date();
  return { '誰': sync.name || UNNAMED, '時間': `${isoDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}` };
}
function isMine(mark) { return mark['誰'] === (sync.name || UNNAMED); }
function markTimeText(mark) {
  const t = mark['時間'] || '';
  return t.length >= 16 ? `${t.slice(5, 7)}/${t.slice(8, 10)} ${t.slice(11, 16)}` : t;
}

// 這間公司底下看得到的標記（客戶進度＋公司與選項），紅點用。月度進度只看本月。
function companyMarks(company) {
  const marks = [company['修改標記'], company['月度待辦標記'],
    ...Object.values(((company['月度進度標記'] || {})[currentMonthKey()]) || {})];
  ['選項', '截止日期', '催件紀錄'].forEach(key => (company[key] || []).forEach(item => marks.push(item['修改標記'])));
  return marks.filter(Boolean);
}
function hasUnseen(company) { return companyMarks(company).some(m => !isMine(m)); }
function dotHtml(company) { return hasUnseen(company) ? '<span class="mark-dot" aria-label="有新修改">●</span>' : ''; }

// ref 指到標記放在哪裡，勾「已看過」時用 resolveMarkRef 找回來刪掉
function markHtml(mark, ref, prefix = '') {
  if (!mark) return '';
  const lead = prefix ? `<span>${prefix}</span>` : '';
  if (isMine(mark)) return `<div class="mark mine">${lead}<span>✏️ 你 ${esc(markTimeText(mark))}・等對方確認</span></div>`;
  return `
    <div class="mark">${lead}<span class="mark-pill">✏️ ${esc(mark['誰'])} ${esc(markTimeText(mark))}</span>
      ${checkHtml({ checked: false, change: 'ack-mark', data: { ref }, label: '已看過' })}
    </div>`;
}

function resolveMarkRef(ref) {
  const [kind, id, companyId] = ref.split(':');
  if (kind === 'todo') return [state.todos.find(t => t.id === id), '修改標記'];
  if (kind === 'intro') return [state.settings, '開頭本文標記'];
  const company = companyId ? findCompany(companyId) : selectedCompany();
  if (!company) return [null, ''];
  if (kind === 'company') return [company, '修改標記'];
  if (kind === 'monthly-list') return [company, '月度待辦標記'];
  if (kind === 'monthly') return [((company['月度進度標記'] || {})[currentMonthKey()]) || null, (company['月度待辦'] || [])[+id]];
  if (kind === 'option') return [(company['選項'] || [])[+id], '修改標記'];
  if (kind === 'deadline') return [(company['截止日期'] || []).find(d => d.id === id), '修改標記'];
  if (kind === 'log') return [(company['催件紀錄'] || []).find(l => l.id === id), '修改標記'];
  return [null, ''];
}

// ───────────────────────── 共用元件 ─────────────────────────
function avatarHtml(company) {
  const name = company['名稱'] || '?';
  return `<span class="avatar" style="background:${avatarColor(name)}">${esc([...name][0])}</span>`;
}

function companyPickerHtml() {
  const company = selectedCompany();
  if (!company) {
    return '<div class="card"><p class="empty">還沒有任何公司，請到「管理」分頁新增 🏢</p></div>';
  }
  return `
    <button class="company-picker" data-action="open-company-sheet">
      ${avatarHtml(company)}
      <span class="cp-text"><small>目前的公司（點這裡換）</small><b>${esc(companyLabel(company))}${dotHtml(company)}</b></span>
      <span class="chev">▼</span>
    </button>`;
}

function monthDayPickerHtml(key, showWeekday = false) {
  const { m, d } = ui.dates[key];
  const dim = daysInMonth(new Date().getFullYear(), m);
  const months = Array.from({ length: 12 }, (_, i) => i + 1)
    .map(v => `<option value="${v}"${v === m ? ' selected' : ''}>${v}</option>`).join('');
  const days = Array.from({ length: dim }, (_, i) => i + 1)
    .map(v => `<option value="${v}"${v === d ? ' selected' : ''}>${v}</option>`).join('');
  return `
    <div class="md-picker">
      <select data-change="date" data-key="${key}" data-part="m" aria-label="月">${months}</select><span>月</span>
      <select data-change="date" data-key="${key}" data-part="d" aria-label="日">${days}</select><span>日</span>
      ${showWeekday ? `<span class="weekday">星期${weekdayOf(m, d)}</span>` : ''}
    </div>`;
}

function checkHtml({ checked, change, data = {}, label, strike = false }) {
  const attrs = Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
  return `
    <label class="check">
      <input type="checkbox" data-change="${change}"${attrs}${checked ? ' checked' : ''}>
      <span class="box"></span>
      <span class="label${strike ? ' strike' : ''}">${label}</span>
    </label>`;
}

// ───────────────────────── 每日待辦 ─────────────────────────
function renderTodo() {
  const today = todayIso();
  const todos = [...state.todos].sort((a, b) => (a['日期'] || '').localeCompare(b['日期'] || ''));
  const rows = todos.map(t => {
    const overdue = !t['完成'] && (t['日期'] || '') < today;
    return `
      <div class="list-row${overdue ? ' danger-text' : ''}">
        ${checkHtml({
          checked: t['完成'], change: 'toggle-todo', data: { id: t.id }, strike: true,
          label: `<span class="date-tag">${esc(friendlyDate(t['日期']))}${overdue ? '　已逾期' : ''}${t['日期'] === today ? '　今天' : ''}</span>${esc(t['內容'])}`,
        })}
        <button class="btn danger small" data-action="delete-todo" data-id="${esc(t.id)}">刪除</button>
        ${markHtml(t['修改標記'], `todo:${t.id}`)}
      </div>`;
  }).join('');
  return `
    <section class="card">
      <h2 class="card-title">📅 新增每日待辦</h2>
      <label class="field-label">日期</label>
      ${monthDayPickerHtml('todo', true)}
      <label class="field-label" for="todo-input">待辦內容</label>
      <div class="input-row">
        <input id="todo-input" class="input" placeholder="例如：整理客戶的發票" enterkeyhint="done" data-enter="add-todo">
        <button class="btn primary" data-action="add-todo">新增</button>
      </div>
    </section>
    <h2 class="section-title">📋 待辦清單</h2>
    ${rows || emptyArtHtml('目前沒有待辦事項，焙子在睡覺～ 🐹')}`;
}

// ───────────────────────── 行事曆 ─────────────────────────
// 不另外存資料：把每日待辦、各公司截止日期、催件紀錄排到月曆上看（跟電腦版一樣）
function calendarItemsByDate() {
  const days = {};
  const slot = key => (days[key] = days[key] || { todos: [], deadlines: [], logs: [] });
  state.todos.forEach(t => { if (t['日期']) slot(t['日期']).todos.push(t); });
  state.companies.forEach(c => {
    (c['截止日期'] || []).forEach(d => { if (d['日期']) slot(d['日期']).deadlines.push({ company: c, d }); });
    (c['催件紀錄'] || []).forEach(log => { if (log['時間']) slot(log['時間'].slice(0, 10)).logs.push({ company: c, log }); });
  });
  return days;
}

// 沒完成的才標紅：待辦過了日期才紅，截止日期 3 天內到期就紅（跟待辦頁、進度頁一樣）
function isUrgent(dateText, done, isDeadline) {
  const due = parseIso(dateText);
  if (done || !due) return false;
  const left = daysFromToday(due);
  return isDeadline ? left <= DEADLINE_WARNING_DAYS : left < 0;
}

// 過去的日子蓋焙子印章（集點卡的感覺）。art/stamp.png 跟電腦版同一張，角度用日期決定
const STAMP_ANGLES = [-14, -6, 5, 13];
function stampHtml(iso) {
  const day = Math.round(parseIso(iso).getTime() / 86400000);
  const angle = STAMP_ANGLES[((day % 4) + 4) % 4];
  return `<img class="stamp" src="art/stamp.png" alt="" style="transform: rotate(${-angle}deg)">`;
}

function renderCalendar() {
  const { y, m, day } = ui.cal;
  const items = calendarItemsByDate();
  const today = todayIso();
  const first = new Date(y, m - 1, 1);
  const cells = Array.from({ length: 42 }, (_, i) => new Date(y, m - 1, 1 - first.getDay() + i)).map(d => {
    const iso = isoDate(d);
    const dayItems = items[iso] || { todos: [], deadlines: [] };
    const entries = [
      ...dayItems.todos.map(t => ({ done: t['完成'], urgent: isUrgent(iso, t['完成'], false), kind: 'todo' })),
      ...dayItems.deadlines.map(({ d: dl }) => ({ done: dl['完成'], urgent: isUrgent(iso, dl['完成'], true), kind: 'deadline' })),
    ];
    const dots = entries.slice(0, 4).map(e => `<i class="dot ${e.done ? 'done' : e.urgent ? 'urgent' : e.kind}"></i>`).join('');
    const cls = [d.getMonth() + 1 !== m && 'other', iso === today && 'today', iso === day && 'selected'].filter(Boolean).join(' ');
    const stamp = iso < today ? stampHtml(iso) : '';
    return `<button class="cal-cell ${cls}" data-action="cal-pick" data-date="${iso}">${stamp}<span>${d.getDate()}</span><span class="dots">${dots}</span></button>`;
  }).join('');

  const dayItems = items[day] || { todos: [], deadlines: [], logs: [] };
  const todoHtml = dayItems.todos.map(t => `
      <div class="list-row${isUrgent(day, t['完成'], false) ? ' danger-text' : ''}">
        ${checkHtml({ checked: t['完成'], change: 'toggle-todo', data: { id: t.id }, label: esc(t['內容']), strike: true })}
        <button class="btn danger small" data-action="delete-todo" data-id="${esc(t.id)}">刪除</button>
        ${markHtml(t['修改標記'], `todo:${t.id}`)}
      </div>`).join('');
  const deadlineHtml = dayItems.deadlines.map(({ company, d }) => `
      <div class="list-row${isUrgent(day, d['完成'], true) ? ' danger-text' : ''}">
        ${checkHtml({
          checked: d['完成'], change: 'toggle-deadline', data: { id: d.id, company: company.id }, strike: true,
          label: `<span class="date-tag">${esc(companyLabel(company))}</span>${esc(d['標題'])}`,
        })}
        ${markHtml(d['修改標記'], `deadline:${d.id}:${company.id}`)}
      </div>`).join('');
  const logHtml = dayItems.logs.map(({ company, log }) => `
      <div class="log-row"><div class="log-text"><span class="date-tag">${esc(log['時間'].slice(11, 16))}　${esc(companyLabel(company))}</span>${esc(log['內容'])}</div></div>`).join('');
  const empty = !todoHtml && !deadlineHtml && !logHtml;

  return `
    <section class="card cal-card">
      <div class="cal-nav">
        <button class="btn small" data-action="cal-shift" data-delta="-1" aria-label="上個月">◀</button>
        <b>${y} 年 ${m} 月</b>
        <button class="btn small" data-action="cal-shift" data-delta="1" aria-label="下個月">▶</button>
        <button class="btn small ghost" data-action="cal-today">今天</button>
      </div>
      <div class="cal-grid">
        ${['日', '一', '二', '三', '四', '五', '六'].map((w, i) => `<span class="cal-week${i === 0 || i === 6 ? ' weekend' : ''}">${w}</span>`).join('')}
        ${cells}
      </div>
      <p class="cal-legend"><span><i class="dot todo"></i>待辦</span><span><i class="dot deadline"></i>截止日期</span><span><i class="dot urgent"></i>逾期／快到期</span><span><i class="dot done"></i>已完成</span><span>🐹 焙子印章＝已經過完的日子</span></p>
    </section>
    <section class="card">
      <h2 class="card-title">📌 ${esc(friendlyDate(day))}${day === today ? '　今天' : ''}</h2>
      <div class="input-row">
        <input id="cal-input" class="input" placeholder="在這天新增待辦" enterkeyhint="done" data-enter="add-cal-todo">
        <button class="btn primary" data-action="add-cal-todo">新增</button>
      </div>
      <div style="margin-top:12px">
        ${empty ? emptyArtHtml('這天沒有安排，焙子在睡覺～') : ''}
        ${todoHtml ? `<h3 class="cal-sub">📅 待辦</h3>${todoHtml}` : ''}
        ${deadlineHtml ? `<h3 class="cal-sub">⏰ 截止日期</h3>${deadlineHtml}` : ''}
        ${logHtml ? `<h3 class="cal-sub">💬 這天的催件紀錄</h3>${logHtml}` : ''}
      </div>
    </section>`;
}

// ───────────────────────── 客戶進度 ─────────────────────────
function renderProgress() {
  const company = selectedCompany();
  if (!company) return companyPickerHtml();
  const monthKey = currentMonthKey();
  const tasks = company['月度待辦'] || [];
  const progress = (company['月度進度'] || {})[monthKey] || {};
  const taskMarks = (company['月度進度標記'] || {})[monthKey] || {};
  const taskHtml = tasks.length
    ? markHtml(company['月度待辦標記'], 'monthly-list', '項目清單有修改') + tasks.map((task, i) => checkHtml({
        checked: !!progress[task], change: 'toggle-monthly', data: { index: i }, label: esc(task), strike: true,
      }) + markHtml(taskMarks[task], `monthly:${i}`)).join('')
    : '<p class="empty">這間公司還沒有設定月度待辦項目，按右上「管理項目」新增</p>';

  const deadlines = [...(company['截止日期'] || [])].sort((a, b) => (a['日期'] || '').localeCompare(b['日期'] || ''));
  const deadlineHtml = deadlines.length
    ? deadlines.map(d => {
        const due = parseIso(d['日期']);
        const left = due ? daysFromToday(due) : null;
        const soon = !d['完成'] && left !== null && left <= DEADLINE_WARNING_DAYS;
        let when = '';
        if (!d['完成'] && left !== null) {
          when = left < 0 ? `　已逾期 ${-left} 天` : left === 0 ? '　今天到期' : left <= DEADLINE_WARNING_DAYS ? `　${left} 天後到期` : '';
        }
        return `
          <div class="list-row${soon ? ' danger-text' : ''}">
            ${checkHtml({
              checked: d['完成'], change: 'toggle-deadline', data: { id: d.id }, strike: true,
              label: `<span class="date-tag">${esc(friendlyDate(d['日期']))}${when}</span>${esc(d['標題'])}`,
            })}
            <button class="btn danger small" data-action="delete-deadline" data-id="${esc(d.id)}">刪除</button>
            ${markHtml(d['修改標記'], `deadline:${d.id}`)}
          </div>`;
      }).join('')
    : '<p class="empty">目前沒有設定截止日期</p>';

  const logs = company['催件紀錄'] || [];
  const logHtml = logs.length
    ? logs.map(log => `
        <div class="log-row">
          <div class="log-text"><span class="date-tag">${esc(log['時間'])}</span>${esc(log['內容'])}${markHtml(log['修改標記'], `log:${log.id}`)}</div>
          <button class="btn danger small" data-action="delete-log" data-id="${esc(log.id)}">刪除</button>
        </div>`).join('')
    : '<p class="empty">還沒有催件紀錄</p>';

  return `
    ${companyPickerHtml()}
    <section class="card">
      <h2 class="card-title">📋 本月待辦（${monthKey}）
        <button class="btn small" data-action="manage-monthly">管理項目</button>
      </h2>
      ${taskHtml}
    </section>
    <section class="card">
      <h2 class="card-title">⏰ 截止日期</h2>
      ${monthDayPickerHtml('deadline', true)}
      <div class="input-row" style="margin-top:8px">
        <input id="deadline-input" class="input" placeholder="例如：營業稅申報" enterkeyhint="done" data-enter="add-deadline">
        <button class="btn" data-action="add-deadline">新增</button>
      </div>
      <div style="margin-top:12px">${deadlineHtml}</div>
    </section>
    <section class="card">
      <h2 class="card-title">💬 客戶聯絡/催件紀錄</h2>
      <div class="input-row">
        <input id="log-input" class="input" placeholder="例如：已催客戶補交發票" enterkeyhint="done" data-enter="add-log">
        <button class="btn" data-action="add-log">新增</button>
      </div>
      <div style="margin-top:8px">${logHtml}</div>
    </section>`;
}

// ───────────────────────── 產生文字 ─────────────────────────
function currentGenOption() {
  const company = selectedCompany();
  const options = company?.['選項'] || [];
  return ui.genIndex !== null && ui.genIndex < options.length ? options[ui.genIndex] : null;
}

// 照電腦版 _regenerate_gen_checklist_text / _regenerate_gen_pickup_text 的組字方式
function buildOutput() {
  const option = currentGenOption();
  if (!option) return '';
  const type = option['類型'] || 'fixed';
  if (type === 'checklist') {
    const intro = `${ui.greeting}，\n${state.settings['開頭本文'] || ''}`;
    const checked = (option['項目'] || []).filter(item => ui.checks[item] !== false);
    const listing = checked.map((item, i) => `${i + 1}. ${item}`).join('\n');
    return listing ? `${intro}\n${listing}` : intro;
  }
  if (type === 'pickup') {
    const company = selectedCompany() || {};
    const { m, d } = ui.dates.pickup;
    const dateText = `${pad(m)}/${pad(d)}`;
    return (option['內容模板'] || '')
      .replaceAll('{公司}', company['名稱'] || '')
      .replaceAll('{地址}', company['取件地址'] || '')
      .replaceAll('{日期}', dateText)
      .replaceAll('{星期}', weekdayOf(m, d));
  }
  return option['內容'] || '';
}

function renderGenerate() {
  const company = selectedCompany();
  if (!company) return companyPickerHtml();
  const options = company['選項'] || [];
  const chips = options.length
    ? `<div class="chips">${options.map((opt, i) => `
        <button class="chip${i === ui.genIndex ? ' selected' : ''}" data-action="pick-option" data-index="${i}">
          ${OPTION_TYPE_ICONS[opt['類型'] || 'fixed'] || '📄'} ${esc(opt['標題'])}
        </button>`).join('')}</div>`
    : '<p class="empty">這間公司還沒有回覆選項，到「管理」分頁新增 💝</p>';

  const option = currentGenOption();
  let highlight = '';
  if (option && option['類型'] === 'checklist') {
    highlight = `
      <div class="highlight lavender">
        <span class="field-label">開頭問候語</span>
        <div class="segmented">
          ${GREETING_OPTIONS.map(g => `<button class="${g === ui.greeting ? 'selected' : ''}" data-action="pick-greeting" data-value="${g}">${g}</button>`).join('')}
        </div>
        <span class="field-label">勾選要包含的項目</span>
        ${(option['項目'] || []).map(item => checkHtml({
          checked: ui.checks[item] !== false, change: 'toggle-check', data: { item }, label: esc(item),
        })).join('')}
      </div>`;
  } else if (option && option['類型'] === 'pickup') {
    highlight = `
      <div class="highlight mint">
        <span class="field-label">🚚 取件日期（會自動算出星期幾）</span>
        ${monthDayPickerHtml('pickup', true)}
      </div>`;
  }

  return `
    ${companyPickerHtml()}
    <p class="hint">① 選公司 🏢 → ② 點回覆選項 💌 → ③ 按複製貼給客戶 ✨</p>
    <h2 class="section-title">💌 回覆選項</h2>
    ${chips}
    ${highlight}
    ${option ? `
      <h2 class="section-title pink">📝 訊息內容（可以先改再複製）</h2>
      <div class="bubble-wrap">
        <textarea id="output" class="bubble">${esc(ui.output)}</textarea>
        <svg class="bubble-tail" viewBox="0 0 28 16" aria-hidden="true">
          <polygon points="0,0 26,0 6,16" fill="#fff" stroke="#FFD6E6" stroke-width="2"/>
          <line x1="1" y1="1" x2="25" y2="1" stroke="#fff" stroke-width="3"/>
        </svg>
      </div>` : ''}`;
}

async function copyOutput() {
  const area = $('#output');
  const text = area ? area.value : ui.output;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // 舊版 iOS 或非 HTTPS 時的備用做法
    area.select();
    document.execCommand('copy');
    area.blur();
  }
  toast('已複製好囉～吱吱 💕 可以去 LINE 貼上了');
}

// ───────────────────────── 管理 ─────────────────────────
function optionPreview(opt) {
  if (opt['類型'] === 'checklist') return (opt['項目'] || []).map((item, i) => `${i + 1}. ${item}`).join('\n');
  if (opt['類型'] === 'pickup') return opt['內容模板'] || '';
  return opt['內容'] || '';
}

function renderManage() {
  const company = selectedCompany();
  let companySection = `
    <section class="card">
      <h2 class="card-title">🏢 公司</h2>
      <button class="btn primary block" data-action="add-company">＋ 新增公司</button>
    </section>`;
  let optionSection = '';
  if (company) {
    companySection = `
      ${companyPickerHtml()}
      <div class="btn-row" style="margin-bottom:14px">
        <button class="btn" data-action="add-company">＋ 新增公司</button>
        <button class="btn" data-action="edit-company">✏️ 編輯</button>
        <button class="btn danger" data-action="delete-company" data-confirm-text="確定刪除？">刪除</button>
      </div>
      ${markHtml(company['修改標記'], 'company', '公司資料有修改')}`;
    const options = company['選項'] || [];
    optionSection = `
      <h2 class="section-title pink">💝 ${esc(companyLabel(company))} 的回覆選項</h2>
      ${options.map((opt, i) => `
        <div class="option-card">
          <h3>${OPTION_TYPE_ICONS[opt['類型'] || 'fixed'] || '📄'} ${esc(opt['標題'])}</h3>
          <span class="type-tag">${OPTION_TYPE_LABELS[opt['類型'] || 'fixed'] || ''}</span>
          <div class="preview">${esc(optionPreview(opt))}</div>
          ${markHtml(opt['修改標記'], `option:${i}`)}
          <div class="btn-row">
            <button class="btn small" data-action="edit-option" data-index="${i}">✏️ 編輯</button>
            <button class="btn small danger" data-action="delete-option" data-index="${i}">🗑️ 刪除</button>
          </div>
        </div>`).join('') || '<p class="empty">還沒有回覆選項</p>'}
      <section class="card">
        <h2 class="card-title">＋ 新增回覆選項</h2>
        <div class="btn-row" style="flex-direction:column">
          <button class="btn" data-action="add-option" data-type="fixed">📄 固定文字</button>
          <button class="btn" data-action="add-option" data-type="checklist">☑️ 可勾選清單</button>
          <button class="btn" data-action="add-option" data-type="pickup">🚚 取件提醒</button>
        </div>
      </section>`;
  }

  return `
    ${companySection}
    ${optionSection}
    <section class="card">
      <h2 class="card-title">💬 可勾選清單的開頭本文</h2>
      <p class="hint" style="margin:0 0 8px">所有公司共用，問候語在產生文字時選</p>
      <textarea id="intro-input" class="textarea" style="min-height:80px">${esc(state.settings['開頭本文'] || '')}</textarea>
      <button class="btn primary" style="margin-top:8px" data-action="save-intro">儲存開頭本文</button>
      ${markHtml(state.settings['開頭本文標記'], 'intro')}
    </section>
    <section class="card">
      <h2 class="card-title">☁️ 雲端同步</h2>
      <p class="hint" style="margin:0 0 10px">手機和電腦版用同一份雲端資料，在哪邊改另一邊都會自動更新（大約 20 秒內）。「匯出資料」可以另外留一份備份。</p>
      <div class="btn-row" style="flex-direction:column">
        <button class="btn primary" data-action="sync-now">🔄 立即同步</button>
        <button class="btn" data-action="export">📤 匯出資料（備份）</button>
        <button class="btn" data-action="change-name">👤 更改我的名字（目前：${esc(sync.name || UNNAMED)}）</button>
        <button class="btn ghost" data-action="change-key">🔑 重新輸入連線碼</button>
        <button class="btn ghost" data-action="show-disclaimer">📜 使用須知與免責聲明</button>
      </div>
    </section>`;
}

// ───────────────────────── 由下往上滑出的表單 ─────────────────────────
function openSheet({ title, body, footer, tall = false, onMount }) {
  closeSheet();
  const root = $('#sheet-root');
  root.innerHTML = `
    <div class="sheet-overlay" data-sheet-overlay>
      <div class="sheet${tall ? ' tall' : ''}" role="dialog" aria-label="${esc(title)}">
        <div class="sheet-header"><h2>${esc(title)}</h2></div>
        <div class="sheet-body">${body}</div>
        ${footer ? `<div class="sheet-footer">${footer}</div>` : ''}
      </div>
    </div>`;
  document.body.style.overflow = 'hidden';
  const overlay = root.firstElementChild;
  overlay.addEventListener('click', e => { if (e.target === overlay) closeSheet(); });
  if (onMount) onMount(overlay);
  return overlay;
}

function closeSheet() {
  $('#sheet-root').innerHTML = '';
  document.body.style.overflow = '';
}

const formFooter = '<button class="btn ghost" data-sheet-cancel>取消</button><button class="btn primary" data-sheet-save>儲存</button>';

function bindFormButtons(overlay, onSave) {
  overlay.querySelector('[data-sheet-cancel]').addEventListener('click', closeSheet);
  overlay.querySelector('[data-sheet-save]').addEventListener('click', () => {
    if (onSave() !== false) closeSheet();
  });
}

function openCompanySheet() {
  const listHtml = keyword => state.companies
    .filter(c => !keyword || (c['名稱'] || '').includes(keyword) || (c['編號'] || '').includes(keyword))
    .map(c => `
      <button class="company-option${c.id === ui.companyId ? ' selected' : ''}" data-pick-company="${esc(c.id)}">
        ${avatarHtml(c)}
        <span><b>${esc(c['名稱'])}${dotHtml(c)}</b><span class="co-sub">${esc(c['編號'] || '')}${c['取件地址'] ? '　' + esc(c['取件地址']) : ''}</span></span>
      </button>`).join('') || '<p class="empty">找不到符合的公司</p>';

  openSheet({
    title: '🏢 選一間公司',
    tall: true,
    body: `<input class="input" id="company-search" placeholder="🔍 搜尋公司名稱或編號" style="margin-bottom:10px"><div id="company-list">${listHtml('')}</div>`,
    onMount(overlay) {
      const list = overlay.querySelector('#company-list');
      overlay.querySelector('#company-search').addEventListener('input', e => {
        list.innerHTML = listHtml(e.target.value.trim());
      });
      list.addEventListener('click', e => {
        const btn = e.target.closest('[data-pick-company]');
        if (!btn) return;
        if (ui.companyId !== btn.dataset.pickCompany) {
          ui.companyId = btn.dataset.pickCompany;
          ui.genIndex = null;
          ui.output = '';
        }
        closeSheet();
        render();
        window.scrollTo(0, 0);
      });
    },
  });
}

function openCompanyForm(existing) {
  openSheet({
    title: existing ? '編輯公司' : '新增公司',
    footer: formFooter,
    body: `
      <label class="field-label" for="f-code">編號（可留空）</label>
      <input id="f-code" class="input" value="${esc(existing?.['編號'] || '')}" inputmode="numeric">
      <label class="field-label" for="f-name">公司名稱</label>
      <input id="f-name" class="input" value="${esc(existing?.['名稱'] || '')}">
      <label class="field-label" for="f-addr">取件地址（可留空，取件提醒的 {地址} 會用到）</label>
      <input id="f-addr" class="input" value="${esc(existing?.['取件地址'] || '')}">`,
    onMount(overlay) {
      bindFormButtons(overlay, () => {
        const code = $('#f-code').value.trim();
        const name = $('#f-name').value.trim();
        const address = $('#f-addr').value.trim();
        if (!name) { toast('請輸入公司名稱'); return false; }
        if (existing) {
          Object.assign(existing, { '編號': code, '名稱': name, '取件地址': address, '修改標記': newMark() });
        } else {
          const company = { id: uid(), '編號': code, '名稱': name, '取件地址': address, '選項': [], '修改標記': newMark() };
          state.companies.push(company);
          ui.companyId = company.id;
          ui.genIndex = null;
        }
        save();
        render();
        toast('已儲存好囉～吱吱 🐹');
      });
    },
  });
}

// 可勾選清單／月度待辦共用的「項目清單」編輯區
function itemEditorHtml(placeholder) {
  return `
    <div id="item-list"></div>
    <div class="input-row" style="margin-top:8px">
      <input id="item-input" class="input" placeholder="${esc(placeholder)}" enterkeyhint="done">
      <button class="btn" id="item-add">新增</button>
    </div>`;
}

function bindItemEditor(overlay, items) {
  const list = overlay.querySelector('#item-list');
  const input = overlay.querySelector('#item-input');
  const draw = () => {
    list.innerHTML = items.length
      ? items.map((item, i) => `
          <div class="list-row">
            <span class="label" style="flex:1;min-width:0;word-break:break-word">${i + 1}. ${esc(item)}</span>
            <button class="btn small" data-move="${i}" ${i === 0 ? 'disabled style="opacity:.35"' : ''} aria-label="往上移">↑</button>
            <button class="btn small danger" data-remove="${i}">刪除</button>
          </div>`).join('')
      : '<p class="empty">還沒有項目</p>';
  };
  const add = () => {
    const value = input.value.trim();
    if (!value) return;
    if (items.includes(value)) { toast('這個項目已經存在囉'); return; }
    items.push(value);
    input.value = '';
    draw();
  };
  overlay.querySelector('#item-add').addEventListener('click', add);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  list.addEventListener('click', e => {
    const remove = e.target.closest('[data-remove]');
    const move = e.target.closest('[data-move]');
    if (remove) items.splice(+remove.dataset.remove, 1);
    if (move && +move.dataset.move > 0) {
      const i = +move.dataset.move;
      [items[i - 1], items[i]] = [items[i], items[i - 1]];
    }
    if (remove || move) draw();
  });
  draw();
}

function openOptionForm(company, type, index) {
  const existing = index !== undefined ? company['選項'][index] : null;
  const titleText = `${existing ? '編輯' : '新增'}${OPTION_TYPE_LABELS[type]}選項`;
  const titleField = `
    <label class="field-label" for="f-title">選項標題</label>
    <input id="f-title" class="input" value="${esc(existing?.['標題'] || '')}" placeholder="例如：營業稅補件">`;
  const commit = option => {
    option['修改標記'] = newMark();
    if (existing) company['選項'][index] = option;
    else (company['選項'] = company['選項'] || []).push(option);
    save();
    render();
    toast('已儲存好囉～吱吱 🐹');
  };
  const readTitle = () => {
    const title = $('#f-title').value.trim();
    if (!title) toast('請輸入選項標題');
    return title;
  };

  if (type === 'checklist') {
    const items = [...(existing?.['項目'] || [])];
    openSheet({
      title: titleText, tall: true, footer: formFooter,
      body: `
        ${titleField}
        <label class="field-label">開頭本文（所有公司共用，僅供參考，到管理頁下方修改）</label>
        <div class="notice" style="background:var(--lavender);white-space:pre-wrap">${esc(state.settings['開頭本文'] || '')}</div>
        <label class="field-label">這間公司的可勾選項目</label>
        ${itemEditorHtml('例如：電子發票媒體檔')}`,
      onMount(overlay) {
        bindItemEditor(overlay, items);
        bindFormButtons(overlay, () => {
          const title = readTitle();
          if (!title) return false;
          commit({ '標題': title, '類型': 'checklist', '項目': items });
        });
      },
    });
    return;
  }

  const isPickup = type === 'pickup';
  const contentKey = isPickup ? '內容模板' : '內容';
  openSheet({
    title: titleText, tall: true, footer: formFooter,
    body: `
      ${titleField}
      <label class="field-label" for="f-content">${isPickup ? '內容模板' : '內容'}</label>
      <textarea id="f-content" class="textarea" style="min-height:200px">${esc(existing?.[contentKey] || '')}</textarea>
      ${isPickup ? `
        <p class="hint" style="margin:6px 0 0">點下面的按鈕可以插入變數：{地址} 是公司資料裡的取件地址，{星期} 會依產生文字時選的日期自動算出</p>
        <div class="var-buttons">${PICKUP_VARS.map(v => `<button class="btn small" data-insert="${v}">${v}</button>`).join('')}</div>` : ''}`,
    onMount(overlay) {
      const area = overlay.querySelector('#f-content');
      overlay.querySelectorAll('[data-insert]').forEach(btn => {
        // 用 pointerdown + preventDefault，點按鈕時文字框才不會失去游標位置、鍵盤也不會收起來
        btn.addEventListener('pointerdown', e => e.preventDefault());
        btn.addEventListener('click', () => {
          const start = area.selectionStart ?? area.value.length;
          const end = area.selectionEnd ?? area.value.length;
          area.setRangeText(btn.dataset.insert, start, end, 'end');
          area.focus();
        });
      });
      bindFormButtons(overlay, () => {
        const title = readTitle();
        if (!title) return false;
        commit({ '標題': title, '類型': type, [contentKey]: area.value });
      });
    },
  });
}

function openMonthlyTasksForm(company) {
  const items = [...(company['月度待辦'] || [])];
  openSheet({
    title: `管理月度待辦項目－${companyLabel(company)}`,
    tall: true,
    footer: formFooter,
    body: `<p class="hint" style="margin:0 0 10px">每個月都要做的事，進度會按月份分開記錄</p>${itemEditorHtml('例如：營業稅申報')}`,
    onMount(overlay) {
      bindItemEditor(overlay, items);
      bindFormButtons(overlay, () => {
        if (stableStringify(items) !== stableStringify(company['月度待辦'] || [])) company['月度待辦標記'] = newMark();
        company['月度待辦'] = items;
        save();
        render();
      });
    },
  });
}

function openReminderSheet(items) {
  const section = (title, lines, color) => lines.length
    ? `<div class="reminder-section"><h3 style="color:${color}">${title}</h3><ul>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>`
    : '';
  const deadlineText = d => {
    const days = d['剩餘天數'];
    const when = days < 0 ? `已逾期 ${-days} 天` : days === 0 ? '今天到期' : `${days} 天後到期`;
    return `${d['公司']}－${d['標題']}（${when}）`;
  };
  openSheet({
    title: '🐹 焙子的今日提醒',
    footer: '<button class="btn primary" data-sheet-cancel>知道了</button>',
    body: `<div class="reminder-art">${$('.logo').outerHTML}<b>焙子陪你一起加油～ 🌻</b></div>`
      + section('📅 今日待辦', items.todos.map(t => t['內容'] || ''), 'var(--blue-text)')
      + section('⏰ 即將到期的截止日期', items.deadlines.map(deadlineText), 'var(--danger-dark)')
      + section('📋 本月還沒完成的事項', items.monthly.map(m => `${m['公司']}－${m['項目']}`), '#E5668E'),
    onMount(overlay) {
      overlay.querySelector('[data-sheet-cancel]').addEventListener('click', closeSheet);
    },
  });
}

function maybeShowReminder() {
  const today = todayIso();
  // 還在輸入連線碼／名字的畫面時先不跳，設定好之後再跳
  if (state.reminderShownDate === today || !sync.key || !sync.name || !hasAgreed()) return;
  const items = collectReminderItems();
  if (items.todos.length || items.deadlines.length || items.monthly.length) openReminderSheet(items);
  state.reminderShownDate = today;
  saveLocal(); // 「今天跳過提醒了」是每支裝置自己的狀態，不用上傳
}

async function exportData() {
  const files = [
    ['companies.json', state.companies],
    ['settings.json', state.settings],
    ['daily_todos.json', state.todos],
  ].map(([name, data]) => new File([JSON.stringify(data, null, 2)], name, { type: 'application/json' }));
  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files, title: '小助手阿焙焙資料' });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  // 不支援分享檔案時，改成顯示文字讓她自己複製
  openSheet({
    title: '📤 匯出資料',
    tall: true,
    footer: '<button class="btn ghost" data-sheet-cancel>關閉</button><button class="btn primary" id="export-copy">複製</button>',
    body: `<p class="hint" style="margin:0 0 8px">這是 companies.json 的內容，複製後傳到電腦存成檔案即可</p>
      <textarea id="export-text" class="textarea" style="min-height:50vh;font-size:13px" readonly>${esc(JSON.stringify(state.companies, null, 2))}</textarea>`,
    onMount(overlay) {
      overlay.querySelector('[data-sheet-cancel]').addEventListener('click', closeSheet);
      overlay.querySelector('#export-copy').addEventListener('click', async () => {
        const area = overlay.querySelector('#export-text');
        try { await navigator.clipboard.writeText(area.value); } catch (e) { area.select(); document.execCommand('copy'); }
        toast('已複製 ✨');
      });
    },
  });
}

// ───────────────────────── 事件 ─────────────────────────
const actions = {
  'open-company-sheet': openCompanySheet,

  'add-todo'() {
    const input = $('#todo-input');
    const content = input.value.trim();
    if (!content) { toast('請輸入待辦內容'); input.focus(); return; }
    input.value = '';
    state.todos.push({ id: uid(), '日期': pickedIso('todo'), '內容': content, '完成': false, '修改標記': newMark() });
    save();
    render();
    toast('已新增～吱吱 🐹');
  },
  'delete-todo'(el) {
    confirmTwice(el, `todo-${el.dataset.id}`, () => {
      state.todos = state.todos.filter(t => t.id !== el.dataset.id);
      save();
      render();
    });
  },

  'cal-shift'(el) {
    const index = ui.cal.y * 12 + ui.cal.m - 1 + +el.dataset.delta;
    ui.cal.y = Math.floor(index / 12);
    ui.cal.m = index % 12 + 1;
    render();
  },
  'cal-today'() {
    const d = new Date();
    ui.cal = { y: d.getFullYear(), m: d.getMonth() + 1, day: isoDate(d) };
    render();
  },
  'cal-pick'(el) {
    const d = parseIso(el.dataset.date);
    ui.cal = { y: d.getFullYear(), m: d.getMonth() + 1, day: el.dataset.date };
    render();
  },
  'add-cal-todo'() {
    const input = $('#cal-input');
    const content = input.value.trim();
    if (!content) { toast('請輸入待辦內容'); input.focus(); return; }
    input.value = '';
    state.todos.push({ id: uid(), '日期': ui.cal.day, '內容': content, '完成': false, '修改標記': newMark() });
    save();
    render();
    toast('已新增～吱吱 🐹');
  },

  'manage-monthly'() { openMonthlyTasksForm(selectedCompany()); },
  'add-deadline'() {
    const input = $('#deadline-input');
    const title = input.value.trim();
    if (!title) { toast('請輸入截止日期的標題'); input.focus(); return; }
    const company = selectedCompany();
    input.value = '';
    (company['截止日期'] = company['截止日期'] || []).push({ id: uid(), '標題': title, '日期': pickedIso('deadline'), '完成': false, '修改標記': newMark() });
    save();
    render();
  },
  'delete-deadline'(el) {
    confirmTwice(el, `deadline-${el.dataset.id}`, () => {
      const company = selectedCompany();
      company['截止日期'] = (company['截止日期'] || []).filter(d => d.id !== el.dataset.id);
      save();
      render();
    });
  },
  'add-log'() {
    const input = $('#log-input');
    const content = input.value.trim();
    if (!content) { input.focus(); return; }
    const company = selectedCompany();
    const d = new Date();
    const time = `${isoDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    input.value = '';
    (company['催件紀錄'] = company['催件紀錄'] || []).unshift({ id: uid(), '時間': time, '內容': content, '修改標記': newMark() });
    save();
    render();
  },
  'delete-log'(el) {
    confirmTwice(el, `log-${el.dataset.id}`, () => {
      const company = selectedCompany();
      company['催件紀錄'] = (company['催件紀錄'] || []).filter(l => l.id !== el.dataset.id);
      save();
      render();
    });
  },

  'pick-option'(el) {
    ui.genIndex = +el.dataset.index;
    ui.checks = {};
    ui.output = buildOutput();
    render();
  },
  'pick-greeting'(el) {
    ui.greeting = el.dataset.value;
    ui.output = buildOutput();
    render();
  },
  copy: copyOutput,

  'add-company'() { openCompanyForm(null); },
  'edit-company'() { openCompanyForm(selectedCompany()); },
  'delete-company'(el) {
    const company = selectedCompany();
    confirmTwice(el, `company-${company.id}`, () => {
      state.companies = state.companies.filter(c => c.id !== company.id);
      ui.companyId = state.companies[0]?.id || null;
      ui.genIndex = null;
      save();
      render();
      toast(`已刪除「${company['名稱']}」`);
    });
  },
  'add-option'(el) { openOptionForm(selectedCompany(), el.dataset.type); },
  'edit-option'(el) {
    const company = selectedCompany();
    const index = +el.dataset.index;
    openOptionForm(company, company['選項'][index]['類型'] || 'fixed', index);
  },
  'delete-option'(el) {
    const company = selectedCompany();
    const index = +el.dataset.index;
    confirmTwice(el, `option-${company.id}-${index}`, () => {
      company['選項'].splice(index, 1);
      if (ui.genIndex !== null && ui.genIndex >= index) { ui.genIndex = null; ui.output = ''; }
      save();
      render();
    });
  },
  'save-intro'() {
    const text = $('#intro-input').value;
    if (text !== (state.settings['開頭本文'] || '')) state.settings['開頭本文標記'] = newMark();
    state.settings['開頭本文'] = text;
    save();
    render();
    toast('已儲存好囉～吱吱 🐹');
  },
  export: exportData,
  async 'sync-now'() {
    if (sync.pending) pushToCloud();
    else await pullFromCloud();
    toast(syncRun.status === 'offline' ? '連不上雲端，請檢查網路' : '已同步 ✨');
  },
  'change-key'(el) {
    confirmTwice(el, 'change-key', () => {
      ui.setup = true;
      render();
    });
  },
  'cancel-setup'() {
    ui.setup = false;
    ui.nameSetup = false;
    render();
  },
  'change-name'() {
    ui.nameSetup = true;
    render();
  },
  'save-name'() {
    const name = readNameInput();
    if (!name) return;
    sync.name = name;
    ui.nameSetup = false;
    saveLocal();
    render();
    toast(`嗨 ${name} 💕`);
    maybeShowReminder();
  },
  async 'connect'() {
    const key = $('#key-input').value.trim();
    if (!key) { toast('請貼上連線碼'); return; }
    const name = readNameInput();
    if (!name) return;
    if (await connectWithKey(key, name, $('[data-action=connect]'))) toast('連線成功 💕');
  },

  // ── 第一次開啟：介紹 → 使用須知與免責聲明 → 暱稱（＋連線碼）──
  'welcome-go'(el) {
    ui.welcomeStep = +el.dataset.step;
    render();
    window.scrollTo(0, 0);
  },
  'welcome-decline'() {
    toast('需要同意使用須知，才能開始使用喔', 2600);
  },
  async 'welcome-finish'() {
    const name = readNameInput();
    if (!name) return;
    const agreed = { version: DISCLAIMER_VERSION, time: nowText(), name };
    if (!sync.key) {
      const key = $('#key-input').value.trim();
      if (!key) { toast('請貼上連線碼'); return; }
      if (!(await connectWithKey(key, name, $('[data-action=welcome-finish]'), agreed))) return;
    } else {
      Object.assign(sync, { name, agreed });
      saveLocal();
      render();
    }
    toast(`嗨 ${name}～歡迎使用小助手阿焙焙 🐹`, 2600);
    maybeShowReminder();
  },
  'show-disclaimer'() {
    const agreed = sync.agreed;
    openSheet({
      title: '📜 使用須知與免責聲明',
      tall: true,
      footer: '<button class="btn primary" data-sheet-cancel>關閉</button>',
      body: `<div class="disclaimer">${esc(DISCLAIMER_TEXT)}</div>
        ${agreed ? `<p class="hint" style="margin:12px 0 0">${esc(agreed.name)} 在 ${esc(agreed.time)} 同意了第 ${agreed.version} 版</p>` : ''}`,
      onMount(overlay) {
        overlay.querySelector('[data-sheet-cancel]').addEventListener('click', closeSheet);
      },
    });
  },
};

const changes = {
  date(el) {
    const slot = ui.dates[el.dataset.key];
    slot[el.dataset.part] = +el.value;
    // 跟電腦版 MonthDayPicker 一樣：換月份後日期超過該月天數就夾到月底
    slot.d = Math.min(slot.d, daysInMonth(new Date().getFullYear(), slot.m));
    // 只重畫這組下拉選單，不整頁重畫，旁邊輸入框已經打好的字才不會不見
    const picker = el.closest('.md-picker');
    picker.outerHTML = monthDayPickerHtml(el.dataset.key, !!picker.querySelector('.weekday'));
    if (el.dataset.key === 'pickup') {
      ui.output = buildOutput();
      const area = $('#output');
      if (area) area.value = ui.output;
    }
  },
  'toggle-todo'(el) {
    const todo = state.todos.find(t => t.id === el.dataset.id);
    if (todo) Object.assign(todo, { '完成': el.checked, '修改標記': newMark() });
    save();
    render();
    if (el.checked) cheer();
  },
  'toggle-monthly'(el) {
    const company = selectedCompany();
    const task = (company['月度待辦'] || [])[+el.dataset.index];
    const monthKey = currentMonthKey();
    company['月度進度'] = company['月度進度'] || {};
    company['月度進度'][monthKey] = company['月度進度'][monthKey] || {};
    company['月度進度'][monthKey][task] = el.checked;
    company['月度進度標記'] = company['月度進度標記'] || {};
    company['月度進度標記'][monthKey] = company['月度進度標記'][monthKey] || {};
    company['月度進度標記'][monthKey][task] = newMark();
    save();
    render();
    if (el.checked) cheer();
  },
  'toggle-deadline'(el) {
    const company = el.dataset.company ? findCompany(el.dataset.company) : selectedCompany();
    const deadline = (company['截止日期'] || []).find(d => d.id === el.dataset.id);
    if (deadline) Object.assign(deadline, { '完成': el.checked, '修改標記': newMark() });
    save();
    render();
    if (el.checked) cheer();
  },
  'ack-mark'(el) {
    const [holder, key] = resolveMarkRef(el.dataset.ref);
    if (holder && key) delete holder[key];
    save();
    render();
  },
  'agree-item'(el) {
    ui.agreeChecks[+el.dataset.index] = el.checked;
    // 不整頁重畫（聲明框捲到哪裡要留著），只更新同意鈕能不能按
    $('[data-action=welcome-go][data-step="3"]').disabled = !ui.agreeChecks.every(Boolean);
  },
  'toggle-check'(el) {
    ui.checks[el.dataset.item] = el.checked;
    ui.output = buildOutput();
    const area = $('#output');
    if (area) area.value = ui.output;
  },
};

document.addEventListener('click', e => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) {
    if (ui.tab !== tabBtn.dataset.tab) {
      ui.tab = tabBtn.dataset.tab;
      render();
      window.scrollTo(0, 0);
    }
    return;
  }
  const el = e.target.closest('[data-action]');
  if (el && actions[el.dataset.action]) actions[el.dataset.action](el, e);
});

document.addEventListener('change', e => {
  const el = e.target.closest('[data-change]');
  if (el && changes[el.dataset.change]) changes[el.dataset.change](el, e);
});

document.addEventListener('input', e => {
  if (e.target.id === 'output') ui.output = e.target.value;
});

document.addEventListener('keydown', e => {
  const el = e.target.closest?.('[data-enter]');
  if (el && e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    actions[el.dataset.enter]?.(el, e);
  }
});

// ───────────────────────── 繪製 ─────────────────────────
const TAB_SUBTITLES = {
  todo: '今天也辛苦了～焙子陪你 🐹',
  calendar: '這個月有什麼事 📆',
  progress: '看看每間公司的進度 📊',
  generate: '挑一間公司開始吧 💌',
  manage: '公司與回覆選項 ⚙️',
};

function readNameInput() {
  const input = $('#name-input');
  const name = input.value.trim().slice(0, 12);
  if (!name) { toast('請輸入你的暱稱'); input.focus(); }
  return name;
}

// 用連線碼連上雲端；成功就記下連線碼、暱稱（agreed 有給就一起記同意紀錄），回傳 true
async function connectWithKey(key, name, button, agreed = sync.agreed) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '連線中…';
  try {
    const result = await cloudRequest(undefined, key);
    sync = { key, rev: 0, pending: false, offlineEdits: false, sent: [], name, agreed };
    ui.setup = false;
    if (result.data) applyRemote(result);
    else { saveLocal(); render(); }
    maybeShowReminder();
    return true;
  } catch (e) {
    button.disabled = false;
    button.textContent = label;
    toast(e.message === 'unauthorized' ? '連線碼不對，請再確認一次' : '連不上雲端，請檢查網路', 3000);
    return false;
  }
}

function nowText() {
  const d = new Date();
  return `${isoDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ───────────────────────── 第一次開啟：介紹＋免責聲明＋暱稱 ─────────────────────────
// 文字跟電腦版 bookkeeping_reply_helper.py 的 WELCOME_INTRO／DISCLAIMER_TEXT／AGREE_ITEMS 一模一樣，改的時候兩邊一起改。
// 聲明內容有大改時把版本號加 1，所有裝置都會再看到一次、重新同意。
const DISCLAIMER_VERSION = 1;
const WELCOME_INTRO = [
  ['每日待辦', '記下今天要做的事，開機時提醒你'],
  ['行事曆', '待辦和各公司的截止日期排在月曆上，過完的日子會蓋上焙子印章'],
  ['客戶進度', '每間公司每個月的待辦、截止日期和催件紀錄'],
  ['產生文字', '一鍵產生要傳給客戶的 LINE 訊息'],
  ['手機、電腦自動同步', '在哪邊改，另一邊都會更新，誰改的也看得到'],
];
const DISCLAIMER_TEXT = `一、本程式的性質
本程式「小助手阿焙焙」是協助整理記帳事務工作的輔助工具，所產生的訊息內容、待辦提醒及截止日期，僅供使用者參考，不構成會計、稅務或法律上的專業意見。

二、使用者的確認責任
稅務申報期限、應備文件及金額等資訊，請以財政部、國稅局等主管機關公告及委任合約為準。使用者在傳送訊息給客戶或辦理申報前，應自行確認內容正確。

三、資料的儲存與同步
為了在手機與電腦之間同步，資料會存放在使用者裝置上，以及本程式建置者設定的 Google 雲端硬碟中。連線碼等同於雲端資料的鑰匙，請勿提供給他人。

四、個人資料保護
程式中記錄的客戶資料可能包含個人資料。使用者應依《個人資料保護法》，在執行業務的必要範圍內蒐集、處理及利用這些資料，並妥善保管使用中的裝置。

五、責任限制
本程式以「現況」提供。因網路中斷、裝置故障、操作錯誤或其他不可預期的原因，造成資料遺失、提醒未送出、內容錯誤或延誤，本程式建置者不負損害賠償責任。建議定期使用「匯出資料」功能備份。

六、條款更新
本聲明更新時，程式會再次請你閱讀並同意。`;
const AGREE_ITEMS = [
  '我了解本程式是輔助工具，產生的訊息、提醒與截止日期需要自己再確認',
  '我了解資料會存放在裝置與雲端以便同步，並會妥善保管連線碼',
  '我會依《個人資料保護法》妥善使用客戶資料',
  '我已閱讀並同意上述使用須知與免責聲明',
];

function hasAgreed() { return !!(sync.agreed && sync.agreed.version >= DISCLAIMER_VERSION); }

function renderWelcome() {
  const step = ui.welcomeStep;
  const pills = ['歡迎', '使用須知', '設定暱稱']
    .map((t, i) => `<span class="step-pill${i + 1 === step ? ' current' : ''}">${i + 1} ${t}</span>`).join('<span class="step-line">─</span>');
  let body = '';
  if (step === 1) {
    body = `
      <section class="card welcome-card">
        <img class="welcome-avatar" src="art/avatar.png" alt="">
        <h2 class="welcome-title">嗨～我是小助手阿焙焙</h2>
        <p class="welcome-lead">我會陪你處理記帳事務所的日常工作：</p>
        <ul class="welcome-list">${WELCOME_INTRO.map(([t, d]) => `<li><b>${t}</b>${d}</li>`).join('')}</ul>
      </section>
      <button class="btn primary block" data-action="welcome-go" data-step="2">下一步</button>`;
  } else if (step === 2) {
    const all = ui.agreeChecks.every(Boolean);
    body = `
      <section class="card">
        <h2 class="card-title">📜 使用須知與免責聲明</h2>
        <div class="disclaimer scroll">${esc(DISCLAIMER_TEXT)}</div>
        <div class="agree-list">${AGREE_ITEMS.map((t, i) => checkHtml({
          checked: ui.agreeChecks[i], change: 'agree-item', data: { index: i }, label: esc(t),
        })).join('')}</div>
      </section>
      <button class="btn primary block" data-action="welcome-go" data-step="3"${all ? '' : ' disabled'}>我同意，下一步</button>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn" data-action="welcome-go" data-step="1">上一步</button>
        <button class="btn ghost" data-action="welcome-decline">不同意</button>
      </div>`;
  } else {
    body = `
      <section class="card">
        <h2 class="card-title">👤 設定你的暱稱</h2>
        ${nameFieldHtml('welcome-finish')}
        ${sync.key ? '' : `
          <label class="field-label" for="key-input" style="margin-top:14px">連線碼</label>
          <input id="key-input" class="input" placeholder="貼上連線碼" autocomplete="off" autocapitalize="off" spellcheck="false">
          <p class="hint" style="margin:6px 0 0">貼上之後，手機就會跟電腦版的資料連在一起。只要輸入一次，之後會記在這支手機裡。</p>`}
      </section>
      <button class="btn primary block" data-action="welcome-finish">開始使用</button>
      <button class="btn block" style="margin-top:8px" data-action="welcome-go" data-step="2">上一步</button>`;
  }
  return `<div class="step-pills">${pills}</div>${body}`;
}

function nameFieldHtml(enter) {
  return `
      <label class="field-label" for="name-input">你的暱稱</label>
      <input id="name-input" class="input" placeholder="例如：小美" value="${esc(sync.name)}" maxlength="12" data-enter="${enter}">
      <p class="hint" style="margin:6px 0 0">改東西時會標記是誰改的，讓對方知道。你的手機和電腦用同一個暱稱就好～</p>`;
}

function renderSetup() {
  if (sync.key && !ui.setup) {
    return `
    <section class="card">
      <h2 class="card-title">👤 設定你的暱稱</h2>
      ${nameFieldHtml('save-name')}
      <button class="btn primary block" style="margin-top:12px" data-action="save-name">儲存</button>
      ${sync.name ? '<button class="btn ghost block" style="margin-top:8px" data-action="cancel-setup">取消</button>' : ''}
    </section>`;
  }
  return `
    <section class="card">
      <h2 class="card-title">🔑 第一次使用</h2>
      <p style="margin:0 0 12px">請貼上連線碼，手機就會跟電腦版的資料連在一起。連線碼只要輸入一次，之後會記在這支手機裡。</p>
      <input id="key-input" class="input" placeholder="貼上連線碼" autocomplete="off" autocapitalize="off" spellcheck="false">
      ${nameFieldHtml('connect')}
      <button class="btn primary block" style="margin-top:12px" data-action="connect">連線</button>
      ${sync.key ? '<button class="btn ghost block" style="margin-top:8px" data-action="cancel-setup">取消</button>' : ''}
    </section>`;
}

function render() {
  const view = $('#view');
  const renderers = { todo: renderTodo, calendar: renderCalendar, progress: renderProgress, generate: renderGenerate, manage: renderManage };
  // 整頁重畫時保留還沒送出的輸入框內容和游標所在的欄位（例如打到一半，雲端剛好同步進來）
  const drafts = {};
  view.querySelectorAll('input.input[id]').forEach(el => { drafts[el.id] = el.value; });
  const focusedId = document.activeElement && view.contains(document.activeElement) ? document.activeElement.id : '';
  if (focusedId === 'intro-input') drafts[focusedId] = document.activeElement.value;
  // 第一次開啟（或聲明改版）先跑歡迎流程；同意過但還沒連線碼／暱稱，才是原本的設定畫面
  const welcome = !hasAgreed();
  const setup = welcome || !sync.key || ui.setup || ui.nameSetup || !sync.name;
  view.innerHTML = welcome ? renderWelcome() : setup ? renderSetup() : renderers[ui.tab]();
  document.querySelector('.tabbar').hidden = setup;
  Object.entries(drafts).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
  });
  if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
  const showCopy = !setup && ui.tab === 'generate' && currentGenOption();
  view.classList.toggle('has-copybar', !!showCopy);
  let bar = $('.copybar');
  if (showCopy && !bar) {
    bar = document.createElement('div');
    bar.className = 'copybar';
    bar.innerHTML = '<button class="btn primary" data-action="copy">💗 複製</button>';
    document.body.appendChild(bar);
  } else if (!showCopy && bar) {
    bar.remove();
  }
  document.querySelectorAll('.tabbar [data-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === ui.tab);
  });
  $('#topbar-sub').textContent = TAB_SUBTITLES[ui.tab];
}

render();

// 打開時先抓雲端最新資料再決定要不要跳今日提醒；之後每 20 秒、以及從背景切回來時再抓
if (sync.key) {
  setSyncStatus(sync.pending ? 'offline' : 'busy', sync.pending ? '⚠️ 稍後上傳' : '同步中…');
  pullFromCloud().finally(() => setTimeout(maybeShowReminder, 300));
}
setInterval(() => { if (document.visibilityState === 'visible') pullFromCloud(); }, SYNC_POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') pullFromCloud(3000);
});
window.addEventListener('online', () => pullFromCloud());
window.addEventListener('pagehide', () => { syncRun.unloading = true; });
window.addEventListener('pageshow', () => { syncRun.unloading = false; });
