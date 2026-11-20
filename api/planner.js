// Planner API — the only thing that talks to Notion.
// Your Notion key and passcode live in Vercel's environment variables (never in this file):
//   NOTION_KEY   = your Notion integration secret
//   APP_PASSCODE = any word/number you choose — the app asks for it once per device
const NOTION = "https://api.notion.com/v1/";
const VERSION = "2022-06-28";
const DB = {
  planner: "3edaedaf73e8805fa3fdc13490d0a9ce",
  todo: "3dcaedaf73e880faa171d9e2c86c3cff",
  timetable: "4dfaedaf73e883878ced81f71f607fa6",
  shared: "3e6aedaf73e880648b85dfed8c75a3b1",
  habits: "236aedaf73e8820597e501c00c659bb1"
};
const P = { title: "Name", date: "Date", preset: "preset", icon: "icon", colour: "colour", source: "source", where: "where" };
const T = { title: "task", date: "the date", done: "done", urgency: "urgency", category: "category" };
const H = { date: "the date", status: "status" };
const SETTINGS_TITLE = "planner settings";

// ---------- notion ----------
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function notion(path, method = "GET", body) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(NOTION + path, {
      method,
      headers: { "Authorization": `Bearer ${process.env.NOTION_KEY}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 429 || res.status >= 500) { await wait(600 * (i + 1)); continue; }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(j.message || `Notion ${res.status}`); e.code = j.code; e.status = res.status; throw e; }
    return j;
  }
  throw new Error("Notion is busy — try again in a moment");
}
async function queryAll(db, body = {}, maxPages = 10) {
  let out = [], cursor = null, n = 0;
  do {
    const b = Object.assign({}, body, { page_size: 100 });
    if (cursor) b.start_cursor = cursor;
    const r = await notion(`databases/${db}/query`, "POST", b);
    out = out.concat(r.results || []);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor && ++n < maxPages);
  return out;
}
const stepText = (text, todo) => todo ? [{ type: "mention", mention: { page: { id: todo } } }] : rt(text);
const rt = (s) => {
  s = String(s || ""); const parts = [];
  for (let i = 0; i < s.length && parts.length < 100; i += 1900) parts.push({ type: "text", text: { content: s.slice(i, i + 1900) } });
  return parts.length ? parts : [{ type: "text", text: { content: "" } }];
};
const plain = (a) => (a || []).map(t => t.plain_text || (t.text && t.text.content) || "").join("");
function txt(p) {
  if (!p) return "";
  switch (p.type) {
    case "title": return plain(p.title);
    case "rich_text": return plain(p.rich_text);
    case "select": return (p.select && p.select.name) || "";
    case "status": return (p.status && p.status.name) || "";
    case "multi_select": return (p.multi_select || []).map(s => s.name).join(", ");
    case "date": return (p.date && p.date.start) || "";
    case "formula": { const f = p.formula || {}; return f.type === "string" ? f.string || "" : f.type === "date" ? (f.date && f.date.start) || "" : ""; }
    default: return "";
  }
}
const firstTitle = (pr) => { for (const k in pr) if (pr[k] && pr[k].type === "title") return txt(pr[k]); return ""; };
const dateOf = (p) => p && p.type === "date" && p.date && p.date.start ? { start: p.date.start, end: p.date.end || null }
  : p && p.type === "formula" && p.formula && p.formula.type === "date" && p.formula.date ? { start: p.formula.date.start, end: p.formula.date.end || null } : null;
const dayPart = (s) => String(s || "").slice(0, 10);

// small in-memory caches (live while the function stays warm)
const MEM = globalThis.__plannerMem || (globalThis.__plannerMem = { children: {}, timetable: null, settingsId: null, creating: {} });

// ---------- reading ----------
function blockOf(p) {
  const pr = p.properties || {}, d = dateOf(pr[P.date]);
  if (!d) return null;
  return { id: p.id, edited: p.last_edited_time, title: (firstTitle(pr) || "block").trim(), start: d.start, end: d.end,
    presetName: txt(pr[P.preset]), icon: txt(pr[P.icon]), colour: txt(pr[P.colour]), source: txt(pr[P.source]), where: txt(pr[P.where]) };
}
async function checklist(id, edited) {
  const hit = MEM.children[id];
  if (hit && hit.edited === edited) return hit.items;
  const r = await notion(`blocks/${id}/children?page_size=100`);
  const items = (r.results || []).filter(x => x.type === "to_do").map(x => {
    const men = (x.to_do.rich_text || []).find(t => t.type === "mention" && t.mention && t.mention.page);
    return { id: x.id, text: plain(x.to_do.rich_text), checked: !!x.to_do.checked, todo: men ? men.mention.page.id : null };
  });
  MEM.children[id] = { edited, items };
  return items;
}
function eventTimes(pr) {
  const st = txt(pr["start time"]);
  if (st) return { start: st, end: txt(pr["end time"]) || null };
  return dateOf(pr["date"]) || dateOf(pr["Date"]) || dateOf(pr["the date"]);
}
const courseFromTitle = (n) => { const m = (n || "").trim().match(/^([A-Z]{2,4}\d[A-Z0-9]{1,3})(?=[\s.]|$)/i); return m ? m[1].toUpperCase() : ""; };
const isDeadline = (n) => /\bis due\b|\bdue\b|submission|deadline/i.test(n || "");
const shortDeadline = (n) => `${(n || "").replace(/\s*submission(\s+portal)?/i, "").replace(/\s+is\s+due\s*$/i, "").trim().toLowerCase()} due`;
async function timetable() {
  if (MEM.timetable && Date.now() - MEM.timetable.at < 5 * 60000) return MEM.timetable.rows;
  const pages = await queryAll(DB.timetable, {}, 10);
  const rows = pages.map(p => {
    const pr = p.properties || {}, t = eventTimes(pr);
    if (!t) return null;
    const name = txt(pr.name) || firstTitle(pr) || "class";
    let course = txt(pr.course).trim(); if (!course || course.toLowerCase() === "general") course = courseFromTitle(name);
    const dl = isDeadline(name);
    const type = dl ? "deadline" : txt(pr.type).toLowerCase().trim();
    return { id: p.id, title: dl ? shortDeadline(name) : (course || name), type, location: txt(pr.location).trim(), start: t.start, end: t.end, deadline: dl, lecture: type.includes("lecture") };
  }).filter(Boolean);
  MEM.timetable = { at: Date.now(), rows };
  return rows;
}
async function shared(from, to) {
  const pages = await queryAll(DB.shared, { filter: { and: [
    { property: "start time", date: { on_or_after: from } }, { property: "start time", date: { on_or_before: to } },
    { or: [{ property: "person", select: { equals: "jasmine" } }, { property: "person", select: { equals: "both" } }] }
  ] } }, 3);
  return pages.map(p => {
    const pr = p.properties || {}, s = pr["start time"] && pr["start time"].date ? pr["start time"].date.start : "";
    if (!s) return null;
    const e = (pr["end time"] && pr["end time"].date && pr["end time"].date.start) || (pr["start time"].date.end) || null;
    return { id: p.id, title: (txt(pr.Name) || firstTitle(pr) || "event").trim(), location: txt(pr.location).trim(), start: s, end: e };
  }).filter(Boolean);
}
async function timedTodos(from, to) {
  const pages = await queryAll(DB.todo, { filter: { and: [{ property: T.date, date: { on_or_after: from } }, { property: T.date, date: { on_or_before: to } }] } }, 3);
  return pages.map(p => {
    const pr = p.properties || {}, d = dateOf(pr[T.date]);
    if (!d || d.start.length <= 10) return null;
    return { id: p.id, title: (txt(pr[T.title]) || firstTitle(pr) || "task").trim(), start: d.start, end: d.end, done: !!(pr[T.done] && pr[T.done].checkbox) };
  }).filter(Boolean);
}
async function openTodos(todayKey) {
  const pages = await queryAll(DB.todo, { filter: { and: [{ property: T.date, date: { on_or_before: todayKey } }, { property: T.done, checkbox: { equals: false } }] } }, 3);
  return pages.map(p => {
    const pr = p.properties || {}, d = dateOf(pr[T.date]);
    return { id: p.id, title: (txt(pr[T.title]) || firstTitle(pr) || "task").trim(), urgency: txt(pr[T.urgency]), dateKey: d ? dayPart(d.start) : "", timed: !!(d && d.start.length > 10) };
  });
}

// ---------- settings (presets, templates…) so every device matches ----------
// v2: kept as an undated row called "planner settings" INSIDE the planner database.
// That always works, wherever the database lives in Notion, and needs no search.
// (It never shows on the calendar because it has no date.)
async function settingsPage(create) {
  if (MEM.settingsId) return MEM.settingsId;
  // 1) the row inside the planner database
  const q = await notion(`databases/${DB.planner}/query`, "POST", { filter: { property: P.title, title: { equals: SETTINGS_TITLE } }, page_size: 5 });
  const row = (q.results || []).find(p => !p.archived);
  if (row) return (MEM.settingsId = row.id);
  // 2) an older separate page called "planner settings", if there is one
  const r = await notion("search", "POST", { query: SETTINGS_TITLE, filter: { property: "object", value: "page" }, page_size: 20 }).catch(() => ({ results: [] }));
  const hit = (r.results || []).find(p => !p.archived && firstTitle(p.properties || {}).trim().toLowerCase() === SETTINGS_TITLE);
  if (hit) return (MEM.settingsId = hit.id);
  if (!create) return null;
  // 3) make the row
  const page = await notion("pages", "POST", {
    parent: { database_id: DB.planner }, icon: { type: "emoji", emoji: "⚙️" },
    properties: { [P.title]: { title: rt(SETTINGS_TITLE) } },
    children: [
      { object: "block", type: "paragraph", paragraph: { rich_text: rt("Your planner app keeps its presets and templates here. Leave this page alone 🤍") } },
      { object: "block", type: "code", code: { language: "json", rich_text: rt("{}") } }
    ]
  });
  return (MEM.settingsId = page.id);
}
async function readSettings() {
  const id = await settingsPage(false);
  if (!id) return null;
  const r = await notion(`blocks/${id}/children?page_size=50`);
  const code = (r.results || []).find(b => b.type === "code");
  if (!code) return null;
  try { return JSON.parse(plain(code.code.rich_text) || "null"); } catch (e) { return null; }
}
async function writeSettings(s) {
  const id = await settingsPage(true);
  const r = await notion(`blocks/${id}/children?page_size=50`);
  const code = (r.results || []).find(b => b.type === "code");
  const body = { code: { language: "json", rich_text: rt(JSON.stringify(s)) } };
  if (code) await notion(`blocks/${code.id}`, "PATCH", body);
  else await notion(`blocks/${id}/children`, "PATCH", { children: [{ object: "block", type: "code", code: body.code }] });
}

// ---------- planner columns ----------
let colsOk = false;
async function ensureColumns() {
  if (colsOk) return;
  const db = await notion(`databases/${DB.planner}`);
  const have = db.properties || {}, add = {};
  if (!have[P.preset]) add[P.preset] = { select: {} };
  if (!have[P.icon]) add[P.icon] = { rich_text: {} };
  if (!have[P.colour]) add[P.colour] = { select: {} };
  if (!have[P.source]) add[P.source] = { rich_text: {} };
  if (!have[P.where]) add[P.where] = { rich_text: {} };
  if (Object.keys(add).length) await notion(`databases/${DB.planner}`, "PATCH", { properties: add });
  colsOk = true;
}
function blockProps(b) {
  const pr = {};
  if (b.title !== undefined) pr[P.title] = { title: rt(b.title) };
  if (b.start) pr[P.date] = { date: { start: b.start, end: b.end || null } };
  if (b.presetName !== undefined) pr[P.preset] = b.presetName ? { select: { name: String(b.presetName).replace(/,/g, " ").slice(0, 100) } } : { select: null };
  if (b.icon) pr[P.icon] = { rich_text: rt(b.icon) };
  if (b.colour) pr[P.colour] = { select: { name: b.colour } };
  if (b.source !== undefined) pr[P.source] = { rich_text: rt(b.source) };
  if (b.where !== undefined) pr[P.where] = { rich_text: rt(b.where) };
  return pr;
}
async function createBlock(b) {
  await ensureColumns();
  const children = (b.checklist || []).map(t => ({ object: "block", type: "to_do", to_do: { rich_text: rt(t), checked: false } }));
  const page = await notion("pages", "POST", { parent: { database_id: DB.planner }, properties: blockProps(b), children });
  let itemIds = [];
  if (children.length) {
    const r = await notion(`blocks/${page.id}/children?page_size=100`);
    itemIds = (r.results || []).filter(x => x.type === "to_do").map(x => x.id);
  }
  return { id: page.id, itemIds };
}

// ---------- classes → planner copies ----------
// Every class/lecture in the days being shown gets its own planner block (source "tt:<id>|<start>|<end>").
// You can move, rename or remove the copy: your uni timetable never changes.
// Removed ones are remembered (planner settings → removedClasses) so they don't come back.
const sameTime = (a, b) => (!a && !b) || (a && b && Date.parse(a) === Date.parse(b));
async function syncClasses(a, blocks, tt, settings) {
  const removed = new Set(a.removed || (settings && settings.removedClasses) || []);
  const rows = tt.filter(c => !c.deadline && String(c.start).length > 10 && dayPart(c.start) >= a.dayFrom && dayPart(c.start) <= a.dayTo);
  const copies = {};
  blocks.forEach(b => { const m = /^tt:([^|]+)/.exec(b.source || ""); if (m) (copies[m[1]] = copies[m[1]] || []).push(b); });
  // tidy any accidental doubles
  for (const id in copies) if (copies[id].length > 1) {
    const extra = copies[id].slice(1);
    copies[id] = copies[id].slice(0, 1);
    for (const b of extra) { await notion(`pages/${b.id}`, "PATCH", { archived: true }).catch(() => {}); const i = blocks.indexOf(b); if (i >= 0) blocks.splice(i, 1); }
  }
  for (const c of rows) {
    if (removed.has(c.id)) continue;
    const end = c.end || new Date(Date.parse(c.start) + 3600000).toISOString();
    const where = [c.type, c.location].filter(Boolean).join(" · ");
    const source = `tt:${c.id}|${c.start}|${end}`;
    const cp = (copies[c.id] || [])[0];
    if (!cp) {
      if (MEM.creating[c.id] && Date.now() - MEM.creating[c.id] < 30000) continue;
      MEM.creating[c.id] = Date.now();
      const title = `${c.title}${c.type && !c.title.toLowerCase().includes(c.type) ? " " + c.type : ""}`;
      const made = await createBlock({ title, start: c.start, end, icon: "graduation-cap", colour: "mauve", source, where }).catch(() => null);
      if (made) blocks.push({ id: made.id, edited: "", title, start: c.start, end, presetName: "", icon: "graduation-cap", colour: "mauve", source, where, checklist: [] });
      continue;
    }
    // the timetable changed and you haven't moved the copy yourself → follow the timetable
    const [, s0, e0] = String(cp.source).split("|");
    const untouched = sameTime(cp.start, s0) && sameTime(cp.end, e0);
    if (untouched && (!sameTime(c.start, s0) || !sameTime(end, e0) || cp.where !== where)) {
      await notion(`pages/${cp.id}`, "PATCH", { properties: blockProps({ start: c.start, end, source, where }) }).catch(() => {});
      Object.assign(cp, { start: c.start, end, source, where });
    }
  }
}

// ---------- habit link ----------
const ALIASES = [
  [/^(meds?|medication|medicine|pills?|tablets?)$/, "medicine"], [/teeth/, "brush teeth"], [/retainers?/, "wear retainers to sleep"],
  [/^breakfast$|eat breakfast/, "eat breakfast"], [/^lunch$|eat lunch/, "eat lunch"], [/^dinner$|eat dinner/, "eat dinner"],
  [/water/, "drink bottle of water"], [/diary|journal/, "write in diary"], [/make (the )?bed/, "make bed"], [/^shower$|have a shower|take a shower/, "shower"],
  [/laundry/, "laundry"], [/tidy|clean (my )?room/, "keep room clean"], [/sunday reset/, "sunday reset"], [/^study$/, "study"]
];
async function habitLink(text, dateKey, which) {
  const t = String(text || "").toLowerCase().trim();
  let target = null;
  for (const [re, name] of ALIASES) if (re.test(t)) { target = name; break; }
  const pages = await queryAll(DB.habits, { filter: { property: H.date, date: { equals: dateKey } } }, 2);
  const rows = pages.map(p => ({ id: p.id, title: firstTitle(p.properties || {}).trim(), prop: (p.properties || {})[H.status] })).filter(r => r.title);
  let row = null;
  if (target === "brush teeth") row = rows.find(r => /brush teeth/i.test(r.title) && r.title.toLowerCase().includes(which || "morning"));
  else if (target) row = rows.find(r => r.title.toLowerCase() === target) || rows.find(r => r.title.toLowerCase().includes(target));
  else row = rows.find(r => { const h = r.title.toLowerCase(); return h.length >= 4 && (h === t || (t.length >= 5 && h.includes(t))); });
  if (!row) return null;
  const type = row.prop ? row.prop.type : "select";
  if (txt(row.prop).toLowerCase() === "done") return null;
  const val = type === "status" ? { status: { name: "done" } } : type === "checkbox" ? { checkbox: true } : { select: { name: "done" } };
  await notion(`pages/${row.id}`, "PATCH", { properties: { [H.status]: val } });
  return row.title;
}

// ---------- ops ----------
const OPS = {
  async load(a) {
    const [pages, tt, sh, timed, open, settings] = await Promise.all([
      queryAll(DB.planner, { filter: { and: [{ property: P.date, date: { on_or_after: a.from } }, { property: P.date, date: { on_or_before: a.to } }] } }, 5),
      timetable().catch(() => []),
      shared(a.dayFrom, a.dayTo).catch(() => []),
      timedTodos(a.dayFrom, a.dayTo).catch(() => []),
      a.withOpen ? openTodos(a.todayKey).catch(() => []) : Promise.resolve([]),
      a.withSettings ? readSettings().catch(() => null) : Promise.resolve(undefined)
    ]);
    const blocks = pages.map(blockOf).filter(Boolean);
    await ensureColumns().catch(() => {});
    // which copies you've removed: sent by the app, or read from your planner settings
    const st = settings || (a.removed ? null : await readSettings().catch(() => null));
    await syncClasses(a, blocks, tt, st).catch(() => {});
    // checklists for blocks around the day being shown
    if (!a.noChecklists) await Promise.all(blocks.filter(b => dayPart(b.start) >= a.dayFrom && dayPart(b.start) <= a.dayTo || (b.end && dayPart(b.end) >= a.dayFrom && dayPart(b.start) <= a.dayTo))
      .map(async b => { b.checklist = await checklist(b.id, b.edited).catch(() => []); }));
    // timed classes are now planner blocks; only deadlines and all-day entries come through here
    const classes = tt.filter(c => dayPart(c.start) >= a.dayFrom && dayPart(c.start) <= a.dayTo && (c.deadline || String(c.start).length <= 10));
    return { blocks, classes, shared: sh, timed, open, settings };
  },
  async createBlock(a) { return createBlock(a.block); },
  async createMany(a) { const out = []; for (const b of a.blocks || []) out.push(await createBlock(b)); return { ids: out.map(o => o.id) }; },
  async updateBlock(a) { await notion(`pages/${a.id}`, "PATCH", { properties: blockProps(a.block) }); return {}; },
  async archive(a) { await notion(`pages/${a.id}`, "PATCH", { archived: true }); delete MEM.children[a.id]; return {}; },
  // shared calendar events: moving/renaming in the planner changes the shared calendar too
  async eventUpdate(a) {
    const pr = {};
    if (a.title) pr.Name = { title: rt(a.title) };
    if (a.start) { pr["start time"] = { date: { start: a.start } }; if (a.end) pr["end time"] = { date: { start: a.end } }; }
    if (Object.keys(pr).length) await notion(`pages/${a.id}`, "PATCH", { properties: pr });
    return {};
  },
  async todoDate(a) { await notion(`pages/${a.id}`, "PATCH", { properties: { [T.date]: { date: { start: a.start, end: a.end || null } } } }); return {}; },
  async todoTitle(a) { await notion(`pages/${a.id}`, "PATCH", { properties: { [T.title]: { title: rt(a.title) } } }); return {}; },
  async todoDone(a) {
    await notion(`pages/${a.id}`, "PATCH", { properties: { [T.done]: { checkbox: true } } });
    const habit = a.dateKey ? await habitLink(a.title, a.dateKey, a.which).catch(() => null) : null;
    return { habit };
  },
  async todoNew(a) { await notion("pages", "POST", { parent: { database_id: DB.todo }, properties: { [T.title]: { title: rt(a.title) }, [T.date]: { date: { start: a.date } }, [T.done]: { checkbox: false } } }); return {}; },
  async check(a) {
    await notion(`blocks/${a.id}`, "PATCH", { to_do: { checked: !!a.checked } });
    // a step that's one of your to-dos: ticking it ticks the to-do too
    if (a.todo) await notion(`pages/${a.todo}`, "PATCH", { properties: { [T.done]: { checkbox: !!a.checked } } }).catch(() => {});
    if (a.block) delete MEM.children[a.block];
    const habit = a.checked && a.dateKey ? await habitLink(a.text, a.dateKey, a.which).catch(() => null) : null;
    return { habit };
  },
  async addItem(a) {
    const r = await notion(`blocks/${a.page}/children`, "PATCH", { children: [{ object: "block", type: "to_do", to_do: { rich_text: stepText(a.text, a.todo), checked: false } }] });
    delete MEM.children[a.page];
    return { id: ((r.results || [])[0] || {}).id };
  },
  // new order for a checklist: rewrite the steps in the order you dragged them into
  async reorderItems(a) {
    const r = await notion(`blocks/${a.page}/children?page_size=100`);
    for (const b of (r.results || []).filter(x => x.type === "to_do")) await notion(`blocks/${b.id}`, "DELETE");
    const out = await notion(`blocks/${a.page}/children`, "PATCH", { children: (a.items || []).map(i => ({ object: "block", type: "to_do", to_do: { rich_text: stepText(i.text, i.todo), checked: !!i.checked } })) });
    delete MEM.children[a.page];
    return { ids: (out.results || []).filter(x => x.type === "to_do").map(x => x.id) };
  },
  async renameItem(a) { await notion(`blocks/${a.id}`, "PATCH", { to_do: { rich_text: rt(a.text) } }); if (a.page) delete MEM.children[a.page]; return {}; },
  async delItem(a) { await notion(`blocks/${a.id}`, "DELETE"); if (a.page) delete MEM.children[a.page]; return {}; },
  async saveSettings(a) { await writeSettings(a.settings); return {}; },
  // ---- for the Mac desktop widgets ----
  async habits(a) {
    const pages = await queryAll(DB.habits, { filter: { property: H.date, date: { equals: a.dateKey } } }, 2);
    const habits = pages.map(p => {
      const pr = p.properties || {}, st = pr[H.status];
      const status = st && st.type === "checkbox" ? (st.checkbox ? "done" : "") : txt(st).toLowerCase();
      const num = pr.number && pr.number.type === "number" ? pr.number.number : null;
      return { id: p.id, title: firstTitle(pr).trim(), status, done: status === "done", missed: status === "missed", order: num == null ? 999 : num };
    }).filter(h => h.title).sort((x, y) => x.order - y.order);
    return { habits };
  },
  async habitDone(a) {
    const page = await notion(`pages/${a.id}`);
    const st = (page.properties || {})[H.status], type = st ? st.type : "select";
    const val = type === "status" ? { status: { name: "done" } } : type === "checkbox" ? { checkbox: true } : { select: { name: "done" } };
    await notion(`pages/${a.id}`, "PATCH", { properties: { [H.status]: val } });
    return {};
  },
  async ping() { await notion(`databases/${DB.planner}`); return { ok: true }; }
};

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const pass = process.env.APP_PASSCODE || "";
  if (!pass || req.headers["x-passcode"] !== pass) { res.status(401).json({ error: "wrong passcode" }); return; }
  if (!process.env.NOTION_KEY) { res.status(500).json({ error: "NOTION_KEY isn't set in Vercel" }); return; }
  let a = req.body;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch (e) { a = {}; } }
  const op = OPS[(a || {}).op];
  if (!op) { res.status(400).json({ error: "unknown op" }); return; }
  try { res.status(200).json(await op(a)); }
  catch (e) {
    const msg = /object_not_found|Could not find/i.test(e.message) ? "Notion can't see one of your databases — add your integration to it (••• → Connections)" : e.message;
    res.status(e.status === 401 ? 502 : 500).json({ error: msg });
  }
};
module.exports.OPS = OPS;
