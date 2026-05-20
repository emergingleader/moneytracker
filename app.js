// ─────────────────────────────────────────────────────────────
// NETWORTH TRACKER — app.js
// Replace YOUR_SUPABASE_URL and YOUR_SUPABASE_ANON_KEY below
// with your actual values from Supabase → Project Settings → API
// ─────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://wqvqkkwnppeetnrqxiil.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndxdnFra3ducHBlZXRucnF4aWlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyOTMyMTksImV4cCI6MjA5NDg2OTIxOX0.ulDI4MV5YZyeTOfb4B33FVgKVNYjri-nlcNRUtIilB8';

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── STATE ───────────────────────────────────────────────────
let currentUser = null;
let assets = [], liabilities = [], incomes = [], expenses = [];
let nwChart = null, ieChart = null, allocChart = null;
let syncTimeout = null;

// ─── INIT ────────────────────────────────────────────────────
let booting = false; // guard against double boot

window.addEventListener('DOMContentLoaded', () => {
  showScreen('loading');

  db.auth.onAuthStateChange(async (event, session) => {
    if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session) {
      if (booting) return; // prevent double boot
      booting = true;
      await bootApp(session.user);
      booting = false;
    } else if (event === 'SIGNED_OUT' || (event === 'INITIAL_SESSION' && !session)) {
      currentUser = null;
      assets = []; liabilities = []; incomes = []; expenses = [];
      showScreen('auth');
    }
  });

  // Hard fallback — if still on loading screen after 8 seconds, go to auth
  setTimeout(() => {
    if (document.getElementById('loading-screen').style.display !== 'none') {
      showScreen('auth');
    }
  }, 8000);
});

async function bootApp(user) {
  currentUser = user;
  showScreen('loading');

  // Load data with a 7-second timeout so we never hang forever
  try {
    await Promise.race([
      loadAllData(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('data timeout')), 7000))
    ]);
  } catch (e) {
    console.warn('Data load timed out or failed — proceeding with empty state:', e.message);
    assets = []; liabilities = []; incomes = []; expenses = [];
  }

  setupUser(user);
  showScreen('app');
  renderAll();
}

function showScreen(name) {
  document.getElementById('loading-screen').style.display = name === 'loading' ? 'flex' : 'none';
  document.getElementById('auth-screen').style.display = name === 'auth' ? 'flex' : 'none';
  document.getElementById('app-screen').style.display = name === 'app' ? 'block' : 'none';
}

function setupUser(user) {
  const initials = (user.user_metadata?.full_name || user.email || '?')
    .split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  document.getElementById('user-avatar').textContent = initials;
  document.getElementById('user-menu-email').textContent = user.email;
}

// ─── AUTH TABS ───────────────────────────────────────────────
function setAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((b, i) =>
    b.classList.toggle('active', ['signin', 'signup'][i] === tab)
  );
  document.getElementById('auth-signin').style.display = tab === 'signin' ? 'block' : 'none';
  document.getElementById('auth-signup').style.display = tab === 'signup' ? 'block' : 'none';
  clearAuthMsg();
}

function showAuthMsg(msg, type = 'error') {
  const el = document.getElementById('auth-msg');
  el.textContent = msg;
  el.className = 'auth-msg ' + type;
  el.style.display = 'block';
}
function clearAuthMsg() {
  document.getElementById('auth-msg').style.display = 'none';
}

// ─── SIGN IN ─────────────────────────────────────────────────
async function signIn() {
  const email = document.getElementById('si-email').value.trim();
  const password = document.getElementById('si-pass').value;
  if (!email || !password) { showAuthMsg('Please enter your email and password.'); return; }
  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) showAuthMsg(error.message);
}

async function signUp() {
  const name = document.getElementById('su-name').value.trim();
  const email = document.getElementById('su-email').value.trim();
  const password = document.getElementById('su-pass').value;
  if (!name || !email || !password) { showAuthMsg('Please fill in all fields.'); return; }
  if (password.length < 8) { showAuthMsg('Password must be at least 8 characters.'); return; }
  const { error } = await db.auth.signUp({
    email, password,
    options: { data: { full_name: name } }
  });
  if (error) { showAuthMsg(error.message); return; }
  showAuthMsg('Account created! Check your email to confirm, then sign in.', 'success');
}

async function signInGoogle() {
  const { error } = await db.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  });
  if (error) showAuthMsg(error.message);
}

