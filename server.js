// KNUH Meal Dashboard - Express + SQLite backend
// Uses Node's built-in node:sqlite (Node 22.13+) to avoid native compilation.
const express = require('express');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = process.env.PORT || 3000;

// Admins: hard-coded for now. Add more employee_ids to this set as needed.
const ADMIN_EMPLOYEE_IDS = new Set(['22807']);
const isAdmin = (user) => user && ADMIN_EMPLOYEE_IDS.has(user.employee_id);

// DB path: configurable so Railway Volume can mount /data
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'knuh.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS meal_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    meal_type TEXT NOT NULL,
    menu TEXT NOT NULL,
    selection TEXT,                                   -- JSON: structured selection (breakfast)
    service_date DATE NOT NULL DEFAULT (date('now', 'localtime')),
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    picked_up_at DATETIME,
    picked_up_by INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (picked_up_by) REFERENCES users(id)
  );

  -- Legacy: free-form menu items for late_night (kept for late_night usage)
  CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meal_type TEXT NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- New for breakfast: categories (the big red headings: 선식, 죽, 빵, ...)
  CREATE TABLE IF NOT EXISTS meal_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meal_type TEXT NOT NULL,                          -- always 'breakfast' for now, but generic
    name TEXT NOT NULL,                               -- e.g. '선식'
    emoji TEXT DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Slots within a category. Each slot represents one "choice" the applicant makes,
  -- or a fixed component (no options = informational only).
  -- options is JSON array of strings, e.g. ["우유","두유"].
  CREATE TABLE IF NOT EXISTS meal_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    name TEXT NOT NULL,                               -- e.g. '음료', '메인', '간식'
    options TEXT NOT NULL DEFAULT '[]',               -- JSON array
    is_fixed INTEGER NOT NULL DEFAULT 0,              -- 1 = informational/fixed, no user choice
    fixed_text TEXT DEFAULT '',                       -- e.g. '계란 2개' when is_fixed=1
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES meal_categories(id) ON DELETE CASCADE
  );

  -- Kimbap/주먹밥 options (single-pick, no slots/categories - just a list)
  CREATE TABLE IF NOT EXISTS kimbap_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Late-night menu periods. Each period defines a date range + kind (weekday/holiday).
  -- A given calendar day picks the period where date is within [start_date, end_date]
  -- AND kind matches whether that day is a 매장 휴무일 or not.
  CREATE TABLE IF NOT EXISTS menu_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meal_type TEXT NOT NULL DEFAULT 'late_night',
    label TEXT NOT NULL,                              -- e.g. '5월 후반', '월말'
    kind TEXT NOT NULL,                               -- 'weekday' (상시) | 'holiday' (휴무일)
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 매장 휴무일 (store closure days). Admin sets these explicitly.
  CREATE TABLE IF NOT EXISTS holidays (
    date TEXT PRIMARY KEY,                            -- YYYY-MM-DD
    label TEXT DEFAULT '',                            -- '주말', '공휴일', '어린이날' 등
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_orders_status ON meal_orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_date ON meal_orders(service_date, meal_type, status);
  CREATE INDEX IF NOT EXISTS idx_menu_items_meal ON menu_items(meal_type, active, sort_order);
  CREATE INDEX IF NOT EXISTS idx_categories_meal ON meal_categories(meal_type, active, sort_order);
  CREATE INDEX IF NOT EXISTS idx_menu_periods_lookup ON menu_periods(meal_type, kind, start_date, end_date, active);

  -- Admin notices: shown to users as a one-time popup on first visit
  CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,       -- 0 = hidden, 1 = active
    expire_at DATETIME,                       -- NULL = never expires
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_slots_category ON meal_slots(category_id, sort_order);
`);

// Migrations
(function migrate() {
  const cols = db.prepare("PRAGMA table_info(meal_orders)").all();
  if (!cols.some(c => c.name === 'service_date')) {
    console.log('[migration] adding service_date column');
    db.exec("ALTER TABLE meal_orders ADD COLUMN service_date DATE");
    db.exec("UPDATE meal_orders SET service_date = date(created_at, 'localtime') WHERE service_date IS NULL");
  }
  if (!cols.some(c => c.name === 'selection')) {
    console.log('[migration] adding selection column');
    db.exec("ALTER TABLE meal_orders ADD COLUMN selection TEXT");
  }
  const itemCols = db.prepare("PRAGMA table_info(menu_items)").all();
  if (!itemCols.some(c => c.name === 'period_id')) {
    console.log('[migration] adding period_id column to menu_items');
    db.exec("ALTER TABLE menu_items ADD COLUMN period_id INTEGER REFERENCES menu_periods(id) ON DELETE CASCADE");
  }
})();

// Partial unique index: one pending order per (user, date, meal_type)
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_unique_pending
    ON meal_orders(user_id, service_date, meal_type)
    WHERE status = 'pending';
`);

// Seed late_night menu periods + items if menu_periods is empty
// This installs the 5/18~5/31 menu set per the user's screenshots.
(function seedLateNightPeriods() {
  const periodCount = db.prepare(`SELECT COUNT(*) AS n FROM menu_periods WHERE meal_type = 'late_night'`).get().n;
  if (periodCount > 0) return;
  console.log('[seed] populating default late_night menu periods & items (5/18~5/31)');

  const insP = db.prepare(`
    INSERT INTO menu_periods (meal_type, label, kind, start_date, end_date, sort_order)
    VALUES ('late_night', ?, ?, ?, ?, ?)
  `);
  const insM = db.prepare(`
    INSERT INTO menu_items (meal_type, name, period_id, sort_order)
    VALUES ('late_night', ?, ?, ?)
  `);

  // 상시 (weekday) — 5/18~5/31
  const r1 = insP.run('5월 후반 상시', 'weekday', '2026-05-18', '2026-05-31', 0);
  const weekdayId = Number(r1.lastInsertRowid);
  const weekdayMenu = [
    '돼지국밥',
    '훈제오리샐러드',
    '소보루덮밥',
    '즉석라면+삶은계란+공기밥',
    '떠먹는요거트+구운란+사과주스',
  ];
  weekdayMenu.forEach((n, i) => insM.run(n, weekdayId, i));

  // 매장 휴무일 — 5/18~5/31
  const r2 = insP.run('5월 후반 휴무일', 'holiday', '2026-05-18', '2026-05-31', 1);
  const holidayId = Number(r2.lastInsertRowid);
  const holidayMenu = [
    '돼지국밥',
    '훈제오리샐러드',
    '빵+멸균우유+핫바',
    '떠먹는요거트+구운란+사과주스',
  ];
  holidayMenu.forEach((n, i) => insM.run(n, holidayId, i));

  // Clean up any orphan menu_items (legacy ones with no period_id) - leave them as-is for safety
  // They won't be served because the API requires a matching period_id.
})();

