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

  CREATE INDEX IF NOT EXISTS idx_orders_status ON meal_orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_date ON meal_orders(service_date, meal_type, status);
  CREATE INDEX IF NOT EXISTS idx_menu_items_meal ON menu_items(meal_type, active, sort_order);
  CREATE INDEX IF NOT EXISTS idx_categories_meal ON meal_categories(meal_type, active, sort_order);
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
})();

// Partial unique index: one pending order per (user, date, meal_type)
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_unique_pending
    ON meal_orders(user_id, service_date, meal_type)
    WHERE status = 'pending';
`);

// Seed late_night menu items (legacy table) if empty
(function seedLateNightMenu() {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM menu_items WHERE meal_type = 'late_night'`).get().n;
  if (count > 0) return;
  console.log('[seed] populating default late_night menu items');
  const items = ['컵라면', '김밥', '햄버거', '죽', '샌드위치', '라면'];
  const ins = db.prepare('INSERT INTO menu_items (meal_type, name, sort_order) VALUES (?, ?, ?)');
  items.forEach((name, i) => ins.run('late_night', name, i));
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

app.get('/api/menu-items', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { meal_type, include_inactive } = req.query;
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

  let { meal_type, name } = req.body || {};
  name = String(name || '').trim();

  if (!['breakfast', 'late_night'].includes(meal_type)) {
    return res.status(400).json({ error: '잘못된 식사 유형입니다' });
  }
  if (!name) return res.status(400).json({ error: '메뉴 이름을 입력해주세요' });
  if (name.length > 50) return res.status(400).json({ error: '메뉴 이름이 너무 깁니다 (50자 이하)' });

  const dup = db.prepare(`
    SELECT * FROM menu_items WHERE meal_type = ? AND name = ? AND active = 1
  `).get(meal_type, name);
  if (dup) return res.status(409).json({ error: '이미 같은 이름의 메뉴가 있습니다' });

  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM menu_items WHERE meal_type = ?').get(meal_type).m;
  const result = db.prepare(`
    INSERT INTO menu_items (meal_type, name, sort_order) VALUES (?, ?, ?)
  `).run(meal_type, name, maxOrder + 1);

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
    menu = String(menu || '').trim();
    if (!menu) return res.status(400).json({ error: '메뉴를 입력해주세요' });
    if (menu.length > 200) return res.status(400).json({ error: '메뉴가 너무 깁니다 (200자 이하)' });
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
    menu = String(menu || '').trim();
    if (!menu) return res.status(400).json({ error: '메뉴를 입력해주세요' });
    if (menu.length > 200) return res.status(400).json({ error: '메뉴가 너무 깁니다 (200자 이하)' });
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
    WHERE user_id = ? AND status = 'pending' AND service_date >= ?
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

app.get('/health', (req, res) => res.json({ ok: true }));

// Pretty URL for the user guide
app.get('/guide', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'guide.html'));
});

app.listen(PORT, () => {
  console.log(`KNUH Meal Dashboard listening on :${PORT}`);
  console.log(`DB: ${DB_PATH}`);

  // ── 자정 자동 삭제: 전날(service_date < 오늘) 주문 전량 삭제 ──────────────
  function scheduleMidnightCleanup() {
    const now = new Date();
    // Next midnight (local)
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5); // 00:00:05
    const msUntil = next - now;
    setTimeout(() => {
      try {
        const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD
        const result = db.prepare(`
          DELETE FROM meal_orders
          WHERE service_date < ?
        `).run(today);
        console.log(`[midnight cleanup] deleted ${result.changes} orders older than ${today}`);
      } catch (e) {
        console.error('[midnight cleanup] error:', e);
      }
      scheduleMidnightCleanup(); // reschedule for next midnight
    }, msUntil);
    console.log(`[midnight cleanup] scheduled in ${Math.round(msUntil / 60000)}min`);
  }
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