async function resetPassword() {
  const email = document.getElementById('si-email').value.trim();
  if (!email) { showAuthMsg('Enter your email address above first.', 'info'); return; }
  const { error } = await db.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin
  });
  if (error) { showAuthMsg(error.message); return; }
  showAuthMsg('Password reset email sent. Check your inbox.', 'success');
}

async function signOut() {
  toggleUserMenu(true);
  await db.auth.signOut();
}

function toggleUserMenu(forceClose = false) {
  const menu = document.getElementById('user-menu');
  if (forceClose) { menu.classList.remove('open'); return; }
  menu.classList.toggle('open');
}
document.addEventListener('click', e => {
  if (!document.getElementById('user-avatar')?.contains(e.target)) {
    document.getElementById('user-menu')?.classList.remove('open');
  }
});

// ─── SUPABASE DATA LAYER ─────────────────────────────────────
// All data lives in one table: finance_entries
// Columns: id (uuid), user_id, type (asset/liability/income/expense), payload (jsonb)

async function loadAllData() {
  const { data, error } = await db
    .from('finance_entries')
    .select('*')
    .eq('user_id', currentUser.id);

  if (error) { console.error('Load error:', error); return; }

  assets = []; liabilities = []; incomes = []; expenses = [];
  (data || []).forEach(row => {
    const item = { ...row.payload, _db_id: row.id };
    if (row.type === 'asset') assets.push(item);
    else if (row.type === 'liability') liabilities.push(item);
    else if (row.type === 'income') incomes.push(item);
    else if (row.type === 'expense') expenses.push(item);
  });
}

async function saveItem(type, item) {
  const { data, error } = await db
    .from('finance_entries')
    .insert({ user_id: currentUser.id, type, payload: item })
    .select()
    .single();
  if (error) { console.error('Save error:', error); return null; }
  return data.id;
}

async function deleteItem(dbId) {
  const { error } = await db
    .from('finance_entries')
    .delete()
    .eq('id', dbId)
    .eq('user_id', currentUser.id);
  if (error) { console.error('Delete error:', error); }
}

// ─── ADD ITEMS ───────────────────────────────────────────────
async function addItem(type) {
  let item;
  if (type === 'asset') {
    const n = document.getElementById('a-name').value.trim();
    const v = parseFloat(document.getElementById('a-val').value) || 0;
    if (!n || v <= 0) { alert('Please enter a name and a value greater than 0.'); return; }
    item = { id: Date.now(), name: n, cat: document.getElementById('a-cat').value, val: v, liq: document.getElementById('a-liq').value === '1' };
    ['a-name', 'a-val'].forEach(id => document.getElementById(id).value = '');
  } else if (type === 'liability') {
    const n = document.getElementById('l-name').value.trim();
    const b = parseFloat(document.getElementById('l-bal').value) || 0;
    if (!n || b <= 0) { alert('Please enter a name and a balance greater than 0.'); return; }
    item = { id: Date.now(), name: n, type: document.getElementById('l-type').value, bal: b, pay: parseFloat(document.getElementById('l-pay').value) || 0, rate: parseFloat(document.getElementById('l-rate').value) || 0 };
    ['l-name', 'l-bal', 'l-pay', 'l-rate'].forEach(id => document.getElementById(id).value = '');
  } else if (type === 'income') {
    const n = document.getElementById('i-name').value.trim();
    const a = parseFloat(document.getElementById('i-amt').value) || 0;
    if (!n || a <= 0) { alert('Please enter a source and amount greater than 0.'); return; }
    item = { id: Date.now(), name: n, type: document.getElementById('i-type').value, amt: a };
    ['i-name', 'i-amt'].forEach(id => document.getElementById(id).value = '');
  } else if (type === 'expense') {
    const n = document.getElementById('e-name').value.trim();
    const a = parseFloat(document.getElementById('e-amt').value) || 0;
    if (!n || a <= 0) { alert('Please enter a name and amount greater than 0.'); return; }
    item = { id: Date.now(), name: n, cat: document.getElementById('e-cat').value, amt: a, ess: document.getElementById('e-ess').value === '1' };
    ['e-name', 'e-amt'].forEach(id => document.getElementById(id).value = '');
  }

  const dbId = await saveItem(type, item);
  if (!dbId) { alert('Could not save. Check your connection.'); return; }
  item._db_id = dbId;

  if (type === 'asset') assets.push(item);
  else if (type === 'liability') liabilities.push(item);
  else if (type === 'income') incomes.push(item);
  else if (type === 'expense') expenses.push(item);

  renderList(type);
  renderHeaderNW();
  if (document.getElementById('tab-overview').classList.contains('active')) renderOverview();
}