// Seed default 매장 휴무일 if empty (this month's known closures)
(function seedHolidays() {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM holidays`).get().n;
  if (count > 0) return;
  console.log('[seed] populating default holidays (May 2026)');
  const defaults = [
    { date: '2026-05-03', label: '주말 (일)' },
    { date: '2026-05-05', label: '어린이날' },
    { date: '2026-05-10', label: '주말 (일)' },
    { date: '2026-05-17', label: '주말 (일)' },
    { date: '2026-05-24', label: '주말 (일)' },
    { date: '2026-05-25', label: '공휴일' },
    { date: '2026-05-31', label: '주말 (일)' },
  ];
  const ins = db.prepare('INSERT OR IGNORE INTO holidays (date, label) VALUES (?, ?)');
  defaults.forEach(h => ins.run(h.date, h.label));
})();

// Seed kimbap options if empty
(function seedKimbap() {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM kimbap_options`).get().n;
  if (count > 0) return;
  console.log('[seed] populating default kimbap options');
  const items = ['김밥', '주먹밥'];
  const ins = db.prepare('INSERT INTO kimbap_options (name, sort_order) VALUES (?, ?)');
  items.forEach((name, i) => ins.run(name, i));
})();

// Seed breakfast categories + slots from the Pick-up station photo
(function seedBreakfast() {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM meal_categories WHERE meal_type = 'breakfast'`).get().n;
  if (count > 0) return;
  console.log('[seed] populating default breakfast structure');

  const cats = [
    { name: '선식', emoji: '🥣', slots: [
      { name: '메인', options: ['선식', '콘푸레이크'] },
      { name: '음료', options: ['우유', '두유'] },
      { name: '계란', is_fixed: 1, fixed_text: '계란 2개' },
    ]},
    { name: '죽', emoji: '🍲', slots: [
      { name: '죽', is_fixed: 1, fixed_text: '죽' },
      { name: '음료', is_fixed: 1, fixed_text: '음료' },
      { name: '계란', is_fixed: 1, fixed_text: '계란 2개' },
    ]},
    { name: '빵', emoji: '🍞', slots: [
      { name: '빵 종류', options: ['1종', '2종'] },
      { name: '음료', is_fixed: 1, fixed_text: '음료' },
      { name: '간식', is_fixed: 1, fixed_text: '간식 1개' },
    ]},
    { name: '햄버거/샌드위치', emoji: '🍔', slots: [
      { name: '메인', options: ['햄버거', '샌드위치'] },
      { name: '음료', is_fixed: 1, fixed_text: '음료' },
      { name: '계란', is_fixed: 1, fixed_text: '계란 2개' },
    ]},
    { name: '닭가슴살', emoji: '🍗', slots: [
      { name: '닭가슴살', is_fixed: 1, fixed_text: '닭가슴살' },
      { name: '음료', options: ['프로틴', '우유', '요거톡'] },
    ]},
    { name: '떡볶이', emoji: '🍢', slots: [
      { name: '떡볶이', is_fixed: 1, fixed_text: '떡볶이' },
      { name: '사이드', options: ['햇반', '컵라면(소)'] },
      { name: '음료', is_fixed: 1, fixed_text: '음료' },
    ]},
    { name: '라면', emoji: '🍜', slots: [
      { name: '컵라면', is_fixed: 1, fixed_text: '컵라면' },
      { name: '음료', is_fixed: 1, fixed_text: '음료' },
      { name: '밥', is_fixed: 1, fixed_text: '밥' },
    ]},
    { name: '밥', emoji: '🍱', slots: [
      { name: '메인', options: ['도시락', '김밥', '컵밥'] },
      { name: '생수', is_fixed: 1, fixed_text: '생수' },
    ]},
  ];

  const insCat = db.prepare(`
    INSERT INTO meal_categories (meal_type, name, emoji, sort_order) VALUES (?, ?, ?, ?)
  `);
  const insSlot = db.prepare(`
    INSERT INTO meal_slots (category_id, name, options, is_fixed, fixed_text, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  cats.forEach((c, ci) => {
    const r = insCat.run('breakfast', c.name, c.emoji || '', ci);
    const catId = Number(r.lastInsertRowid);
    c.slots.forEach((s, si) => {
      insSlot.run(
        catId,
        s.name,
        JSON.stringify(s.options || []),
        s.is_fixed ? 1 : 0,
        s.fixed_text || '',
        si
      );
    });
  });
})();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Helpers ---
function getUserByEmployeeId(employee_id) {
  return db.prepare('SELECT * FROM users WHERE employee_id = ?').get(employee_id);
}

function requireUser(req, res) {
  const employee_id = req.headers['x-employee-id'] || req.query.employee_id || req.body?.employee_id;
  if (!employee_id) {
    res.status(401).json({ error: '로그인이 필요합니다' });
    return null;
  }
  const user = getUserByEmployeeId(String(employee_id));
  if (!user) {
    res.status(401).json({ error: '등록되지 않은 사용자입니다' });
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (!isAdmin(user)) {
    res.status(403).json({ error: '관리자 권한이 필요합니다' });
    return null;
  }
  return user;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00');
  return !isNaN(d.getTime());
}

function parseJSON(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// Load breakfast structure: categories with their slots
function loadBreakfastStructure({ include_inactive = false } = {}) {
  const catSql = include_inactive
    ? `SELECT * FROM meal_categories WHERE meal_type = 'breakfast' ORDER BY sort_order, id`
    : `SELECT * FROM meal_categories WHERE meal_type = 'breakfast' AND active = 1 ORDER BY sort_order, id`;
  const cats = db.prepare(catSql).all();
  const slotsByCat = {};
  const allSlots = db.prepare(`
    SELECT s.* FROM meal_slots s
    JOIN meal_categories c ON s.category_id = c.id
    WHERE c.meal_type = 'breakfast'
    ORDER BY s.sort_order, s.id
  `).all();
  for (const s of allSlots) {
    s.options = parseJSON(s.options, []);
    s.is_fixed = !!s.is_fixed;
    (slotsByCat[s.category_id] = slotsByCat[s.category_id] || []).push(s);
  }
  return cats.map(c => ({
    ...c,
    active: !!c.active,
    slots: slotsByCat[c.id] || [],
  }));
}

// Build a human-readable summary string from a structured breakfast selection.
// New schema:
// {
//   meal_form: 'snack_pick' | 'kimbap',
//   kimbap_choice?: '김밥',                                // only when form=kimbap
//   category_priorities?: [                                // only when form=snack_pick
//     {
//       category_id, category_name, category_emoji,
//       slots: [
//         { slot_id, slot_name, fixed }                    // for fixed slots
//         OR { slot_id, slot_name, priority: [...], any }  // for option slots
//       ]
//     }, ...
//   ],
//   fallback_any?: boolean,                                // for snack_pick
//   note?: string
// }
function summarizeCategoryChoice(cc) {
  const emoji = cc.category_emoji || '';
  const name = cc.category_name || '';
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

function summarizeBreakfast(sel) {
  if (!sel) return '';
  if (sel.meal_form === 'no_meal') {
    let s = '🚫 식사 안 받음';
    if (sel.note) s += ` — ${sel.note}`;
    return s;
  }
  if (sel.meal_form === 'kimbap') {
    let s = `🍙 ${sel.kimbap_choice || ''}`;
    if (sel.note) s += ` — ${sel.note}`;
    return s;
  }
  // snack_pick
  const prios = Array.isArray(sel.category_priorities) ? sel.category_priorities : [];
  if (prios.length === 0) return '';
  const tiers = prios.map((cc, i) => `${i + 1}순위 ${summarizeCategoryChoice(cc)}`).join(' → ');
  const tail = sel.fallback_any ? ' → 🎲아무거나' : '';
  let s = `🥣 ${tiers}${tail}`;
  if (sel.note) s += ` — ${sel.note}`;
  return s;
}

// Validate one category choice (used for each priority tier)
function validateCategoryChoice(catChoice) {
  if (!catChoice || typeof catChoice !== 'object') return { error: '카테고리 선택이 올바르지 않습니다' };
  const catId = Number(catChoice.category_id);
  if (!catId) return { error: '카테고리를 선택해주세요' };

  const cat = db.prepare(`SELECT * FROM meal_categories WHERE id = ? AND meal_type = 'breakfast' AND active = 1`).get(catId);
  if (!cat) return { error: '존재하지 않는 카테고리입니다' };

  const slots = db.prepare(`SELECT * FROM meal_slots WHERE category_id = ? ORDER BY sort_order, id`).all(catId);
  const submittedBySlot = {};
  if (Array.isArray(catChoice.slots)) {
    for (const s of catChoice.slots) {
      if (s && typeof s.slot_id !== 'undefined') submittedBySlot[Number(s.slot_id)] = s;
    }
  }

  const normSlots = [];
  for (const s of slots) {
    const opts = parseJSON(s.options, []);
    if (s.is_fixed) {
      normSlots.push({ slot_id: s.id, slot_name: s.name, fixed: s.fixed_text || s.name });
      continue;
    }
    const u = submittedBySlot[s.id] || {};
    let priority = Array.isArray(u.priority) ? u.priority.slice() : [];
    priority = priority.filter(v => opts.includes(v));
    priority = [...new Set(priority)];
    const any = !!u.any;
    if (priority.length === 0 && !any) {
      return { error: `"${cat.name}" 카테고리의 "${s.name}" 선택을 해주세요` };
    }
    normSlots.push({ slot_id: s.id, slot_name: s.name, priority, any });
  }

  return {
    choice: {
      category_id: cat.id,
      category_name: cat.name,
      category_emoji: cat.emoji || '',
      slots: normSlots,
    }
  };
}

// Validate full breakfast selection (handles both meal_forms)
function validateBreakfastSelection(input) {
  if (!input || typeof input !== 'object') return { error: '선택 정보가 올바르지 않습니다' };
  const form = input.meal_form;

  if (form === 'no_meal') {
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 200) : '';
    const sel = { meal_form: 'no_meal' };
    if (note) sel.note = note;
    return { selection: sel, menu: summarizeBreakfast(sel) };
  }

  if (form === 'kimbap') {
    const choice = String(input.kimbap_choice || '').trim();
    if (!choice) return { error: '김밥/주먹밥 종류를 선택해주세요' };
    // Validate against active kimbap options
    const valid = db.prepare(`SELECT * FROM kimbap_options WHERE name = ? AND active = 1`).get(choice);
    if (!valid) return { error: '선택한 항목이 없습니다' };

    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 200) : '';
    const sel = { meal_form: 'kimbap', kimbap_choice: choice };
    if (note) sel.note = note;
    return { selection: sel, menu: summarizeBreakfast(sel) };
  }

  if (form === 'snack_pick') {
    const prios = Array.isArray(input.category_priorities) ? input.category_priorities : [];
    if (prios.length === 0) return { error: '대분류를 선택해주세요' };
    if (prios.length > 5) return { error: '대분류 우선순위는 최대 5개까지 가능합니다' };

    const usedCatIds = new Set();
    const normPriorities = [];
    for (let i = 0; i < prios.length; i++) {
      const v = validateCategoryChoice(prios[i]);
      if (v.error) return { error: `${i + 1}순위: ${v.error}` };
      if (usedCatIds.has(v.choice.category_id)) {
        return { error: `${i + 1}순위: 같은 카테고리를 중복 선택할 수 없습니다` };
      }
      usedCatIds.add(v.choice.category_id);
      normPriorities.push(v.choice);
    }

    // fallback_any: only meaningful if user said "if all gone, give me anything"
    const fallback_any = !!input.fallback_any;

    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 200) : '';
    const sel = {
      meal_form: 'snack_pick',
      category_priorities: normPriorities,
      fallback_any,
    };
    if (note) sel.note = note;
    return { selection: sel, menu: summarizeBreakfast(sel) };
  }

  return { error: '식사 형태(meal_form)가 올바르지 않습니다' };
}

// --- Auth / User ---

app.post('/api/register', (req, res) => {
  let { employee_id, name } = req.body || {};
  employee_id = String(employee_id || '').trim();
  name = String(name || '').trim();

  if (!/^\d{3,10}$/.test(employee_id)) {
    return res.status(400).json({ error: '사번은 숫자만 입력해주세요' });
  }
  if (!name) {
    return res.status(400).json({ error: '이름을 입력해주세요' });
  }

  const existing = getUserByEmployeeId(employee_id);
  if (existing) {
    if (existing.name !== name) {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, existing.id);
      existing.name = name;
    }
    return res.json({ ...existing, is_admin: isAdmin(existing) });
  }

  const result = db.prepare('INSERT INTO users (employee_id, name) VALUES (?, ?)').run(employee_id, name);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(result.lastInsertRowid));
  res.json({ ...user, is_admin: isAdmin(user) });
});

