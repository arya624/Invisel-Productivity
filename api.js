/**
 * Shared client-side helpers for all three Invisel Tracker dashboards.
 * Requires config.js to be loaded first.
 */

// ---------------------------------------------------------------
// API
// ---------------------------------------------------------------

async function apiCall(action, payload) {
  const delays = [900, 1800]; // two retries, with increasing backoff
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await apiCallOnce(action, payload);
    } catch (err) {
      lastErr = err;
      if (!err.transient || attempt === delays.length) throw err;
      await new Promise(r => setTimeout(r, delays[attempt]));
    }
  }
  throw lastErr;
}

async function apiCallOnce(action, payload) {
  if (!APP_CONFIG.APPS_SCRIPT_URL || APP_CONFIG.APPS_SCRIPT_URL === 'PASTE_YOUR_WEB_APP_URL_HERE') {
    throw new Error('Backend not configured yet. Paste your Apps Script Web App URL into config.js.');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  let res;
  try {
    res = await fetch(APP_CONFIG.APPS_SCRIPT_URL, {
      method: 'POST',
      // text/plain avoids a CORS preflight request, which Apps Script does not handle.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...payload }),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      const timeoutErr = new Error('Request timed out. Retrying…');
      timeoutErr.transient = true;
      throw timeoutErr;
    }
    const networkErr = new Error('Could not reach the backend. Check your internet connection and that config.js has the correct URL.');
    networkErr.transient = true;
    throw networkErr;
  } finally {
    clearTimeout(timeoutId);
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    const parseErr = new Error('Backend returned an unexpected (non-JSON) response. This usually means the Apps Script deployment access isn\'t set to "Anyone" — check Deploy → Manage deployments.');
    parseErr.transient = true;
    throw parseErr;
  }

  if (data.success === false) throw new Error(data.error || 'Request failed.');
  return data;
}

// ---------------------------------------------------------------
// SESSION (persisted in localStorage — this is a deployed site, not a Claude.ai preview)
// ---------------------------------------------------------------

const SESSION_KEY = 'invisel_tracker_session';

function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function getSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

/**
 * Wires up an embedded login screen scoped to one role. Expects these elements
 * to exist in the page: #loginScreen, #appShell, #nameSelect, #pinInput,
 * #loginBtn, #loginError. The name dropdown only ever lists people of
 * `expectedRole`, and the backend's returned role is double-checked before
 * granting access. Calls onAuthed({name, role}) once signed in.
 */
function initGatedLogin(expectedRole, onAuthed) {
  const nameSelect = document.getElementById('nameSelect');
  const pinInput = document.getElementById('pinInput');
  const loginBtn = document.getElementById('loginBtn');
  const errorEl = document.getElementById('loginError');
  const loginScreen = document.getElementById('loginScreen');
  const appShell = document.getElementById('appShell');

  function showError(msg) { errorEl.textContent = msg; errorEl.classList.add('show'); }
  function hideError() { errorEl.classList.remove('show'); }

  function enter(session) {
    loginScreen.style.display = 'none';
    appShell.style.display = '';
    onAuthed(session);
  }

  async function loadNames() {
    const cacheKey = 'invisel_names_' + expectedRole;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      // Show instantly from cache, then quietly refresh underneath.
      renderNameOptions(JSON.parse(cached));
    }
    try {
      const data = await apiCall('getPeopleNames', { role: expectedRole });
      localStorage.setItem(cacheKey, JSON.stringify(data.people));
      renderNameOptions(data.people);
    } catch (err) {
      if (!cached) {
        nameSelect.innerHTML = '<option value="">Could not load — check config.js</option>';
        showError(err.message);
      }
      // If we had cached names, fail silently — the person can still sign in
      // with what's already showing, and we'll retry fresh next visit.
    }
  }

  function renderNameOptions(people) {
    if (!people.length) {
      nameSelect.innerHTML = `<option value="">No one added yet — ask Admin</option>`;
      return;
    }
    const prevValue = nameSelect.value;
    nameSelect.innerHTML = '<option value="">Select your name…</option>' +
      people
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(p => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`)
        .join('');
    if (prevValue) nameSelect.value = prevValue;
  }

  async function doLogin() {
    hideError();
    const name = nameSelect.value;
    const pin = pinInput.value;
    if (!name) return showError('Please select your name.');
    if (!/^\d{4}$/.test(pin)) return showError('PIN must be 4 digits.');

    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in…';
    try {
      const data = await apiCall('login', { name, pin });
      if (data.role !== expectedRole) {
        showError(`${data.name} is registered as ${data.role}, not ${expectedRole}. Use the correct link for that role.`);
        return;
      }
      const session = { name: data.name, role: data.role };
      saveSession(session);
      enter(session);
    } catch (err) {
      showError(err.message);
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign in';
    }
  }

  loginBtn.addEventListener('click', doLogin);
  pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  const existing = getSession();
  if (existing && existing.role === expectedRole) {
    enter(existing);
  } else {
    if (existing) clearSession(); // stale session for a different role
    loadNames();
  }
}

// ---------------------------------------------------------------
// DATE / PRIORITY / STATUS HELPERS
// ---------------------------------------------------------------

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + 'T00:00:00');
  return Math.round((target - today) / 86400000);
}

function formatDatePretty(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Combines set priority with real deadline proximity into a display urgency. */
function urgencyFor(task) {
  const days = daysUntil(task.endDate);
  const done = task.status === 'Completed';
  if (done) return { label: 'Completed', tone: 'done' };
  if (days === null) return { label: task.priority || 'Medium', tone: (task.priority || 'medium').toLowerCase() };
  if (days < 0) return { label: `Overdue by ${Math.abs(days)}d`, tone: 'overdue' };
  if (days === 0) return { label: 'Due today', tone: 'overdue' };
  if (days <= 2) return { label: `Due in ${days}d`, tone: 'high' };
  if (task.priority === 'High') return { label: 'High priority', tone: 'high' };
  if (task.priority === 'Low') return { label: 'Low priority', tone: 'low' };
  return { label: 'Medium priority', tone: 'medium' };
}

function statusToneClass(status) {
  switch (status) {
    case 'Completed': return 'tone-done';
    case 'In Progress': return 'tone-progress';
    case 'Blocked': return 'tone-overdue';
    default: return 'tone-medium';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

/** Restarts the fade-in animation on an element — used when switching sidebar views. */
function fadeInView(el) {
  el.classList.remove('view-fade-in');
  void el.offsetWidth; // force reflow so the animation restarts
  el.classList.add('view-fade-in');
}

// ---------------------------------------------------------------
// TOASTS
// ---------------------------------------------------------------

function showToast(message, isError) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = 'toast show' + (isError ? ' toast-error' : '');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

// ---------------------------------------------------------------
// CALENDAR (shared month-grid builder)
// ---------------------------------------------------------------

/**
 * Renders a month calendar into container `el`.
 * tasksByDate: { 'yyyy-mm-dd': [task, ...] }
 * onDayClick(dateStr, tasksOnDay)
 * onMonthChange(year, month) — optional, fires on initial render and after
 * navigating months, so callers can sync other UI (e.g. a log below the grid).
 */
function renderCalendar(el, year, month, tasksByDate, onDayClick, onMonthChange) {
  const first = new Date(year, month, 1);
  const startWeekday = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthName = first.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const todayStr = new Date().toISOString().slice(0, 10);

  let html = `
    <div class="cal-header">
      <button class="cal-nav" data-dir="-1" aria-label="Previous month">‹</button>
      <span class="cal-title">${monthName}</span>
      <button class="cal-nav" data-dir="1" aria-label="Next month">›</button>
    </div>
    <div class="cal-grid cal-grid-labels">
      ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => `<div class="cal-daylabel">${d}</div>`).join('')}
    </div>
    <div class="cal-grid">
  `;

  for (let i = 0; i < startWeekday; i++) html += `<div class="cal-cell cal-empty"></div>`;

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dayTasks = tasksByDate[dateStr] || [];
    const isToday = dateStr === todayStr;
    const dots = dayTasks.slice(0, 3).map(t => {
      const u = urgencyFor(t);
      return `<span class="cal-dot tone-${u.tone}"></span>`;
    }).join('');
    html += `
      <div class="cal-cell ${isToday ? 'cal-today' : ''} ${dayTasks.length ? 'cal-has-tasks' : ''}" data-date="${dateStr}">
        <span class="cal-daynum">${day}</span>
        <div class="cal-dots">${dots}${dayTasks.length > 3 ? `<span class="cal-more">+${dayTasks.length - 3}</span>` : ''}</div>
      </div>
    `;
  }

  html += `</div>`;
  el.innerHTML = html;

  el.querySelectorAll('.cal-cell[data-date]').forEach(cell => {
    cell.addEventListener('click', () => {
      const d = cell.getAttribute('data-date');
      onDayClick(d, tasksByDate[d] || []);
    });
  });

  el.querySelectorAll('.cal-nav').forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = parseInt(btn.getAttribute('data-dir'), 10);
      let m = month + dir, y = year;
      if (m < 0) { m = 11; y--; }
      if (m > 11) { m = 0; y++; }
      renderCalendar(el, y, m, tasksByDate, onDayClick, onMonthChange);
    });
  });

  if (onMonthChange) onMonthChange(year, month);
}

function groupTasksByDate(tasks) {
  const map = {};
  tasks.forEach(t => {
    if (!t.endDate) return;
    (map[t.endDate] = map[t.endDate] || []).push(t);
  });
  return map;
}

// ---------------------------------------------------------------
// COMPLETED LOG helpers (shared by employee/manager/admin)
// ---------------------------------------------------------------

/** The date a completed task should be logged under — falls back to
 * lastUpdated for tasks completed before CompletedDate existed. */
function effectiveCompletedDate(task) {
  return task.completedDate || (task.lastUpdated ? task.lastUpdated.slice(0, 10) : null);
}

function monthKey(dateStr) {
  return dateStr ? dateStr.slice(0, 7) : null; // 'YYYY-MM'
}

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

/** Populates a <select> with month options from a list of completed tasks,
 * newest first, plus an "All time" option. Preserves current selection if
 * it still exists among the options. */
function populateLogMonths(selectEl, completedTasks) {
  const keys = [...new Set(completedTasks.map(t => monthKey(effectiveCompletedDate(t))).filter(Boolean))]
    .sort((a, b) => b.localeCompare(a));
  const prev = selectEl.value;
  selectEl.innerHTML = '<option value="">All time</option>' +
    keys.map(k => `<option value="${k}">${monthLabel(k)}</option>`).join('');
  if (keys.includes(prev)) selectEl.value = prev;
  else if (keys.length) selectEl.value = keys[0]; // default to most recent month with activity
}