async function removeItem(type, dbId) {
  await deleteItem(dbId);
  if (type === 'asset') assets = assets.filter(a => a._db_id !== dbId);
  else if (type === 'liability') liabilities = liabilities.filter(l => l._db_id !== dbId);
  else if (type === 'income') incomes = incomes.filter(i => i._db_id !== dbId);
  else if (type === 'expense') expenses = expenses.filter(e => e._db_id !== dbId);
  renderList(type);
  renderHeaderNW();
  if (document.getElementById('tab-overview').classList.contains('active')) renderOverview();
}

// ─── TOTALS ──────────────────────────────────────────────────
const totA = () => assets.reduce((s, a) => s + a.val, 0);
const totL = () => liabilities.reduce((s, l) => s + l.bal, 0);
const totI = () => incomes.reduce((s, i) => s + i.amt, 0);
const totE = () => expenses.reduce((s, e) => s + e.amt, 0);
const nwVal = () => totA() - totL();
const cfVal = () => totI() - totE();
const mDebt = () => liabilities.reduce((s, l) => s + l.pay, 0);
const liqA = () => assets.filter(a => a.liq).reduce((s, a) => s + a.val, 0);

const fmt = n => 'KES ' + Math.round(n).toLocaleString();
const pct = n => Math.round(n) + '%';

// ─── TABS ────────────────────────────────────────────────────
function switchTab(t) {
  const tabs = ['overview', 'assets', 'liabilities', 'income', 'expenses', 'insights'];
  document.querySelectorAll('.tab-btn').forEach((b, i) =>
    b.classList.toggle('active', tabs[i] === t)
  );
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById('tab-' + t).classList.add('active');
  if (t === 'overview') renderOverview();
  if (t === 'insights') renderInsights();
}

// ─── RENDER ALL ──────────────────────────────────────────────
function renderAll() {
  ['asset', 'liability', 'income', 'expense'].forEach(t => renderList(t));
  renderOverview();
  renderHeaderNW();
}

// ─── RENDER LISTS ────────────────────────────────────────────
function renderList(type) {
  const configs = {
    asset: {
      listId: 'asset-list', emptyId: 'asset-empty', totalRowId: 'asset-total-row', totalId: 'asset-total',
      items: assets, totalFn: totA, totalClass: 'green', totalLabel: 'Total assets',
      rowFn: a => `
        <div class="list-item">
          <div><div class="li-name">${a.name}</div>
            <div class="li-meta"><span class="tag">${a.cat}</span><span class="tag ${a.liq ? 'tag-green' : 'tag-amber'}">${a.liq ? 'Liquid' : 'Illiquid'}</span></div>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <div class="li-val green">${fmt(a.val)}</div>
            <button class="btn btn-danger" onclick="removeItem('asset','${a._db_id}')">✕</button>
          </div>
        </div>`
    },
    liability: {
      listId: 'liability-list', emptyId: 'liab-empty', totalRowId: 'liab-total-row', totalId: 'liability-total',
      items: liabilities, totalFn: totL, totalClass: 'red', totalLabel: 'Total liabilities',
      rowFn: l => `
        <div class="list-item">
          <div><div class="li-name">${l.name}</div>
            <div class="li-meta"><span class="tag">${l.type}</span>${l.rate ? `<span class="tag tag-red">${l.rate}% p.a.</span>` : ''}</div>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="text-align:right"><div class="li-val red">${fmt(l.bal)}</div>${l.pay ? `<div class="li-sub">${fmt(l.pay)}/mo</div>` : ''}</div>
            <button class="btn btn-danger" onclick="removeItem('liability','${l._db_id}')">✕</button>
          </div>
        </div>`
    },
    income: {
      listId: 'income-list', emptyId: 'income-empty', totalRowId: 'income-total-row', totalId: 'income-total',
      items: incomes, totalFn: totI, totalClass: 'green', totalLabel: 'Monthly income',
      rowFn: i => {
        const ti = totI();
        return `
          <div class="list-item">
            <div><div class="li-name">${i.name}</div>
              <div class="li-meta"><span class="tag">${i.type}</span><span class="tag tag-blue">${ti > 0 ? Math.round(i.amt / ti * 100) : 0}% of income</span></div>
            </div>
            <div style="display:flex;align-items:center;gap:10px">
              <div class="li-val green">${fmt(i.amt)}</div>
              <button class="btn btn-danger" onclick="removeItem('income','${i._db_id}')">✕</button>
            </div>
          </div>`;
      }
    },
    expense: {
      listId: 'expense-list', emptyId: 'expense-empty', totalRowId: 'expense-total-row', totalId: 'expense-total',
      items: expenses, totalFn: totE, totalClass: 'red', totalLabel: 'Monthly expenses',
      rowFn: e => {
        const te = totE();
        return `
          <div class="list-item">
            <div><div class="li-name">${e.name}</div>
              <div class="li-meta"><span class="tag">${e.cat}</span><span class="tag ${e.ess ? 'tag-green' : 'tag-amber'}">${e.ess ? 'Essential' : 'Discretionary'}</span><span class="tag">${te > 0 ? Math.round(e.amt / te * 100) : 0}%</span></div>
            </div>
            <div style="display:flex;align-items:center;gap:10px">
              <div class="li-val red">${fmt(e.amt)}</div>
              <button class="btn btn-danger" onclick="removeItem('expense','${e._db_id}')">✕</button>
            </div>
          </div>`;
      }
    }
  };

  const c = configs[type];
  const el = document.getElementById(c.listId);
  const empty = document.getElementById(c.emptyId);
  const totalRow = document.getElementById(c.totalRowId);

  if (!c.items.length) {
    empty.style.display = 'block'; el.innerHTML = ''; totalRow.style.display = 'none'; return;
  }
  empty.style.display = 'none';
  totalRow.style.display = 'flex';
  el.innerHTML = c.items.map(c.rowFn).join('');
  document.getElementById(c.totalId).textContent = fmt(c.totalFn());
}