app.get('/api/me', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json({ ...user, is_admin: isAdmin(user) });
});

// --- Late-night menu items (legacy / current usage) ---

// Determines if a given date string is a 매장 휴무일
function isHoliday(dateStr) {
  if (!validDate(dateStr)) return false;
  const row = db.prepare('SELECT date FROM holidays WHERE date = ?').get(dateStr);
  return !!row;
}

// For a given date + meal_type, find the matching active period.
// Returns the period row, or null if none matches.
function findPeriodForDate(meal_type, dateStr) {
  const kind = isHoliday(dateStr) ? 'holiday' : 'weekday';
  return db.prepare(`
    SELECT * FROM menu_periods
    WHERE meal_type = ?
      AND kind = ?
      AND active = 1
      AND start_date <= ?
      AND end_date >= ?
    ORDER BY start_date DESC, id DESC
    LIMIT 1
  `).get(meal_type, kind, dateStr, dateStr);
}

app.get('/api/menu-items', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { meal_type, include_inactive, date, period_id } = req.query;

  // Date-based query: applicant flow uses this to get the right menu for the day they're ordering for.
  // Returns: { period: {...}|null, kind: 'weekday'|'holiday', is_holiday: bool, items: [...] }
  if (date) {
    if (!validDate(date)) return res.status(400).json({ error: '잘못된 날짜 형식입니다' });
    if (!meal_type) return res.status(400).json({ error: 'meal_type이 필요합니다' });
    const holiday = isHoliday(date);
    const kind = holiday ? 'holiday' : 'weekday';
    const period = findPeriodForDate(meal_type, date);
    let items = [];
    if (period) {
      items = db.prepare(`
        SELECT * FROM menu_items
        WHERE meal_type = ? AND active = 1 AND period_id = ?
        ORDER BY sort_order, id
      `).all(meal_type, period.id);
    }
    return res.json({ period, kind, is_holiday: holiday, items });
  }

  // Period-based query (admin views)
  if (period_id) {
    const sql = include_inactive
      ? 'SELECT * FROM menu_items WHERE period_id = ? ORDER BY sort_order, id'
      : 'SELECT * FROM menu_items WHERE period_id = ? AND active = 1 ORDER BY sort_order, id';
    return res.json(db.prepare(sql).all(Number(period_id)));
  }

  // Legacy: plain meal_type query (returns all items including orphans without period)
  let sql = 'SELECT * FROM menu_items';
  const params = [];
  const conds = [];
  if (meal_type) { conds.push('meal_type = ?'); params.push(meal_type); }
  if (!include_inactive) { conds.push('active = 1'); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY meal_type, sort_order, id';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/menu-items', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;

  let { meal_type, name, period_id } = req.body || {};
  name = String(name || '').trim();
  period_id = period_id ? Number(period_id) : null;

  if (!['breakfast', 'late_night'].includes(meal_type)) {
    return res.status(400).json({ error: '잘못된 식사 유형입니다' });
  }
  if (!name) return res.status(400).json({ error: '메뉴 이름을 입력해주세요' });
  if (name.length > 50) return res.status(400).json({ error: '메뉴 이름이 너무 깁니다 (50자 이하)' });

  if (meal_type === 'late_night') {
    if (!period_id) return res.status(400).json({ error: '메뉴 기간(period_id)을 지정해주세요' });
    const period = db.prepare('SELECT * FROM menu_periods WHERE id = ? AND meal_type = ?').get(period_id, meal_type);
    if (!period) return res.status(404).json({ error: '존재하지 않는 기간입니다' });
  }

  // Duplicate check scoped to (meal_type, period_id)
  const dup = db.prepare(`
    SELECT * FROM menu_items
    WHERE meal_type = ? AND name = ? AND active = 1
      AND ((? IS NULL AND period_id IS NULL) OR period_id = ?)
  `).get(meal_type, name, period_id, period_id);
  if (dup) return res.status(409).json({ error: '이미 같은 이름의 메뉴가 있습니다' });

  const maxOrder = db.prepare(`
    SELECT COALESCE(MAX(sort_order), -1) AS m FROM menu_items
    WHERE meal_type = ? AND ((? IS NULL AND period_id IS NULL) OR period_id = ?)
  `).get(meal_type, period_id, period_id).m;
  const result = db.prepare(`
    INSERT INTO menu_items (meal_type, name, period_id, sort_order) VALUES (?, ?, ?, ?)
  `).run(meal_type, name, period_id, maxOrder + 1);

  res.json(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(Number(result.lastInsertRowid)));
});

