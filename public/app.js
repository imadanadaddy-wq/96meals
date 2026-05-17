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
  let draftMenuName = '';
  let draftCustomText = '';

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
  let activeOrders = [];
  let activeSummary = [];

  // Admin
  let adminMealTab = 'breakfast';
  let adminItems = [];
  let breakfastStructure = [];
  let adminBreakfastExpanded = new Set();
  let kimbapOptions = [];

  let menuItemsCache = { breakfast: [], late_night: [] };

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
          const cls = [
            'date-chip',
            isSel ? 'selected' : '',
            isToday ? 'today' : '',
            dow === 0 ? 'sun' : '',
            dow === 6 ? 'sat' : '',
            withOrdersDates.has(d) ? 'has-orders' : '',
          ].filter(Boolean).join(' ');
          return `
            <button class="${cls}" data-date="${d}">
              <span class="dow">${DOW_KR[dow]}</span>
              <span class="day">${dt.getDate()}</span>
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
        <button class="btn btn-ghost skip-meal-btn" id="skipMealBtn">
          🙅 오늘은 패스할게요
        </button>
      ` : `
        <div class="section-title" style="margin-top:14px;">
          <h2>내 신청 현황</h2>
          <span class="hint">탭하면 바코드 · ${sorted.length}건</span>
        </div>
        <div class="my-orders-list">
          ${sorted.map((o, i) => `
            <div class="my-order-row">
              <button class="my-order-main" data-view-idx="${i}">
                <div class="meal-badge ${o.meal_type}">${mealEmoji(o.meal_type)}</div>
                <div class="info">
                  <div class="date">${fmtFull(o.service_date)} · ${mealLabel(o.meal_type)}</div>
                  <div class="menu">${escape(o.menu)}</div>
                </div>
                <span class="view-hint">바코드 ›</span>
              </button>
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

    const skipBtn = document.getElementById('skipMealBtn');
    if (skipBtn) {
      skipBtn.addEventListener('click', () => {
        toast('오늘도 화이팅! 🙌');
        saveRole(null);
        render();
      });
    }

    document.querySelectorAll('[data-meal]').forEach(b =>
      b.addEventListener('click', () => {
        draftMealType = b.dataset.meal;
        draftDates = [todayStr()];
        draftMenuName = '';
        draftCustomText = '';
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

  function renderApplicantLateNightMenu() {
    const items = menuItemsCache.late_night || [];
    const dateLabel = draftDates.length === 1
      ? fmtFull(draftDates[0])
      : `${draftDates.length}일 (${draftDates.map(d => fmtDate(d, { withDow: false })).join(', ')})`;

    root.innerHTML = `
      ${renderBrand()}
      ${applicantHeader(`🍜 야식 신청`, { onBack: true, step: 2, totalSteps: 3 })}

      <div class="card step-card">
        <h2 class="step-h">메뉴 선택</h2>
        <p class="step-desc">${escape(dateLabel)}</p>

        ${items.length === 0 ? `
          <div class="empty" style="margin-top:8px;">
            <span class="empty-emoji">📭</span>
            등록된 메뉴가 없습니다. 직접 입력으로 신청해주세요.
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
          <label for="menuInput">직접 입력 (선택)</label>
          <textarea class="textarea" id="menuInput" maxlength="200"
            placeholder="예: 컵라면, 안 매운걸로 / 죽 (전복죽 선호)">${escape(draftCustomText)}</textarea>
        </div>
      </div>

      <div class="step-action">
        <button class="btn btn-primary" id="stepSubmit">
          ${draftDates.length === 1 ? '신청하기' : `${draftDates.length}일 신청하기`}
        </button>
      </div>
    `;

    $('#stepBack').addEventListener('click', () => { applicantStep = 'date'; renderApplicantStep(); });

    document.querySelectorAll('[data-menu]').forEach(b =>
      b.addEventListener('click', () => {
        draftMenuName = b.dataset.menu;
        draftCustomText = '';
        renderApplicantLateNightMenu();
      }));

    const ta = $('#menuInput');
    ta.addEventListener('input', () => {
      draftCustomText = ta.value;
      if (draftCustomText && draftMenuName) {
        draftMenuName = '';
        document.querySelectorAll('.menu-chip.selected').forEach(c => c.classList.remove('selected'));
      }
    });

    $('#stepSubmit').addEventListener('click', async () => {
      const menu = (draftCustomText || ta.value || '').trim() || draftMenuName;
      if (!menu) { toast('메뉴를 선택하거나 입력해주세요'); return; }
      await submitOrders({ menu });
    });
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
      </div>
    `;
    $('#stepBack').addEventListener('click', () => { applicantStep = 'date'; renderApplicantStep(); });
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
  function summarizeSelection(sel) {
    if (!sel) return '';
    if (sel.meal_form === 'kimbap') {
      return `[김밥/주먹밥] ${sel.kimbap_choice || ''}`;
    }
    if (sel.meal_form === 'snack_pick') {
      const prios = Array.isArray(sel.category_priorities) ? sel.category_priorities : [];
      if (prios.length === 0) return '';
      const tiers = prios.map((cc, i) => {
        const cat = breakfastStructure.find(c => c.id === Number(cc.category_id));
        const catName = (cat && cat.name) || cc.category_name || '';
        const slotParts = [];
        for (const s of (cc.slots || [])) {
          if (s.fixed) continue;
          const pri = Array.isArray(s.priority) ? s.priority : [];
          let txt = '';
          if (pri.length === 1) txt = pri[0];
          else if (pri.length > 1) txt = pri.map((v, i) => `${v}(${i + 1})`).join('/');
          if (s.any) txt = txt ? `${txt} or 아무거나` : '아무거나';
          if (txt) slotParts.push(txt);
        }
        return `${i + 1}순위 ${catName}${slotParts.length ? `(${slotParts.join(' · ')})` : ''}`;
      }).join(' → ');
      const tail = sel.fallback_any ? ' → 없으면 아무거나' : '';
      return `[스낵픽] ${tiers}${tail}`;
    }
    // Legacy fallback (old schema with category_id at top level)
    const cat = breakfastStructure.find(c => c.id === Number(sel.category_id));
    const catName = (cat && cat.name) || sel.category_name || '';
    const parts = [];
    const slots = Array.isArray(sel.slots) ? sel.slots : [];
    for (const s of slots) {
      const pri = Array.isArray(s.priority) ? s.priority : [];
      let txt = '';
      if (pri.length === 1) txt = pri[0];
      else if (pri.length > 1) txt = pri.map((v, i) => `${v}(${i + 1})`).join('/');
      if (s.any) txt = txt ? `${txt} or 아무거나` : '아무거나';
      if (txt) parts.push(txt);
    }
    return `[${catName}] ${parts.join(' · ')}`;
  }

  function goHome() {
    applicantStep = 'home';
    draftMealType = null;
    draftDates = [];
    draftMenuName = '';
    draftCustomText = '';
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
    const totalFor = (mt) => activeSummary.filter(x => x.meal_type === mt).reduce((s, x) => s + x.n, 0);

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
          <span class="count">오늘 ${countFor('breakfast', today)} · 내일 ${countFor('breakfast', tomorrow)} · 전체 ${totalFor('breakfast')}</span>
        </button>
        <button class="choice-card late_night" data-meal="late_night">
          <span class="emoji">🍜</span>
          <span class="name">야식</span>
          <span class="count">오늘 ${countFor('late_night', today)} · 내일 ${countFor('late_night', tomorrow)} · 전체 ${totalFor('late_night')}</span>
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
    const countOnDate = activeOrders.length;

    // Breakfast breakdown: snack_pick vs kimbap
    let breakdownHtml = '';
    if (actingMealType === 'breakfast' && activeOrders.length > 0) {
      const snackCount = activeOrders.filter(o => o.selection && o.selection.meal_form === 'snack_pick').length;
      const kimbapCount = activeOrders.filter(o => o.selection && o.selection.meal_form === 'kimbap').length;
      const otherCount = countOnDate - snackCount - kimbapCount;
      const parts = [];
      if (snackCount > 0) parts.push(`<span class="breakdown-chip snack">🥣 스낵픽 <strong>${snackCount}</strong></span>`);
      if (kimbapCount > 0) parts.push(`<span class="breakdown-chip kimbap">🍙 밥 <strong>${kimbapCount}</strong></span>`);
      if (otherCount > 0) parts.push(`<span class="breakdown-chip other">기타 <strong>${otherCount}</strong></span>`);
      if (parts.length > 0) breakdownHtml = `<div class="order-breakdown">${parts.join('')}</div>`;
    }

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

      <div class="section-title">
        <h2>대기 중 (${countOnDate}건)</h2>
        <span class="hint">탭하면 바코드</span>
      </div>
      ${breakdownHtml}

      <div class="order-list">
        ${activeOrders.length === 0 ? `
          <div class="empty">
            <span class="empty-emoji">🌙</span>
            ${fmtDate(actingDate)} ${mealLabel(actingMealType)} 신청이 없어요
          </div>
        ` : activeOrders.map(o => `
          <button class="order-card" data-id="${o.id}">
            <div class="meal-badge ${o.meal_type}">${mealEmoji(o.meal_type)}</div>
            <div class="order-body">
              <div class="order-name">
                ${escape(o.name)}
                <span class="order-eid">${escape(o.employee_id)}</span>
              </div>
              ${renderOrderDetailDark(o)}
            </div>
            <div class="order-chevron">›</div>
          </button>
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

    document.querySelectorAll('.order-card').forEach(c =>
      c.addEventListener('click', () => {
        const id = Number(c.dataset.id);
        const startIdx = activeOrders.findIndex(o => o.id === id);
        if (startIdx >= 0) {
          openOrderViewer(activeOrders, startIdx, {
            allowPickup: true,
            onDataChanged: async () => {
              await Promise.all([loadActiveOrders(), loadActiveSummary()]);
              renderActing();
            }
          });
        }
      }));
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
          const slots = (cc.slots || []).filter(s => !s.fixed);
          const slotSummary = slots.map(s => {
            const pri = Array.isArray(s.priority) ? s.priority : [];
            return pri.slice(0, 2).join('/');
          }).filter(Boolean).join(' ');
          return `<span class="vc-tier-chip ${i === 0 ? 'primary' : 'secondary'}">${i+1}순위 ${escape(cc.category_name || '')}${slotSummary ? ` · ${slotSummary}` : ''}</span>`;
        }).join('');
        const note = sel.note ? ` <span class="vc-note">📝 ${escape(sel.note)}</span>` : '';
        const fallback = sel.fallback_any ? ' <span class="vc-note">🎲 아무거나OK</span>' : '';
        return parts + fallback + note;
      }
      if (Array.isArray(sel.slots)) {
        const parts = sel.slots.filter(s => !s.fixed && Array.isArray(s.priority) && s.priority.length)
          .map(s => s.priority.slice(0, 2).join('/')).join(' · ');
        return `${sel.category_name ? escape(sel.category_name) + ' · ' : ''}${parts}${sel.note ? ` 📝 ${escape(sel.note)}` : ''}`;
      }
    }
    return escape(order.menu);
  }

  // Renders a single category choice (one priority tier) on light surface — compact card for horizontal scroll
  function renderCategoryChoiceLight(cc, tierIdx) {
    const catName = cc.category_name || '';
    const catEmoji = cc.category_emoji || '🍽️';
    const slots = cc.slots || [];

    const choiceRows = slots.filter(s => !s.fixed).map(s => {
      const pri = Array.isArray(s.priority) ? s.priority : [];
      const priHtml = pri.map((v, i) => `<span class="det-pri"><span class="det-rank">${i+1}</span>${escape(v)}</span>`).join('');
      const anyHtml = s.any ? `<span class="det-any">아무거나 OK</span>` : '';
      return `<div class="det-row"><span class="det-name">${escape(s.slot_name)}</span><span class="det-val">${priHtml}${anyHtml || (pri.length === 0 ? '<span class="det-empty">—</span>' : '')}</span></div>`;
    }).join('');

    const fixedSlots = slots.filter(s => s.fixed);
    const fixedHtml = fixedSlots.length
      ? `<div class="det-fixed-row">${fixedSlots.map(s => `<span class="det-fixed-chip">${escape(s.slot_name ? s.slot_name + ': ' : '')}${escape(s.fixed)}</span>`).join('')}</div>`
      : '';

    return `
      <div class="tier-card ${tierIdx === 0 ? 'tier-primary' : 'tier-secondary'}">
        <div class="tier-head">
          <span class="tier-badge">${tierIdx + 1}순위</span>
          <span class="tier-cat">${catEmoji} ${escape(catName)}</span>
        </div>
        ${choiceRows}
        ${fixedHtml}
      </div>
    `;
  }

  // Renders an order's content (menu / structured breakfast selection) on a light/white surface (used in viewer modal)
  function renderOrderDetailLight(order) {
    const sel = order.selection;
    if (order.meal_type === 'breakfast' && sel) {
      if (sel.meal_form === 'kimbap') {
        return `
          <div class="id-menu id-menu-struct">
            <span class="label">🍙 김밥/주먹밥</span>
            <div style="font-size:18px;font-weight:700;color:#111;margin-top:6px;">${escape(sel.kimbap_choice || '')}</div>
            ${sel.note ? `<div class="det-note">📝 ${escape(sel.note)}</div>` : ''}
          </div>
        `;
      }
      if (sel.meal_form === 'snack_pick') {
        const prios = Array.isArray(sel.category_priorities) ? sel.category_priorities : [];
        const tiersHtml = prios.map((cc, i) => renderCategoryChoiceLight(cc, i)).join('');
        const fallbackHtml = sel.fallback_any
          ? `<div class="fallback-note"><span class="fb-icon">🎲</span> 위 메뉴들이 모두 없으면 <strong>아무거나</strong> 받아가셔도 OK</div>`
          : '';
        return `
          <div class="tier-scroll-wrap">
            ${tiersHtml}
          </div>
          ${fallbackHtml}
          ${sel.note ? `<div class="det-note">📝 ${escape(sel.note)}</div>` : ''}
        `;
      }
      // Legacy schema (single category)
      if (Array.isArray(sel.slots)) {
        const catName = sel.category_name || '';
        const catEmoji = sel.category_emoji || '🍽️';
        const choiceRows = sel.slots.filter(s => !s.fixed).map(s => {
          const pri = Array.isArray(s.priority) ? s.priority : [];
          const priHtml = pri.map((v, i) => `<span class="det-pri"><span class="det-rank">${i+1}</span>${escape(v)}</span>`).join('');
          const anyHtml = s.any ? `<span class="det-any">아무거나 OK</span>` : '';
          return `<li class="det-row"><span class="det-name">${escape(s.slot_name)}</span><span class="det-val">${priHtml}${anyHtml || (pri.length === 0 ? '<span class="det-empty">—</span>' : '')}</span></li>`;
        }).join('');
        const fixedSlots = sel.slots.filter(s => s.fixed);
        const fixedHtml = fixedSlots.length ? `<div class="det-fixed-row">${fixedSlots.map(s => `<span class="det-fixed-chip">${escape(s.slot_name ? s.slot_name + ': ' : '')}${escape(s.fixed)}</span>`).join('')}</div>` : '';
        return `
          <div class="id-menu id-menu-struct">
            <span class="label">${catEmoji} ${escape(catName)}</span>
            ${choiceRows ? `<ul class="det-list">${choiceRows}</ul>` : ''}
            ${fixedHtml}
            ${sel.note ? `<div class="det-note">📝 ${escape(sel.note)}</div>` : ''}
          </div>
        `;
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
        // Show: "1순위 카테고리명 · 2순위 카테고리명" on one line, slots as compact chips below
        const tierLine = prios.map((cc, i) => `<span class="d-rank">${i+1}</span>${escape(cc.category_name || '')}`).join(' <span class="sep">·</span> ');
        // Flatten key slots (non-fixed, first priority only) into one line
        const slotLine = prios.slice(0, 1).flatMap(cc =>
          (cc.slots || []).filter(s => !s.fixed && Array.isArray(s.priority) && s.priority.length).map(s =>
            `${escape(s.slot_name)}: ${escape(s.priority[0])}${s.priority[1] ? `/${escape(s.priority[1])}` : ''}`
          )
        ).join(' · ');
        const extra = (sel.fallback_any ? ' 🎲' : '') + (sel.note ? ` 📝${escape(sel.note)}` : '');
        return `<div class="order-menu compact"><span class="tier-inline">${tierLine}</span>${slotLine ? `<br><span class="slot-inline">${slotLine}${extra}</span>` : extra}</div>`;
      }
      // Legacy slots
      if (Array.isArray(sel.slots)) {
        const parts = sel.slots.filter(s => !s.fixed && Array.isArray(s.priority) && s.priority.length).map(s =>
          `${escape(s.slot_name)}: ${escape(s.priority[0])}${s.priority[1] ? `/${escape(s.priority[1])}` : ''}`
        ).join(' · ');
        const catLabel = sel.category_name ? `[${escape(sel.category_name)}] ` : '';
        return `<div class="order-menu compact">${catLabel}${parts}${sel.note ? ` 📝${escape(sel.note)}` : ''}</div>`;
      }
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
        <div class="barcode-wrap">
          <svg class="barcode-svg"></svg>
        </div>
        <div class="vc-menu-summary">${renderMenuOneLine(order)}</div>
        <div class="modal-actions">
          <button class="btn btn-ghost-light" data-action="close">닫기</button>
          ${allowPickup ? `<button class="btn" data-action="pickup">수령 완료 · 다음</button>` : ''}
        </div>
      `;

      content.innerHTML = '';
      content.appendChild(card);

      try {
        JsBarcode(card.querySelector('.barcode-svg'), String(order.employee_id || user.employee_id), {
          format: 'CODE128', displayValue: true, fontSize: 18,
          height: 110, margin: 8, background: '#ffffff', lineColor: '#000000',
        });
      } catch (e) { console.error('barcode error', e); }

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
      </div>

      <div id="adminBody"></div>
    `;

    $('#switchRole').addEventListener('click', () => { saveRole(null); render(); });
    document.querySelectorAll('.tab').forEach(t =>
      t.addEventListener('click', () => { adminMealTab = t.dataset.tab; renderAdmin(); }));

    if (adminMealTab === 'breakfast') renderAdminBreakfast();
    else if (adminMealTab === 'manual') renderAdminManual();
    else renderAdminLateNight();
  }

  function renderAdminManual() {
    $('#adminBody').innerHTML = `
      <div class="section-title"><h2>야식 수동 입력 (백업 데이터 복원용)</h2></div>
      <p style="color:var(--muted);font-size:13px;margin:0 4px 12px;">사번·이름·날짜·메뉴를 직접 입력해서 야식 신청을 생성합니다.</p>
      <div class="manual-form">
        <div class="manual-row">
          <input class="input" id="mEmpId" maxlength="10" placeholder="사번 (예: 12345)" inputmode="numeric" />
          <input class="input" id="mName" maxlength="20" placeholder="이름" />
        </div>
        <div class="manual-row">
          <input class="input" id="mDate" type="date" />
          <input class="input" id="mMenu" maxlength="200" placeholder="메뉴 (예: 컵라면)" />
        </div>
        <button class="btn btn-primary" id="mAddBtn">등록</button>
      </div>
      <div id="manualLog" style="margin-top:12px;font-size:13px;"></div>
    `;

    // Set default date to today
    const todayInput = new Date().toISOString().slice(0, 10);
    $('#mDate').value = todayInput;

    $('#mAddBtn').addEventListener('click', async () => {
      const employee_id = $('#mEmpId').value.trim();
      const name = $('#mName').value.trim();
      const service_date = $('#mDate').value.trim();
      const menu = $('#mMenu').value.trim();
      const log = $('#manualLog');
      if (!employee_id || !name || !service_date || !menu) {
        toast('모든 항목을 입력해주세요'); return;
      }
      try {
        const res = await api('/api/admin/orders/manual', {
          method: 'POST',
          body: JSON.stringify({ employee_id, name, meal_type: 'late_night', menu, service_date })
        });
        const msg = res.action === 'created' ? '✅ 등록됨' : '🔄 수정됨';
        log.innerHTML = `<div style="color:var(--accent);margin-bottom:6px;">${msg} — ${escape(name)}(${escape(employee_id)}) ${service_date} ${escape(menu)}</div>` + log.innerHTML;
        $('#mEmpId').value = '';
        $('#mName').value = '';
        $('#mMenu').value = '';
      } catch (e) { toast(e.message); }
    });
  }

  function renderAdminLateNight() {
    const items = adminItems;
    $('#adminBody').innerHTML = `
      <div class="section-title">
        <h2>야식 메뉴 (${items.filter(i=>i.active).length}개 활성)</h2>
      </div>

      <div class="admin-list">
        ${items.length === 0 ? `
          <div class="empty"><span class="empty-emoji">📭</span>아직 등록된 메뉴가 없습니다</div>
        ` : items.map(it => `
          <div class="admin-row ${it.active ? '' : 'inactive'}">
            <div class="name">${escape(it.name)}</div>
            <button data-toggle="${it.id}" data-active="${it.active}">${it.active ? '숨기기' : '보이기'}</button>
            <button class="del" data-del="${it.id}" data-name="${escape(it.name)}">삭제</button>
          </div>
        `).join('')}
      </div>

      <div class="section-title"><h2>새 메뉴 추가</h2></div>
      <div class="add-row">
        <input class="input" id="newName" maxlength="50" placeholder="예: 컵라면" />
        <button class="btn btn-primary" id="addBtn">추가</button>
      </div>
      <p class="muted-note">활성 상태인 항목만 신청자에게 보입니다.</p>
    `;

    document.querySelectorAll('[data-toggle]').forEach(b =>
      b.addEventListener('click', async () => {
        const id = Number(b.dataset.toggle);
        const newActive = b.dataset.active !== '1';
        try {
          await api(`/api/menu-items/${id}`, { method: 'PATCH', body: JSON.stringify({ active: newActive }) });
          await loadAdminItems();
          renderAdmin();
        } catch (e) { toast(e.message); }
      }));

    document.querySelectorAll('[data-del]').forEach(b =>
      b.addEventListener('click', async () => {
        const id = Number(b.dataset.del);
        if (!confirm(`"${b.dataset.name}" 메뉴를 삭제할까요?`)) return;
        try {
          await api(`/api/menu-items/${id}`, { method: 'DELETE' });
          toast('삭제되었습니다');
          await loadAdminItems();
          renderAdmin();
        } catch (e) { toast(e.message); }
      }));

    const input = $('#newName');
    async function addMenu() {
      const name = input.value.trim();
      if (!name) { toast('메뉴 이름을 입력해주세요'); return; }
      try {
        await api('/api/menu-items', { method: 'POST', body: JSON.stringify({ meal_type: 'late_night', name }) });
        toast('추가되었습니다');
        input.value = '';
        await loadAdminItems();
        renderAdmin();
      } catch (e) { toast(e.message); }
    }
    $('#addBtn').addEventListener('click', addMenu);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') addMenu(); });
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
            renderActing();
          } else {
            renderActing();
          }
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

    if (!role) { renderRolePicker(); return; }

    if (role === 'applicant') {
      await Promise.all([loadMyOrders(), loadMenuItems(), loadBreakfastStructure(), loadKimbapOptions()]);
      renderApplicant();
      startPolling();
    } else if (role === 'acting') {
      await loadActiveSummary();
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
        loadKimbapOptions({ include_inactive: true })
      ]);
      renderAdmin();
    }
  }

  // Boot
  loadStored();
  render();
  window.addEventListener('focus', () => { if (user && role) render(); });
})();