// ─── HEADER NW ───────────────────────────────────────────────
function renderHeaderNW() {
  const v = nwVal();
  const el = document.getElementById('header-nw');
  el.textContent = fmt(v);
  el.className = 'header-nw-val ' + (v >= 0 ? 'green' : 'red');
}

// ─── OVERVIEW ────────────────────────────────────────────────
function renderOverview() {
  const ta = totA(), tl = totL(), ti = totI(), te = totE();
  const netw = nwVal(), cash = cfVal();
  const savRate = ti > 0 ? ((ti - te) / ti * 100) : 0;
  const dti = ti > 0 ? (mDebt() / ti * 100) : 0;
  const la = liqA();
  const months = te > 0 ? (la / te) : 0;
  const liabRatio = ta > 0 ? (tl / ta * 100) : 0;

  const mCard = (label, value, cls, sub) =>
    `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value ${cls}">${value}</div><div class="metric-sub">${sub}</div></div>`;

  document.getElementById('overview-metrics').innerHTML =
    mCard('Net worth', fmt(netw), netw >= 0 ? 'green' : 'red', netw >= 0 ? 'Positive ✓' : 'Negative — review') +
    mCard('Monthly cashflow', fmt(cash), cash >= 0 ? 'green' : 'red', cash >= 0 ? 'Surplus' : 'Deficit') +
    mCard('Savings rate', pct(savRate), savRate >= 20 ? 'green' : savRate >= 10 ? 'amber' : 'red', 'Target ≥ 20%') +
    mCard('Debt-to-income', pct(dti), dti <= 30 ? 'green' : dti <= 43 ? 'amber' : 'red', 'Target ≤ 30%') +
    mCard('Emergency fund', Math.round(months) + ' months', months >= 6 ? 'green' : months >= 3 ? 'amber' : 'red', 'Target 3–6 months') +
    mCard('Debt ratio', pct(liabRatio), liabRatio <= 40 ? 'green' : liabRatio <= 70 ? 'amber' : 'red', 'Liabilities / assets');

  renderNWChart(ta, tl, netw);
  renderIEChart(ti, te, cash);
  renderAllocChart();
  renderHealthScore(savRate, dti, months, netw, cash, ta, tl);
}