app.patch('/api/menu-items/:id', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;

  const id = Number(req.params.id);
  const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ error: '메뉴를 찾을 수 없습니다' });

  const updates = [];
  const params = [];
  if (typeof req.body?.name === 'string') {
    const name = req.body.name.trim();
    if (!name || name.length > 50) return res.status(400).json({ error: '메뉴 이름이 올바르지 않습니다' });
    updates.push('name = ?'); params.push(name);
  }
  if (typeof req.body?.active === 'boolean') {
    updates.push('active = ?'); params.push(req.body.active ? 1 : 0);
  }
  if (typeof req.body?.sort_order === 'number') {
    updates.push('sort_order = ?'); params.push(req.body.sort_order);
  }
  if (!updates.length) return res.status(400).json({ error: '변경할 내용이 없습니다' });

  params.push(id);
  db.prepare(`UPDATE menu_items SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id));
});

app.delete('/api/menu-items/:id', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  const id = Number(req.params.id);
  const result = db.prepare('DELETE FROM menu_items WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: '메뉴를 찾을 수 없습니다' });
  res.json({ ok: true });
});

// --- Breakfast structure: categories + slots ---

// --- Late-night menu periods (CRUD) ---

app.get('/api/menu-periods', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const include_inactive = !!req.query.include_inactive;
  const meal_type = req.query.meal_type || 'late_night';
  const sql = include_inactive
    ? `SELECT * FROM menu_periods WHERE meal_type = ? ORDER BY sort_order, start_date, id`
    : `SELECT * FROM menu_periods WHERE meal_type = ? AND active = 1 ORDER BY sort_order, start_date, id`;
  res.json(db.prepare(sql).all(meal_type));
});

app.post('/api/menu-periods', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  let { meal_type, label, kind, start_date, end_date } = req.body || {};
  meal_type = meal_type || 'late_night';
  label = String(label || '').trim();
  kind = String(kind || '').trim();

  if (meal_type !== 'late_night') return res.status(400).json({ error: 'meal_type은 현재 late_night만 지원합니다' });
  if (!label) return res.status(400).json({ error: '기간 이름을 입력해주세요' });
  if (label.length > 50) return res.status(400).json({ error: '이름이 너무 깁니다' });
  if (!['weekday', 'holiday'].includes(kind)) return res.status(400).json({ error: 'kind는 weekday 또는 holiday여야 합니다' });
  if (!validDate(start_date) || !validDate(end_date)) return res.status(400).json({ error: '시작/종료 날짜가 올바르지 않습니다' });
  if (start_date > end_date) return res.status(400).json({ error: '시작 날짜가 종료 날짜보다 늦습니다' });

  const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM menu_periods WHERE meal_type = ?`).get(meal_type).m;
  const r = db.prepare(`
    INSERT INTO menu_periods (meal_type, label, kind, start_date, end_date, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(meal_type, label, kind, start_date, end_date, maxOrder + 1);
  res.json(db.prepare('SELECT * FROM menu_periods WHERE id = ?').get(Number(r.lastInsertRowid)));
});

app.patch('/api/menu-periods/:id', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  const id = Number(req.params.id);
  const p = db.prepare('SELECT * FROM menu_periods WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: '기간을 찾을 수 없습니다' });

  const updates = [];
  const params = [];
  if (typeof req.body?.label === 'string') {
    const v = req.body.label.trim();
    if (!v || v.length > 50) return res.status(400).json({ error: '이름이 올바르지 않습니다' });
    updates.push('label = ?'); params.push(v);
  }
  if (typeof req.body?.kind === 'string') {
    if (!['weekday', 'holiday'].includes(req.body.kind)) return res.status(400).json({ error: 'kind는 weekday 또는 holiday여야 합니다' });
    updates.push('kind = ?'); params.push(req.body.kind);
  }
  if (typeof req.body?.start_date === 'string') {
    if (!validDate(req.body.start_date)) return res.status(400).json({ error: '시작 날짜가 올바르지 않습니다' });
    updates.push('start_date = ?'); params.push(req.body.start_date);
  }
  if (typeof req.body?.end_date === 'string') {
    if (!validDate(req.body.end_date)) return res.status(400).json({ error: '종료 날짜가 올바르지 않습니다' });
    updates.push('end_date = ?'); params.push(req.body.end_date);
  }
  if (typeof req.body?.active === 'boolean') {
    updates.push('active = ?'); params.push(req.body.active ? 1 : 0);
  }
  if (typeof req.body?.sort_order === 'number') {
    updates.push('sort_order = ?'); params.push(req.body.sort_order);
  }
  if (!updates.length) return res.status(400).json({ error: '변경할 내용이 없습니다' });
  params.push(id);
  db.prepare(`UPDATE menu_periods SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM menu_periods WHERE id = ?').get(id));
});

app.delete('/api/menu-periods/:id', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  const id = Number(req.params.id);
  // Manually delete menu_items in this period first (FK CASCADE configured but ON DELETE may not fire with ALTER TABLE-added FK in SQLite)
  db.prepare('DELETE FROM menu_items WHERE period_id = ?').run(id);
  const r = db.prepare('DELETE FROM menu_periods WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: '기간을 찾을 수 없습니다' });
  res.json({ ok: true });
});

// --- Holidays (CRUD) ---

