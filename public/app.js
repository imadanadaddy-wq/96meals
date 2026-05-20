// KNUH Meal Dashboard - frontend SPA
(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const root = document.getElementById('app');

  const STORAGE_KEY = 'knuh.user.v1';
  const ROLE_KEY = 'knuh.role.v1';
  const POLL_MS = 3000;

  // Meal types ordered breakfast first throughout the app
  const MEAL_ORDER = ['breakfast', 'late_night'];

  // ===== State =====
  let user = null;          // {id, employee_id, name, is_admin}
  let role = null;          // 'applicant' | 'acting' | 'admin'
  let pollTimer = null;

  // Applicant
  let applicantStep = 'home';      // 'home' | 'date' | 'menu' | 'done'
  let draftMealType = null;
  let draftDates = [];
  let draftMenuName = '';                // legacy, kept for backward compat (unused for new flow)
  let draftCustomText = '';
  let draftLnPriority = [];              // late_night: array of menu names in priority order (max 3)

  // Breakfast draft
  let bfStep = null;               // null | 'form' | 'kimbap' | 'cat1' | 'tier' | 'fallback' | 'note'
  let draftMealForm = null;        // 'snack_pick' | 'kimbap'
  let draftKimbapChoice = null;
  // For snack_pick: array of category choices in priority order
  // each item: { category_id, slots: { [slot_id]: { priority: [], any: bool } } }
  let draftPriorities = [];
  let draftFallbackAny = false;
  let draftBuildingTier = null;    // index of priority being currently configured (0..N)
  let draftNote = '';

  let lastSubmitted = null;
  let myOrders = [];

  // Acting
  let actingStep = 'choose';
  let actingMealType = null;
  let actingDate = null;
  let actingFilter = 'all'; // 'all' | 'snack_pick' | 'kimbap' | 'no_meal'
  let activeOrders = [];
  let activeSummary = [];

  // Admin
  let adminMealTab = 'breakfast';
  let adminLogDate = null;        // selected date string for pickup log
  let adminLogDates = [];         // dates with order activity (within retention)
  let adminLogOrders = [];        // orders for selected date
  let adminItems = [];
  let breakfastStructure = [];
  let adminBreakfastExpanded = new Set();
  let kimbapOptions = [];

  let menuItemsCache = { breakfast: [], late_night: [] };
  // For late_night: keyed by date → { items, period, is_holiday, kind }
  let lateNightMenuByDate = {};
  // Holidays cache (Set of YYYY-MM-DD)
  let holidaysSet = new Set();
  // Late-night menu periods (admin manages)
  let menuPeriods = [];

  // ===== Storage =====
  function loadStored() {
    try {
      const u = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      const r = localStorage.getItem(ROLE_KEY);
      if (u) user = u;
      if (r) role = r;
    } catch {}
  }
  function saveUser(u) {
    user = u;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
  }
  function saveRole(r) {
    role = r;
    if (r) localStorage.setItem(ROLE_KEY, r);
    else localStorage.removeItem(ROLE_KEY);
  }

  // ===== API =====
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (user) headers['X-Employee-Id'] = user.employee_id;
    const res = await fetch(path, { ...opts, headers });
    let body = null;
    try { body = await res.json(); } catch {}
    if (!res.ok) throw new Error(body?.error || `요청 실패 (${res.status})`);
    return body;
  }

  // ===== Toast =====
  let toastEl = null;
  let toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  // ===== Date helpers =====
  function todayStr() { return ymd(new Date()); }
  function ymd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function addDays(s, n) {
    const d = new Date(s + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return ymd(d);
  }
  function nextNDays(n) {
    const out = [];
    let cur = todayStr();
    for (let i = 0; i < n; i++) { out.push(cur); cur = addDays(cur, 1); }
    return out;
  }
  const DOW_KR = ['일', '월', '화', '수', '목', '금', '토'];
  function fmtDate(s, { withDow = true, withMonth = false } = {}) {
    const d = new Date(s + 'T00:00:00');
    const dow = DOW_KR[d.getDay()];
    const day = d.getDate();
    const month = d.getMonth() + 1;
    if (withMonth) return `${month}/${day} (${dow})`;
    return withDow ? `${day}일 (${dow})` : `${day}일`;
  }
  function fmtFull(s) {
    const d = new Date(s + 'T00:00:00');
    return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. (${DOW_KR[d.getDay()]})`;
  }
  function dayOfWeek(s) { return new Date(s + 'T00:00:00').getDay(); }

  // ===== Helpers =====
  function mealLabel(t) { return t === 'breakfast' ? '조식' : '야식'; }
  function mealEmoji(t) { return t === 'breakfast' ? '🍳' : '🍜'; }
  function escape(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    }[c]));
  }

  // Sort orders breakfast-first then by date
  function sortOrders(list) {
    return [...list].sort((a, b) => {
      if (a.service_date !== b.service_date) return a.service_date < b.service_date ? -1 : 1;
      const ai = MEAL_ORDER.indexOf(a.meal_type);
      const bi = MEAL_ORDER.indexOf(b.meal_type);
      return ai - bi;
    });
  }

  function renderBrand() {
    return `
      <div class="brand">
        <div>
          <div class="brand-logo">KNUH</div>
          <div class="brand-sub">조식·야식 신청</div>
        </div>
        ${user ? `
          <div class="user-pill">
            <span class="dot"></span>
            <span>${escape(user.name)} · ${escape(user.employee_id)}</span>
          </div>
        ` : ''}
      </div>
    `;
  }

  // ===== Login =====
  function renderLogin() {
    root.innerHTML = `
      ${renderBrand()}
      <div class="card">
        <h2 style="margin:0 0 6px;font-size:20px;font-weight:800;">처음이신가요?</h2>
        <p style="margin:0 0 18px;color:var(--muted);font-size:13px;">
          사번과 이름을 입력하면 다음부터는 자동으로 로그인됩니다.
        </p>
        <div class="field">
          <label for="eid">사번</label>
          <input class="input" id="eid" inputmode="numeric" pattern="[0-9]*"
                 maxlength="10" placeholder="예: 22807" autocomplete="off" />
        </div>
        <div class="field">
          <label for="nm">이름</label>
          <input class="input" id="nm" maxlength="20" placeholder="예: 김덕근" autocomplete="off" />
        </div>
        <button class="btn btn-primary" id="loginBtn">등록하고 시작하기</button>
      </div>
      <p style="text-align:center;margin-top:14px;font-size:12px;color:var(--muted);">
        처음 사용하시나요? <a href="/guide" style="color:var(--text-soft);text-decoration:underline;">사용 가이드 보기 →</a>
      </p>
    `;
    const eid = $('#eid'), nm = $('#nm'), btn = $('#loginBtn');
    eid.focus();
    async function submit() {
      const employee_id = eid.value.trim();
      const name = nm.value.trim();
      if (!employee_id || !name) { toast('사번과 이름을 모두 입력해주세요'); return; }
      btn.disabled = true; btn.textContent = '등록 중...';
      try {
        const u = await api('/api/register', {
          method: 'POST', body: JSON.stringify({ employee_id, name })
        });
        saveUser(u);
        render();
      } catch (e) {
        toast(e.message);
        btn.disabled = false; btn.textContent = '등록하고 시작하기';
      }
    }
    btn.addEventListener('click', submit);
    [eid, nm].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); }));
  }

  // ===== Role picker =====
  function renderRolePicker() {
    root.innerHTML = `
      ${renderBrand()}
      <div style="margin: 8px 4px 20px;">
        <h2 style="margin:0;font-size:22px;font-weight:800;">안녕하세요, ${escape(user.name)}님 👋</h2>
        <p style="margin:6px 0 0;color:var(--muted);font-size:13px;">오늘 어떻게 사용하실까요?</p>
      </div>
      <div class="role-grid">
        <button class="role-card" data-role="applicant">
          <span class="role-emoji">🙋</span>
          <span class="role-name">신청자</span>
          <span class="role-desc">조식·야식 메뉴를 신청해요</span>
        </button>
        <button class="role-card" data-role="acting">
          <span class="role-emoji">🏃</span>
          <span class="role-name">액팅</span>
          <span class="role-desc">메뉴 확인하고 받으러 가요</span>
        </button>
        ${user.is_admin ? `
          <button class="role-card admin" data-role="admin">
            <span class="role-emoji">🛠️</span>
            <span class="role-name">관리자</span>
            <span class="role-desc">메뉴 항목 추가·삭제</span>
          </button>
        ` : ''}
      </div>
      <div style="margin-top:20px;text-align:center;display:flex;gap:8px;justify-content:center;align-items:center;">
        <a href="/guide" class="btn btn-ghost btn-sm" style="text-decoration:none;">📖 사용 가이드</a>
        <button class="btn btn-ghost btn-sm" id="logoutBtn">로그아웃</button>
      </div>
    `;
    document.querySelectorAll('.role-card').forEach(c => {
      c.addEventListener('click', () => { saveRole(c.dataset.role); render(); });
    });
    $('#logoutBtn').addEventListener('click', () => {
      if (confirm('로그아웃 하시겠습니까?')) {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(ROLE_KEY);
        user = null; role = null;
        render();
      }
    });
  }

  // ===== Date chip helpers =====
  function renderDateChips(dates, selected, withOrdersDates = new Set()) {
    const today = todayStr();
    return `
      <div class="date-grid">
        ${dates.map(d => {
          const isSel = selected.includes(d);
          const isToday = d === today;
          const dow = dayOfWeek(d);
          const dt = new Date(d + 'T00:00:00');
          const isHoliday = holidaysSet.has(d);
          const cls = [
            'date-chip',
            isSel ? 'selected' : '',
            isToday ? 'today' : '',
            dow === 0 ? 'sun' : '',
            dow === 6 ? 'sat' : '',
            withOrdersDates.has(d) ? 'has-orders' : '',
            isHoliday ? 'holiday' : '',
          ].filter(Boolean).join(' ');
          return `
            <button class="${cls}" data-date="${d}" title="${isHoliday ? '매장 휴무일' : ''}">
              <span class="dow">${DOW_KR[dow]}</span>
              <span class="day">${dt.getDate()}</span>
              ${isHoliday ? '<span class="holiday-mark">휴</span>' : ''}
            </button>
          `;
        }).join('')}
      </div>
    `;
  }

  // ===== APPLICANT - Stepped flow =====

  function applicantHeader(title, opts = {}) {
    // opts: { onBack: bool, step: 0..3 (0 = hidden), totalSteps: 3 }
    const showStep = typeof opts.step === 'number' && opts.step > 0;
    return `
      <div class="step-top">
        ${opts.onBack ? `<button class="icon-btn" id="stepBack" aria-label="뒤로">‹</button>`
                     : `<button class="icon-btn" id="stepClose" aria-label="홈으로">✕</button>`}
        <div class="step-title">${escape(title)}</div>
        ${showStep ? `<div class="step-indicator">${opts.step}/${opts.totalSteps || 3}</div>`
                  : `<div class="step-indicator-spacer"></div>`}
      </div>
    `;
  }

  function renderApplicantHome() {
    const sorted = sortOrders(myOrders);

    root.innerHTML = `
      ${renderBrand()}
      <div class="topbar">
        <h1>메뉴 신청</h1>
        <button class="btn btn-ghost btn-sm" id="switchRole">역할 전환</button>
      </div>

      ${sorted.length === 0 ? `
        <p style="margin:8px 4px 18px;color:var(--muted);font-size:13px;">
          어떤 식사를 신청하시겠어요?
        </p>
        <div class="choice-grid">
          <button class="choice-card breakfast" data-meal="breakfast">
            <span class="emoji">🍳</span>
            <span class="name">조식</span>
            <span class="count">아침 식사</span>
          </button>
          <button class="choice-card late_night" data-meal="late_night">
            <span class="emoji">🍜</span>
            <span class="name">야식</span>
            <span class="count">밤 야식</span>
          </button>
        </div>

      ` : `
        <div class="section-title" style="margin-top:14px;">
          <h2>내 신청 현황</h2>
          <span class="hint">${sorted.some(o => o.meal_type === 'breakfast') ? `탭하면 바코드 · ` : ''}${sorted.length}건</span>
        </div>
        <div class="my-orders-list">
          ${sorted.map((o, i) => `
            <div class="my-order-row">
              ${o.meal_type === 'late_night' ? `
                <div class="my-order-main my-order-static">
                  <div class="meal-badge ${o.meal_type}">${mealEmoji(o.meal_type)}</div>
                  <div class="info">
                    <div class="date">${fmtFull(o.service_date)} · ${mealLabel(o.meal_type)}</div>
                    <div class="menu">${escape(o.menu)}</div>
                  </div>
                </div>
              ` : `
                <button class="my-order-main" data-view-idx="${i}">
                  <div class="meal-badge ${o.meal_type}">${mealEmoji(o.meal_type)}</div>
                  <div class="info">
                    <div class="date">${fmtFull(o.service_date)} · ${mealLabel(o.meal_type)}</div>
                    <div class="menu">${o.selection ? escape(summarizeSelection(o.selection)) : escape(o.menu)}</div>
                  </div>
                  <span class="view-hint">바코드 ›</span>
                </button>
              `}
              <button class="x" data-cancel-id="${o.id}" title="취소">✕</button>
            </div>
          `).join('')}
        </div>

        <div style="margin-top:18px;">
          <div class="add-meal-row">
            <button class="btn btn-primary add-half breakfast-btn" data-meal="breakfast">
              <span style="font-size:18px;">🍳</span> 조식 신청
            </button>
            <button class="btn btn-primary add-half late_night-btn" data-meal="late_night">
              <span style="font-size:18px;">🍜</span> 야식 신청
            </button>
          </div>
        </div>
      `}
    `;

    $('#switchRole').addEventListener('click', () => { saveRole(null); render(); });



    document.querySelectorAll('[data-meal]').forEach(b =>
      b.addEventListener('click', () => {
        draftMealType = b.dataset.meal;
        draftDates = [todayStr()];
        draftMenuName = '';
        draftCustomText = '';
        draftLnPriority = [];
        resetBreakfastDraft();
        applicantStep = 'date';
        renderApplicantStep();
      }));

    document.querySelectorAll('[data-view-idx]').forEach(b =>
      b.addEventListener('click', () => {
        const i = Number(b.dataset.viewIdx);
        openOrderViewer(sortOrders(myOrders), i, { allowPickup: false });
      }));

    document.querySelectorAll('[data-cancel-id]').forEach(b =>
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('이 신청을 취소할까요?')) return;
        try {
          await api(`/api/orders/${b.dataset.cancelId}`, { method: 'DELETE' });
          toast('취소되었습니다');
          await loadMyOrders();
          renderApplicantHome();
        } catch (e) { toast(e.message); }
      }));
  }

  function renderApplicantStep() {
    if (applicantStep === 'date') renderApplicantDate();
    else if (applicantStep === 'menu') renderApplicantMenu();
    else if (applicantStep === 'done') renderApplicantDone();
    else renderApplicantHome();
  }

  function renderApplicantDate() {
    const dates = nextNDays(7);
    const existing = new Set(
      myOrders.filter(o => o.meal_type === draftMealType).map(o => o.service_date)
    );

    root.innerHTML = `
      ${renderBrand()}
      ${applicantHeader(`${mealEmoji(draftMealType)} ${mealLabel(draftMealType)} 신청`, { onBack: true, step: 1, totalSteps: 3 })}

      <div class="card step-card">
        <h2 class="step-h">날짜 선택</h2>
        <p class="step-desc">여러 날짜를 한번에 선택할 수 있어요. 이미 신청한 날은 점으로 표시됩니다.</p>

        <div class="date-quick">
          <button data-quick="today">오늘</button>
          <button data-quick="tomorrow">내일</button>
          <button data-quick="3">앞으로 3일</button>
          <button data-quick="clear">초기화</button>
        </div>

        ${renderDateChips(dates, draftDates, existing)}
      </div>

      <div class="step-action">
        <button class="btn btn-primary" id="stepNext" ${draftDates.length === 0 ? 'disabled' : ''}>
          ${draftDates.length === 0 ? '날짜를 선택해주세요'
            : `${draftDates.length}일 선택 · 다음으로`}
        </button>
      </div>
    `;

    $('#stepBack').addEventListener('click', goHome);

    document.querySelectorAll('[data-date]').forEach(b =>
      b.addEventListener('click', () => {
        const d = b.dataset.date;
        const i = draftDates.indexOf(d);
        if (i >= 0) draftDates.splice(i, 1);
        else draftDates.push(d);
        draftDates.sort();
        renderApplicantDate();
      }));

    document.querySelectorAll('[data-quick]').forEach(b =>
      b.addEventListener('click', () => {
        const q = b.dataset.quick;
        if (q === 'today') draftDates = [todayStr()];
        else if (q === 'tomorrow') draftDates = [addDays(todayStr(), 1)];
        else if (q === '3') draftDates = nextNDays(3);
        else if (q === 'clear') draftDates = [];
        renderApplicantDate();
      }));

    $('#stepNext').addEventListener('click', () => {
      if (draftDates.length === 0) return;
      // If single date and existing order present for late_night, pre-fill menu text
      if (draftMealType === 'late_night' && draftDates.length === 1) {
        const ex = myOrders.find(o => o.service_date === draftDates[0] && o.meal_type === 'late_night');
        if (ex) draftCustomText = ex.menu;
      }
      applicantStep = 'menu';
      renderApplicantStep();
    });
  }

  function renderApplicantMenu() {
    if (draftMealType === 'breakfast') return renderApplicantBreakfastMenu();
    return renderApplicantLateNightMenu();
  }

  async function fetchLateNightMenuForDate(date) {
    if (lateNightMenuByDate[date]) return lateNightMenuByDate[date];
    try {
      const r = await api(`/api/menu-items?meal_type=late_night&date=${encodeURIComponent(date)}`);
      lateNightMenuByDate[date] = r;
      return r;
    } catch (e) {
      return { period: null, kind: 'weekday', is_holiday: false, items: [] };
    }
  }

  function renderApplicantLateNightMenu() {
    // Pre-flight check: do all selected dates share the same kind (weekday vs holiday)?
    // If mixed, ask the user to split the request.
    const kinds = new Set(draftDates.map(d => holidaysSet.has(d) ? 'holiday' : 'weekday'));
    const mixed = kinds.size > 1;

    const dateLabel = draftDates.length === 1
      ? fmtFull(draftDates[0])
      : `${draftDates.length}일 (${draftDates.map(d => fmtDate(d, { withDow: false })).join(', ')})`;

    if (mixed) {
      const holidayDates = draftDates.filter(d => holidaysSet.has(d));
      const weekdayDates = draftDates.filter(d => !holidaysSet.has(d));
      root.innerHTML = `
        ${renderBrand()}
        ${applicantHeader(`🍜 야식 신청`, { onBack: true, step: 2, totalSteps: 3 })}
        <div class="card step-card">
          <h2 class="step-h">⚠️ 휴무일이 섞여있어요</h2>
          <p class="step-desc">선택한 날짜에 매장 휴무일과 상시일이 함께 있어 메뉴가 다릅니다. 분리해서 신청해주세요.</p>
          <div class="ln-split-info">
            <div class="ln-split-row">
              <span class="ln-split-label">상시일</span>
              <span class="ln-split-dates">${weekdayDates.map(d => fmtDate(d, { withDow: true })).join(', ')}</span>
            </div>
            <div class="ln-split-row holiday">
              <span class="ln-split-label">매장 휴무일</span>
              <span class="ln-split-dates">${holidayDates.map(d => fmtDate(d, { withDow: true })).join(', ')}</span>
            </div>
          </div>
          <div class="step-action" style="margin-top:14px;">
            <button class="btn btn-primary" id="splitToWeekday">${weekdayDates.length}일(상시) 먼저 신청</button>
            <button class="btn" id="splitToHoliday" style="margin-top:6px;">${holidayDates.length}일(휴무일) 먼저 신청</button>
          </div>
        </div>
      `;
      $('#stepBack').addEventListener('click', () => { applicantStep = 'date'; renderApplicantStep(); });
      $('#splitToWeekday').addEventListener('click', () => {
        draftDates = weekdayDates;
        renderApplicantLateNightMenu();
      });
      $('#splitToHoliday').addEventListener('click', () => {
        draftDates = holidayDates;
        renderApplicantLateNightMenu();
      });
      return;
    }

    // All dates share the same kind. Fetch menu for the first date (representative).
    const repDate = draftDates[0];
    const isHoliday = holidaysSet.has(repDate);

    // Show loading state then re-render with items
    root.innerHTML = `
      ${renderBrand()}
      ${applicantHeader(`🍜 야식 신청`, { onBack: true, step: 2, totalSteps: 3 })}
      <div class="card step-card">
        <h2 class="step-h">메뉴 불러오는 중...</h2>
      </div>
    `;
    $('#stepBack').addEventListener('click', () => { applicantStep = 'date'; renderApplicantStep(); });

    fetchLateNightMenuForDate(repDate).then(menuInfo => {
      const items = menuInfo.items || [];
      const period = menuInfo.period;

      root.innerHTML = `
        ${renderBrand()}
        ${applicantHeader(`🍜 야식 신청`, { onBack: true, step: 2, totalSteps: 3 })}

        <div class="card step-card">
          <h2 class="step-h">메뉴 선택</h2>
          <p class="step-desc">${escape(dateLabel)}</p>

          ${isHoliday ? `
            <div class="ln-day-banner holiday">
              <span class="ln-banner-emoji">🏪</span>
              <div>
                <div class="ln-banner-title">매장 휴무일</div>
                <div class="ln-banner-sub">상시일과 메뉴 구성이 다릅니다 (보통 4종)</div>
              </div>
            </div>
          ` : `
            <div class="ln-day-banner">
              <span class="ln-banner-emoji">🍽️</span>
              <div>
                <div class="ln-banner-title">상시일</div>
                <div class="ln-banner-sub">평일 야식 메뉴 (보통 5종)</div>
              </div>
            </div>
          `}

          ${period ? `
            <div class="ln-period-tag">${escape(period.label)} (${period.start_date.slice(5)} ~ ${period.end_date.slice(5)})</div>
          ` : ''}

          ${items.length === 0 ? `
            <div class="empty" style="margin-top:14px;">
              <span class="empty-emoji">📭</span>
              ${period ? '이 기간에 등록된 메뉴가 없습니다' : '해당 날짜에 정의된 메뉴 기간이 없습니다'}<br/>
              <span style="font-size:11px;color:var(--muted);">직접 입력으로 신청 가능합니다</span>
            </div>
          ` : `
            <p class="ln-priority-hint">
              ${draftLnPriority.length === 0
                ? '메뉴를 탭하면 1순위로 추가됩니다. 다른 메뉴를 추가로 탭하면 2·3순위로 추가돼요 (최대 3개)'
                : `${draftLnPriority.length}개 선택됨${draftLnPriority.length >= 3 ? ' · 최대 도달' : ' · 더 추가하려면 다른 메뉴 탭'}`}
            </p>
            <div class="menu-grid">
              ${items.map(it => {
                const idx = draftLnPriority.indexOf(it.name);
                const isSel = idx >= 0;
                const rank = idx + 1;
                return `
                  <button class="menu-chip ln-chip ${isSel ? 'selected' : ''}" data-menu="${escape(it.name)}">
                    ${isSel ? `<span class="ln-chip-rank">${rank}</span>` : ''}
                    <span>${escape(it.name)}</span>
                  </button>
                `;
              }).join('')}
            </div>
          `}

          <div class="field" style="margin-top:14px;margin-bottom:0;">
            <label for="menuInput">직접 입력 (선택)</label>
            <textarea class="textarea" id="menuInput" maxlength="200"
              placeholder="예: 안 매운걸로 / 채식">${escape(draftCustomText)}</textarea>
          </div>
        </div>

        <div class="step-action">
          <button class="btn btn-primary" id="stepSubmit" ${(draftLnPriority.length === 0 && !draftCustomText.trim()) ? 'disabled' : ''}>
            ${(draftLnPriority.length === 0 && !draftCustomText.trim())
              ? '메뉴를 선택해주세요'
              : (draftDates.length === 1 ? '신청하기' : `${draftDates.length}일 신청하기`)}
          </button>
        </div>
      `;

      $('#stepBack').addEventListener('click', () => { applicantStep = 'date'; renderApplicantStep(); });

      document.querySelectorAll('[data-menu]').forEach(b =>
        b.addEventListener('click', () => {
          const name = b.dataset.menu;
          const i = draftLnPriority.indexOf(name);
          if (i >= 0) {
            draftLnPriority.splice(i, 1);
          } else {
            if (draftLnPriority.length >= 3) {
              toast('최대 3개까지만 선택할 수 있어요');
              return;
            }
            draftLnPriority.push(name);
          }
          renderApplicantLateNightMenu();
        }));

      const ta = $('#menuInput');
      if (ta) {
        ta.addEventListener('input', () => {
          draftCustomText = ta.value;
          // Just re-enable the submit button label; no full re-render to keep focus
          const btn = $('#stepSubmit');
          if (btn) {
            const hasAny = draftLnPriority.length > 0 || draftCustomText.trim();
            btn.disabled = !hasAny;
            btn.textContent = !hasAny
              ? '메뉴를 선택해주세요'
              : (draftDates.length === 1 ? '신청하기' : `${draftDates.length}일 신청하기`);
          }
        });
      }

      $('#stepSubmit').addEventListener('click', async () => {
        const taEl = $('#menuInput');
        const custom = ((taEl ? taEl.value : '') || draftCustomText || '').trim();
        if (draftLnPriority.length === 0 && !custom) {
          toast('메뉴를 선택하거나 입력해주세요'); return;
        }
        await submitOrders({
          selection: { priority: draftLnPriority.slice(), custom },
        });
      });
    });  // end of fetchLateNightMenuForDate().then(...)
  }

  function renderApplicantBreakfastMenu() {
    // bfStep initial = 'form'
    if (!bfStep) bfStep = 'form';
    if (bfStep === 'form') return renderBfForm();
    if (bfStep === 'kimbap') return renderBfKimbap();
    if (bfStep === 'tier') return renderBfTier();
    if (bfStep === 'fallback') return renderBfFallback();
    if (bfStep === 'note') return renderBfNote();
    bfStep = 'form'; return renderBfForm();
  }

  // ----- Step: Choose meal_form -----
  function renderBfForm() {
    const dateLabel = draftDates.length === 1
      ? fmtFull(draftDates[0])
      : `${draftDates.length}일`;
    root.innerHTML = `
      ${renderBrand()}
      ${applicantHeader('🍳 조식 신청', { onBack: true, step: 2, totalSteps: 3 })}

      <div class="card step-card">
        <h2 class="step-h">식사 형태</h2>
        <p class="step-desc">${escape(dateLabel)} · 어떤 형태로 드실까요?</p>

        <div class="choice-grid" style="margin-top:8px;">
          <button class="choice-card breakfast" data-form="snack_pick">
            <span class="emoji">🥣</span>
            <span class="name">스낵픽</span>
            <span class="count">선식·죽·빵·햄버거 등</span>
          </button>
          <button class="choice-card late_night" data-form="kimbap">
            <span class="emoji">🍙</span>
            <span class="name">김밥/주먹밥</span>
            <span class="count">요일별 고정 메뉴</span>
          </button>
        </div>

        <button class="btn btn-ghost skip-meal-btn" id="noMealBtn" style="margin-top:10px;">
          🙅 오늘은 안 받을게요
        </button>
      </div>
    `;
    $('#stepBack').addEventListener('click', () => { applicantStep = 'date'; renderApplicantStep(); });

    // 패스 버튼: 메모 없이 바로 신청
    const noMealBtn = document.getElementById('noMealBtn');
    if (noMealBtn) {
      noMealBtn.addEventListener('click', async () => {
        draftMealForm = 'no_meal';
        await submitOrders({ selection: { meal_form: 'no_meal' } });
      });
    }

    document.querySelectorAll('[data-form]').forEach(b =>
      b.addEventListener('click', () => {
        const f = b.dataset.form;
        draftMealForm = f;
        if (f === 'kimbap') {
          bfStep = 'kimbap';
        } else {
          // Pre-fill from existing single-date order if same form
          if (draftDates.length === 1) {
            const ex = myOrders.find(o =>
              o.service_date === draftDates[0] &&
              o.meal_type === 'breakfast' &&
              o.selection && o.selection.meal_form === 'snack_pick'
            );
            if (ex && Array.isArray(ex.selection.category_priorities)) {
              draftPriorities = ex.selection.category_priorities.map(cc => ({
                category_id: cc.category_id,
                slots: Object.fromEntries((cc.slots || []).filter(s => !s.fixed).map(s => [
                  s.slot_id, { priority: (s.priority || []).slice(), any: !!s.any }
                ])),
              }));
              draftFallbackAny = !!ex.selection.fallback_any;
              draftNote = ex.selection.note || '';
            }
          }
          // Start fresh if nothing to prefill
          if (draftPriorities.length === 0) draftPriorities = [];
          draftBuildingTier = draftPriorities.length; // append new tier
          bfStep = 'tier';
          ensureTierDraft();
        }
        renderApplicantBreakfastMenu();
      }));
  }

  // ----- Step: no_meal (식사 안 받음) -----
  function renderBfNoMeal() {
    root.innerHTML = `
      ${renderBrand()}
      ${applicantHeader('🙅‍♀️ 식사 안 받음', { onBack: true, step: 3, totalSteps: 3 })}

      <div class="card step-card">
        <h2 class="step-h">출근은 하지만 식사는 안 받아요</h2>
        <p class="step-desc">
          이렇게 신청하면 액팅이 식사를 가져갈 필요는 없지만,
          그 날의 멤버 명단에는 포함되어 인원 파악에 사용돼요.
        </p>

        <div class="field" style="margin-top:14px;margin-bottom:0;">
          <label for="noteInput">메모 (선택)</label>
          <textarea class="textarea" id="noteInput" maxlength="200"
            placeholder="예: 외부 일정 / 다이어트 중 / 본인이 따로 챙김">${escape(draftNote)}</textarea>
        </div>
      </div>

      <div class="step-action">
        <button class="btn btn-primary" id="stepSubmit">
          ${draftDates.length === 1 ? '신청하기' : `${draftDates.length}일 신청하기`}
        </button>
      </div>
    `;
    $('#stepBack').addEventListener('click', () => { bfStep = 'form'; renderApplicantBreakfastMenu(); });
    const noteTa = $('#noteInput');
    if (noteTa) noteTa.addEventListener('input', () => { draftNote = noteTa.value; });
    $('#stepSubmit').addEventListener('click', async () => {
      await submitOrders({
        selection: { meal_form: 'no_meal', note: draftNote }
      });
    });
  }

  // ----- Step: kimbap pick -----
  function renderBfKimbap() {
    const opts = kimbapOptions.filter(k => k.active);
    root.innerHTML = `
      ${renderBrand()}
      ${applicantHeader('🍙 김밥/주먹밥', { onBack: true, step: 3, totalSteps: 3 })}

      <div class="card step-card">
        <h2 class="step-h">선택</h2>
        <p class="step-desc">오늘 제공되는 김밥/주먹밥을 골라주세요. 요일별로 메뉴가 다릅니다.</p>

        ${opts.length === 0 ? `
          <div class="empty"><span class="empty-emoji">📭</span>등록된 항목이 없습니다</div>
        ` : `
          <div class="menu-grid">
            ${opts.map(o => `
              <button class="menu-chip ${draftKimbapChoice === o.name ? 'selected' : ''}" data-kimbap="${escape(o.name)}">
                ${escape(o.name)}
              </button>
            `).join('')}
          </div>
        `}

        <div class="field" style="margin-top:14px;margin-bottom:0;">
          <label for="noteInput">메모 (선택)</label>
          <textarea class="textarea" id="noteInput" maxlength="200"
            placeholder="예: 단무지 빼주세요">${escape(draftNote)}</textarea>
        </div>
      </div>

      <div class="step-action">
        <button class="btn btn-primary" id="stepSubmit" ${!draftKimbapChoice ? 'disabled' : ''}>
          ${!draftKimbapChoice ? '선택해주세요'
            : draftDates.length === 1 ? '신청하기' : `${draftDates.length}일 신청하기`}
        </button>
      </div>
    `;
    $('#stepBack').addEventListener('click', () => { bfStep = 'form'; renderApplicantBreakfastMenu(); });
    document.querySelectorAll('[data-kimbap]').forEach(b =>
      b.addEventListener('click', () => {
        draftKimbapChoice = b.dataset.kimbap;
        renderBfKimbap();
      }));
    const noteTa = $('#noteInput');
    if (noteTa) noteTa.addEventListener('input', () => { draftNote = noteTa.value; });
    $('#stepSubmit').addEventListener('click', async () => {
      if (!draftKimbapChoice) return;
      await submitOrders({
        selection: { meal_form: 'kimbap', kimbap_choice: draftKimbapChoice, note: draftNote }
      });
    });
  }

  function ensureTierDraft() {
    if (draftBuildingTier === draftPriorities.length) {
      draftPriorities.push({ category_id: null, slots: {} });
    }
  }

  function tierLabel(i) { return i === 0 ? '1순위' : i === 1 ? '2순위' : i === 2 ? '3순위' : `${i+1}순위`; }

  // ----- Step: configure one priority tier (pick category + slots) -----
  function renderBfTier() {
    ensureTierDraft();
    const tier = draftPriorities[draftBuildingTier];
    const cats = breakfastStructure.filter(c => c.active !== false);
    const usedCatIds = new Set(draftPriorities.slice(0, draftBuildingTier).map(p => p.category_id).filter(Boolean));
    const availableCats = cats.filter(c => !usedCatIds.has(c.id));

    // If category not yet chosen for this tier, show category picker
    if (!tier.category_id) {
      const isFirst = draftBuildingTier === 0;
      const prevText = draftBuildingTier > 0 ? draftPriorities[draftBuildingTier - 1] : null;
      const prevName = prevText && breakfastStructure.find(c => c.id === prevText.category_id)?.name || '';

      root.innerHTML = `
        ${renderBrand()}
        ${applicantHeader('🥣 스낵픽', { onBack: true, step: 3, totalSteps: 3 })}

        <div class="card step-card">
          ${renderTierProgress()}
          <h2 class="step-h">${tierLabel(draftBuildingTier)} 대분류</h2>
          <p class="step-desc">
            ${isFirst ? '먼저 받고 싶은 종류를 골라주세요.' :
              `<strong>${escape(prevName)}</strong>이(가) 없을 때 받을 ${tierLabel(draftBuildingTier)} 대분류를 골라주세요.`}
          </p>

          ${availableCats.length === 0 ? `
            <div class="empty"><span class="empty-emoji">✅</span>더 추가할 카테고리가 없습니다</div>
          ` : `
            <div class="cat-grid">
              ${availableCats.map(c => `
                <button class="cat-card" data-cat="${c.id}">
                  <span class="cat-emoji">${c.emoji || '🍽️'}</span>
                  <span class="cat-name">${escape(c.name)}</span>
                </button>
              `).join('')}
            </div>
          `}
        </div>
      `;

      $('#stepBack').addEventListener('click', () => {
        // Back from category picker → if first tier, back to form; else back to fallback question of previous tier
        if (draftBuildingTier === 0) {
          // Drop empty tier
          if (tier && !tier.category_id) draftPriorities.pop();
          bfStep = 'form';
        } else {
          draftPriorities.pop(); // discard the empty new tier
          draftBuildingTier--;
          bfStep = 'fallback';
        }
        renderApplicantBreakfastMenu();
      });

      document.querySelectorAll('[data-cat]').forEach(b =>
        b.addEventListener('click', () => {
          tier.category_id = Number(b.dataset.cat);
          tier.slots = {};
          renderApplicantBreakfastMenu();
        }));
      return;
    }

    // Category chosen: show slot editor
    const cat = breakfastStructure.find(c => c.id === tier.category_id);
    if (!cat) {
      // Category was deleted; reset
      tier.category_id = null;
      renderApplicantBreakfastMenu();
      return;
    }
    const slots = cat.slots || [];
    const optionSlots = slots.filter(s => !s.is_fixed);
    const fixedSlots = slots.filter(s => s.is_fixed);

    const incomplete = optionSlots.some(s => {
      const sel = tier.slots[s.id] || {};
      const pri = Array.isArray(sel.priority) ? sel.priority : [];
      return pri.length === 0 && !sel.any;
    });

    root.innerHTML = `
      ${renderBrand()}
      ${applicantHeader('🥣 스낵픽', { onBack: true, step: 3, totalSteps: 3 })}

      <div class="card step-card">
        ${renderTierProgress()}
        <div class="cat-header">
          <span class="cat-header-emoji">${cat.emoji || '🍽️'}</span>
          <div class="cat-header-text">
            <div class="cat-header-name">${tierLabel(draftBuildingTier)} · ${escape(cat.name)}</div>
            <div class="cat-header-sub">슬롯별로 우선순위를 선택하세요. 품절 대비로 2순위까지 선택 가능.</div>
          </div>
          <button class="btn-ghost btn-sm cat-change" id="changeCat">변경</button>
        </div>

        ${optionSlots.length === 0 ? `
          <div class="empty" style="margin-top:14px;">
            <span class="empty-emoji">✅</span>
            선택할 옵션이 없어요. 다음으로 진행하시면 됩니다.
          </div>
        ` : optionSlots.map(s => renderSlotEditor(s, tier)).join('')}

        ${fixedSlots.length > 0 ? `
          <div class="fixed-block">
            <div class="fixed-label">기본 포함</div>
            <div class="fixed-list">
              ${fixedSlots.map(s => `<span class="fixed-chip">${escape(s.fixed_text || s.name)}</span>`).join('')}
            </div>
          </div>
        ` : ''}
      </div>

      <div class="step-action">
        <button class="btn btn-primary" id="stepNext" ${incomplete ? 'disabled' : ''}>
          ${incomplete ? '모든 슬롯을 선택해주세요' : '다음으로'}
        </button>
      </div>
    `;

    $('#stepBack').addEventListener('click', () => {
      // Back from slot editor: clear category to go back to category picker
      tier.category_id = null;
      tier.slots = {};
      renderApplicantBreakfastMenu();
    });

    $('#changeCat').addEventListener('click', () => {
      tier.category_id = null;
      tier.slots = {};
      renderApplicantBreakfastMenu();
    });

    document.querySelectorAll('[data-slot-opt]').forEach(b =>
      b.addEventListener('click', () => {
        const slotId = Number(b.dataset.slot);
        const opt = b.dataset.slotOpt;
        const cur = tier.slots[slotId] || { priority: [], any: false };
        const i = cur.priority.indexOf(opt);
        if (i >= 0) cur.priority.splice(i, 1);
        else cur.priority.push(opt);
        tier.slots[slotId] = cur;
        renderBfTier();
      }));

    document.querySelectorAll('[data-slot-any]').forEach(b =>
      b.addEventListener('click', () => {
        const slotId = Number(b.dataset.slot);
        const cur = tier.slots[slotId] || { priority: [], any: false };
        cur.any = !cur.any;
        tier.slots[slotId] = cur;
        renderBfTier();
      }));

    $('#stepNext').addEventListener('click', () => {
      if (incomplete) return;
      bfStep = 'fallback';
      renderApplicantBreakfastMenu();
    });
  }

  function renderTierProgress() {
    if (draftPriorities.length === 0) return '';
    const tiers = draftPriorities.map((p, i) => {
      const cat = p.category_id ? breakfastStructure.find(c => c.id === p.category_id) : null;
      const name = cat ? cat.name : '?';
      const isCur = i === draftBuildingTier;
      return `<span class="tier-pill ${isCur ? 'cur' : ''}">${i+1}. ${escape(name)}</span>`;
    }).join('<span class="tier-arrow">→</span>');
    return `<div class="tier-progress">${tiers}</div>`;
  }

  function renderSlotEditor(s, tier) {
    const sel = tier.slots[s.id] || { priority: [], any: false };
    const opts = Array.isArray(s.options) ? s.options : [];
    return `
      <div class="slot-block">
        <div class="slot-title">
          <span>${escape(s.name)}</span>
          <span class="slot-hint">${sel.priority.length === 0 && !sel.any ? '선택 필요' : `${sel.priority.length}개 선택`}</span>
        </div>
        <div class="slot-options">
          ${opts.map(opt => {
            const idx = sel.priority.indexOf(opt);
            const isSel = idx >= 0;
            const order = idx + 1;
            return `
              <button class="slot-opt ${isSel ? 'selected' : ''}" data-slot="${s.id}" data-slot-opt="${escape(opt)}">
                ${isSel ? `<span class="opt-rank">${order}</span>` : ''}
                <span>${escape(opt)}</span>
              </button>
            `;
          }).join('')}
        </div>
        <button class="slot-any ${sel.any ? 'on' : ''}" data-slot-any data-slot="${s.id}">
          ${sel.any ? '✓ 모두 없으면 아무거나 OK' : '없으면 아무거나 받기'}
        </button>
      </div>
    `;
  }

  // ----- Step: fallback question ("선식이 없으면 어떡할까요?") -----
  function renderBfFallback() {
    const curTier = draftPriorities[draftBuildingTier];
    const cat = breakfastStructure.find(c => c.id === curTier.category_id);
    const curName = cat ? cat.name : '?';
    const remainingCats = breakfastStructure.filter(c =>
      c.active !== false && !draftPriorities.slice(0, draftBuildingTier + 1).some(p => p.category_id === c.id)
    );
    const canAddMore = remainingCats.length > 0 && draftPriorities.length < 5;

    root.innerHTML = `
      ${renderBrand()}
      ${applicantHeader('🥣 스낵픽', { onBack: true, step: 3, totalSteps: 3 })}

      <div class="card step-card">
        ${renderTierProgress()}
        <h2 class="step-h">📍 ${escape(curName)}도 없으면?</h2>
        <p class="step-desc">대분류 자체가 품절일 때를 대비해서 추가 옵션을 정할 수 있어요.</p>

        <div class="fallback-grid">
          ${canAddMore ? `
            <button class="fallback-card" data-fb="next">
              <span class="fb-emoji">➕</span>
              <span class="fb-name">${tierLabel(draftBuildingTier + 1)} 추가하기</span>
              <span class="fb-desc">다른 대분류를 ${tierLabel(draftBuildingTier + 1)}로 지정</span>
            </button>
          ` : ''}
          <button class="fallback-card" data-fb="any">
            <span class="fb-emoji">🎲</span>
            <span class="fb-name">아무거나 받기</span>
            <span class="fb-desc">액팅이 남아있는 거 골라서 가져옴</span>
          </button>
          <button class="fallback-card" data-fb="stop">
            <span class="fb-emoji">🛑</span>
            <span class="fb-name">여기까지만</span>
            <span class="fb-desc">${escape(curName)}이(가) 없으면 신청 안 받음 (액팅이 보면 메모로 처리)</span>
          </button>
        </div>
      </div>
    `;

    $('#stepBack').addEventListener('click', () => {
      // Back to slot editor of current tier
      renderApplicantBreakfastMenu();
    });

    document.querySelectorAll('[data-fb]').forEach(b =>
      b.addEventListener('click', () => {
        const action = b.dataset.fb;
        if (action === 'next') {
          draftBuildingTier++;
          ensureTierDraft();
          bfStep = 'tier';
        } else if (action === 'any') {
          draftFallbackAny = true;
          bfStep = 'note';
        } else { // stop
          draftFallbackAny = false;
          bfStep = 'note';
        }
        renderApplicantBreakfastMenu();
      }));
  }

  // ----- Step: note + submit -----
  function renderBfNote() {
    const summary = summarizeSelection({
      meal_form: 'snack_pick',
      category_priorities: draftPriorities.map(p => buildCategoryChoice(p)),
      fallback_any: draftFallbackAny,
    });

    root.innerHTML = `
      ${renderBrand()}
      ${applicantHeader('🥣 스낵픽', { onBack: true, step: 3, totalSteps: 3 })}

      <div class="card step-card">
        <h2 class="step-h">최종 확인</h2>
        <p class="step-desc">아래 신청 내용으로 제출합니다.</p>

        <div class="summary-box">${escape(summary)}</div>

        <div class="field" style="margin-top:14px;margin-bottom:0;">
          <label for="noteInput">메모 (선택)</label>
          <textarea class="textarea" id="noteInput" maxlength="200"
            placeholder="예: 땅콩 알러지, 단무지 빼주세요">${escape(draftNote)}</textarea>
        </div>
      </div>

      <div class="step-action">
        <button class="btn btn-primary" id="stepSubmit">
          ${draftDates.length === 1 ? '신청하기' : `${draftDates.length}일 신청하기`}
        </button>
      </div>
    `;

    $('#stepBack').addEventListener('click', () => { bfStep = 'fallback'; renderApplicantBreakfastMenu(); });

    const noteTa = $('#noteInput');
    if (noteTa) noteTa.addEventListener('input', () => { draftNote = noteTa.value; });

    $('#stepSubmit').addEventListener('click', async () => {
      await submitOrders({
        selection: {
          meal_form: 'snack_pick',
          category_priorities: draftPriorities.map(p => buildCategoryChoice(p)),
          fallback_any: draftFallbackAny,
          note: draftNote,
        }
      });
    });
  }

  // Convert internal draft tier to API category choice
  function buildCategoryChoice(p) {
    const cat = breakfastStructure.find(c => c.id === p.category_id);
    if (!cat) return { category_id: p.category_id, slots: [] };
    const slots = (cat.slots || []).filter(s => !s.is_fixed).map(s => {
      const sel = p.slots[s.id] || { priority: [], any: false };
      return { slot_id: s.id, priority: sel.priority, any: !!sel.any };
    });
    return { category_id: p.category_id, slots };
  }

  // Shared submit (both meal types)
  async function submitOrders(payload) {
    const btn = $('#stepSubmit');
    if (btn) { btn.disabled = true; btn.textContent = '신청 중...'; }
    try {
      const body = {
        meal_type: draftMealType,
        dates: draftDates,
        ...payload,
      };
      const r = await api('/api/orders/batch', { method: 'POST', body: JSON.stringify(body) });
      lastSubmitted = {
        meal_type: draftMealType,
        dates: [...draftDates],
        created: r.created,
        updated: r.updated,
        // For done screen display
        menu: payload.menu || null,
        selection: payload.selection || null,
      };
      await loadMyOrders();
      applicantStep = 'done';
      renderApplicantStep();
    } catch (e) {
      toast(e.message);
      if (btn) { btn.disabled = false; btn.textContent = draftDates.length === 1 ? '신청하기' : `${draftDates.length}일 신청하기`; }
    }
  }

  function renderApplicantDone() {
    if (!lastSubmitted) { goHome(); return; }
    const { meal_type, menu, selection, dates, created, updated } = lastSubmitted;
    const summaryText = [
      created.length ? `${created.length}일 신청` : '',
      updated.length ? `${updated.length}일 수정` : '',
    ].filter(Boolean).join(' · ');
    const sortedDates = [...dates].sort();
    const displayMenu = menu || (selection ? summarizeSelection(selection) : '');

    root.innerHTML = `
      ${renderBrand()}
      ${applicantHeader('신청 완료', { onBack: false, step: 3, totalSteps: 3 })}

      <div class="card step-card done-card">
        <div class="done-emoji">✅</div>
        <h2 class="done-h">${escape(summaryText || '신청 완료')}</h2>
        <p class="step-desc" style="text-align:center;">
          ${mealEmoji(meal_type)} ${mealLabel(meal_type)}
          ${displayMenu ? '· ' + escape(displayMenu) : ''}
        </p>
        <ul class="done-dates">
          ${sortedDates.map(d => `<li>${fmtFull(d)}</li>`).join('')}
        </ul>
        <div class="done-actions">
          <button class="btn" id="doneViewBarcode">📱 내 바코드 보기</button>
          <button class="btn btn-primary" id="doneHome">홈으로</button>
        </div>
        <p class="muted-note" style="text-align:center;margin-top:10px;">
          현황은 언제든 홈에서 다시 볼 수 있어요.
        </p>
      </div>
    `;

    $('#stepClose').addEventListener('click', goHome);
    $('#doneHome').addEventListener('click', goHome);
    $('#doneViewBarcode').addEventListener('click', () => {
      const sorted = sortOrders(myOrders);
      const target = sorted.findIndex(o =>
        o.meal_type === meal_type && sortedDates.includes(o.service_date)
      );
      if (target >= 0) {
        openOrderViewer(sorted, target, { allowPickup: false });
      } else {
        toast('바코드를 표시할 신청이 없습니다');
      }
    });
  }

  // Build a short summary string from a structured breakfast selection (client-side)
  function summarizeCatChoice(cc) {
    const cat = breakfastStructure.find(c => c.id === Number(cc.category_id));
    const emoji = (cat && cat.emoji) || cc.category_emoji || '';
    const name = (cat && cat.name) || cc.category_name || '';
    const parts = [];
    for (const s of (cc.slots || [])) {
      if (s.fixed) { parts.push(s.fixed); continue; }
      const pri = Array.isArray(s.priority) ? s.priority : [];
      let txt = pri.join('→');
      if (s.any) txt = txt ? `${txt}→아무거나` : '아무거나';
      if (txt) parts.push(txt);
    }
    const detail = parts.join(' | ');
    return detail ? `${emoji}${name} · ${detail}` : `${emoji}${name}`;
  }

  function summarizeSelection(sel) {
    if (!sel) return '';
    if (sel.meal_form === 'kimbap') {
      return `🍙 ${sel.kimbap_choice || ''}`;
    }
    if (sel.meal_form === 'snack_pick') {
      const prios = Array.isArray(sel.category_priorities) ? sel.category_priorities : [];
      if (prios.length === 0) return '';
      const tiers = prios.map((cc, i) => `${i + 1}순위 ${summarizeCatChoice(cc)}`).join(' → ');
      const tail = sel.fallback_any ? ' → 🎲아무거나' : '';
      return `🥣 ${tiers}${tail}`;
    }
    // Legacy fallback
    const cat = breakfastStructure.find(c => c.id === Number(sel.category_id));
    const name = (cat && cat.name) || sel.category_name || '';
    const parts = [];
    for (const s of (Array.isArray(sel.slots) ? sel.slots : [])) {
      if (s.fixed) continue;
      const pri = Array.isArray(s.priority) ? s.priority : [];
      let txt = pri.join('→');
      if (s.any) txt = txt ? `${txt}→아무거나` : '아무거나';
      if (txt) parts.push(txt);
    }
    return `${name}${parts.length ? ' · ' + parts.join(' | ') : ''}`;
  }

  function goHome() {
    applicantStep = 'home';
    draftMealType = null;
    draftDates = [];
    draftMenuName = '';
    draftCustomText = '';
    draftLnPriority = [];
    resetBreakfastDraft();
    renderApplicantHome();
  }

  function resetBreakfastDraft() {
    bfStep = null;
    draftMealForm = null;
    draftKimbapChoice = null;
    draftPriorities = [];
    draftFallbackAny = false;
    draftBuildingTier = null;
    draftNote = '';
  }

  function renderApplicant() {
    if (applicantStep === 'home') renderApplicantHome();
    else renderApplicantStep();
  }

  // ===== ACTING =====
  async function renderActingChoose() {
    const today = todayStr();
    const tomorrow = addDays(today, 1);
    const countFor = (mt, d) => {
      const r = activeSummary.find(x => x.service_date === d && x.meal_type === mt);
      return r ? r.n : 0;
    };

    root.innerHTML = `
      ${renderBrand()}
      <div class="topbar">
        <h1>액팅</h1>
        <button class="btn btn-ghost btn-sm" id="switchRole">역할 전환</button>
      </div>
      <p style="margin:4px 4px 16px;color:var(--muted);font-size:13px;">
        먼저 어떤 식사를 보러 가실지 선택하세요.
      </p>
      <div class="choice-grid">
        <button class="choice-card breakfast" data-meal="breakfast">
          <span class="emoji">🍳</span>
          <span class="name">조식</span>
          <span class="count">오늘 ${countFor('breakfast', today)} · 내일 ${countFor('breakfast', tomorrow)}</span>
        </button>
        <button class="choice-card late_night" data-meal="late_night">
          <span class="emoji">🍜</span>
          <span class="name">야식</span>
          <span class="count">오늘 ${countFor('late_night', today)} · 내일 ${countFor('late_night', tomorrow)}</span>
        </button>
      </div>
    `;

    $('#switchRole').addEventListener('click', () => { saveRole(null); render(); });
    document.querySelectorAll('[data-meal]').forEach(c =>
      c.addEventListener('click', () => {
        actingMealType = c.dataset.meal;
        actingDate = todayStr();
        actingStep = 'list';
        renderActing();
      }));
  }

  async function renderActingList() {
    const dates = nextNDays(7);
    const withOrders = new Set(
      activeSummary.filter(x => x.meal_type === actingMealType).map(x => x.service_date)
    );

    // Compute counts per category
    const isBreakfast = actingMealType === 'breakfast';
    const counts = {
      all: activeOrders.length,
      snack_pick: 0,
      kimbap: 0,
      no_meal: 0,
      other: 0,
    };
    for (const o of activeOrders) {
      const form = o.selection && o.selection.meal_form;
      if (form === 'snack_pick') counts.snack_pick++;
      else if (form === 'kimbap') counts.kimbap++;
      else if (form === 'no_meal') counts.no_meal++;
      else counts.other++;
    }

    // Apply filter
    const filtered = activeOrders.filter(o => {
      if (actingFilter === 'all') return true;
      const form = o.selection && o.selection.meal_form;
      return form === actingFilter;
    });

    // Group orders (only relevant for breakfast and "all" view)
    const groups = [];
    if (isBreakfast && actingFilter === 'all') {
      const byForm = { snack_pick: [], kimbap: [], no_meal: [], other: [] };
      for (const o of filtered) {
        const form = (o.selection && o.selection.meal_form) || 'other';
        (byForm[form] || byForm.other).push(o);
      }
      if (byForm.snack_pick.length) groups.push({ key: 'snack_pick', label: '🥣 스낵픽', items: byForm.snack_pick });
      if (byForm.kimbap.length) groups.push({ key: 'kimbap', label: '🍙 김밥/주먹밥', items: byForm.kimbap });
      if (byForm.no_meal.length) groups.push({ key: 'no_meal', label: '🙅‍♀️ 미수령 (식사 안 받음)', items: byForm.no_meal });
      if (byForm.other.length) groups.push({ key: 'other', label: '기타', items: byForm.other });
    } else {
      // Single-group view (filter selected) or non-breakfast
      groups.push({ key: actingFilter, label: '', items: filtered });
    }

    // Pickup-able orders only (for viewer; no_meal doesn't have anything to pick up)
    const pickupableOrders = activeOrders.filter(o => {
      const form = o.selection && o.selection.meal_form;
      return form !== 'no_meal';
    });

    // Filter tab button helper
    const filterBtn = (key, emoji, label, n) => {
      const active = actingFilter === key;
      return `<button class="act-filter ${active ? 'active' : ''}" data-filter="${key}">
        <span class="af-label">${emoji}${label}</span>
        <span class="af-count">${n}</span>
      </button>`;
    };

    root.innerHTML = `
      ${renderBrand()}
      <div class="topbar">
        <button class="btn btn-ghost btn-sm" id="backBtn">← 뒤로</button>
        <h1 style="flex:1;text-align:center;font-size:18px;">
          ${mealEmoji(actingMealType)} ${mealLabel(actingMealType)}
        </h1>
        <button class="btn btn-ghost btn-sm" id="switchRole">전환</button>
      </div>

      <div class="section-title" style="margin-top:14px;">
        <h2>날짜</h2>
        <span class="hint">${fmtFull(actingDate)}</span>
      </div>
      ${renderDateChips(dates, [actingDate], withOrders)}

      ${isBreakfast ? `
        <div class="act-filter-row">
          ${filterBtn('all', '', '전체', counts.all)}
          ${filterBtn('snack_pick', '🥣', ' 스낵픽', counts.snack_pick)}
          ${filterBtn('kimbap', '🍙', ' 김밥', counts.kimbap)}
          ${filterBtn('no_meal', '🙅‍♀️', ' 미수령', counts.no_meal)}
        </div>
      ` : ''}

      <div class="section-title">
        <h2>${actingFilter === 'all' ? `대기 중 (${filtered.length}건)` : `${filtered.length}건`}</h2>
        <span class="hint">탭하면 바코드</span>
      </div>

      <div class="order-list">
        ${filtered.length === 0 ? `
          <div class="empty">
            <span class="empty-emoji">🌙</span>
            ${fmtDate(actingDate)} ${mealLabel(actingMealType)}
            ${actingFilter === 'all' ? '신청이 없어요' : '에 해당하는 신청이 없어요'}
          </div>
        ` : groups.map(g => `
          ${g.label ? `<div class="group-header">${g.label} <span class="group-count">${g.items.length}</span></div>` : ''}
          ${g.items.map(o => {
            const isNoMeal = o.selection && o.selection.meal_form === 'no_meal';
            const isLateNight = o.meal_type === 'late_night';
            const showQuickPickup = isLateNight && !isNoMeal;
            return `
              <div class="order-card ${isNoMeal ? 'no-meal' : ''} ${showQuickPickup ? 'with-quick' : ''}" data-card-id="${o.id}">
                <div class="order-main" data-id="${o.id}">
                  <div class="meal-badge ${o.meal_type}">${isNoMeal ? '🙅‍♀️' : mealEmoji(o.meal_type)}</div>
                  <div class="order-body">
                    <div class="order-name">
                      ${escape(o.name)}
                      <span class="order-eid">${escape(o.employee_id)}</span>
                    </div>
                    ${renderOrderDetailDark(o)}
                  </div>
                  ${showQuickPickup ? '' : '<div class="order-chevron">›</div>'}
                </div>
                ${showQuickPickup ? `
                  <button class="quick-pickup" data-quick-pickup="${o.id}" aria-label="수령 완료">
                    <span class="qp-check">✓</span>
                    <span class="qp-text">수령<br/>완료</span>
                  </button>
                ` : ''}
              </div>
            `;
          }).join('')}
        `).join('')}
      </div>
    `;

    $('#backBtn').addEventListener('click', () => { actingStep = 'choose'; render(); });
    $('#switchRole').addEventListener('click', () => { saveRole(null); render(); });

    document.querySelectorAll('[data-date]').forEach(b =>
      b.addEventListener('click', async () => {
        actingDate = b.dataset.date;
        await loadActiveOrders();
        renderActing();
      }));

    document.querySelectorAll('[data-filter]').forEach(b =>
      b.addEventListener('click', () => {
        actingFilter = b.dataset.filter;
        renderActingList();
      }));

    document.querySelectorAll('.order-main').forEach(c =>
      c.addEventListener('click', () => {
        const id = Number(c.dataset.id);
        // Find the order
        const order = activeOrders.find(o => o.id === id);
        if (!order) return;
        // no_meal orders open in a simpler info modal (no barcode pickup loop)
        if (order.selection && order.selection.meal_form === 'no_meal') {
          openNoMealInfo(order, {
            onConfirmed: async () => {
              toast('미수령으로 처리되었습니다');
              await Promise.all([loadActiveOrders(), loadActiveSummary()]);
              renderActing();
            }
          });
          return;
        }
        // Late-night: card body click is a no-op since the quick-pickup button handles it.
        if (order.meal_type === 'late_night') {
          return;
        }
        // Breakfast (snack_pick / kimbap): open barcode viewer
        const list = pickupableOrders;
        const startIdx = list.findIndex(o => o.id === id);
        if (startIdx >= 0) {
          openOrderViewer(list, startIdx, {
            allowPickup: true,
            onDataChanged: async () => {
              await Promise.all([loadActiveOrders(), loadActiveSummary()]);
              renderActing();
            }
          });
        }
      }));

    // Late-night quick-pickup button: pick up directly without opening modal
    document.querySelectorAll('[data-quick-pickup]').forEach(b =>
      b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const id = Number(b.dataset.quickPickup);
        const order = activeOrders.find(o => o.id === id);
        const name = order ? order.name : '';
        b.disabled = true;
        // Visual confirmation: card briefly turns green
        const card = b.closest('.order-card');
        if (card) card.classList.add('picking-up');
        try {
          await api(`/api/orders/${id}/pickup`, { method: 'POST' });
          if (name) toast(`✓ ${name} 수령 완료`);
          await Promise.all([loadActiveOrders(), loadActiveSummary()]);
          renderActing();
        } catch (e) {
          if (card) card.classList.remove('picking-up');
          b.disabled = false;
          toast(e.message);
        }
      }));
  }

  // Lightweight info card for no_meal orders (no barcode shown — nothing to scan)
  function openNoMealInfo(order, opts = {}) {
    const onConfirmed = opts.onConfirmed || (() => {});
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="viewer-content" style="padding:24px;">
          <div class="modal-header">
            <div class="modal-title">🙅‍♀️ 미수령 · ${fmtDate(order.service_date, { withMonth: true })}</div>
            <button class="modal-close" data-close aria-label="닫기">✕</button>
          </div>
          <div class="id-name">${escape(order.name)}</div>
          <div class="id-eid">사번 ${escape(order.employee_id)}</div>
          <div class="no-meal-banner">
            <div class="nm-emoji">🙅‍♀️</div>
            <div>
              <div class="nm-title">식사 안 받음</div>
              <div class="nm-sub">출근은 했지만 식사 수령은 안 한다고 신청했어요.</div>
            </div>
          </div>
          ${order.selection && order.selection.note ? `
            <div class="id-menu" style="margin-top:14px;">
              <span class="label">메모</span>
              ${escape(order.selection.note)}
            </div>
          ` : ''}
          <p style="margin-top:14px;font-size:12px;color:#666;line-height:1.5;">
            확인을 누르면 목록에서 제거되어 더 이상 액팅 화면에 보이지 않습니다.
          </p>
          <div class="modal-actions" style="margin-top:16px;">
            <button class="btn btn-ghost-light" data-close>닫기</button>
            <button class="btn" data-confirm-no-meal>확인 (제거)</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    function close() {
      overlay.remove();
      document.body.style.overflow = '';
    }
    overlay.addEventListener('click', async (e) => {
      if (e.target === overlay) { close(); return; }
      if (e.target.closest && e.target.closest('[data-close]')) { close(); return; }
      if (e.target.closest && e.target.closest('[data-confirm-no-meal]')) {
        const btn = e.target.closest('[data-confirm-no-meal]');
        btn.disabled = true;
        btn.textContent = '처리 중...';
        try {
          // Mark as picked_up so it's removed from the pending list
          await api(`/api/orders/${order.id}/pickup`, { method: 'POST' });
          close();
          await onConfirmed();
        } catch (err) {
          toast(err.message);
          btn.disabled = false;
          btn.textContent = '확인 (제거)';
        }
      }
    });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
  }

  function renderActing() {
    if (actingStep === 'choose') renderActingChoose();
    else renderActingList();
  }

  // One-line menu summary for the modal (shown below barcode)
  function renderMenuOneLine(order) {
    const sel = order.selection;
    if (order.meal_type === 'breakfast' && sel) {
      if (sel.meal_form === 'kimbap') {
        return `🍙 ${escape(sel.kimbap_choice || '')}${sel.note ? ` · 📝 ${escape(sel.note)}` : ''}`;
      }
      if (sel.meal_form === 'snack_pick') {
        const prios = Array.isArray(sel.category_priorities) ? sel.category_priorities : [];
        const parts = prios.map((cc, i) => {
          const cat = breakfastStructure.find(c => c.id === Number(cc.category_id));
          const emoji = (cat && cat.emoji) || cc.category_emoji || '';
          const name = escape((cat && cat.name) || cc.category_name || '');
          const optParts = (cc.slots || []).map(s => {
            if (s.fixed) return s.fixed;
            const pri = Array.isArray(s.priority) ? s.priority : [];
            let txt = pri.join('→');
            if (s.any) txt = txt ? `${txt}→아무거나` : '아무거나';
            return txt;
          }).filter(Boolean);
          const detail = optParts.join(' | ');
          const label = detail ? ` · ${detail}` : '';
          return `<span class="vc-tier-chip ${i === 0 ? 'primary' : 'secondary'}">${i+1}순위 ${emoji}${name}${label}</span>`;
        }).join('');
        const fallback = sel.fallback_any ? ' <span class="vc-note">🎲 아무거나OK</span>' : '';
        const note = sel.note ? ` <span class="vc-note">📝 ${escape(sel.note)}</span>` : '';
        return parts + fallback + note;
      }
      if (Array.isArray(sel.slots)) {
        const parts = sel.slots.filter(s => !s.fixed && Array.isArray(s.priority) && s.priority.length)
          .map(s => s.priority.join('→')).join(' | ');
        return `${sel.category_name ? escape(sel.category_name) + ' · ' : ''}${parts}${sel.note ? ` 📝 ${escape(sel.note)}` : ''}`;
      }
    }
    if (order.meal_type === 'late_night' && sel && Array.isArray(sel.priority) && sel.priority.length > 0) {
      const parts = sel.priority.map((name, i) =>
        `<span class="vc-tier-chip ${i === 0 ? 'primary' : 'secondary'}">${i+1}순위 ${escape(name)}</span>`
      ).join('');
      const note = sel.custom ? ` <span class="vc-note">📝 ${escape(sel.custom)}</span>` : '';
      return parts + note;
    }
    return escape(order.menu);
  }

  // Renders a single category choice (one priority tier) on light surface — compact card for horizontal scroll
  function renderCategoryChoiceLight(cc, tierIdx) {
    const catName = cc.category_name || '';
    const catEmoji = cc.category_emoji || '🍽️';
    const slots = cc.slots || [];

    const rowsHtml = slots.map(s => {
      if (s.fixed) {
        return `<div class="vtier-row"><span class="vtier-rowname">${escape(s.slot_name)}</span><span class="vtier-rowval fixed">${escape(s.fixed)}</span></div>`;
      }
      const pri = Array.isArray(s.priority) ? s.priority : [];
      const chips = pri.map((v, i) =>
        `<span class="vtier-chip"><span class="vtier-chip-rank">${i+1}</span>${escape(v)}</span>`
      ).join('');
      const anyHtml = s.any ? `<span class="vtier-chip any">아무거나 OK</span>` : '';
      const valHtml = (pri.length === 0 && !s.any)
        ? '<span class="vtier-empty">—</span>'
        : `${chips}${anyHtml}`;
      return `<div class="vtier-row"><span class="vtier-rowname">${escape(s.slot_name)}</span><span class="vtier-rowval">${valHtml}</span></div>`;
    }).join('');

    return `
      <div class="vtier-card ${tierIdx === 0 ? 'primary' : 'secondary'}">
        <div class="vtier-head">
          <span class="vtier-badge">${tierIdx + 1}순위</span>
          <span class="vtier-cat">${catEmoji} ${escape(catName)}</span>
        </div>
        ${rowsHtml}
      </div>
    `;
  }

  // Renders an order's content (menu / structured breakfast selection) on a light/white surface (used in viewer modal)
  function renderOrderDetailLight(order) {
    const sel = order.selection;
    if (order.meal_type === 'breakfast' && sel) {
      if (sel.meal_form === 'no_meal') {
        return `
          <div class="no-meal-banner" style="margin-top:14px;">
            <div class="nm-emoji">🙅‍♀️</div>
            <div>
              <div class="nm-title">식사 안 받음</div>
              <div class="nm-sub">출근은 했지만 식사는 받지 않아요.</div>
            </div>
          </div>
          ${sel.note ? `<div class="id-menu" style="margin-top:10px;"><span class="label">메모</span>${escape(sel.note)}</div>` : ''}
        `;
      }
      if (sel.meal_form === 'kimbap') {
        return `
          <div class="vtier-card primary" style="margin-top:14px;">
            <div class="vtier-head">
              <span class="vtier-badge">🍙</span>
              <span class="vtier-cat">${escape(sel.kimbap_choice || '')}</span>
            </div>
          </div>
          ${sel.note ? `<div class="det-note">📝 ${escape(sel.note)}</div>` : ''}
        `;
      }
      if (sel.meal_form === 'snack_pick') {
        const prios = Array.isArray(sel.category_priorities) ? sel.category_priorities : [];
        const tiersHtml = prios.map((cc, i) => renderCategoryChoiceLight(cc, i)).join('');
        const fallbackHtml = sel.fallback_any
          ? `<div class="fallback-note"><span class="fb-icon">🎲</span> 위 메뉴들이 모두 없으면 <strong>아무거나</strong> 받아가셔도 OK</div>`
          : '';
        return `
          <div class="vtier-list">
            ${tiersHtml}
          </div>
          ${fallbackHtml}
          ${sel.note ? `<div class="det-note">📝 ${escape(sel.note)}</div>` : ''}
        `;
      }
      // Legacy schema
      if (Array.isArray(sel.slots)) {
        const catName = sel.category_name || '';
        const catEmoji = sel.category_emoji || '🍽️';
        return renderCategoryChoiceLight({
          category_name: catName,
          category_emoji: catEmoji,
          slots: sel.slots,
        }, 0) + (sel.note ? `<div class="det-note">📝 ${escape(sel.note)}</div>` : '');
      }
    }
    return `
      <div class="id-menu">
        <span class="label">메뉴</span>
        ${escape(order.menu)}
      </div>
    `;
  }

  // Renders structured detail on dark surface — compact 1~2 line summary for acting list
  function renderOrderDetailDark(order) {
    const sel = order.selection;
    if (order.meal_type === 'breakfast' && sel) {
      if (sel.meal_form === 'kimbap') {
        return `<div class="order-menu compact">🍙 ${escape(sel.kimbap_choice || '')}${sel.note ? ` · 📝${escape(sel.note)}` : ''}</div>`;
      }
      if (sel.meal_form === 'snack_pick') {
        const prios = Array.isArray(sel.category_priorities) ? sel.category_priorities : [];
        const rows = prios.map((cc, i) => {
          const cat = breakfastStructure.find(c => c.id === Number(cc.category_id));
          const emoji = (cat && cat.emoji) || cc.category_emoji || '';
          const name = escape((cat && cat.name) || cc.category_name || '');
          const optParts = (cc.slots || []).map(s => {
            if (s.fixed) return s.fixed;
            const pri = Array.isArray(s.priority) ? s.priority : [];
            let txt = pri.join('→');
            if (s.any) txt = txt ? `${txt}→아무거나` : '아무거나';
            return txt;
          }).filter(Boolean);
          const detail = optParts.join(' | ');
          return `<div class="rank-row-dark"><span class="d-rank">${i+1}</span><span class="rank-row-text">${emoji}${name}${detail ? ' · ' + detail : ''}</span></div>`;
        });
        if (sel.fallback_any) rows.push(`<div class="rank-row-dark"><span class="rank-row-text muted-rank">🎲 아무거나</span></div>`);
        if (sel.note) rows.push(`<div class="rank-row-dark"><span class="rank-row-text muted-rank">📝 ${escape(sel.note)}</span></div>`);
        return `<div class="order-menu-rows">${rows.join('')}</div>`;
      }
      // Legacy slots
      if (Array.isArray(sel.slots)) {
        const parts = sel.slots.filter(s => !s.fixed && Array.isArray(s.priority) && s.priority.length).map(s =>
          `${escape(s.slot_name)}: ${escape(s.priority[0])}${s.priority[1] ? `→${escape(s.priority[1])}` : ''}`
        ).join(' · ');
        const catLabel = sel.category_name ? `[${escape(sel.category_name)}] ` : '';
        return `<div class="order-menu compact">${catLabel}${parts}${sel.note ? ` 📝${escape(sel.note)}` : ''}</div>`;
      }
    }
    // Late-night with priority selection
    if (order.meal_type === 'late_night' && sel && Array.isArray(sel.priority) && sel.priority.length > 0) {
      const rows = sel.priority.map((name, i) =>
        `<span class="d-pri"><span class="d-rank">${i+1}</span>${escape(name)}</span>`
      ).join('');
      return `
        <div class="struct-mini">
          ${rows ? `<div class="d-row" style="flex-wrap:wrap;gap:4px;">${rows}</div>` : ''}
          ${sel.custom ? `<div class="struct-note">📝 ${escape(sel.custom)}</div>` : ''}
        </div>
      `;
    }
    return `<div class="order-menu">${escape(order.menu)}</div>`;
  }

  // ===== Order viewer (swipeable, used by acting & applicant) =====
  function openOrderViewer(initialOrders, startIndex = 0, opts = {}) {
    if (!initialOrders || initialOrders.length === 0) {
      toast('표시할 항목이 없습니다');
      return;
    }
    const allowPickup = !!opts.allowPickup;
    let orders = [...initialOrders];
    let idx = Math.max(0, Math.min(startIndex, orders.length - 1));
    let dataChanged = false;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="viewer-content" id="viewerContent"></div>
        <div class="viewer-nav">
          <button class="nav-btn" id="navPrev" aria-label="이전">‹</button>
          <div class="viewer-indicator">
            <span id="viewerCount"></span>
            <span class="swipe-hint"></span>
          </div>
          <button class="nav-btn" id="navNext" aria-label="다음">›</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    const content = overlay.querySelector('#viewerContent');
    const prevBtn = overlay.querySelector('#navPrev');
    const nextBtn = overlay.querySelector('#navNext');
    const countEl = overlay.querySelector('#viewerCount');

    function renderCard(animDir = 0) {
      if (orders.length === 0) { close(); return; }
      if (idx >= orders.length) idx = orders.length - 1;
      if (idx < 0) idx = 0;
      const order = orders[idx];

      const isLateNight = order.meal_type === 'late_night';

      const card = document.createElement('div');
      card.className = 'viewer-card';
      if (animDir > 0) card.classList.add('enter-right');
      else if (animDir < 0) card.classList.add('enter-left');
      card.innerHTML = `
        <div class="vc-top-row">
          <div class="vc-meta">${mealEmoji(order.meal_type)} ${mealLabel(order.meal_type)} · ${fmtDate(order.service_date, { withMonth: true })}</div>
          <button class="modal-close" data-action="close" aria-label="닫기">✕</button>
        </div>
        <div class="vc-name">${escape(order.name || user.name)}</div>
        <div class="vc-eid">사번 ${escape(order.employee_id || user.employee_id)}</div>
        ${isLateNight ? `
          <div class="late-night-menu-block">
            <div class="ln-viewer-label">야식 메뉴</div>
            <div class="vc-menu-summary">${renderMenuOneLine(order)}</div>
          </div>
        ` : `
          <div class="barcode-wrap">
            <svg class="barcode-svg"></svg>
          </div>
          <div class="vc-menu-summary">${renderMenuOneLine(order)}</div>
        `}
        <div class="modal-actions">
          <button class="btn btn-ghost-light" data-action="close">닫기</button>
          ${allowPickup ? `<button class="btn" data-action="pickup">수령 완료 · 다음</button>` : ''}
        </div>
      `;

      content.innerHTML = '';
      content.appendChild(card);

      if (!isLateNight) {
        try {
          JsBarcode(card.querySelector('.barcode-svg'), String(order.employee_id || user.employee_id), {
            format: 'CODE128', displayValue: false,
            height: 90, margin: 6, background: '#ffffff', lineColor: '#000000',
          });
        } catch (e) { console.error('barcode error', e); }
      }

      countEl.textContent = orders.length > 1 ? `${idx + 1} / ${orders.length}` : '';
      prevBtn.style.visibility = orders.length > 1 ? 'visible' : 'hidden';
      nextBtn.style.visibility = orders.length > 1 ? 'visible' : 'hidden';
      prevBtn.disabled = idx === 0;
      nextBtn.disabled = idx === orders.length - 1;
    }

    function go(dir) {
      if (dir < 0 && idx > 0) { idx--; renderCard(-1); }
      else if (dir > 0 && idx < orders.length - 1) { idx++; renderCard(1); }
      else {
        const card = content.firstElementChild;
        if (card) {
          card.style.transition = 'transform .12s';
          card.style.transform = `translateX(${dir > 0 ? -12 : 12}px)`;
          setTimeout(() => { card.style.transform = ''; setTimeout(() => card.style.transition = '', 150); }, 120);
        }
      }
    }

    async function doPickup() {
      if (!allowPickup) return;
      const order = orders[idx];
      const btn = content.querySelector('[data-action="pickup"]');
      if (btn) { btn.disabled = true; btn.textContent = '처리 중...'; }
      try {
        await api(`/api/orders/${order.id}/pickup`, { method: 'POST' });
        toast(`${order.name}님 수령 완료`);
        dataChanged = true;
        orders.splice(idx, 1);
        if (orders.length === 0) { close(); return; }
        if (idx >= orders.length) idx = orders.length - 1;
        renderCard(1);
      } catch (e) {
        toast(e.message);
        if (btn) { btn.disabled = false; btn.textContent = '수령 완료 · 다음'; }
      }
    }

    function close() {
      overlay.removeEventListener('click', overlayClick);
      document.removeEventListener('keydown', keyHandler);
      overlay.remove();
      document.body.style.overflow = '';
      if (dataChanged && typeof opts.onDataChanged === 'function') opts.onDataChanged();
      if (typeof opts.onClose === 'function') opts.onClose();
    }

    function overlayClick(e) {
      if (e.target === overlay) { close(); return; }
      const action = e.target.closest?.('[data-action]')?.dataset.action;
      if (action === 'close') close();
      else if (action === 'pickup') doPickup();
    }
    overlay.addEventListener('click', overlayClick);
    prevBtn.addEventListener('click', () => go(-1));
    nextBtn.addEventListener('click', () => go(1));

    function keyHandler(e) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (allowPickup && e.key === 'Enter') { e.preventDefault(); doPickup(); }
    }
    document.addEventListener('keydown', keyHandler);

    // Touch swipe
    let startX = null, startY = null, dragX = 0, isDragging = false;
    const SWIPE_THRESHOLD = 55;

    content.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      isDragging = false;
      dragX = 0;
    }, { passive: true });

    content.addEventListener('touchmove', (e) => {
      if (startX === null) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (!isDragging) {
        if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
          isDragging = true;
        } else if (Math.abs(dy) > 12) {
          startX = null; return;
        } else return;
      }
      dragX = dx;
      const card = content.firstElementChild;
      if (card) {
        let applied = dx;
        if ((idx === 0 && dx > 0) || (idx === orders.length - 1 && dx < 0)) {
          applied = dx * 0.3;
        }
        card.style.transition = 'none';
        card.style.transform = `translateX(${applied}px)`;
        card.style.opacity = String(Math.max(0.4, 1 - Math.abs(applied) / 420));
      }
    }, { passive: true });

    content.addEventListener('touchend', () => {
      if (startX === null) return;
      const card = content.firstElementChild;
      if (!isDragging) { startX = null; return; }
      isDragging = false;
      const moved = dragX;
      startX = null; startY = null; dragX = 0;
      if (card) {
        card.style.transition = '';
        if (moved < -SWIPE_THRESHOLD && idx < orders.length - 1) go(1);
        else if (moved > SWIPE_THRESHOLD && idx > 0) go(-1);
        else { card.style.transform = ''; card.style.opacity = ''; }
      }
    });

    renderCard(0);
    return { close };
  }

  // ===== ADMIN =====
  async function renderAdmin() {
    root.innerHTML = `
      ${renderBrand()}
      <div class="topbar">
        <h1>🛠️ 관리자</h1>
        <button class="btn btn-ghost btn-sm" id="switchRole">역할 전환</button>
      </div>
      <p style="margin:4px 4px 16px;color:var(--muted);font-size:13px;">
        조식은 카테고리·슬롯·옵션을, 야식은 메뉴 칩을 관리합니다.
      </p>

      <div class="tabs">
        <button class="tab ${adminMealTab==='breakfast'?'active':''}" data-tab="breakfast">🍳 조식 구조</button>
        <button class="tab ${adminMealTab==='late_night'?'active':''}" data-tab="late_night">🍜 야식 메뉴</button>
        <button class="tab ${adminMealTab==='manual'?'active':''}" data-tab="manual">📋 수동 입력</button>
        <button class="tab ${adminMealTab==='log'?'active':''}" data-tab="log">📊 수령 로그</button>
        <button class="tab ${adminMealTab==='notice'?'active':''}" data-tab="notice">📢 공지</button>
      </div>

      <div id="adminBody"></div>
    `;

    $('#switchRole').addEventListener('click', () => { saveRole(null); render(); });
    document.querySelectorAll('.tab').forEach(t =>
      t.addEventListener('click', () => { if (t.dataset.tab !== 'manual') manualStep = 'info'; adminMealTab = t.dataset.tab; renderAdmin(); }));

    if (adminMealTab === 'breakfast') renderAdminBreakfast();
    else if (adminMealTab === 'manual') renderAdminManual();
    else if (adminMealTab === 'log') renderAdminLog();
    else if (adminMealTab === 'notice') renderAdminNotice();
    else renderAdminLateNight();
  }

  // ===== Admin Manual Entry State =====
  let manualStep = 'info';   // 'info' | 'menu'
  let manualEmpId = '';
  let manualName = '';
  let manualDate = '';
  let manualMealType = 'breakfast';
  let manualLog = [];
  // menu draft reuses draftMealType, draftMenuName, draftCustomText, bfStep, draftMealForm,
  // draftPriorities, draftFallbackAny, draftKimbapChoice, draftNote

  function renderAdminManual() {
    if (manualStep === 'menu') {
      renderAdminManualMenu();
    } else {
      renderAdminManualInfo();
    }
  }

  function renderAdminManualInfo() {
    const todayInput = new Date().toISOString().slice(0, 10);
    if (!manualDate) manualDate = todayInput;

    $('#adminBody').innerHTML = `
      <div class="section-title"><h2>수동 신청 입력</h2></div>
      <p style="color:var(--muted);font-size:13px;margin:0 4px 12px;">사번·이름을 입력한 뒤 기존 방식으로 메뉴를 선택합니다.</p>
      <div class="manual-form">
        <div class="manual-row">
          <input class="input" id="mEmpId" maxlength="10" placeholder="사번 (예: 12345)" inputmode="numeric" value="${escape(manualEmpId)}" />
          <input class="input" id="mName" maxlength="20" placeholder="이름" value="${escape(manualName)}" />
        </div>
        <div class="manual-row">
          <input class="input" id="mDate" type="date" value="${manualDate}" />
          <select class="input" id="mMealType">
            <option value="breakfast" ${manualMealType==='breakfast'?'selected':''}>🍳 조식</option>
            <option value="late_night" ${manualMealType==='late_night'?'selected':''}>🍜 야식</option>
          </select>
        </div>
        <button class="btn btn-primary" id="mNextBtn" style="margin-top:6px;">메뉴 선택하기 →</button>
      </div>
      ${manualLog.length ? `<div id="manualLogBox" style="margin-top:14px;font-size:13px;">${manualLog.map(l=>l).join('')}</div>` : ''}
    `;

    $('#mNextBtn').addEventListener('click', async () => {
      const employee_id = $('#mEmpId').value.trim();
      const name = $('#mName').value.trim();
      const service_date = $('#mDate').value.trim();
      const meal_type = $('#mMealType').value;
      if (!employee_id || !name || !service_date) {
        toast('사번·이름·날짜를 모두 입력해주세요'); return;
      }
      manualEmpId = employee_id;
      manualName = name;
      manualDate = service_date;
      manualMealType = meal_type;

      // Reset menu draft state (same as applicant flow)
      draftMealType = meal_type;
      draftDates = [service_date];
      draftMenuName = '';
      draftCustomText = '';
      resetBreakfastDraft();

      // Ensure menu data is loaded
      if ((menuItemsCache.late_night || []).length === 0) await loadMenuItems();
      if (!breakfastStructure.length) await loadBreakfastStructure();

      manualStep = 'menu';
      renderAdminManual();
    });
  }

  function renderAdminManualMenu() {
    const adminBody = $('#adminBody');

    // Header with back button and person info
    const infoBar = `
      <div class="section-title" style="margin-bottom:8px;">
        <h2>수동 신청 — 메뉴 선택</h2>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
        <button class="btn btn-ghost" id="mBackBtn" style="padding:6px 12px;font-size:13px;">← 뒤로</button>
        <span style="font-size:13px;color:var(--muted);">
          ${escape(manualName)} (${escape(manualEmpId)}) · ${manualDate} · ${manualMealType==='breakfast'?'🍳 조식':'🍜 야식'}
        </span>
      </div>
    `;

    adminBody.innerHTML = infoBar + `<div id="manualMenuArea"></div>`;

    document.getElementById('mBackBtn').addEventListener('click', () => {
      manualStep = 'info';
      renderAdminManual();
    });

    // Render the appropriate menu picker into #manualMenuArea
    if (manualMealType === 'late_night') {
      renderAdminManualLateNight();
    } else {
      renderAdminManualBreakfast();
    }
  }

  function renderAdminManualLateNight() {
    const items = menuItemsCache.late_night || [];
    const area = document.getElementById('manualMenuArea');
    area.innerHTML = `
      <div class="card step-card" style="margin:0;">
        <h2 class="step-h">메뉴 선택</h2>
        ${items.length === 0 ? `
          <div class="empty" style="margin-top:8px;">
            <span class="empty-emoji">📭</span>등록된 메뉴가 없습니다.
          </div>
        ` : `
          <div class="menu-grid">
            ${items.map(it => `
              <button class="menu-chip ${draftMenuName===it.name?'selected':''}" data-menu="${escape(it.name)}">
                ${escape(it.name)}
              </button>
            `).join('')}
          </div>
        `}
        <div class="field" style="margin-top:14px;margin-bottom:0;">
          <label for="mMenuInput">직접 입력 (선택)</label>
          <textarea class="textarea" id="mMenuInput" maxlength="200"
            placeholder="예: 컵라면, 안 매운걸로">${escape(draftCustomText)}</textarea>
        </div>
      </div>
      <div class="step-action" style="padding:12px 0 0;">
        <button class="btn btn-primary" id="mSubmitBtn">등록하기</button>
      </div>
    `;

    area.querySelectorAll('[data-menu]').forEach(b =>
      b.addEventListener('click', () => {
        draftMenuName = b.dataset.menu;
        draftCustomText = '';
        renderAdminManualLateNight();
      }));

    const ta = document.getElementById('mMenuInput');
    ta.addEventListener('input', () => {
      draftCustomText = ta.value;
      if (draftCustomText) draftMenuName = '';
    });

    document.getElementById('mSubmitBtn').addEventListener('click', async () => {
      const menu = (draftCustomText || '').trim() || draftMenuName;
      if (!menu) { toast('메뉴를 선택하거나 입력해주세요'); return; }
      await submitAdminManual({ menu });
    });
  }

  function renderAdminManualBreakfast() {
    // Reuse the applicant breakfast flow but render into #manualMenuArea
    // We temporarily swap root → manualMenuArea, then swap back after events are attached
    const area = document.getElementById('manualMenuArea');
    const origRoot = root;

    // Proxy: point rendering to area
    const fakeRoot = { innerHTML: '' };
    Object.defineProperty(fakeRoot, 'innerHTML', {
      set(v) { area.innerHTML = v; },
      get() { return area.innerHTML; }
    });

    // Patch $ to search inside area for step actions
    const origInner = root.innerHTML;

    // Use the real applicant breakfast renders but intercept submitOrders
    // We render directly using existing functions with root pointing to area
    // Simplest approach: temporarily replace root innerHTML target

    // Since root is a const pointing to #app, we can't replace it.
    // Instead, we inline the breakfast menu into the area using renderBfForm logic,
    // adapted to use #manualMenuArea as container.
    renderAdminManualBfForm();
  }

  function renderAdminManualBfForm() {
    if (!bfStep) bfStep = 'form';
    const area = document.getElementById('manualMenuArea');
    if (!area) return;

    if (bfStep === 'form') _renderAdminBfFormPicker(area);
    else if (bfStep === 'kimbap') _renderAdminBfKimbap(area);
    else if (bfStep === 'tier') _renderAdminBfTier(area);
    else if (bfStep === 'fallback') _renderAdminBfFallback(area);
    else if (bfStep === 'note') _renderAdminBfNote(area);
    else { bfStep = 'form'; _renderAdminBfFormPicker(area); }
  }

  function _areaRefreshBf() {
    const area = document.getElementById('manualMenuArea');
    if (area) renderAdminManualBfForm();
  }

  function _renderAdminBfFormPicker(area) {
    area.innerHTML = `
      <div class="card step-card" style="margin:0;">
        <h2 class="step-h">식사 형태</h2>
        <p class="step-desc">${manualDate} · 어떤 형태로 드실까요?</p>
        <div class="choice-grid" style="margin-top:8px;">
          <button class="choice-card breakfast" data-form="snack_pick">
            <span class="emoji">🥣</span>
            <span class="name">스낵픽</span>
            <span class="count">선식·죽·빵·햄버거 등</span>
          </button>
          <button class="choice-card late_night" data-form="kimbap">
            <span class="emoji">🍙</span>
            <span class="name">김밥/주먹밥</span>
            <span class="count">요일별 고정 메뉴</span>
          </button>
        </div>
        <button class="btn btn-ghost" id="aNoMealBtn" style="margin-top:10px;">🙅 오늘은 안 받을게요</button>
      </div>
    `;
    area.querySelectorAll('[data-form]').forEach(b =>
      b.addEventListener('click', () => {
        draftMealForm = b.dataset.form;
        if (b.dataset.form === 'kimbap') {
          bfStep = 'kimbap';
        } else {
          draftPriorities = [];
          draftBuildingTier = 0;
          bfStep = 'tier';
          ensureTierDraft();
        }
        _areaRefreshBf();
      }));
    document.getElementById('aNoMealBtn').addEventListener('click', async () => {
      draftMealForm = 'no_meal';
      await submitAdminManual({ selection: { meal_form: 'no_meal' } });
    });
  }

  function _renderAdminBfKimbap(area) {
    const opts = kimbapOptions.filter(o => o.active);
    area.innerHTML = `
      <div class="card step-card" style="margin:0;">
        <h2 class="step-h">김밥/주먹밥 선택</h2>
        <div class="menu-grid" style="margin-top:10px;">
          ${opts.map(o => `
            <button class="menu-chip ${draftKimbapChoice===o.name?'selected':''}" data-kname="${escape(o.name)}">
              ${escape(o.name)}
            </button>
          `).join('')}
        </div>
      </div>
      <div class="step-action" style="padding:12px 0 0;display:flex;gap:8px;">
        <button class="btn btn-ghost" id="aBfBack">← 뒤로</button>
        <button class="btn btn-primary" id="aBfKimbapNext">다음 →</button>
      </div>
    `;
    area.querySelectorAll('[data-kname]').forEach(b =>
      b.addEventListener('click', () => {
        draftKimbapChoice = b.dataset.kname;
        draftMenuName = b.dataset.kname;
        _renderAdminBfKimbap(area);
      }));
    document.getElementById('aBfBack').addEventListener('click', () => { bfStep = 'form'; _areaRefreshBf(); });
    document.getElementById('aBfKimbapNext').addEventListener('click', async () => {
      if (!draftKimbapChoice || !draftMenuName) { toast('메뉴를 선택해주세요'); return; }
      bfStep = 'note';
      _areaRefreshBf();
    });
  }

  function _renderAdminBfTier(area) {
    const tier = draftPriorities[draftBuildingTier];
    if (!tier) { bfStep = 'form'; _areaRefreshBf(); return; }

    // Phase A: 카테고리 아직 미선택 → 카테고리 피커
    if (!tier.category_id) {
      _renderAdminBfCatPicker(area, tier);
      return;
    }

    // Phase B: 카테고리 선택됨 → 슬롯 에디터
    _renderAdminBfSlotEditor(area, tier);
  }

  function _renderAdminBfCatPicker(area, tier) {
    const usedCatIds = new Set(
      draftPriorities.slice(0, draftBuildingTier).map(p => p.category_id).filter(Boolean)
    );
    const availableCats = breakfastStructure.filter(c => c.active !== false && !usedCatIds.has(c.id));

    area.innerHTML = `
      <div class="card step-card" style="margin:0;">
        <h2 class="step-h">${tierLabel(draftBuildingTier)} 대분류</h2>
        <p class="step-desc">${draftBuildingTier === 0 ? '먼저 받고 싶은 종류를 골라주세요.' : '이전 대분류가 없을 때 받을 종류를 골라주세요.'}</p>
        <div class="cat-grid" style="margin-top:8px;">
          ${availableCats.map(c => `
            <button class="cat-card" data-cat="${c.id}">
              <span class="cat-emoji">${c.emoji || '🍽️'}</span>
              <span class="cat-name">${escape(c.name)}</span>
            </button>
          `).join('')}
        </div>
      </div>
      <div class="step-action" style="padding:12px 0 0;">
        <button class="btn btn-ghost" id="aBfCatBack">← 뒤로</button>
      </div>
    `;
    area.querySelectorAll('[data-cat]').forEach(b =>
      b.addEventListener('click', () => {
        tier.category_id = Number(b.dataset.cat);
        tier.slots = {};
        _renderAdminBfTier(area);
      }));
    document.getElementById('aBfCatBack').addEventListener('click', () => {
      if (draftBuildingTier > 0) {
        draftPriorities.pop();
        draftBuildingTier--;
        bfStep = 'fallback';
      } else {
        if (!tier.category_id) draftPriorities.pop();
        bfStep = 'form';
      }
      _areaRefreshBf();
    });
  }

  function _renderAdminBfSlotEditor(area, tier) {
    const cat = breakfastStructure.find(c => c.id === tier.category_id);
    if (!cat) { tier.category_id = null; _renderAdminBfTier(area); return; }
    const optionSlots = (cat.slots || []).filter(s => !s.is_fixed);
    const fixedSlots = (cat.slots || []).filter(s => s.is_fixed);
    const incomplete = optionSlots.some(s => {
      const sel = tier.slots[s.id] || {};
      const pri = Array.isArray(sel.priority) ? sel.priority : [];
      return pri.length === 0 && !sel.any;
    });

    area.innerHTML = `
      <div class="card step-card" style="margin:0;">
        <div class="cat-header">
          <span class="cat-header-emoji">${cat.emoji || '🍽️'}</span>
          <div class="cat-header-text">
            <div class="cat-header-name">${tierLabel(draftBuildingTier)} · ${escape(cat.name)}</div>
            <div class="cat-header-sub">슬롯별로 우선순위를 선택하세요.</div>
          </div>
          <button class="btn-ghost btn-sm cat-change" id="aChangeCat">변경</button>
        </div>
        ${optionSlots.length === 0 ? `
          <div class="empty" style="margin-top:14px;">
            <span class="empty-emoji">✅</span>선택할 옵션이 없어요. 다음으로 진행하세요.
          </div>
        ` : optionSlots.map(s => renderSlotEditor(s, tier)).join('')}
        ${fixedSlots.length > 0 ? `
          <div class="fixed-block">
            <div class="fixed-label">기본 포함</div>
            <div class="fixed-list">
              ${fixedSlots.map(s => `<span class="fixed-chip">${escape(s.fixed_text || s.name)}</span>`).join('')}
            </div>
          </div>
        ` : ''}
      </div>
      <div class="step-action" style="padding:12px 0 0;">
        <button class="btn btn-primary" id="aBfSlotNext" ${incomplete ? 'disabled' : ''}>
          ${incomplete ? '모든 슬롯을 선택해주세요' : '다음으로'}
        </button>
      </div>
    `;

    document.getElementById('aChangeCat').addEventListener('click', () => {
      tier.category_id = null; tier.slots = {};
      _renderAdminBfTier(area);
    });

    area.querySelectorAll('[data-slot-opt]').forEach(b =>
      b.addEventListener('click', () => {
        const slotId = Number(b.dataset.slot);
        const opt = b.dataset.slotOpt;
        const cur = tier.slots[slotId] || { priority: [], any: false };
        const i = cur.priority.indexOf(opt);
        if (i >= 0) cur.priority.splice(i, 1);
        else cur.priority.push(opt);
        tier.slots[slotId] = cur;
        _renderAdminBfSlotEditor(area, tier);
      }));

    area.querySelectorAll('[data-slot-any]').forEach(b =>
      b.addEventListener('click', () => {
        const slotId = Number(b.dataset.slot);
        const cur = tier.slots[slotId] || { priority: [], any: false };
        cur.any = !cur.any;
        tier.slots[slotId] = cur;
        _renderAdminBfSlotEditor(area, tier);
      }));

    document.getElementById('aBfSlotNext').addEventListener('click', () => {
      if (incomplete) return;
      bfStep = 'fallback';
      _areaRefreshBf();
    });
  }

  function _renderAdminBfFallback(area) {
    const curTier = draftPriorities[draftBuildingTier];
    const cat = curTier ? breakfastStructure.find(c => c.id === curTier.category_id) : null;
    const curName = cat ? cat.name : '?';
    const remainingCats = breakfastStructure.filter(c =>
      c.active !== false && !draftPriorities.slice(0, draftBuildingTier + 1).some(p => p.category_id === c.id)
    );
    const canAddMore = remainingCats.length > 0 && draftPriorities.length < 5;

    area.innerHTML = `
      <div class="card step-card" style="margin:0;">
        <h2 class="step-h">📍 ${escape(curName)}도 없으면?</h2>
        <p class="step-desc">대분류 자체가 품절일 때 추가 옵션을 정하세요.</p>
        <div class="fallback-grid" style="margin-top:8px;">
          ${canAddMore ? `
            <button class="fallback-card" data-fb="next">
              <span class="fb-emoji">➕</span>
              <span class="fb-name">${tierLabel(draftBuildingTier + 1)} 추가하기</span>
              <span class="fb-desc">다른 대분류를 ${tierLabel(draftBuildingTier + 1)}로 지정</span>
            </button>
          ` : ''}
          <button class="fallback-card" data-fb="any">
            <span class="fb-emoji">🎲</span>
            <span class="fb-name">아무거나 받기</span>
            <span class="fb-desc">액팅이 남아있는 거 골라서 가져옴</span>
          </button>
          <button class="fallback-card" data-fb="stop">
            <span class="fb-emoji">🛑</span>
            <span class="fb-name">여기까지만</span>
            <span class="fb-desc">${escape(curName)}이(가) 없으면 신청 안 받음</span>
          </button>
        </div>
      </div>
      <div class="step-action" style="padding:12px 0 0;">
        <button class="btn btn-ghost" id="aBfFbBack">← 뒤로</button>
      </div>
    `;
    area.querySelectorAll('[data-fb]').forEach(b =>
      b.addEventListener('click', () => {
        const action = b.dataset.fb;
        if (action === 'next') {
          draftBuildingTier++;
          ensureTierDraft();
          bfStep = 'tier';
        } else if (action === 'any') {
          draftFallbackAny = true;
          bfStep = 'note';
        } else {
          draftFallbackAny = false;
          bfStep = 'note';
        }
        _areaRefreshBf();
      }));
    document.getElementById('aBfFbBack').addEventListener('click', () => {
      // 슬롯 에디터로 돌아감
      bfStep = 'tier';
      _areaRefreshBf();
    });
  }

  function _renderAdminBfNote(area) {
    area.innerHTML = `
      <div class="card step-card" style="margin:0;">
        <h2 class="step-h">메모 (선택)</h2>
        <div class="field" style="margin-top:8px;margin-bottom:0;">
          <textarea class="textarea" id="aBfNoteInput" maxlength="200"
            placeholder="예: 계란 알러지 / 두유 선호">${escape(draftNote)}</textarea>
        </div>
      </div>
      <div class="step-action" style="padding:12px 0 0;display:flex;gap:8px;">
        <button class="btn btn-ghost" id="aBfNoteBack">← 뒤로</button>
        <button class="btn btn-primary" id="aBfNoteSubmit">등록하기</button>
      </div>
    `;
    document.getElementById('aBfNoteInput').addEventListener('input', e => { draftNote = e.target.value; });
    document.getElementById('aBfNoteBack').addEventListener('click', () => {
      bfStep = draftMealForm === 'kimbap' ? 'kimbap' : 'fallback'; _areaRefreshBf();
    });
    document.getElementById('aBfNoteSubmit').addEventListener('click', async () => {
      let selection;
      if (draftMealForm === 'kimbap') {
        // 서버는 kimbap_choice(이름 문자열)를 기대함 — draftMenuName에 이름이 저장됨
        selection = { meal_form: 'kimbap', kimbap_choice: draftMenuName, note: draftNote };
      } else {
        selection = {
          meal_form: 'snack_pick',
          category_priorities: draftPriorities.map(p => buildCategoryChoice(p)),
          fallback_any: draftFallbackAny,
          note: draftNote,
        };
      }
      await submitAdminManual({ selection });
    });
  }

  async function submitAdminManual(payload) {
    const btn = document.getElementById('aBfNoteSubmit') || document.getElementById('mSubmitBtn');
    if (btn) { btn.disabled = true; btn.textContent = '등록 중...'; }
    try {
      let menu = payload.menu;
      if (!menu && payload.selection) menu = summarizeSelection(payload.selection);
      const res = await api('/api/admin/orders/manual', {
        method: 'POST',
        body: JSON.stringify({
          employee_id: manualEmpId,
          name: manualName,
          meal_type: manualMealType,
          service_date: manualDate,
          menu,
          selection: payload.selection || null,
        })
      });
      const msg = res.action === 'created' ? '✅ 등록됨' : '🔄 수정됨';
      const mealBadge = manualMealType === 'breakfast' ? '🍳 조식' : '🍜 야식';
      manualLog.unshift(`<div style="color:var(--accent);margin-bottom:6px;">${msg} — ${mealBadge} ${escape(manualName)}(${escape(manualEmpId)}) ${manualDate} ${escape(menu || '')}</div>`);
      toast(msg.replace(/[✅🔄] /, ''));
      // Reset for next entry: keep emp/name, clear meal draft
      draftMenuName = ''; draftCustomText = ''; resetBreakfastDraft();
      manualStep = 'info';
      renderAdminManual();
    } catch (e) {
      toast(e.message);
      if (btn) { btn.disabled = false; btn.textContent = '등록하기'; }
    }
  }

  // ===== Admin: Pickup Log =====
  async function renderAdminLog() {
    // Load activity dates (with counts) on first render
    if (!adminLogDate) {
      adminLogDate = todayStr();
    }
    try {
      adminLogDates = await api('/api/admin/pickup-log/dates');
    } catch (e) {
      adminLogDates = [];
      toast(e.message);
    }
    await loadAdminLogOrders();
    renderAdminLogContent();
  }

  async function loadAdminLogOrders() {
    try {
      adminLogOrders = await api(`/api/admin/pickup-log?date=${encodeURIComponent(adminLogDate)}`);
    } catch (e) {
      adminLogOrders = [];
      toast(e.message);
    }
  }

  function renderAdminLogContent() {
    const todayS = todayStr();
    // Build last 3 days (retention window)
    const dateOptions = [];
    for (let i = 0; i < 3; i++) {
      dateOptions.push(addDays(todayS, -i));
    }

    const countByDate = {};
    for (const d of adminLogDates) {
      countByDate[d.service_date] = d;
    }

    // Split orders into picked/pending
    const breakfast = { picked: [], pending: [] };
    const late_night = { picked: [], pending: [] };
    for (const o of adminLogOrders) {
      const bucket = o.meal_type === 'breakfast' ? breakfast : late_night;
      if (o.status === 'picked_up') bucket.picked.push(o);
      else bucket.pending.push(o);
    }

    const totalCount = adminLogOrders.length;
    const pickedCount = breakfast.picked.length + late_night.picked.length;
    const pendingCount = totalCount - pickedCount;

    $('#adminBody').innerHTML = `
      <p style="margin:4px 4px 12px;color:var(--muted);font-size:13px;">
        오늘 포함 최근 <strong>3일치</strong> 수령 기록을 볼 수 있어요. 그 이상은 자동 삭제됩니다.
      </p>

      <div class="log-date-row">
        ${dateOptions.map(d => {
          const info = countByDate[d];
          const total = info ? info.total : 0;
          const picked = info ? info.picked : 0;
          const isSel = d === adminLogDate;
          const dow = new Date(d + 'T00:00:00').getDay();
          const dowKor = ['일','월','화','수','목','금','토'][dow];
          const isToday = d === todayS;
          const label = isToday ? '오늘' : (d === addDays(todayS, -1) ? '어제' : '그저께');
          return `
            <button class="log-date-card ${isSel ? 'sel' : ''} ${total === 0 ? 'empty' : ''}" data-log-date="${d}">
              <div class="ldc-label">${label}</div>
              <div class="ldc-date">${d.slice(5)} (${dowKor})</div>
              <div class="ldc-counts">
                ${total === 0 ? '<span class="ldc-empty">신청 없음</span>'
                  : `<span class="ldc-picked">✓ ${picked}</span> · <span class="ldc-total">총 ${total}</span>`}
              </div>
            </button>
          `;
        }).join('')}
      </div>

      ${totalCount === 0 ? `
        <div class="empty" style="margin-top:18px;">
          <span class="empty-emoji">📭</span>
          ${fmtDate(adminLogDate)}에 신청 기록이 없습니다
        </div>
      ` : `
        <div class="log-stats">
          <div class="log-stat-card picked">
            <div class="ls-num">${pickedCount}</div>
            <div class="ls-lbl">✓ 수령 완료</div>
          </div>
          <div class="log-stat-card pending">
            <div class="ls-num">${pendingCount}</div>
            <div class="ls-lbl">⏳ 미수령 (대기 중)</div>
          </div>
        </div>

        ${renderLogSection('🍳 조식', breakfast)}
        ${renderLogSection('🍜 야식', late_night)}
      `}
    `;

    document.querySelectorAll('[data-log-date]').forEach(b =>
      b.addEventListener('click', async () => {
        adminLogDate = b.dataset.logDate;
        await loadAdminLogOrders();
        renderAdminLogContent();
      }));
  }

  function renderLogSection(title, bucket) {
    const total = bucket.picked.length + bucket.pending.length;
    if (total === 0) return '';
    // Combine: picked sorted by picked_up_at desc, then pending sorted by created_at
    const sortedPicked = bucket.picked.slice().sort((a, b) =>
      (b.picked_up_at || '').localeCompare(a.picked_up_at || '')
    );
    const sortedPending = bucket.pending.slice().sort((a, b) =>
      (a.created_at || '').localeCompare(b.created_at || '')
    );
    return `
      <div class="section-title" style="margin-top:18px;">
        <h2>${title} (${total})</h2>
      </div>
      <div class="log-list">
        ${sortedPicked.map(o => renderLogRow(o)).join('')}
        ${sortedPending.map(o => renderLogRow(o)).join('')}
      </div>
    `;
  }

  function renderLogRow(o) {
    const isPicked = o.status === 'picked_up';
    const isNoMeal = o.selection && o.selection.meal_form === 'no_meal';
    const time = isPicked && o.picked_up_at
      ? new Date(o.picked_up_at + 'Z').toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
      : '';
    const statusLabel = isPicked
      ? (isNoMeal ? '🙅 미수령 확인됨' : `✓ 수령 ${time}`)
      : (isNoMeal ? '⏳ 미수령 대기' : '⏳ 미수령');
    const menuSummary = renderLogMenuSummary(o);
    return `
      <div class="log-row ${isPicked ? 'picked' : 'pending'} ${isNoMeal ? 'no-meal' : ''}">
        <div class="lr-head">
          <span class="lr-name">${escape(o.name)}</span>
          <span class="lr-eid">${escape(o.employee_id)}</span>
          <span class="lr-status">${statusLabel}</span>
        </div>
        <div class="lr-menu">${menuSummary}</div>
      </div>
    `;
  }

  function renderLogMenuSummary(o) {
    const sel = o.selection;
    if (!sel) return escape(o.menu || '');
    if (sel.meal_form === 'no_meal') {
      return `🚫 식사 안 받음${sel.note ? ` · 📝 ${escape(sel.note)}` : ''}`;
    }
    if (sel.meal_form === 'kimbap') {
      return `🍙 ${escape(sel.kimbap_choice || '')}${sel.note ? ` · 📝 ${escape(sel.note)}` : ''}`;
    }
    if (sel.meal_form === 'snack_pick') {
      const prios = Array.isArray(sel.category_priorities) ? sel.category_priorities : [];
      const summary = prios.map((cc, i) => `${i+1}순위 ${escape(cc.category_name || '')}`).join(' → ');
      return `🥣 ${summary}${sel.fallback_any ? ' → 🎲' : ''}${sel.note ? ` · 📝 ${escape(sel.note)}` : ''}`;
    }
    // Late-night with priority selection
    if (Array.isArray(sel.priority) && sel.priority.length > 0) {
      const summary = sel.priority.map((name, i) => `${i+1}순위 ${escape(name)}`).join(' → ');
      return `🍜 ${summary}${sel.custom ? ` · 📝 ${escape(sel.custom)}` : ''}`;
    }
    return escape(o.menu || '');
  }

  // ===== Admin: Notice Management =====
  async function renderAdminNotice() {
    let notices = [];
    try { notices = await api('/api/admin/notices'); } catch(e) { toast(e.message); }

    const fmtExpire = (v) => {
      if (!v) return '<span style="color:var(--muted)">만료 없음</span>';
      const d = new Date(v);
      return d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    };
    const isExpired = (v) => v && new Date(v) < new Date();
    const isActive = (n) => n.active && !isExpired(n.expire_at);

    $('#adminBody').innerHTML = `
      <p class="muted-note" style="margin-bottom:12px;">
        활성 공지는 사용자가 앱에 접속할 때 팝업으로 1회 표시됩니다.
        한 번에 1개만 보이며, 가장 최근 활성 공지가 우선합니다.
      </p>

      <!-- 공지 목록 -->
      <div class="section-title"><h2>등록된 공지 (${notices.length}개)</h2></div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px;">
        ${notices.length === 0 ? `<div class="empty"><span class="empty-emoji">📭</span>등록된 공지가 없습니다</div>` :
          notices.map(n => `
            <div class="period-card ${isActive(n) ? '' : 'inactive'}">
              <div class="period-head">
                <span class="period-kind ${isActive(n) ? 'weekday' : 'orphan'}">
                  ${isExpired(n.expire_at) ? '⏰ 만료됨' : n.active ? '📢 활성' : '🔕 꺼짐'}
                </span>
                <span class="period-label" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escape(n.title)}</span>
                <div class="period-actions">
                  <button class="btn-sm btn-ghost" data-notice-toggle="${n.id}" data-active="${n.active}">
                    ${n.active ? '끄기' : '켜기'}
                  </button>
                  <button class="btn-sm btn-ghost" style="color:#ef4444;" data-notice-del="${n.id}" data-title="${escape(n.title)}">삭제</button>
                </div>
              </div>
              <div class="period-body">
                <div style="font-size:13px;color:var(--text-soft);white-space:pre-wrap;line-height:1.65;margin-bottom:8px;">${escape(n.body)}</div>
                <div style="font-size:11px;color:var(--muted);">
                  만료: ${fmtExpire(n.expire_at)} &nbsp;·&nbsp;
                  등록: ${new Date(n.created_at).toLocaleDateString('ko-KR', {month:'long',day:'numeric'})}
                </div>
              </div>
            </div>
          `).join('')}
      </div>

      <!-- 새 공지 작성 -->
      <div class="section-title"><h2>새 공지 작성</h2></div>
      <div class="period-add-form">
        <div class="field" style="margin-bottom:8px;">
          <label style="font-size:11px;font-weight:700;color:var(--text-soft);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:.04em;">제목</label>
          <input class="input" id="noticeTitle" maxlength="100" placeholder="예: 서버 점검 안내" style="width:100%;"/>
        </div>
        <div class="field" style="margin-bottom:8px;">
          <label style="font-size:11px;font-weight:700;color:var(--text-soft);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:.04em;">내용</label>
          <textarea class="textarea" id="noticeBody" maxlength="1000" rows="4"
            placeholder="예: 오늘 조식 수령 시간에 서버 장애로 불편을 드려 죄송합니다."></textarea>
        </div>
        <div class="field" style="margin-bottom:12px;">
          <label style="font-size:11px;font-weight:700;color:var(--text-soft);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:.04em;">
            만료 일시 <span style="font-weight:400;color:var(--muted)">(비워두면 수동으로 끄기 전까지 표시)</span>
          </label>
          <input class="input" id="noticeExpire" type="datetime-local" style="width:100%;"/>
        </div>
        <button class="btn btn-primary" id="noticeSubmit">공지 등록</button>
      </div>
    `;

    // Toggle active
    document.querySelectorAll('[data-notice-toggle]').forEach(b =>
      b.addEventListener('click', async () => {
        const id = Number(b.dataset.noticeToggle);
        const newActive = b.dataset.active !== '1';
        try {
          await api(`/api/admin/notices/${id}`, { method: 'PATCH', body: JSON.stringify({ active: newActive }) });
          toast(newActive ? '공지 활성화됨' : '공지 꺼짐');
          await renderAdminNotice();
        } catch(e) { toast(e.message); }
      }));

    // Delete
    document.querySelectorAll('[data-notice-del]').forEach(b =>
      b.addEventListener('click', async () => {
        if (!confirm(`"${b.dataset.title}" 공지를 삭제할까요?`)) return;
        try {
          await api(`/api/admin/notices/${Number(b.dataset.noticeDel)}`, { method: 'DELETE' });
          toast('삭제되었습니다');
          await renderAdminNotice();
        } catch(e) { toast(e.message); }
      }));

    // Submit
    $('#noticeSubmit').addEventListener('click', async () => {
      const title  = $('#noticeTitle').value.trim();
      const body   = $('#noticeBody').value.trim();
      const expire = $('#noticeExpire').value;  // datetime-local → "YYYY-MM-DDTHH:MM"
      if (!title) { toast('제목을 입력해주세요'); return; }
      if (!body)  { toast('내용을 입력해주세요'); return; }
      // Convert local datetime to ISO (KST offset +09:00)
      let expireISO = null;
      if (expire) {
        const pad = n => String(n).padStart(2, '0');
        const d = new Date(expire);
        // Just use the value directly as KST
        expireISO = expire + ':00+09:00';
      }
      try {
        await api('/api/admin/notices', {
          method: 'POST',
          body: JSON.stringify({ title, body, expire_at: expireISO }),
        });
        toast('공지 등록됨 ✓');
        await renderAdminNotice();
      } catch(e) { toast(e.message); }
    });
  }

  function renderAdminLateNight() {
    // Group admin menu items by period_id
    const itemsByPeriod = {};
    const orphanItems = [];
    for (const it of adminItems) {
      if (it.period_id) {
        (itemsByPeriod[it.period_id] = itemsByPeriod[it.period_id] || []).push(it);
      } else {
        orphanItems.push(it);
      }
    }

    const periodsBlock = menuPeriods.length === 0 ? `
      <div class="empty"><span class="empty-emoji">📭</span>등록된 기간이 없습니다. 아래에서 새로 추가하세요.</div>
    ` : menuPeriods.map(p => renderPeriodCard(p, itemsByPeriod[p.id] || [])).join('');

    const sortedHolidays = Array.from(holidaysSet).sort();

    $('#adminBody').innerHTML = `
      <div class="section-title">
        <h2>야식 메뉴 기간 (${menuPeriods.filter(p=>p.active).length}개 활성)</h2>
      </div>
      <p class="muted-note" style="margin-bottom:10px;">
        매 2주마다 메뉴가 바뀌니, 새 기간을 추가하고 그 기간의 메뉴 칩을 등록하세요.
        같은 날짜에 상시(weekday)와 휴무일(holiday) 둘 다 정의하면 신청자가 알아서 매칭됩니다.
      </p>

      <div class="period-list">
        ${periodsBlock}
      </div>

      ${orphanItems.length > 0 ? `
        <div class="period-card orphan">
          <div class="period-head">
            <span class="period-kind orphan">⚠️ 기간 미배정</span>
            <span class="period-label">기존(legacy) 메뉴</span>
          </div>
          <div class="period-body">
            <div class="admin-list">
              ${orphanItems.map(it => `
                <div class="admin-row ${it.active ? '' : 'inactive'}">
                  <div class="name">${escape(it.name)}</div>
                  <button class="del" data-orphan-del="${it.id}" data-name="${escape(it.name)}">삭제</button>
                </div>
              `).join('')}
            </div>
            <p class="muted-note">위 메뉴는 기간이 정해지지 않아 신청자에게 안 보입니다. 삭제하거나 무시해주세요.</p>
          </div>
        </div>
      ` : ''}

      <div class="section-title"><h2>새 기간 추가</h2></div>
      <div class="period-add-form">
        <div class="field-row">
          <input class="input" id="newPeriodLabel" maxlength="50" placeholder="예: 6월 전반" />
          <select class="input" id="newPeriodKind" style="max-width:130px;">
            <option value="weekday">상시</option>
            <option value="holiday">매장 휴무일</option>
          </select>
        </div>
        <div class="field-row" style="margin-top:6px;">
          <input class="input" id="newPeriodStart" type="date" />
          <span style="color:var(--muted);align-self:center;">~</span>
          <input class="input" id="newPeriodEnd" type="date" />
        </div>
        <button class="btn btn-primary" id="addPeriodBtn" style="margin-top:8px;">+ 기간 추가</button>
      </div>

      <div class="section-title" style="margin-top:24px;">
        <h2>🏪 매장 휴무일 (${sortedHolidays.length}개)</h2>
      </div>
      <p class="muted-note" style="margin-bottom:10px;">
        등록된 날짜는 자동으로 휴무일 메뉴가 적용됩니다.
      </p>
      <div class="holiday-list">
        ${sortedHolidays.length === 0 ? `
          <div class="empty"><span class="empty-emoji">📭</span>등록된 휴무일이 없습니다</div>
        ` : sortedHolidays.map(d => {
          const dt = new Date(d + 'T00:00:00');
          const dow = ['일','월','화','수','목','금','토'][dt.getDay()];
          return `
            <div class="holiday-row">
              <span class="hr-date">${d.slice(5)} (${dow})</span>
              <span class="hr-full">${d}</span>
              <button class="del" data-holiday-del="${d}">제거</button>
            </div>
          `;
        }).join('')}
      </div>
      <div class="field-row" style="margin-top:8px;">
        <input class="input" id="newHolidayDate" type="date" style="flex:1;" />
        <input class="input" id="newHolidayLabel" maxlength="30" placeholder="라벨 (선택)" />
        <button class="btn btn-primary" id="addHolidayBtn">+ 추가</button>
      </div>
    `;

    // Period actions
    document.querySelectorAll('[data-period-toggle]').forEach(b =>
      b.addEventListener('click', async () => {
        const id = Number(b.dataset.periodToggle);
        const newActive = b.dataset.active !== '1';
        try {
          await api(`/api/menu-periods/${id}`, { method: 'PATCH', body: JSON.stringify({ active: newActive }) });
          await loadMenuPeriods({ include_inactive: true });
          renderAdmin();
        } catch (e) { toast(e.message); }
      }));

    document.querySelectorAll('[data-period-del]').forEach(b =>
      b.addEventListener('click', async () => {
        const id = Number(b.dataset.periodDel);
        if (!confirm(`"${b.dataset.label}" 기간과 그 안의 모든 메뉴를 삭제할까요?`)) return;
        try {
          await api(`/api/menu-periods/${id}`, { method: 'DELETE' });
          toast('삭제되었습니다');
          await Promise.all([loadMenuPeriods({ include_inactive: true }), loadAdminItems()]);
          renderAdmin();
        } catch (e) { toast(e.message); }
      }));

    // Period menu item actions
    document.querySelectorAll('[data-item-toggle]').forEach(b =>
      b.addEventListener('click', async () => {
        const id = Number(b.dataset.itemToggle);
        const newActive = b.dataset.active !== '1';
        try {
          await api(`/api/menu-items/${id}`, { method: 'PATCH', body: JSON.stringify({ active: newActive }) });
          await loadAdminItems();
          renderAdmin();
        } catch (e) { toast(e.message); }
      }));

    document.querySelectorAll('[data-item-del]').forEach(b =>
      b.addEventListener('click', async () => {
        const id = Number(b.dataset.itemDel);
        if (!confirm(`"${b.dataset.name}" 메뉴를 삭제할까요?`)) return;
        try {
          await api(`/api/menu-items/${id}`, { method: 'DELETE' });
          toast('삭제되었습니다');
          await loadAdminItems();
          renderAdmin();
        } catch (e) { toast(e.message); }
      }));

    document.querySelectorAll('[data-orphan-del]').forEach(b =>
      b.addEventListener('click', async () => {
        const id = Number(b.dataset.orphanDel);
        if (!confirm(`"${b.dataset.name}" 메뉴를 삭제할까요?`)) return;
        try {
          await api(`/api/menu-items/${id}`, { method: 'DELETE' });
          await loadAdminItems();
          renderAdmin();
        } catch (e) { toast(e.message); }
      }));

    // Per-period add menu button
    document.querySelectorAll('[data-add-period-item]').forEach(b =>
      b.addEventListener('click', async () => {
        const periodId = Number(b.dataset.addPeriodItem);
        const wrap = b.closest('.period-card');
        const nameInput = wrap.querySelector('[data-new-item-name]');
        const name = nameInput.value.trim();
        if (!name) { toast('메뉴 이름을 입력해주세요'); return; }
        try {
          await api('/api/menu-items', {
            method: 'POST',
            body: JSON.stringify({ meal_type: 'late_night', name, period_id: periodId }),
          });
          toast('추가되었습니다');
          nameInput.value = '';
          await loadAdminItems();
          renderAdmin();
        } catch (e) { toast(e.message); }
      }));

    // New period add
    $('#addPeriodBtn').addEventListener('click', async () => {
      const label = $('#newPeriodLabel').value.trim();
      const kind = $('#newPeriodKind').value;
      const start = $('#newPeriodStart').value;
      const end = $('#newPeriodEnd').value;
      if (!label || !start || !end) { toast('모든 항목을 입력해주세요'); return; }
      try {
        await api('/api/menu-periods', {
          method: 'POST',
          body: JSON.stringify({ meal_type: 'late_night', label, kind, start_date: start, end_date: end }),
        });
        toast('기간 추가됨');
        await loadMenuPeriods({ include_inactive: true });
        renderAdmin();
      } catch (e) { toast(e.message); }
    });

    // Holiday actions
    document.querySelectorAll('[data-holiday-del]').forEach(b =>
      b.addEventListener('click', async () => {
        const date = b.dataset.holidayDel;
        if (!confirm(`${date} 휴무일을 제거할까요?`)) return;
        try {
          await api(`/api/holidays/${date}`, { method: 'DELETE' });
          await loadHolidays();
          renderAdmin();
        } catch (e) { toast(e.message); }
      }));

    $('#addHolidayBtn').addEventListener('click', async () => {
      const date = $('#newHolidayDate').value;
      const label = $('#newHolidayLabel').value.trim();
      if (!date) { toast('날짜를 선택해주세요'); return; }
      try {
        await api('/api/holidays', { method: 'POST', body: JSON.stringify({ date, label }) });
        toast('휴무일 추가됨');
        $('#newHolidayDate').value = '';
        $('#newHolidayLabel').value = '';
        await loadHolidays();
        renderAdmin();
      } catch (e) { toast(e.message); }
    });
  }

  function renderPeriodCard(p, items) {
    const kindLabel = p.kind === 'holiday' ? '🏪 매장 휴무일' : '🍽️ 상시';
    return `
      <div class="period-card ${p.active ? '' : 'inactive'} ${p.kind === 'holiday' ? 'holiday' : ''}">
        <div class="period-head">
          <span class="period-kind ${p.kind}">${kindLabel}</span>
          <span class="period-label">${escape(p.label)}</span>
          <span class="period-range">${p.start_date.slice(5)} ~ ${p.end_date.slice(5)}</span>
          <div class="period-actions">
            <button class="btn-sm btn-ghost" data-period-toggle="${p.id}" data-active="${p.active ? 1 : 0}">${p.active ? '숨기기' : '보이기'}</button>
            <button class="btn-sm btn-ghost" data-period-del="${p.id}" data-label="${escape(p.label)}">삭제</button>
          </div>
        </div>
        <div class="period-body">
          <div class="admin-list">
            ${items.length === 0 ? `<div class="muted-note" style="text-align:center;padding:10px;">메뉴 없음</div>` :
              items.map(it => `
                <div class="admin-row ${it.active ? '' : 'inactive'}">
                  <div class="name">${escape(it.name)}</div>
                  <button data-item-toggle="${it.id}" data-active="${it.active}">${it.active ? '숨기기' : '보이기'}</button>
                  <button class="del" data-item-del="${it.id}" data-name="${escape(it.name)}">삭제</button>
                </div>
              `).join('')}
          </div>
          <div class="field-row" style="margin-top:8px;">
            <input class="input" data-new-item-name maxlength="50" placeholder="예: 돼지국밥" />
            <button class="btn btn-primary" data-add-period-item="${p.id}">+ 메뉴</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderAdminBreakfast() {
    const cats = breakfastStructure;
    $('#adminBody').innerHTML = `
      <div class="section-title">
        <h2>스낵픽 카테고리 (${cats.filter(c=>c.active).length}개 활성)</h2>
      </div>

      <div class="cat-edit-list">
        ${cats.length === 0 ? `
          <div class="empty"><span class="empty-emoji">📭</span>아직 등록된 카테고리가 없습니다</div>
        ` : cats.map(c => renderAdminCategoryRow(c)).join('')}
      </div>

      <div class="section-title"><h2>새 카테고리 추가</h2></div>
      <div class="add-row">
        <input class="input" id="newCatEmoji" style="max-width:80px;" maxlength="4" placeholder="🍽️" />
        <input class="input" id="newCatName" maxlength="30" placeholder="예: 죽" />
        <button class="btn btn-primary" id="addCatBtn">추가</button>
      </div>
      <p class="muted-note">카테고리 추가 후, 각 카테고리 안에서 슬롯(메인/음료/계란 등)을 정의하세요.</p>

      <div class="section-title" style="margin-top:32px;">
        <h2>🍙 김밥/주먹밥 옵션 (${kimbapOptions.filter(k=>k.active).length}개 활성)</h2>
      </div>
      <p class="muted-note" style="margin-bottom:10px;">요일별로 바뀌는 김밥/주먹밥 메뉴를 추가·삭제하세요.</p>
      <div class="admin-list">
        ${kimbapOptions.length === 0 ? `
          <div class="empty"><span class="empty-emoji">📭</span>등록된 항목이 없습니다</div>
        ` : kimbapOptions.map(k => `
          <div class="admin-row ${k.active ? '' : 'inactive'}">
            <div class="name">${escape(k.name)}</div>
            <button data-kimbap-toggle="${k.id}" data-active="${k.active}">${k.active ? '숨기기' : '보이기'}</button>
            <button class="del" data-kimbap-del="${k.id}" data-name="${escape(k.name)}">삭제</button>
          </div>
        `).join('')}
      </div>
      <div class="add-row" style="margin-top:10px;">
        <input class="input" id="newKimbapName" maxlength="30" placeholder="예: 참치김밥" />
        <button class="btn btn-primary" id="addKimbapBtn">추가</button>
      </div>
    `;

    // Toggle expand
    document.querySelectorAll('[data-cat-expand]').forEach(b =>
      b.addEventListener('click', () => {
        const id = Number(b.dataset.catExpand);
        if (adminBreakfastExpanded.has(id)) adminBreakfastExpanded.delete(id);
        else adminBreakfastExpanded.add(id);
        renderAdminBreakfast();
      }));

    document.querySelectorAll('[data-cat-toggle]').forEach(b =>
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = Number(b.dataset.catToggle);
        const newActive = b.dataset.active !== '1';
        try {
          await api(`/api/categories/${id}`, { method: 'PATCH', body: JSON.stringify({ active: newActive }) });
          await loadBreakfastStructure({ include_inactive: true });
          renderAdminBreakfast();
        } catch (e) { toast(e.message); }
      }));

    document.querySelectorAll('[data-cat-del]').forEach(b =>
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = Number(b.dataset.catDel);
        if (!confirm(`"${b.dataset.name}" 카테고리와 모든 슬롯을 삭제할까요?`)) return;
        try {
          await api(`/api/categories/${id}`, { method: 'DELETE' });
          toast('삭제되었습니다');
          adminBreakfastExpanded.delete(id);
          await loadBreakfastStructure({ include_inactive: true });
          renderAdminBreakfast();
        } catch (e) { toast(e.message); }
      }));

    document.querySelectorAll('[data-slot-del]').forEach(b =>
      b.addEventListener('click', async () => {
        const id = Number(b.dataset.slotDel);
        if (!confirm(`"${b.dataset.name}" 슬롯을 삭제할까요?`)) return;
        try {
          await api(`/api/slots/${id}`, { method: 'DELETE' });
          toast('삭제되었습니다');
          await loadBreakfastStructure({ include_inactive: true });
          renderAdminBreakfast();
        } catch (e) { toast(e.message); }
      }));

    document.querySelectorAll('[data-add-slot]').forEach(b =>
      b.addEventListener('click', async () => {
        const catId = Number(b.dataset.addSlot);
        const wrap = b.closest('.cat-edit-card');
        const name = wrap.querySelector('[data-slot-name]').value.trim();
        const isFixed = wrap.querySelector('[data-slot-fixed]').checked;
        const fixedText = wrap.querySelector('[data-slot-fixed-text]').value.trim();
        const optsRaw = wrap.querySelector('[data-slot-opts]').value.trim();
        if (!name) { toast('슬롯 이름을 입력해주세요'); return; }
        const body = { category_id: catId, name, is_fixed: isFixed };
        if (isFixed) body.fixed_text = fixedText || name;
        else {
          const options = optsRaw.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
          if (options.length === 0) { toast('옵션을 한 개 이상 입력해주세요'); return; }
          body.options = options;
        }
        try {
          await api('/api/slots', { method: 'POST', body: JSON.stringify(body) });
          toast('슬롯 추가됨');
          await loadBreakfastStructure({ include_inactive: true });
          renderAdminBreakfast();
        } catch (e) { toast(e.message); }
      }));

    document.querySelectorAll('[data-slot-fixed]').forEach(cb =>
      cb.addEventListener('change', (e) => {
        const wrap = e.target.closest('.cat-edit-card');
        wrap.querySelector('[data-slot-opts-row]').style.display = e.target.checked ? 'none' : '';
        wrap.querySelector('[data-slot-fixed-row]').style.display = e.target.checked ? '' : 'none';
      }));

    // Add category
    const catNameInput = $('#newCatName');
    const catEmojiInput = $('#newCatEmoji');
    async function addCat() {
      const name = catNameInput.value.trim();
      if (!name) { toast('카테고리 이름을 입력해주세요'); return; }
      try {
        await api('/api/categories', { method: 'POST', body: JSON.stringify({ name, emoji: catEmojiInput.value.trim() }) });
        toast('카테고리 추가됨');
        catNameInput.value = ''; catEmojiInput.value = '';
        await loadBreakfastStructure({ include_inactive: true });
        renderAdminBreakfast();
      } catch (e) { toast(e.message); }
    }
    $('#addCatBtn').addEventListener('click', addCat);
    catNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') addCat(); });

    // Kimbap handlers
    document.querySelectorAll('[data-kimbap-toggle]').forEach(b =>
      b.addEventListener('click', async () => {
        const id = Number(b.dataset.kimbapToggle);
        const newActive = b.dataset.active !== '1';
        try {
          await api(`/api/kimbap-options/${id}`, { method: 'PATCH', body: JSON.stringify({ active: newActive }) });
          await loadKimbapOptions({ include_inactive: true });
          renderAdminBreakfast();
        } catch (e) { toast(e.message); }
      }));
    document.querySelectorAll('[data-kimbap-del]').forEach(b =>
      b.addEventListener('click', async () => {
        const id = Number(b.dataset.kimbapDel);
        if (!confirm(`"${b.dataset.name}" 을(를) 삭제할까요?`)) return;
        try {
          await api(`/api/kimbap-options/${id}`, { method: 'DELETE' });
          toast('삭제되었습니다');
          await loadKimbapOptions({ include_inactive: true });
          renderAdminBreakfast();
        } catch (e) { toast(e.message); }
      }));
    const kbInput = $('#newKimbapName');
    async function addKb() {
      const name = kbInput.value.trim();
      if (!name) { toast('이름을 입력해주세요'); return; }
      try {
        await api('/api/kimbap-options', { method: 'POST', body: JSON.stringify({ name }) });
        toast('추가되었습니다');
        kbInput.value = '';
        await loadKimbapOptions({ include_inactive: true });
        renderAdminBreakfast();
      } catch (e) { toast(e.message); }
    }
    $('#addKimbapBtn').addEventListener('click', addKb);
    kbInput.addEventListener('keydown', e => { if (e.key === 'Enter') addKb(); });
  }

  function renderAdminCategoryRow(c) {
    const open = adminBreakfastExpanded.has(c.id);
    const slots = c.slots || [];
    const summary = slots.length === 0 ? '슬롯 없음'
      : slots.map(s => s.is_fixed ? `${s.name}=${s.fixed_text}` : `${s.name}: ${(s.options || []).join('/')}`).join(' · ');
    return `
      <div class="cat-edit-card ${c.active ? '' : 'inactive'}">
        <div class="cat-edit-head" data-cat-expand="${c.id}">
          <span class="emoji">${c.emoji || '🍽️'}</span>
          <div class="cat-edit-text">
            <div class="cat-edit-name">${escape(c.name)} ${c.active ? '' : '<span class="cat-hidden">(숨김)</span>'}</div>
            <div class="cat-edit-sub">${escape(summary)}</div>
          </div>
          <div class="cat-edit-actions">
            <button class="btn-sm btn-ghost" data-cat-toggle="${c.id}" data-active="${c.active ? 1 : 0}">${c.active ? '숨기기' : '보이기'}</button>
            <button class="btn-sm btn-ghost" data-cat-del="${c.id}" data-name="${escape(c.name)}">삭제</button>
            <span class="cat-expand-arrow">${open ? '▾' : '▸'}</span>
          </div>
        </div>

        ${open ? `
          <div class="cat-edit-body">
            <div class="slot-edit-list">
              ${slots.length === 0 ? `<p class="muted-note">슬롯이 없습니다. 아래에서 추가하세요.</p>` :
                slots.map(s => `
                  <div class="slot-edit-row">
                    <div class="slot-edit-info">
                      <strong>${escape(s.name)}</strong>
                      ${s.is_fixed
                        ? `<span class="slot-edit-tag">고정: ${escape(s.fixed_text || s.name)}</span>`
                        : `<span class="slot-edit-tag">옵션: ${(s.options || []).map(escape).join(', ')}</span>`}
                    </div>
                    <button class="btn-sm btn-ghost" data-slot-del="${s.id}" data-name="${escape(s.name)}">삭제</button>
                  </div>
                `).join('')}
            </div>

            <div class="slot-add-form">
              <div class="slot-add-title">새 슬롯 추가</div>
              <div class="field" style="margin-bottom:8px;">
                <input class="input" data-slot-name placeholder="슬롯 이름 (예: 음료)" maxlength="30" />
              </div>
              <label class="check-label">
                <input type="checkbox" data-slot-fixed />
                <span>고정 항목 (사용자가 선택 안함, 항상 같이 제공)</span>
              </label>
              <div class="field" data-slot-opts-row style="margin-top:8px;margin-bottom:0;">
                <label>옵션 (쉼표 또는 줄바꿈으로 구분)</label>
                <textarea class="textarea" data-slot-opts maxlength="300" placeholder="예: 우유, 두유" style="min-height:60px;"></textarea>
              </div>
              <div class="field" data-slot-fixed-row style="margin-top:8px;margin-bottom:0;display:none;">
                <label>고정 표시 텍스트</label>
                <input class="input" data-slot-fixed-text maxlength="50" placeholder="예: 계란 2개" />
              </div>
              <button class="btn btn-primary" data-add-slot="${c.id}" style="margin-top:10px;">+ 슬롯 추가</button>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  // ===== Data loaders =====
  async function loadMyOrders() {
    try { myOrders = await api('/api/orders/my'); } catch { myOrders = []; }
  }
  async function loadActiveOrders() {
    if (!actingMealType || !actingDate) { activeOrders = []; return; }
    try {
      activeOrders = await api(`/api/orders/active?meal_type=${actingMealType}&date=${actingDate}`);
    } catch { activeOrders = []; }
  }
  async function loadActiveSummary() {
    try { activeSummary = await api('/api/orders/active/summary?days=7'); }
    catch { activeSummary = []; }
  }
  async function loadMenuItems() {
    try {
      const items = await api('/api/menu-items');
      menuItemsCache = { breakfast: [], late_night: [] };
      for (const it of items) {
        if (menuItemsCache[it.meal_type]) menuItemsCache[it.meal_type].push(it);
      }
    } catch { menuItemsCache = { breakfast: [], late_night: [] }; }
  }
  async function loadBreakfastStructure({ include_inactive = false } = {}) {
    try {
      const qs = include_inactive ? '?include_inactive=1' : '';
      breakfastStructure = await api('/api/breakfast-structure' + qs);
    } catch { breakfastStructure = []; }
  }
  async function loadKimbapOptions({ include_inactive = false } = {}) {
    try {
      const qs = include_inactive ? '?include_inactive=1' : '';
      kimbapOptions = await api('/api/kimbap-options' + qs);
    } catch { kimbapOptions = []; }
  }
  async function loadHolidays() {
    try {
      const list = await api('/api/holidays');
      holidaysSet = new Set((list || []).map(h => h.date));
    } catch { holidaysSet = new Set(); }
  }
  async function loadMenuPeriods({ include_inactive = false } = {}) {
    try {
      const qs = include_inactive ? '?include_inactive=1' : '';
      menuPeriods = await api('/api/menu-periods' + qs);
    } catch { menuPeriods = []; }
  }
  async function loadAdminItems() {
    try { adminItems = await api('/api/menu-items?include_inactive=1&meal_type=late_night'); }
    catch { adminItems = []; }
  }

  // ===== Polling =====
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        if (role === 'acting') {
          await loadActiveSummary();
          if (actingStep === 'list') {
            await loadActiveOrders();
          }
          // Always re-render acting (both choose and list) so counts stay fresh
          renderActing();
        } else if (role === 'applicant') {
          // Only refresh home view automatically; in the middle of a step, don't disturb
          if (applicantStep === 'home') {
            await loadMyOrders();
            renderApplicantHome();
          }
        }
      } catch {}
    }, POLL_MS);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ===== Router =====
  async function render() {
    stopPolling();
    if (!user) { renderLogin(); return; }

    try {
      const fresh = await api('/api/me');
      saveUser(fresh);
    } catch {
      try {
        const fresh = await api('/api/register', {
          method: 'POST',
          body: JSON.stringify({ employee_id: user.employee_id, name: user.name })
        });
        saveUser(fresh);
      } catch {
        localStorage.removeItem(STORAGE_KEY);
        user = null; renderLogin(); return;
      }
    }

    if (role === 'admin' && !user.is_admin) saveRole(null);

    // 로그인 직후 공지 팝업 트리거 (역할 선택 화면에서 1회)
    if (!role) { renderRolePicker(); checkNotice(); return; }

    if (role === 'applicant') {
      lateNightMenuByDate = {};  // clear cache on enter
      await Promise.all([
        loadMyOrders(),
        loadMenuItems(),
        loadBreakfastStructure(),
        loadKimbapOptions(),
        loadHolidays(),
      ]);
      renderApplicant();
      startPolling();
    } else if (role === 'acting') {
      await Promise.all([loadActiveSummary(), loadHolidays()]);
      if (actingStep === 'list' && actingMealType) {
        if (!actingDate) actingDate = todayStr();
        await loadActiveOrders();
      }
      renderActing();
      startPolling();
    } else if (role === 'admin') {
      await Promise.all([
        loadAdminItems(),
        loadBreakfastStructure({ include_inactive: true }),
        loadKimbapOptions({ include_inactive: true }),
        loadHolidays(),
        loadMenuPeriods({ include_inactive: true }),
      ]);
      renderAdmin();
    }
  }

  // Boot
  loadStored();
  render();
  window.addEventListener('focus', () => { if (user && role) render(); });

  // ── 공지 팝업 (관리자가 등록한 공지, 첫 접속 1회만) ──
  async function checkNotice() {
    if (!user) return;
    try {
      const notice = await api('/api/notices/active');
      if (!notice) return;
      const seenKey = `knuh_notice_seen_${notice.id}`;
      if (localStorage.getItem(seenKey)) return;

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" style="max-width:440px;">
          <div class="viewer-content" style="padding:22px 20px 8px;">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
              <span style="font-size:24px;">📢</span>
              <div>
                <div style="font-size:15px;font-weight:800;color:#111;">${escape(notice.title)}</div>
                <div style="font-size:11px;color:#888;margin-top:2px;">${new Date(notice.created_at).toLocaleDateString('ko-KR', {year:'numeric',month:'long',day:'numeric'})}</div>
              </div>
            </div>
            <div style="font-size:14px;line-height:1.75;color:#333;white-space:pre-wrap;">${escape(notice.body)}</div>
            ${notice.expire_at ? `<div style="margin-top:12px;font-size:11px;color:#aaa;">이 공지는 ${new Date(notice.expire_at).toLocaleDateString('ko-KR', {month:'long',day:'numeric', hour:'2-digit',minute:'2-digit'})}까지 표시됩니다.</div>` : ''}
          </div>
          <div style="padding:12px 20px 20px;display:flex;gap:8px;">
            <button id="noticeClose" style="flex:1;padding:12px;background:#111;color:#fff;border:none;border-radius:11px;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;">확인</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      document.body.style.overflow = 'hidden';
      function closeNotice() {
        localStorage.setItem(seenKey, '1');
        overlay.remove();
        document.body.style.overflow = '';
      }
      document.getElementById('noticeClose').addEventListener('click', closeNotice);
      overlay.addEventListener('click', e => { if (e.target === overlay) closeNotice(); });
    } catch(e) { /* 공지 없거나 오류 — 무시 */ }
  }

  // Boot
  loadStored();
  render();
  window.addEventListener('focus', () => { if (user && role) render(); });
})();