// ─── CHARTS ──────────────────────────────────────────────────
const CHART_OPTS = {
  responsive: true, maintainAspectRatio: false,
  plugins: { legend: { display: false } },
  scales: {
    y: {
      ticks: { callback: v => v >= 1000000 ? (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(0) + 'K' : v, color: '#636880', font: { size: 10 } },
      grid: { color: 'rgba(255,255,255,0.05)' }, border: { display: false }
    },
    x: { grid: { display: false }, ticks: { color: '#9aa0b8', font: { size: 11 } }, border: { display: false } }
  }
};

function renderNWChart(ta, tl, netw) {
  if (nwChart) nwChart.destroy();
  nwChart = new Chart(document.getElementById('nwChart'), {
    type: 'bar',
    data: {
      labels: ['Assets', 'Liabilities', 'Net Worth'],
      datasets: [{ data: [ta, tl, Math.abs(netw)], backgroundColor: ['rgba(45,212,160,0.8)', 'rgba(240,90,90,0.8)', netw >= 0 ? 'rgba(91,156,246,0.8)' : 'rgba(240,90,90,0.5)'], borderRadius: 6 }]
    },
    options: CHART_OPTS
  });
}

function renderIEChart(ti, te, cash) {
  if (ieChart) ieChart.destroy();
  ieChart = new Chart(document.getElementById('ieChart'), {
    type: 'bar',
    data: {
      labels: ['Income', 'Expenses', 'Cashflow'],
      datasets: [{ data: [ti, te, Math.abs(cash)], backgroundColor: ['rgba(45,212,160,0.8)', 'rgba(240,90,90,0.8)', cash >= 0 ? 'rgba(91,156,246,0.8)' : 'rgba(240,90,90,0.5)'], borderRadius: 6 }]
    },
    options: CHART_OPTS
  });
}

function renderAllocChart() {
  if (allocChart) allocChart.destroy();
  if (!assets.length) {
    document.getElementById('alloc-legend').innerHTML = '<span style="color:var(--text3);font-size:12px">Add assets to see allocation.</span>';
    return;
  }
  const cats = {};
  assets.forEach(a => { cats[a.cat] = (cats[a.cat] || 0) + a.val; });
  const labels = Object.keys(cats), data = Object.values(cats);
  const colors = ['#2dd4a0', '#5b9cf6', '#f0a832', '#f05a5a', '#a78bfa', '#f472b6', '#34d399'];
  const total = data.reduce((s, v) => s + v, 0);
  allocChart = new Chart(document.getElementById('allocChart'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors.slice(0, data.length), borderWidth: 0, hoverOffset: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '65%', plugins: { legend: { display: false } } }
  });
  document.getElementById('alloc-legend').innerHTML = labels.map((l, i) =>
    `<span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;border-radius:2px;background:${colors[i]};flex-shrink:0"></span><span style="color:var(--text2)">${l}</span><span style="color:var(--text3)">${total > 0 ? Math.round(data[i] / total * 100) : 0}%</span></span>`
  ).join('');
}