app.get('/api/holidays', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { from, to } = req.query;
  let sql = 'SELECT date, label FROM holidays';
  const params = [];
  const conds = [];
  if (from && validDate(from)) { conds.push('date >= ?'); params.push(from); }
  if (to && validDate(to)) { conds.push('date <= ?'); params.push(to); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY date';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/holidays', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  let { date, label } = req.body || {};
  date = String(date || '').trim();
  label = String(label || '').trim().slice(0, 50);
  if (!validDate(date)) return res.status(400).json({ error: '날짜를 YYYY-MM-DD 형식으로 입력해주세요' });
  const dup = db.prepare('SELECT date FROM holidays WHERE date = ?').get(date);
  if (dup) return res.status(409).json({ error: '이미 등록된 휴무일입니다' });
  db.prepare('INSERT INTO holidays (date, label) VALUES (?, ?)').run(date, label);
  res.json({ date, label });
});

app.delete('/api/holidays/:date', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  const date = String(req.params.date || '').trim();
  if (!validDate(date)) return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다' });
  const r = db.prepare('DELETE FROM holidays WHERE date = ?').run(date);
  if (r.changes === 0) return res.status(404).json({ error: '해당 휴무일을 찾을 수 없습니다' });
  res.json({ ok: true });
});

// --- Notices ---

// Public: return the single currently-active, non-expired notice (for popup)
app.get('/api/notices/active', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const now = new Date().toISOString();
  const notice = db.prepare(`
    SELECT id, title, body, expire_at, created_at
    FROM notices
    WHERE active = 1
      AND (expire_at IS NULL OR expire_at > ?)
    ORDER BY created_at DESC
    LIMIT 1
  `).get(now);
  res.json(notice || null);
});

// Admin: list all notices
app.get('/api/admin/notices', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  res.json(db.prepare('SELECT * FROM notices ORDER BY created_at DESC').all());
});

// Admin: create notice
app.post('/api/admin/notices', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  let { title, body, expire_at } = req.body || {};
  title = String(title || '').trim();
  body  = String(body  || '').trim();
  if (!title) return res.status(400).json({ error: '제목을 입력해주세요' });
  if (!body)  return res.status(400).json({ error: '내용을 입력해주세요' });
  if (title.length > 100) return res.status(400).json({ error: '제목이 너무 깁니다' });
  if (body.length  > 1000) return res.status(400).json({ error: '내용이 너무 깁니다' });
  // expire_at: accept ISO string or null/empty → null
  const expireVal = expire_at && String(expire_at).trim() ? String(expire_at).trim() : null;
  const r = db.prepare('INSERT INTO notices (title, body, expire_at) VALUES (?, ?, ?)').run(title, body, expireVal);
  res.json(db.prepare('SELECT * FROM notices WHERE id = ?').get(Number(r.lastInsertRowid)));
});

// Admin: update (title/body/active/expire_at)
app.patch('/api/admin/notices/:id', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  const id = Number(req.params.id);
  const notice = db.prepare('SELECT * FROM notices WHERE id = ?').get(id);
  if (!notice) return res.status(404).json({ error: '공지를 찾을 수 없습니다' });
  const updates = []; const params = [];
  if (typeof req.body?.title === 'string') {
    const v = req.body.title.trim();
    if (!v || v.length > 100) return res.status(400).json({ error: '제목이 올바르지 않습니다' });
    updates.push('title = ?'); params.push(v);
  }
  if (typeof req.body?.body === 'string') {
    const v = req.body.body.trim();
    if (!v || v.length > 1000) return res.status(400).json({ error: '내용이 올바르지 않습니다' });
    updates.push('body = ?'); params.push(v);
  }
  if (typeof req.body?.active === 'boolean') {
    updates.push('active = ?'); params.push(req.body.active ? 1 : 0);
  }
  if ('expire_at' in (req.body || {})) {
    const v = req.body.expire_at && String(req.body.expire_at).trim() ? String(req.body.expire_at).trim() : null;
    updates.push('expire_at = ?'); params.push(v);
  }
  if (!updates.length) return res.status(400).json({ error: '변경할 내용이 없습니다' });
  params.push(id);
  db.prepare(`UPDATE notices SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM notices WHERE id = ?').get(id));
});

// Admin: delete notice
app.delete('/api/admin/notices/:id', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  const r = db.prepare('DELETE FROM notices WHERE id = ?').run(Number(req.params.id));
  if (r.changes === 0) return res.status(404).json({ error: '공지를 찾을 수 없습니다' });
  res.json({ ok: true });
});

// --- Breakfast structure ---

app.get('/api/breakfast-structure', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const include_inactive = !!req.query.include_inactive;
  res.json(loadBreakfastStructure({ include_inactive }));
});

// Categories CRUD
app.post('/api/categories', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  let { name, emoji } = req.body || {};
  name = String(name || '').trim();
  emoji = String(emoji || '').trim().slice(0, 4);
  if (!name) return res.status(400).json({ error: '카테고리 이름을 입력해주세요' });
  if (name.length > 30) return res.status(400).json({ error: '이름이 너무 깁니다' });

  const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM meal_categories WHERE meal_type = 'breakfast'`).get().m;
  const r = db.prepare(`
    INSERT INTO meal_categories (meal_type, name, emoji, sort_order) VALUES ('breakfast', ?, ?, ?)
  `).run(name, emoji, maxOrder + 1);
  res.json(db.prepare('SELECT * FROM meal_categories WHERE id = ?').get(Number(r.lastInsertRowid)));
});

app.patch('/api/categories/:id', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  const id = Number(req.params.id);
  const cat = db.prepare('SELECT * FROM meal_categories WHERE id = ?').get(id);
  if (!cat) return res.status(404).json({ error: '카테고리를 찾을 수 없습니다' });

  const updates = [];
  const params = [];
  if (typeof req.body?.name === 'string') {
    const v = req.body.name.trim();
    if (!v || v.length > 30) return res.status(400).json({ error: '이름이 올바르지 않습니다' });
    updates.push('name = ?'); params.push(v);
  }
  if (typeof req.body?.emoji === 'string') {
    updates.push('emoji = ?'); params.push(req.body.emoji.slice(0, 4));
  }
  if (typeof req.body?.active === 'boolean') {
    updates.push('active = ?'); params.push(req.body.active ? 1 : 0);
  }
  if (typeof req.body?.sort_order === 'number') {
    updates.push('sort_order = ?'); params.push(req.body.sort_order);
  }
  if (!updates.length) return res.status(400).json({ error: '변경할 내용이 없습니다' });
  params.push(id);
  db.prepare(`UPDATE meal_categories SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM meal_categories WHERE id = ?').get(id));
});

app.delete('/api/categories/:id', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  const id = Number(req.params.id);
  const r = db.prepare('DELETE FROM meal_categories WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: '카테고리를 찾을 수 없습니다' });
  res.json({ ok: true });
});

// Slots CRUD
app.post('/api/slots', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  let { category_id, name, options, is_fixed, fixed_text } = req.body || {};
  category_id = Number(category_id);
  name = String(name || '').trim();
  is_fixed = !!is_fixed;
  fixed_text = String(fixed_text || '').trim();
  if (!category_id) return res.status(400).json({ error: '카테고리를 지정해주세요' });
  if (!name) return res.status(400).json({ error: '슬롯 이름을 입력해주세요' });
  if (name.length > 30) return res.status(400).json({ error: '이름이 너무 깁니다' });

  const cat = db.prepare('SELECT * FROM meal_categories WHERE id = ?').get(category_id);
  if (!cat) return res.status(404).json({ error: '카테고리를 찾을 수 없습니다' });

  let optsArr = [];
  if (!is_fixed) {
    if (!Array.isArray(options)) return res.status(400).json({ error: '옵션 목록이 올바르지 않습니다' });
    optsArr = options.map(s => String(s || '').trim()).filter(Boolean).slice(0, 20);
    if (optsArr.length === 0) return res.status(400).json({ error: '옵션을 한 개 이상 입력해주세요' });
  } else {
    if (!fixed_text) fixed_text = name;
  }

  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM meal_slots WHERE category_id = ?').get(category_id).m;
  const r = db.prepare(`
    INSERT INTO meal_slots (category_id, name, options, is_fixed, fixed_text, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(category_id, name, JSON.stringify(optsArr), is_fixed ? 1 : 0, fixed_text, maxOrder + 1);

  res.json(db.prepare('SELECT * FROM meal_slots WHERE id = ?').get(Number(r.lastInsertRowid)));
});

app.patch('/api/slots/:id', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  const id = Number(req.params.id);
  const slot = db.prepare('SELECT * FROM meal_slots WHERE id = ?').get(id);
  if (!slot) return res.status(404).json({ error: '슬롯을 찾을 수 없습니다' });

  const updates = [];
  const params = [];
  if (typeof req.body?.name === 'string') {
    const v = req.body.name.trim();
    if (!v || v.length > 30) return res.status(400).json({ error: '이름이 올바르지 않습니다' });
    updates.push('name = ?'); params.push(v);
  }
  if (typeof req.body?.is_fixed === 'boolean') {
    updates.push('is_fixed = ?'); params.push(req.body.is_fixed ? 1 : 0);
  }
  if (typeof req.body?.fixed_text === 'string') {
    updates.push('fixed_text = ?'); params.push(req.body.fixed_text.trim());
  }
  if (Array.isArray(req.body?.options)) {
    const arr = req.body.options.map(s => String(s || '').trim()).filter(Boolean).slice(0, 20);
    updates.push('options = ?'); params.push(JSON.stringify(arr));
  }
  if (typeof req.body?.sort_order === 'number') {
    updates.push('sort_order = ?'); params.push(req.body.sort_order);
  }
  if (!updates.length) return res.status(400).json({ error: '변경할 내용이 없습니다' });
  params.push(id);
  db.prepare(`UPDATE meal_slots SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM meal_slots WHERE id = ?').get(id));
});

app.delete('/api/slots/:id', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  const id = Number(req.params.id);
  const r = db.prepare('DELETE FROM meal_slots WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: '슬롯을 찾을 수 없습니다' });
  res.json({ ok: true });
});

// --- Kimbap options ---

app.get('/api/kimbap-options', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const include_inactive = !!req.query.include_inactive;
  const sql = include_inactive
    ? `SELECT * FROM kimbap_options ORDER BY sort_order, id`
    : `SELECT * FROM kimbap_options WHERE active = 1 ORDER BY sort_order, id`;
  res.json(db.prepare(sql).all());
});

app.post('/api/kimbap-options', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  let { name } = req.body || {};
  name = String(name || '').trim();
  if (!name) return res.status(400).json({ error: '이름을 입력해주세요' });
  if (name.length > 30) return res.status(400).json({ error: '이름이 너무 깁니다' });

  const dup = db.prepare(`SELECT * FROM kimbap_options WHERE name = ? AND active = 1`).get(name);
  if (dup) return res.status(409).json({ error: '이미 같은 이름이 있습니다' });

  const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM kimbap_options`).get().m;
  const r = db.prepare(`INSERT INTO kimbap_options (name, sort_order) VALUES (?, ?)`).run(name, maxOrder + 1);
  res.json(db.prepare(`SELECT * FROM kimbap_options WHERE id = ?`).get(Number(r.lastInsertRowid)));
});

app.patch('/api/kimbap-options/:id', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  const id = Number(req.params.id);
  const item = db.prepare(`SELECT * FROM kimbap_options WHERE id = ?`).get(id);
  if (!item) return res.status(404).json({ error: '항목을 찾을 수 없습니다' });

  const updates = [];
  const params = [];
  if (typeof req.body?.name === 'string') {
    const v = req.body.name.trim();
    if (!v || v.length > 30) return res.status(400).json({ error: '이름이 올바르지 않습니다' });
    updates.push('name = ?'); params.push(v);
  }
  if (typeof req.body?.active === 'boolean') {
    updates.push('active = ?'); params.push(req.body.active ? 1 : 0);
  }
  if (typeof req.body?.sort_order === 'number') {
    updates.push('sort_order = ?'); params.push(req.body.sort_order);
  }
  if (!updates.length) return res.status(400).json({ error: '변경할 내용이 없습니다' });
  params.push(id);
  db.prepare(`UPDATE kimbap_options SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare(`SELECT * FROM kimbap_options WHERE id = ?`).get(id));
});

app.delete('/api/kimbap-options/:id', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  const id = Number(req.params.id);
  const r = db.prepare(`DELETE FROM kimbap_options WHERE id = ?`).run(id);
  if (r.changes === 0) return res.status(404).json({ error: '항목을 찾을 수 없습니다' });
  res.json({ ok: true });
});

// --- Orders ---

// Single-date create or update.
// For breakfast: requires { selection: {...} }. menu is derived.
// For late_night: requires { menu: "..." }.
// Validate & normalize a late-night selection.
// schema: { priority: ['메뉴1','메뉴2','메뉴3'], custom: '...' } — both fields optional, but at least one must be non-empty
function validateLateNightSelection(input, fallbackMenu) {
  // Legacy: if no selection provided but menu given, fall back to simple menu-only
  if (!input || typeof input !== 'object') {
    const m = String(fallbackMenu || '').trim();
    if (!m) return { error: '메뉴를 입력해주세요' };
    if (m.length > 200) return { error: '메뉴가 너무 깁니다 (200자 이하)' };
    return { selection: null, menu: m };
  }

  let priority = Array.isArray(input.priority) ? input.priority.map(s => String(s || '').trim()).filter(Boolean) : [];
  // Dedup preserving order
  priority = [...new Set(priority)];
  if (priority.length > 3) return { error: '순위는 최대 3개까지 가능합니다' };
  for (const p of priority) {
    if (p.length > 100) return { error: '메뉴 이름이 너무 깁니다' };
  }
  const custom = typeof input.custom === 'string' ? input.custom.trim().slice(0, 200) : '';

  if (priority.length === 0 && !custom) {
    return { error: '메뉴를 한 개 이상 선택하거나 직접 입력해주세요' };
  }

  // Build human-readable menu string
  let menu = '';
  if (priority.length === 1) {
    menu = priority[0];
  } else if (priority.length > 1) {
    menu = priority.map((v, i) => `${i+1}순위 ${v}`).join(' → ');
  }
  if (custom) {
    menu = menu ? `${menu} · ${custom}` : custom;
  }
  if (menu.length > 200) menu = menu.slice(0, 197) + '...';

  return {
    selection: { priority, custom },
    menu,
  };
}

app.post('/api/orders', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  let { meal_type, menu, selection, service_date } = req.body || {};

  if (!['breakfast', 'late_night'].includes(meal_type)) {
    return res.status(400).json({ error: '잘못된 식사 유형입니다' });
  }
  if (service_date && !validDate(service_date)) {
    return res.status(400).json({ error: '잘못된 날짜 형식입니다 (YYYY-MM-DD)' });
  }
  if (!service_date) {
    service_date = db.prepare("SELECT date('now', 'localtime') AS d").get().d;
  }

  let selectionJSON = null;
  if (meal_type === 'breakfast') {
    const v = validateBreakfastSelection(selection);
    if (v.error) return res.status(400).json({ error: v.error });
    selectionJSON = JSON.stringify(v.selection);
    menu = v.menu;
  } else {
    const v = validateLateNightSelection(selection, menu);
    if (v.error) return res.status(400).json({ error: v.error });
    if (v.selection) selectionJSON = JSON.stringify(v.selection);
    menu = v.menu;
  }

  const existing = db.prepare(`
    SELECT * FROM meal_orders
    WHERE user_id = ? AND meal_type = ? AND service_date = ? AND status = 'pending'
  `).get(user.id, meal_type, service_date);

  if (existing) {
    db.prepare(`
      UPDATE meal_orders SET menu = ?, selection = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(menu, selectionJSON, existing.id);
    return res.json(db.prepare('SELECT * FROM meal_orders WHERE id = ?').get(existing.id));
  }

  const result = db.prepare(`
    INSERT INTO meal_orders (user_id, meal_type, menu, selection, service_date) VALUES (?, ?, ?, ?, ?)
  `).run(user.id, meal_type, menu, selectionJSON, service_date);

  res.json(db.prepare('SELECT * FROM meal_orders WHERE id = ?').get(Number(result.lastInsertRowid)));
});