// ─── HEALTH SCORE ────────────────────────────────────────────
function renderHealthScore(savRate, dti, months, netw, cash, ta, tl) {
  const hasData = totA() > 0 || totL() > 0 || totI() > 0 || totE() > 0;

  if (!hasData) {
    document.getElementById('health-score-area').innerHTML = `
      <div style="text-align:center;padding:2rem 1rem">
        <div style="font-size:2.5rem;margin-bottom:0.5rem;opacity:0.3">—</div>
        <div style="font-size:13px;color:var(--text3);line-height:1.6">Add your assets, liabilities, income, and expenses<br>to generate your financial health score.</div>
      </div>`;
    return;
  }

  // Only score dimensions that have relevant data
  const hasIncome = totI() > 0;
  const hasExpenses = totE() > 0;
  const hasAssets = totA() > 0;
  const hasLiab = totL() > 0;

  const s1 = hasIncome && hasExpenses ? Math.min(100, Math.max(0, savRate * 5)) : null;
  const s2 = hasIncome && hasLiab ? (dti <= 30 ? 100 : dti <= 43 ? Math.round(100 - (dti - 30) * 3.3) : Math.max(0, 40 - dti)) : null;
  const s3 = hasAssets && hasExpenses ? (months >= 6 ? 100 : months >= 3 ? 65 : Math.min(55, months * 18)) : null;
  const s4 = hasAssets || hasLiab ? (netw >= 0 ? Math.min(100, 60 + Math.min(40, netw / (ta || 1) * 60)) : Math.max(0, 40 + (netw / (tl || 1)) * 40)) : null;
  const s5 = hasIncome && hasExpenses ? (cash > 0 ? 100 : cash === 0 ? 50 : 30) : null;

  const scored = [s1, s2, s3, s4, s5].filter(v => v !== null);
  const overall = scored.length > 0 ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : 0;
  const grade = overall >= 80 ? 'Strong 💪' : overall >= 60 ? 'Moderate' : overall >= 40 ? 'Needs work' : 'At risk ⚠';
  const col = overall >= 80 ? 'var(--green)' : overall >= 60 ? 'var(--amber)' : 'var(--red)';

  const bar = (label, score, note) => {
    if (score === null) return `<div class="sbar"><div class="sbar-row"><span style="color:var(--text2)">${label}</span><span style="color:var(--text3);font-size:11px">Add data to score</span></div><div class="sbar-track"><div class="sbar-fill" style="width:0%;background:var(--border2)"></div></div></div>`;
    const c = score >= 70 ? 'var(--green)' : score >= 40 ? 'var(--amber)' : 'var(--red)';
    return `<div class="sbar"><div class="sbar-row"><span style="color:var(--text2)">${label}</span><span style="color:${c};font-weight:500">${note}</span></div><div class="sbar-track"><div class="sbar-fill" style="width:${Math.round(score)}%;background:${c}"></div></div></div>`;
  };

  document.getElementById('health-score-area').innerHTML = `
    <div class="health-wrap">
      <div class="score-circle">
        <div class="score-num" style="color:${col}">${overall}</div>
        <div class="score-grade">/100</div>
        <div class="score-grade" style="margin-top:4px;font-weight:500;color:${col}">${grade}</div>
      </div>
      <div class="score-bars">
        ${bar('Savings rate', s1, s1 !== null ? pct(savRate) + ' saved' : '')}
        ${bar('Debt burden', s2, s2 !== null ? 'DTI: ' + pct(dti) : '')}
        ${bar('Emergency fund', s3, s3 !== null ? Math.round(months) + 'mo cover' : '')}
        ${bar('Net worth', s4, s4 !== null ? (netw >= 0 ? 'Positive' : 'Negative') : '')}
        ${bar('Monthly cashflow', s5, s5 !== null ? (cash > 0 ? 'Surplus' : cash === 0 ? 'Break-even' : 'Deficit') : '')}
      </div>
    </div>`;
}

// ─── INSIGHTS ────────────────────────────────────────────────
function renderInsights() {
  const ti = totI(), te = totE(), ta = totA(), tl = totL();
  const cash = cfVal(), netw = nwVal();
  const savRate = ti > 0 ? ((ti - te) / ti * 100) : 0;
  const dti = ti > 0 ? (mDebt() / ti * 100) : 0;
  const la = liqA();
  const months = te > 0 ? (la / te) : 0;
  const discExp = expenses.filter(e => !e.ess).reduce((s, e) => s + e.amt, 0);
  const highRateLoans = liabilities.filter(l => l.rate > 18);
  const passiveInc = incomes.filter(i => ['Investment returns', 'Rental income'].includes(i.type));

  if (ta === 0 && tl === 0 && ti === 0 && te === 0) {
    document.getElementById('insights-content').innerHTML =
      `<div class="alert alert-info">💡 Add your data in the Assets, Liabilities, Income, and Expenses tabs first — then your personalised analysis will appear here.</div>`;
    return;
  }

  const alerts = [], improvements = [], strengths = [];

  if (cash < 0) alerts.push({ level: 'danger', msg: `<strong>🔴 Negative cashflow — deficit of ${fmt(Math.abs(cash))}/month.</strong> You are spending more than you earn. Every month this continues, you deplete savings or accumulate debt. <em>Action: Review the Expenses tab. Cut at least ${fmt(Math.abs(cash))} from discretionary items immediately.</em>` });
  if (dti > 43) alerts.push({ level: 'danger', msg: `<strong>🔴 Critical debt-to-income: ${pct(dti)}.</strong> Above 43% means you are severely overleveraged. A job loss or income disruption could make repayments impossible. <em>Action: Stop all new debt. Redirect every surplus to the highest-rate loan (avalanche method).</em>` });
  else if (dti > 30) alerts.push({ level: 'warning', msg: `<strong>🟡 Elevated DTI: ${pct(dti)} — above the 30% safe threshold.</strong> <em>Action: Avoid new loans. Allocate bonuses or windfalls to principal reduction.</em>` });
  if (months < 3) alerts.push({ level: 'danger', msg: `<strong>🔴 Emergency fund: only ${Math.round(months)} month(s) of cover.</strong> A medical bill, job loss, or car breakdown would force you into debt immediately. <em>Action: Open a separate savings account or money market fund. Save a fixed amount monthly — target ${fmt(te * 3)} minimum.</em>` });
  else if (months < 6) alerts.push({ level: 'warning', msg: `<strong>🟡 Emergency fund below 6-month target (${Math.round(months)} months).</strong> <em>Action: Keep building. Target ${fmt(te * 6)} in liquid savings.</em>` });
  if (incomes.length <= 1 && ti > 0) alerts.push({ level: 'warning', msg: `<strong>🟡 Single income stream — high concentration risk.</strong> Losing this source puts all your financial commitments at risk simultaneously. <em>Action: Explore a complementary stream — MEAL consultancy, data analysis contracts, training workshops, or content.</em>` });
  if (highRateLoans.length > 0) alerts.push({ level: 'warning', msg: `<strong>🟡 High-interest loan(s): ${highRateLoans.map(l => l.name + ' @ ' + l.rate + '%').join(', ')}.</strong> Rates above 18% p.a. compound aggressively against your net worth. <em>Action: Treat these as the priority over any discretionary investment. Consider refinancing through a SACCO at a lower rate.</em>` });
  if (netw < 0) alerts.push({ level: 'danger', msg: `<strong>🔴 Net worth is negative (${fmt(netw)}).</strong> You owe more than you own. <em>Action: Dual focus — grow assets (savings, investments) while aggressively reducing liabilities. Track monthly to confirm the trend is improving.</em>` });

  if (savRate < 20 && ti > 0) {
    const gap = Math.max(0, ti * 0.2 - Math.max(0, cash));
    improvements.push(`<strong>Boost savings rate from ${pct(savRate)} to 20%.</strong> That means saving an extra ${fmt(gap)}/month. Automate a transfer on payday before discretionary spending begins.`);
  }
  if (discExp > 0 && ti > 0) {
    improvements.push(`<strong>Discretionary spending is ${fmt(discExp)}/month (${pct(discExp / ti * 100)} of income).</strong> A 30% cut frees ${fmt(discExp * 0.3)}/month — or ${fmt(discExp * 0.3 * 12)}/year — available for investment or debt repayment.`);
  }
  if (passiveInc.length === 0) improvements.push(`<strong>No passive income detected.</strong> A money market fund (Sanlam, CIC, ICEA) at ~11% p.a. on KES 100,000 earns roughly KES 900/month passively. Start small — it compounds.`);
  if (assets.filter(a => a.cat === 'Pension / NSSF').length === 0) improvements.push(`<strong>No pension asset recorded.</strong> Ensure you are contributing to NSSF and ideally a supplementary pension. Contributions reduce taxable income and build long-term wealth.`);

  if (savRate >= 20) strengths.push(`Savings rate of ${pct(savRate)} — above the 20% benchmark. You are building wealth.`);
  if (months >= 6) strengths.push(`Emergency fund covers ${Math.round(months)} months — strong financial resilience.`);
  if (dti <= 30 && tl > 0) strengths.push(`Debt-to-income ratio of ${pct(dti)} — within the safe 30% threshold.`);
  if (netw > 0) strengths.push(`Positive net worth of ${fmt(netw)} — you own more than you owe.`);
  if (incomes.length >= 2) strengths.push(`${incomes.length} income streams — good diversification. Income concentration risk is lower.`);
  if (passiveInc.length > 0) strengths.push(`Passive income present (${passiveInc.map(i => i.name).join(', ')}) — money working for you.`);
  if (cash > 0 && savRate >= 20) strengths.push(`Surplus cashflow of ${fmt(cash)}/month — strong position to accelerate wealth building.`);

  const row = (label, value, cls) =>
    `<div class="list-item"><span style="color:var(--text2);font-size:13px">${label}</span><span class="${cls}" style="font-weight:600;font-size:13px">${value}</span></div>`;

  let html = '';
  if (alerts.length) {
    html += `<div class="section-head">⚠ Risk alerts (${alerts.length})</div>`;
    alerts.forEach(a => { html += `<div class="alert alert-${a.level}">${a.msg}</div>`; });
  }
  if (improvements.length) {
    html += `<div class="section-head">💡 Where to improve (${improvements.length})</div>`;
    improvements.forEach(imp => { html += `<div class="alert alert-warning">${imp}</div>`; });
  }
  if (strengths.length) {
    html += `<div class="section-head">✓ What you are doing well (${strengths.length})</div>`;
    strengths.forEach(s => { html += `<div class="alert alert-success">✓ ${s}</div>`; });
  }

  html += `
    <div style="margin-top:1.5rem">
      <div class="section-head">📊 Summary snapshot</div>
      <div class="list-card" style="padding:0.25rem 1.25rem">
        ${row('Total assets', fmt(totA()), 'green')}
        ${row('Total liabilities', fmt(totL()), 'red')}
        ${row('Net worth', fmt(nwVal()), nwVal() >= 0 ? 'green' : 'red')}
        ${row('Monthly income', fmt(ti), 'green')}
        ${row('Monthly expenses', fmt(te), 'red')}
        ${row('Monthly cashflow', fmt(cash), cash >= 0 ? 'green' : 'red')}
        ${row('Annual cashflow projection', fmt(cash * 12), cash >= 0 ? 'green' : 'red')}
        ${row('Savings rate', pct(savRate), savRate >= 20 ? 'green' : savRate >= 10 ? 'amber' : 'red')}
        ${row('Debt-to-income ratio', pct(dti), dti <= 30 ? 'green' : dti <= 43 ? 'amber' : 'red')}
        ${row('Emergency fund cover', Math.round(months) + ' months', months >= 6 ? 'green' : months >= 3 ? 'amber' : 'red')}
      </div>
    </div>`;

  document.getElementById('insights-content').innerHTML = html;
}