// Batch: one menu/selection, many dates
app.post('/api/orders/batch', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  let { meal_type, menu, selection, dates } = req.body || {};

  if (!['breakfast', 'late_night'].includes(meal_type)) {
    return res.status(400).json({ error: '잘못된 식사 유형입니다' });
  }
  if (!Array.isArray(dates) || dates.length === 0) {
    return res.status(400).json({ error: '날짜를 한 개 이상 선택해주세요' });
  }
  if (dates.length > 31) return res.status(400).json({ error: '한번에 최대 31일까지 가능합니다' });

  const uniq = [...new Set(dates)];
  for (const d of uniq) {
    if (!validDate(d)) return res.status(400).json({ error: `잘못된 날짜: ${d}` });
  }

  let selectionJSON = null;
  if (meal_type === 'breakfast') {
    const v = validateBreakfastSelection(selection);
    if (v.error) return res.status(400).json({ error: v.error });
    selectionJSON = JSON.stringify(v.selection);
    menu = v.menu;
  } else {
    const v = validateLateNightSelection(selection, menu);
    if (v.error) return res.status(400).json({ error: v.error });
    if (v.selection) selectionJSON = JSON.stringify(v.selection);
    menu = v.menu;
  }

  const findStmt = db.prepare(`
    SELECT id FROM meal_orders
    WHERE user_id = ? AND meal_type = ? AND service_date = ? AND status = 'pending'
  `);
  const updStmt = db.prepare(`
    UPDATE meal_orders SET menu = ?, selection = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?
  `);
  const insStmt = db.prepare(`
    INSERT INTO meal_orders (user_id, meal_type, menu, selection, service_date) VALUES (?, ?, ?, ?, ?)
  `);

  const created = [];
  const updated = [];

  db.prepare('BEGIN').run();
  try {
    for (const d of uniq) {
      const existing = findStmt.get(user.id, meal_type, d);
      if (existing) {
        updStmt.run(menu, selectionJSON, existing.id);
        updated.push(d);
      } else {
        insStmt.run(user.id, meal_type, menu, selectionJSON, d);
        created.push(d);
      }
    }
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    return res.status(500).json({ error: '저장 중 오류: ' + e.message });
  }

  res.json({ created, updated });
});

// Decorate orders with parsed selection
function decorateOrder(o) {
  if (o && o.selection) {
    try { o.selection = JSON.parse(o.selection); } catch { o.selection = null; }
  }
  return o;
}

app.get('/api/orders/my', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { from } = req.query;
  const fromDate = (from && validDate(from)) ? from : db.prepare("SELECT date('now', 'localtime') AS d").get().d;

  const orders = db.prepare(`
    SELECT * FROM meal_orders
    WHERE user_id = ?
      AND status IN ('pending', 'picked_up')
      AND service_date >= ?
    ORDER BY service_date, meal_type
  `).all(user.id, fromDate);
  res.json(orders.map(decorateOrder));
});

app.delete('/api/orders/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const orderId = Number(req.params.id);
  const order = db.prepare('SELECT * FROM meal_orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: '주문을 찾을 수 없습니다' });
  if (order.user_id !== user.id) return res.status(403).json({ error: '본인 주문만 취소 가능합니다' });
  if (order.status === 'picked_up') return res.status(400).json({ error: '이미 수령 완료된 주문은 취소할 수 없습니다' });

  db.prepare('DELETE FROM meal_orders WHERE id = ?').run(orderId);
  res.json({ ok: true });
});

app.get('/api/orders/active', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const { meal_type, date } = req.query;
  const conds = ["mo.status = 'pending'"];
  const params = [];

  if (meal_type) {
    if (!['breakfast', 'late_night'].includes(meal_type)) {
      return res.status(400).json({ error: '잘못된 식사 유형입니다' });
    }
    conds.push('mo.meal_type = ?'); params.push(meal_type);
  }
  if (date) {
    if (!validDate(date)) return res.status(400).json({ error: '잘못된 날짜 형식입니다' });
    conds.push('mo.service_date = ?'); params.push(date);
  }

  const orders = db.prepare(`
    SELECT mo.id, mo.meal_type, mo.menu, mo.selection, mo.service_date, mo.created_at,
           u.employee_id, u.name
    FROM meal_orders mo
    JOIN users u ON mo.user_id = u.id
    WHERE ${conds.join(' AND ')}
    ORDER BY mo.service_date, mo.meal_type, mo.created_at
  `).all(...params);
  res.json(orders.map(decorateOrder));
});

app.get('/api/orders/active/summary', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const days = Math.min(14, Math.max(1, Number(req.query.days) || 7));
  const rows = db.prepare(`
    SELECT service_date, meal_type, COUNT(*) AS n
    FROM meal_orders
    WHERE status = 'pending'
      AND service_date >= date('now', 'localtime')
      AND service_date <= date('now', 'localtime', '+${days} days')
    GROUP BY service_date, meal_type
    ORDER BY service_date
  `).all();
  res.json(rows);
});

app.post('/api/orders/:id/pickup', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const result = db.prepare(`
    UPDATE meal_orders
    SET status = 'picked_up', picked_up_at = CURRENT_TIMESTAMP, picked_up_by = ?
    WHERE id = ? AND status = 'pending'
  `).run(user.id, Number(req.params.id));

  if (result.changes === 0) {
    return res.status(404).json({ error: '이미 처리되었거나 없는 주문입니다' });
  }
  res.json({ ok: true });
});