// ─── EXPORT REPORT ───────────────────────────────────────────
function exportData() {
  toggleUserMenu(true);
  const ti = totI(), te = totE(), ta = totA(), tl = totL();
  const netw = nwVal(), cash = cfVal();
  const savRate = ti > 0 ? ((ti - te) / ti * 100) : 0;
  const dti = ti > 0 ? (mDebt() / ti * 100) : 0;
  const la = liqA();
  const months = te > 0 ? (la / te) : 0;
  const date = new Date().toLocaleDateString('en-KE', { year: 'numeric', month: 'long', day: 'numeric' });

  const line = (label, value) => `${label.padEnd(30, '.')} ${value}`;
  const sep = '─'.repeat(50);

  let report = `NETWORTH TRACKER — FINANCIAL SUMMARY REPORT
Generated: ${date}
${sep}

NET WORTH SNAPSHOT
${sep}
${line('Total Assets', fmt(ta))}
${line('Total Liabilities', fmt(tl))}
${line('Net Worth', fmt(netw))}

MONTHLY CASHFLOW
${sep}
${line('Total Monthly Income', fmt(ti))}
${line('Total Monthly Expenses', fmt(te))}
${line('Monthly Cashflow', fmt(cash))}
${line('Annual Cashflow (projected)', fmt(cash * 12))}

KEY RATIOS
${sep}
${line('Savings Rate', Math.round(savRate) + '% (target ≥ 20%)')}
${line('Debt-to-Income Ratio', Math.round(dti) + '% (target ≤ 30%)')}
${line('Emergency Fund Cover', Math.round(months) + ' months (target 3–6)')}

ASSETS (${assets.length} items)
${sep}
${assets.length ? assets.map(a => line(a.name, fmt(a.val) + ' — ' + a.cat)).join('\n') : 'None recorded.'}

LIABILITIES (${liabilities.length} items)
${sep}
${liabilities.length ? liabilities.map(l => line(l.name, fmt(l.bal) + (l.rate ? ' @ ' + l.rate + '%' : ''))).join('\n') : 'None recorded.'}

INCOME STREAMS (${incomes.length} items)
${sep}
${incomes.length ? incomes.map(i => line(i.name, fmt(i.amt) + '/month — ' + i.type)).join('\n') : 'None recorded.'}

MONTHLY EXPENSES (${expenses.length} items)
${sep}
${expenses.length ? expenses.map(e => line(e.name, fmt(e.amt) + '/month — ' + (e.ess ? 'Essential' : 'Discretionary'))).join('\n') : 'None recorded.'}

${sep}
This report was generated by NetWorth Tracker.
Data is personal and confidential.
`;

  const blob = new Blob([report], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'networth_report_' + new Date().toISOString().slice(0, 10) + '.txt';
  a.click();
}