// Admin: manually insert orders (for data recovery)
app.post('/api/admin/orders/manual', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;

  const { employee_id, name, meal_type, menu, selection, service_date } = req.body || {};

  if (!employee_id || !name) return res.status(400).json({ error: '사번과 이름을 입력해주세요' });
  if (!['breakfast', 'late_night'].includes(meal_type)) return res.status(400).json({ error: '잘못된 식사 유형입니다' });
  if (!service_date || !validDate(service_date)) return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD)' });

  // Derive menu text and selection JSON (same as regular order endpoints)
  let finalMenu = menu ? String(menu).trim() : '';
  let selectionJSON = null;

  if (meal_type === 'breakfast' && selection) {
    const v = validateBreakfastSelection(selection);
    if (v.error) return res.status(400).json({ error: v.error });
    selectionJSON = JSON.stringify(v.selection);
    finalMenu = v.menu;
  } else if (meal_type === 'late_night') {
    if (!finalMenu) return res.status(400).json({ error: '메뉴를 입력해주세요' });
  } else {
    if (!finalMenu) return res.status(400).json({ error: '메뉴를 입력해주세요' });
  }

  // Upsert user
  let target = getUserByEmployeeId(String(employee_id).trim());
  if (target) {
    if (target.name !== String(name).trim()) {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(name).trim(), target.id);
    }
  } else {
    const r = db.prepare('INSERT INTO users (employee_id, name) VALUES (?, ?)').run(String(employee_id).trim(), String(name).trim());
    target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid));
  }

  // Upsert order
  const existing = db.prepare(`
    SELECT id FROM meal_orders WHERE user_id = ? AND meal_type = ? AND service_date = ? AND status = 'pending'
  `).get(target.id, meal_type, service_date);

  if (existing) {
    db.prepare('UPDATE meal_orders SET menu = ?, selection = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(finalMenu, selectionJSON, existing.id);
    return res.json({ ok: true, action: 'updated', order_id: existing.id });
  }

  const ins = db.prepare(`
    INSERT INTO meal_orders (user_id, meal_type, menu, selection, service_date) VALUES (?, ?, ?, ?, ?)
  `).run(target.id, meal_type, finalMenu, selectionJSON, service_date);
  res.json({ ok: true, action: 'created', order_id: Number(ins.lastInsertRowid) });
});

app.post('/api/admin/cleanup', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  const result = db.prepare(`
    DELETE FROM meal_orders
    WHERE status = 'picked_up' AND picked_up_at < datetime('now', '-7 days')
  `).run();
  res.json({ deleted: result.changes });
});

// Admin: pickup log for a given date (all statuses, all meal_types)
// Returns: orders with status (pending/picked_up), meal_form for breakfast, picked_up_at timestamp
app.get('/api/admin/pickup-log', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;

  const { date } = req.query;
  if (!date || !validDate(date)) {
    return res.status(400).json({ error: '날짜를 지정해주세요 (YYYY-MM-DD)' });
  }

  const orders = db.prepare(`
    SELECT mo.id, mo.meal_type, mo.menu, mo.selection, mo.service_date,
           mo.status, mo.created_at, mo.picked_up_at,
           u.employee_id, u.name
    FROM meal_orders mo
    JOIN users u ON mo.user_id = u.id
    WHERE mo.service_date = ?
    ORDER BY mo.meal_type, COALESCE(mo.picked_up_at, mo.created_at), u.name
  `).all(date);

  res.json(orders.map(decorateOrder));
});

// Admin: which dates in the retention window have any orders (for calendar UI)
app.get('/api/admin/pickup-log/dates', (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;

  const rows = db.prepare(`
    SELECT service_date,
           SUM(CASE WHEN status = 'picked_up' THEN 1 ELSE 0 END) AS picked,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           COUNT(*) AS total
    FROM meal_orders
    GROUP BY service_date
    ORDER BY service_date DESC
  `).all();

  res.json(rows);
});

app.get('/health', (req, res) => res.json({ ok: true }));

// 진단용: 현재 DB가 어디 저장되고 있는지, 오래된 데이터가 있는지 확인
app.get('/db-status', (req, res) => {
  try {
    const stats = fs.statSync(DB_PATH);
    const orderCount = db.prepare('SELECT COUNT(*) AS n FROM meal_orders').get().n;
    const oldestOrder = db.prepare(`
      SELECT service_date, COUNT(*) AS n FROM meal_orders
      GROUP BY service_date ORDER BY service_date LIMIT 5
    `).all();
    const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
    const isPersistent = DB_PATH.startsWith('/data') || DB_PATH.startsWith('/mnt') || DB_PATH.startsWith('/var/lib');
    res.json({
      db_path: DB_PATH,
      db_size_bytes: stats.size,
      db_modified: stats.mtime.toISOString(),
      on_railway: onRailway,
      is_persistent_path: isPersistent,
      database_path_env: process.env.DATABASE_PATH || null,
      total_orders: orderCount,
      orders_by_date: oldestOrder,
      warning: (onRailway && !isPersistent) ? '⚠️ DB가 임시 저장소에 있음. Railway Volume 설정 필요' : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pretty URL for the user guide
app.get('/guide', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'guide.html'));
});

app.listen(PORT, () => {
  console.log(`KNUH Meal Dashboard listening on :${PORT}`);
  console.log(`DB: ${DB_PATH}`);

  // ── 자정 자동 정리: 3일 이전(service_date < 오늘-2일) 주문 삭제 ─────────
  // 오늘 + 어제 + 그저께(3일치)는 보존 → 관리자 수령 로그 확인용
  // 추가 안전망: 서버 시작 시에도 한 번 청소 (자정에 서버가 꺼져 있었을 경우 대비)
  function cleanupPastOrders(label) {
    try {
      // Retention cutoff = today - 2 days (inclusive). Anything earlier gets deleted.
      const today = new Date();
      const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 2);
      const cutoffStr = cutoff.toLocaleDateString('sv-SE'); // YYYY-MM-DD (local)
      const result = db.prepare(`
        DELETE FROM meal_orders
        WHERE service_date < ?
      `).run(cutoffStr);
      if (result.changes > 0) {
        console.log(`[${label}] deleted ${result.changes} orders older than ${cutoffStr} (3-day retention)`);
      } else {
        console.log(`[${label}] no stale orders to delete (cutoff=${cutoffStr})`);
      }
    } catch (e) {
      console.error(`[${label}] error:`, e);
    }
  }

  function scheduleMidnightCleanup() {
    const now = new Date();
    // Next midnight (local) + 5s buffer
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    const msUntil = next - now;
    setTimeout(() => {
      cleanupPastOrders('midnight cleanup');
      scheduleMidnightCleanup(); // reschedule for next midnight
    }, msUntil);
    console.log(`[midnight cleanup] scheduled in ${Math.round(msUntil / 60000)}min`);
  }
  // Run once on startup so stale data is gone immediately
  cleanupPastOrders('startup cleanup');
  scheduleMidnightCleanup();
  // ──────────────────────────────────────────────────────────────────────────

  // Warn if DB is likely on ephemeral storage on Railway
  const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
  const isEphemeral = !DB_PATH.startsWith('/data') && !DB_PATH.startsWith('/mnt') && !DB_PATH.startsWith('/var/lib');
  if (onRailway && isEphemeral) {
    console.warn('');
    console.warn('==================================================================');
    console.warn('⚠️  WARNING: DB is on EPHEMERAL storage. Data will be LOST on every');
    console.warn('   redeploy or container restart.');
    console.warn('');
    console.warn('   To fix: in Railway dashboard:');
    console.warn('   1. Service → Settings → Volumes → New Volume, mount at /data');
    console.warn('   2. Variables → add DATABASE_PATH = /data/knuh.db');
    console.warn('==================================================================');
    console.warn('');
  }
});
