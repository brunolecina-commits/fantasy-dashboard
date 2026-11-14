import { bestLineup, expected, availability, avgOf, ADD_LIMIT, ROSTER_MAX, CENTER_MAX } from "./lib.js";

const FILES = ["meta", "teams", "matchups", "daily", "players", "nba_schedule", "activity", "player_pool", "player_games", "derived", "history", "game_log"];
const TABS = [["team", "My team"], ["week", "This week"], ["stream", "Streaming"], ["trade", "Trade machine"], ["standings", "Standings"], ["teams", "Teams"], ["players", "Players"], ["moves", "Moves"], ["trends", "Trends"]];
const SLOT_ORDER = ["PG", "SG", "SF", "PF", "C", "G", "F", "UTIL", "BE", "IR"];
const $ = s => document.querySelector(s);
const h = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const n0 = x => x == null || isNaN(x) ? "–" : Math.round(x).toLocaleString();
const n1 = x => x == null || isNaN(x) ? "–" : (+x).toFixed(1);
const pct = x => x == null ? "–" : x > 0 && x < 0.01 ? "<1%" : x > 0.99 && x < 1 ? ">99%" : Math.round(x * 100) + "%";
const signed = (x, f = n0) => (x > 0 ? "+" : x < 0 ? "−" : "") + f(Math.abs(x));
const dayLabel = iso => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", day: "numeric" });
const wd = iso => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" });
const isoOf = day => { const d = new Date("2026-10-20T12:00:00Z"); d.setUTCDate(d.getUTCDate() + day - 1); return d.toISOString().slice(0, 10); };

let S = null; // loaded data + lookups
const ui = { rv: "cards", tab: "team", open: new Set(), sort: {}, team: null, win: "this", today: null, tradeB: null, selA: new Set(), selB: new Set(), q: "", pf: "all", moveTeam: 0, metric: "weekly", hi: 0 };

async function load() {
  const got = await Promise.all(FILES.map(n => fetch(`data/${n}.json`, { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null)));
  if (got.slice(0, 9).some(x => !x)) return false;
  const d = Object.fromEntries(FILES.map((n, i) => [n, got[i]]));
  const m = d.meta[0], T = Object.fromEntries(d.teams.map(t => [t.team_id, t]));
  const games = {}; d.player_games.forEach(g => (games[g.player_id] = games[g.player_id] || []).push(g));
  Object.values(games).forEach(a => a.sort((x, y) => x.day - y.day));
  const P = {};
  d.player_pool.forEach(p => P[p.player_id] = { ...p, slot: "" });
  d.players.forEach(p => P[p.player_id] = { ...(P[p.player_id] || {}), ...p });
  Object.values(P).forEach(p => {
    const l5 = avgOf((games[p.player_id] || []).slice(-5).map(g => g.fpts));
    p.l5 = l5; p.ev = d.derived?.ev?.[p.player_id]?.ev ?? expected(p, l5); p.pos = (p.positions || "").split(",").filter(Boolean);
    p.avail = availability(p.status);
  });
  const sched = {}; d.nba_schedule.forEach(g => (sched[g.nba_team] = sched[g.nba_team] || []).push(g));
  const D = Object.fromEntries((d.derived?.teams || []).map(t => [t.team_id, t]));
  const dayPts = {}; d.daily.forEach(x => dayPts[x.team_id + ":" + x.day] = x);
  const wk = {}; (d.game_log || []).forEach(g => { if (g.day >= m.week_start_day && g.day <= m.week_end_day && !["BE", "IR"].includes(g.slot)) wk[g.player_id + ":" + g.team_id] = (wk[g.player_id + ":" + g.team_id] || 0) + g.pts; });
  S = { ...d, m, T, P, games, sched, D, dayPts, wk, me: m.my_team_id, hist: d.history || { days: [], owned: {} } };
  S.roster = id => Object.values(P).filter(p => p.team_id === id && p.slot);
  S.plays = (p, day) => (sched[p.nba_team] || []).find(g => g.day === day);
  ui.team ??= S.me; ui.tradeB ??= d.teams.find(t => t.team_id !== S.me).team_id;
  if (ui.today == null) { const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Toronto" })); ui.today = now.getHours() < ([0, 6].includes(now.getDay()) ? 13 : 19); }
  return true;
}

/* ---------- small pieces ---------- */
const statusTag = p => p.status === "Healthy" || !p.status ? "" : `<span class="tag ${p.status === "DTD" ? "dtd" : "out"}">${h(p.status === "DTD" ? "DTD" : p.status === "OUT" ? "Out" : p.status[0] + p.status.slice(1).toLowerCase().replace(/_/g, " "))}</span>`;
const pBtn = p => `<div class="pc"><button class="link" data-p="${p.player_id}">${h(p.player)}</button>${statusTag(p)}</div><div class="sub">${h(p.nba_team)} · ${h(p.positions)}</div>`;
const pBtnSlot = p => pBtn(p).replace('<div class="sub">', `<div class="sub">${["BE", "IR", ""].includes(p.slot) ? "" : `<b>${h(p.slot)}</b> · `}`);
const tName = id => h(S.T[id]?.team ?? "—");
const todayGame = p => { const g = S.plays(p, S.m.today_day); return g ? (g.home ? "vs " : "@ ") + g.opp : "–"; };
const gamesLeft = (p, a = S.m.today_day, b = S.m.week_end_day) => (S.sched[p.nba_team] || []).filter(g => g.day >= a && g.day <= b).length;
const item = (p, w = p.avail) => ({ pos: p.pos, v: p.ev * w, p });

function table(id, cols, rows, opt = {}) {
  const st = ui.sort[id] || opt.sort; let rs = rows;
  if (st) { const c = cols.find(c => c.k === st.k); if (c) { const val = c.s || (r => r[c.k]); rs = rows.slice().sort((a, b) => { const x = val(a), y = val(b); return (x == null) - (y == null) || (typeof x === "string" ? x.localeCompare(y) : x - y) * st.dir; }); } }
  if (opt.limit) rs = rs.slice(0, opt.limit);
  return `<div class="wrap"><table class="t pin" data-table="${id}"><thead><tr>${cols.map(c => `<th class="${c.n ? "n" : ""}" data-k="${c.k}" ${st?.k === c.k ? `aria-sort="${st.dir > 0 ? "ascending" : "descending"}"` : ""} title="${h(c.title || "Sort by " + c.label)}">${h(c.label)}${st?.k === c.k ? (st.dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead><tbody>${rs.map((r, i) => `<tr class="${opt.cls ? opt.cls(r) : ""}">${cols.map(c => `<td class="${c.n ? "n" : ""}">${c.f ? c.f(r, i) : h(r[c.k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function dayRows(a, b) {
  const m = S.m, rows = [];
  for (let d = m.week_start_day; d <= m.week_end_day; d++) {
    const cell = id => { const act = d <= m.today_day ? (S.dayPts[id + ":" + d]?.points ?? 0) : 0, pr = d >= m.today_day ? (S.D[id]?.week_proj?.[d] ?? 0) : 0; return { act, extra: Math.max(0, pr - act) }; };
    rows.push({ d, a: cell(a), b: cell(b) });
  }
  const max = Math.max(1, ...rows.flatMap(r => [r.a.act + r.a.extra, r.b.act + r.b.extra]));
  const bar = (c, cls) => `<div style="display:flex;gap:2px">${c.act ? `<div class="bar ${cls}" style="width:${c.act / max * 100}%"></div>` : ""}${c.extra ? `<div class="bar ${cls} p" style="width:${c.extra / max * 100}%"></div>` : ""}</div>`;
  const val = (c, d) => d < m.today_day ? n0(c.act) : d === m.today_day ? `${n0(c.act)}<span class="dim">/${n0(c.act + c.extra)}</span>` : `<span class="dim">${n0(c.extra)}</span>`;
  return `<table class="days">${rows.map(r => `<tr class="${r.d === m.today_day ? "today" : ""}" data-tip="${h(dayLabel(isoOf(r.d)))}: ${h(S.T[a].abbrev)} ${n0(r.a.act + r.a.extra)}, ${h(S.T[b].abbrev)} ${n0(r.b.act + r.b.extra)}${r.d >= m.today_day ? " (projected)" : ""}"><td class="d">${r.d === m.today_day ? "Today" : dayLabel(isoOf(r.d))}</td><td class="bars">${bar(r.a, "me")}${bar(r.b, "opp")}</td><td class="v">${val(r.a, r.d)}</td><td class="v">${val(r.b, r.d)}</td></tr>`).join("")}</table><p class="note" style="margin-bottom:0">Solid bars are points scored. Pale bars and grey numbers are projections from each team's best legal lineup that day.</p>`;
}

function matchupCard(mu, forceOpen) {
  let a = mu.team_id, b = mu.opp_id; if (b === S.me || (ui.tab === "teams" && b === ui.team)) [a, b] = [b, a];
  const pa = S.matchups.find(x => x.week === mu.week && x.team_id === a), wp = S.D[a]?.win_prob ?? 0.5, open = forceOpen || ui.open.has(mu.team_id);
  const row = (id, pts, cls) => `<div class="row"><div class="name"><span class="key" style="background:var(--${cls})"></span>${tName(id)} <span class="dim" style="font-weight:400">${h(S.T[id].wins)}-${h(S.T[id].losses)}</span></div><div class="proj">proj ${n0(S.D[id]?.proj_final)}</div><div class="pts">${n0(pts)}</div></div>`;
  return `<div class="card mu ${a === S.me ? "mine" : ""}" ${forceOpen ? "" : `data-mu="${mu.team_id}"`}>${row(a, pa.pts, "me")}${row(b, pa.opp_pts, "opp")}<div class="prob"><i style="width:${wp * 100}%"></i><i style="width:${(1 - wp) * 100}%"></i></div><div class="problabel"><span>${h(S.T[a].abbrev)} wins ${pct(wp)}</span><span>${pct(1 - wp)} ${h(S.T[b].abbrev)}</span></div>${open ? dayRows(a, b) : ""}</div>`;
}

function rosterTable(id) {
  const rs = S.roster(id).sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot) || b.ev - a.ev);
  const row = p => `<tr><td>${pBtnSlot(p)}</td><td>${h(todayGame(p))}</td><td class="n">${gamesLeft(p)}</td><td class="n">${n1(p.avg)}</td><td class="n">${n1(p.l5)}</td><td class="n">${n1(p.ev)}</td></tr>`;
  const sec = (label, list) => list.length ? `<tr class="sep"><td colspan="6">${label}</td></tr>` + list.map(row).join("") : "";
  return `<div class="wrap"><table class="t pin"><thead><tr><th>Player</th><th>Today</th><th class="n" title="Games left this week">Left</th><th class="n" title="Season average">Avg</th><th class="n" title="Average of the last 5 games">L5</th><th class="n" title="Expected points per game">Exp</th></tr></thead><tbody>${sec("Starters", rs.filter(p => !["BE", "IR"].includes(p.slot)))}${sec("Bench", rs.filter(p => p.slot === "BE"))}${sec("Injured reserve", rs.filter(p => p.slot === "IR"))}</tbody></table></div>`;
}

// NBA team colours (primary, secondary) for the player cards
const NBA = { ATL: ["#c8102e", "#fdb927"], BOS: ["#007a33", "#0b3d20"], BKN: ["#1d1d1d", "#555"], CHA: ["#1d1160", "#00788c"], CHI: ["#ce1141", "#1d1d1d"], CLE: ["#6f263d", "#ffb81c"], DAL: ["#00538c", "#002b5e"], DEN: ["#0e2240", "#fec524"], DET: ["#c8102e", "#1d42ba"], GS: ["#1d428a", "#ffc72c"], HOU: ["#ce1141", "#1d1d1d"], IND: ["#002d62", "#fdbb30"], LAC: ["#1d428a", "#c8102e"], LAL: ["#552583", "#fdb927"], MEM: ["#5d76a9", "#12173f"], MIA: ["#98002e", "#1d1d1d"], MIL: ["#00471b", "#9c8e62"], MIN: ["#0c2340", "#236192"], NO: ["#0c2340", "#c8102e"], NY: ["#006bb6", "#f58426"], OKC: ["#007ac1", "#ef3b24"], ORL: ["#0077c0", "#1d1d1d"], PHI: ["#006bb6", "#ed174c"], PHX: ["#1d1160", "#e56020"], POR: ["#e03a3e", "#1d1d1d"], SAC: ["#5a2d81", "#63727a"], SA: ["#1d1d1d", "#8a8d8f"], TOR: ["#ce1141", "#1d1d1d"], UTAH: ["#3e2680", "#f9a01b"], WSH: ["#002b5c", "#e31837"] };
const grad = t => { const c = NBA[t] || ["#444", "#777"]; return `linear-gradient(105deg, ${c[0]} 0%, ${c[0]} 45%, ${c[1]} 130%)`; };
const initials = n => n.replace(/[^A-Za-z' -]/g, "").split(/[ -]+/).filter(w => !/^(jr|sr|ii|iii|iv)$/i.test(w)).map(w => w[0]).slice(0, 2).join("").toUpperCase();
const nextGames = (p, n = 2) => (S.sched[p.nba_team] || []).filter(g => g.day >= S.m.today_day).slice(0, n).map(g => `${g.day === S.m.today_day ? "Today" : wd(g.date)} ${g.home ? "vs " : "@"}${g.opp}`).join(" · ") || "No games soon";
const weekSpan = w => { const a = w === 1 ? 1 : 7 * w - 7, b = w === 1 ? 6 : 7 * w - 1, D = x => new Date(isoOf(x) + "T12:00:00"), f = x => D(x).toLocaleDateString("en-US", { month: "short", day: "numeric" }); return `${f(a)}–${D(a).getMonth() === D(b).getMonth() ? D(b).getDate() : f(b)}`; };

function weekCells(a, b) { // per day: points scored and projected remainder, for both teams
  const m = S.m, rows = [];
  for (let d = m.week_start_day; d <= m.week_end_day; d++) {
    const cell = id => { const act = d <= m.today_day ? (S.dayPts[id + ":" + d]?.points ?? 0) : 0, pr = d >= m.today_day ? (S.D[id]?.week_proj?.[d] ?? 0) : 0; return { act, extra: Math.max(0, pr - act) }; };
    rows.push({ d, a: cell(a), b: cell(b) });
  }
  return rows;
}
function weekBars(a, b) {
  const m = S.m, rows = weekCells(a, b), max = Math.max(1, ...rows.flatMap(r => [r.a.act + r.a.extra, r.b.act + r.b.extra]));
  const col = (c, cls) => `<div class="vb">${c.extra ? `<i class="${cls} p" style="height:${c.extra / max * 100}%"></i>` : ""}${c.act ? `<i class="${cls}" style="height:${c.act / max * 100}%"></i>` : ""}</div>`;
  return `<div class="vbars">${rows.map(r => `<div class="vday ${r.d === m.today_day ? "today" : ""}" data-tip="${h(dayLabel(isoOf(r.d)))}: ${h(S.T[a].abbrev)} ${n0(r.a.act)}${r.a.extra ? " (proj " + n0(r.a.act + r.a.extra) + ")" : ""}, ${h(S.T[b].abbrev)} ${n0(r.b.act)}${r.b.extra ? " (proj " + n0(r.b.act + r.b.extra) + ")" : ""}"><div class="vpair">${col(r.a, "me")}${col(r.b, "opp")}</div><span>${r.d === m.today_day ? "Today" : h(wd(isoOf(r.d)))}</span></div>`).join("")}</div>`;
}
function runningTotal(a, b) {
  const m = S.m, rows = weekCells(a, b), W = 380, H = 190, L = 38, R = 46, Tp = 10, B = 22, n = rows.length;
  const cum = k => { let act = 0, all = 0; return rows.map(r => { act += r[k].act; all += r[k].act + r[k].extra; return { act, all, d: r.d }; }); };
  const A = cum("a"), Bc = cum("b"), max = Math.max(A.at(-1).all, Bc.at(-1).all, 1) * 1.06;
  const x = i => L + (i + 1) / n * (W - L - R), y = v => Tp + (1 - v / max) * (H - Tp - B), ti = Math.min(n - 1, Math.max(0, m.today_day - m.week_start_day));
  const line = (c, cls) => { const solid = [`M${L},${y(0)}`].concat(c.filter(p => p.d <= m.today_day).map((p, i) => `L${x(i)},${y(p.act)}`)).join(""), dash = c.filter(p => p.d >= m.today_day).map((p, i) => `${i ? "L" : `M${x(ti)},${y(c[ti].act)}L`}${x(ti + i)},${y(p.all)}`).join("");
    return `<path d="${dash}" fill="none" stroke="var(--${cls})" stroke-width="2" stroke-dasharray="3 4" stroke-linecap="round"/><path d="${solid}" fill="none" stroke="var(--${cls})" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${x(ti)}" cy="${y(c[ti].act)}" r="4" fill="var(--${cls})" stroke="var(--surface)" stroke-width="2"/>`; };
  const ea = y(A.at(-1).all), eb = y(Bc.at(-1).all), off = Math.abs(ea - eb) < 13 ? (ea < eb ? -7 : 7) : 0;
  const ticks = [0, 1, 2, 3].map(i => max / 1.06 * i / 3);
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Running total for the week, both teams">${ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${n0(t)}</text>`).join("")}${rows.map((r, i) => `<text x="${x(i)}" y="${H - 5}" text-anchor="middle" ${r.d === m.today_day ? `class="lab"` : ""}>${r.d === m.today_day ? "Today" : h(wd(isoOf(r.d)))}</text>`).join("")}${line(Bc, "opp")}${line(A, "me")}<text class="lab" x="${W - R + 6}" y="${ea + 4 + off}">${n0(A.at(-1).all)}</text><text class="lab" x="${W - R + 6}" y="${eb + 4 - off}">${n0(Bc.at(-1).all)}</text>${rows.map((r, i) => `<rect x="${x(i) - (W - L - R) / n / 2}" y="${Tp}" width="${(W - L - R) / n}" height="${H - Tp - B}" fill="transparent" data-tip="${h(dayLabel(isoOf(r.d)))}: ${h(S.T[a].abbrev)} ${n0(r.d <= m.today_day ? A[i].act : A[i].all)}, ${h(S.T[b].abbrev)} ${n0(r.d <= m.today_day ? Bc[i].act : Bc[i].all)}${r.d > m.today_day ? " (projected)" : ""}"/>`).join("")}</svg></div>`;
}

function rosterCards(id) {
  const rs = S.roster(id).sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot) || b.ev - a.ev);
  const card = p => { const d = p.avg - (p.proj_avg || p.avg), wk = S.wk[p.player_id + ":" + id] || 0; return `<button class="pcard" data-p="${p.player_id}"><div class="phead" style="background:${grad(p.nba_team)}"><span class="av">${h(initials(p.player))}</span><span class="pn"><b>${h(p.player)}</b><small>${h(p.slot === "BE" ? "Bench" : p.slot)} · ${h(p.positions)} · ${h(p.nba_team)}</small></span>${p.status !== "Healthy" ? `<span class="badge">${p.status === "DTD" ? "DTD" : "OUT"}</span>` : ""}</div><div class="pstats"><div><b>${n1(p.avg)}</b><span>Avg</span></div><div><b>${n1(p.l5)}</b><span>Last 5</span></div><div><b class="${d >= 0.05 ? "pos" : d <= -0.05 ? "neg" : ""}">${signed(d, n1)}</b><span>vs proj</span></div><div><b>${n0(wk)}</b><span>This wk</span></div></div><div class="pnext">${h(nextGames(p))}</div></button>`; };
  const act = rs.filter(p => p.slot !== "IR"), ir = rs.filter(p => p.slot === "IR");
  return `<div class="pgrid">${act.map(card).join("")}</div>${ir.length ? `<details><summary><b>Injured reserve (${ir.length})</b> <span class="dim">${ir.map(p => h(p.player)).join(", ")}</span></summary><div class="pgrid" style="margin-top:8px">${ir.map(card).join("")}</div></details>` : ""}`;
}
function next7(id) {
  const m = S.m, days = []; for (let d = m.today_day; d < m.today_day + 7; d++) days.push(d);
  const rs = S.roster(id).filter(p => p.slot !== "IR").sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot) || b.ev - a.ev);
  const starts = days.map(d => bestLineup(rs.filter(p => S.plays(p, d)).map(p => item(p))).count), playing = days.map(d => rs.filter(p => p.avail > 0 && S.plays(p, d)).length);
  return `<div class="wrap"><table class="t pin n7"><thead><tr><th>Player</th>${days.map(d => `<th class="${d === m.today_day ? "tcol" : ""}">${d === m.today_day ? "Today" : h(dayLabel(isoOf(d)))}</th>`).join("")}</tr></thead><tbody>${rs.map(p => `<tr><td><div class="pc"><span class="dot" style="background:${(NBA[p.nba_team] || ["#666"])[0]}"></span><button class="link" data-p="${p.player_id}">${h(p.player)}</button>${statusTag(p)}</div></td>${days.map(d => { const g = S.plays(p, d); return `<td class="${d === m.today_day ? "tcol" : ""}">${g ? (g.home ? "vs " : "@") + h(g.opp) : `<span class="dim">·</span>`}</td>`; }).join("")}</tr>`).join("")}<tr class="tot"><td>Starts (of 10)</td>${days.map((d, i) => `<td class="${d === m.today_day ? "tcol" : ""}"><b>${starts[i]}</b>${playing[i] > 10 ? ` <span class="dim">+${playing[i] - 10} sit</span>` : ""}</td>`).join("")}</tr></tbody></table></div>`;
}
function seasonSchedule(id) {
  const rows = S.matchups.filter(x => x.team_id === id && x.week <= S.m.regular_weeks).sort((a, b) => a.week - b.week);
  return `<div class="wrap"><table class="t"><thead><tr><th class="n">Wk</th><th>Dates</th><th>Opponent</th><th class="n">Result</th></tr></thead><tbody>${rows.map(x => { const done = x.week < S.m.week, live = x.week === S.m.week; return `<tr class="${live ? "me" : ""}"><td class="n">${x.week}</td><td>${h(weekSpan(x.week))}</td><td style="max-width:38vw"><div class="pc"><button class="link" data-team="${x.opp_id}">${tName(x.opp_id)}</button></div></td><td class="n">${done ? `<span class="${x.pts > x.opp_pts ? "up" : "down"}">${x.pts > x.opp_pts ? "W" : "L"}</span> ${n0(x.pts)}–${n0(x.opp_pts)}` : live ? `${n0(x.pts)}–${n0(x.opp_pts)} <span class="dim">live</span>` : `<span class="dim">–</span>`}</td></tr>`; }).join("")}</tbody></table></div>`;
}
function teamMoves(id) {
  const ev = {}; S.activity.forEach(a => (ev[a.event] = ev[a.event] || []).push(a));
  const list = Object.values(ev).filter(e => e.some(a => [a.team_id, a.from_id, a.to_id].includes(id))).sort((a, b) => b[0].time.localeCompare(a[0].time)).slice(0, 8);
  const when = t => new Date(t).toLocaleString("en-US", { timeZone: "America/Toronto", month: "short", day: "numeric" });
  return list.length ? `<div class="wrap"><table class="t"><thead><tr><th>When</th><th>Move</th></tr></thead><tbody>${list.map(e => `<tr><td class="dim">${h(when(e[0].time))}</td><td style="white-space:normal">${e.map(a => a.kind === "Trade" ? `<b>${h(a.player)}</b> <span class="dim">${h(S.T[a.from_id]?.abbrev ?? "?")} → ${h(S.T[a.to_id]?.abbrev ?? "?")}</span>` : `<span class="${a.kind.startsWith("Add") ? "up" : "down"}">${a.kind.startsWith("Add") ? "Add" : "Drop"}</span> <b>${h(a.player)}</b>`).join("<br>")}</td></tr>`).join("")}</tbody></table></div>` : `<p class="note" style="margin:0">No moves yet.</p>`;
}

function teamPage(id) {
  const t = S.T[id], d = S.D[id] || {}, m = S.m, mu = S.matchups.find(x => x.week === m.week && x.team_id === id);
  const rs = S.roster(id), idle = rs.filter(p => !["BE", "IR"].includes(p.slot) && !S.plays(p, m.today_day)), ready = rs.filter(p => p.slot === "BE" && p.avail > 0 && S.plays(p, m.today_day));
  const opp = mu?.opp_id, od = S.D[opp] || {}, diff = mu ? mu.pts - mu.opp_pts : 0;
  const standing = S.teams.slice().sort((a, b) => b.wins - a.wins || b.points_for - a.points_for).findIndex(x => x.team_id === id) + 1;
  const startsLeft = tid => { let n = 0; for (let x = m.today_day; x <= m.week_end_day; x++) n += bestLineup(S.roster(tid).filter(p => S.plays(p, x)).map(p => item(p))).count; return n; };
  const st = (v, k) => `<div><b>${v}</b><span>${k}</span></div>`;
  const hero = `<section class="hero" id="s-over"><div class="herotop"><div><h2 class="big">${h(t.team)}</h2><div class="dim">Manager: ${h(t.manager)}</div></div>${mu ? `<div class="heroscore"><div class="dim">Week ${m.week} vs ${tName(opp)}</div><div class="score">${n0(mu.pts)} – ${n0(mu.opp_pts)}</div><div class="${diff >= 0 ? "pos" : "neg"}">${diff === 0 ? "Level" : (diff > 0 ? "Leading by " : "Trailing by ") + n0(Math.abs(diff))}</div></div>` : ""}</div>
  <div class="herostats">${mu ? st(`${n0(d.proj_final)}–${n0(od.proj_final)}`, "Projected final") + st(pct(d.win_prob), "Win chance") + st(`${startsLeft(id)}–${startsLeft(opp)}`, "Starts left") : ""}${st(`${t.wins}-${t.losses}`, "Record")}${st("#" + standing, "Standing")}${st(pct(d.playoff), "Playoff odds")}${st(pct(d.title), "Title odds")}${st("#" + (d.power_rank ?? "–"), "Power rank")}${st(`${d.adds_used ?? 0}/${ADD_LIMIT}`, "Adds used")}${st(signed(d.luck_adj ?? 0), "Luck (pts)")}${st(n0(t.points_for), "Season points")}</div></section>`;
  const jump = `<div class="jump">${[["s-over", "Overview"], ["s-mu", "This week's matchup"], ["s-roster", "Roster"], ["s-next", "Next 7 days"], ["s-season", "Schedule and moves"]].map(([a, l]) => `<button data-jump="${a}">${l}</button>`).join("")}</div>`;
  const wp = d.win_prob ?? 0.5;
  const matchup = mu ? `<div class="card"><div class="legend"><span><span class="key" style="background:var(--me)"></span>${tName(id)}</span><span><span class="key" style="background:var(--opp)"></span>${tName(opp)}</span><span class="dim">Pale and dashed = projected</span></div><h3>Points by day</h3>${weekBars(id, opp)}<h3>Running total</h3>${runningTotal(id, opp)}<div class="prob"><i style="width:${wp * 100}%"></i><i style="width:${(1 - wp) * 100}%"></i></div><div class="problabel"><span>${h(t.abbrev)} wins ${pct(wp)}</span><span>${pct(1 - wp)} ${h(S.T[opp].abbrev)}</span></div><details><summary>Show as a table</summary>${dayRows(id, opp)}</details></div>` : `<p class="note">No matchup this week.</p>`;
  return `${jump}${hero}<h2 id="s-mu">This week's matchup</h2>${matchup}
  <h2 id="s-roster">Roster</h2><div class="card"><div class="controls"><div class="seg"><button data-set="rv=cards" aria-pressed="${ui.rv === "cards"}">Cards</button><button data-set="rv=table" aria-pressed="${ui.rv === "table"}">Table</button></div></div>${ui.rv === "cards" ? rosterCards(id) : rosterTable(id)}${idle.length && ready.length ? `<p class="warnline">${ready.length} bench player${ready.length > 1 ? "s" : ""} (${ready.map(p => h(p.player)).join(", ")}) play${ready.length > 1 ? "" : "s"} today while ${idle.length} starter${idle.length > 1 ? "s" : ""} (${idle.map(p => h(p.player)).join(", ")}) ${idle.length > 1 ? "have" : "has"} no game.</p>` : ""}<p class="note" style="margin-bottom:0">"vs proj" is his season average minus ESPN's preseason projection. "This wk" counts only points scored in a starting slot. Tap a player for his game log.</p></div>
  <h2 id="s-next">Next 7 days</h2><div class="card">${next7(id)}</div>
  <h2 id="s-season">Schedule and moves</h2><div class="grid"><div class="card"><h3>Matchup schedule</h3>${seasonSchedule(id)}</div><div class="card"><h3>Recent moves</h3>${teamMoves(id)}</div></div>`;
}

/* ---------- views ---------- */
const V = {};
V.team = () => teamPage(S.me);
V.week = () => `<h2>Week ${S.m.week}, ${h(dayLabel(S.m.week_start))} to ${h(dayLabel(S.m.week_end))}</h2><div class="grid">${S.matchups.filter(x => x.week === S.m.week && x.home).sort((a, b) => ([b.team_id, b.opp_id].includes(S.me)) - ([a.team_id, a.opp_id].includes(S.me))).map(mu => matchupCard(mu)).join("")}</div><p class="note">Tap a matchup for the day-by-day view.</p>`;

V.stream = () => {
  const m = S.m, d = S.D[S.me] || {}, mine = S.roster(S.me);
  const from = ui.win === "this" ? m.today_day + (ui.today ? 0 : 1) : m.week_end_day + 1, to = ui.win === "this" ? m.week_end_day : m.week_end_day + 7;
  const days = []; for (let x = from; x <= to; x++) days.push(x);
  const base = Object.fromEntries(days.map(x => [x, bestLineup(mine.filter(p => S.plays(p, x)).map(p => item(p)))]));
  const centers = mine.filter(p => p.slot !== "IR" && p.pos.includes("C")).length;
  const fa = Object.values(S.P).filter(p => !p.team_id && p.avail > 0).map(p => {
    let gain = 0, fills = 0, g = 0;
    for (const x of days) if (S.plays(p, x)) { g++; const add = bestLineup([...base[x].used, item(p)]).total - base[x].total; if (add > 0.05) { gain += add; fills++; } }
    const gs = S.games[p.player_id] || [], last = gs.at(-1);
    return { ...p, gain, fills, g, spike: p.games_played >= 4 && last && last.fpts >= 1.6 * p.avg && last.fpts >= 30, capped: p.pos.includes("C") && centers >= CENTER_MAX };
  });
  const cols = [
    { k: "player", label: "Player", f: p => `${pBtn(p)}<div class="sub">${p.fantasy_team === "Waivers" ? `<span class="tag">Waivers</span>` : ""}${p.spike ? `<span class="tag spike" title="His last game was far above his average. Check that the role is real before adding.">Spike</span>` : ""}${p.capped ? `<span class="tag" title="You already have ${CENTER_MAX} centers">C cap</span>` : ""}</div>` },
    { k: "gain", label: "+Pts", n: 1, f: p => `<b>${signed(p.gain)}</b>`, title: "Points added to your lineup over the window" },
    { k: "fills", label: "Fills", n: 1, title: "Days he would actually crack your lineup" }, { k: "g", label: "Games", n: 1 },
    { k: "avg", label: "Avg", n: 1, f: p => n1(p.avg) }, { k: "l5", label: "L5", n: 1, f: p => n1(p.l5) }, { k: "min", label: "Min", n: 1, f: p => n1(p.min) }, { k: "pct_owned", label: "Own%", n: 1, f: p => n0(p.pct_owned) },
  ];
  return `<div class="tiles"><div class="tile"><div class="k">Adds this week</div><div class="v">${d.adds_used ?? 0}/${ADD_LIMIT}</div><div class="s">${Math.max(0, ADD_LIMIT - (d.adds_used ?? 0))} left</div></div><div class="tile"><div class="k">Centers</div><div class="v">${centers}/${CENTER_MAX}</div><div class="s">${centers >= CENTER_MAX ? "at the cap" : "room for " + (CENTER_MAX - centers)}</div></div></div>
  <h2>Window</h2><div class="controls"><div class="seg"><button data-set="win=this" aria-pressed="${ui.win === "this"}">Rest of this week</button><button data-set="win=next" aria-pressed="${ui.win === "next"}">Next week</button></div>${ui.win === "this" ? `<div class="seg"><button data-set="today=1" aria-pressed="${!!ui.today}">Count today</button><button data-set="today=" aria-pressed="${!ui.today}">Skip today</button></div>` : ""}</div>
  ${ui.win === "this" ? `<p class="note">Today only counts if you make the add before the day's first tip-off, because moves lock for the whole day.</p>` : ""}
  <h2>Your open slots</h2><div class="card">${days.length ? table("slots", [{ k: "d", label: "Day", f: r => h(r.d === m.today_day ? "Today" : dayLabel(isoOf(r.d))) }, { k: "n", label: "Playing", n: 1 }, { k: "open", label: "Open slots", n: 1, f: r => r.open ? `<b>${r.open}</b>` : "0" }, { k: "pts", label: "Proj pts", n: 1, f: r => n0(r.pts) }], days.map(x => ({ d: x, n: base[x].count, open: 10 - base[x].count, pts: base[x].total }))) : `<p class="note">No days left in this window.</p>`}</div>
  <h2>Free agents by points added</h2><div class="card">${table("fa", cols, fa.filter(p => p.g > 0), { sort: { k: "gain", dir: -1 }, limit: 40 })}</div>
  <p class="note">+Pts is what each free agent adds to your best legal lineup on the days he plays, so a player who only plays when your lineup is already full scores zero. It uses expected points (season average blended with the last 5 games).</p>`;
};

V.trade = () => {
  const A = S.me, B = ui.tradeB, ra = S.roster(A), rb = S.roster(B);
  const out = ra.filter(p => ui.selA.has(p.player_id)), inc = rb.filter(p => ui.selB.has(p.player_id));
  const calc = (r, minus, plus) => { const after = r.filter(p => !minus.includes(p)).concat(plus); const f = (list, w) => bestLineup(list.map(p => item(p, w ? p.avail : 1))).total; return { now0: f(r, 1), now1: f(after, 1), full0: f(r, 0), full1: f(after, 0), size: after.filter(p => p.slot !== "IR").length, c: after.filter(p => p.slot !== "IR" && p.pos.includes("C")).length }; };
  const a = calc(ra, out, inc), b = calc(rb, inc, out), any = out.length || inc.length;
  const chips = (r, sel, cls) => `<div class="chips">${r.slice().sort((x, y) => y.ev - x.ev).map(p => `<button class="chip ${cls}" data-pick="${cls}:${p.player_id}" aria-pressed="${sel.has(p.player_id)}">${h(p.player)}<small>${n1(p.ev)}</small>${p.status !== "Healthy" ? `<small>${p.status === "DTD" ? "DTD" : "out"}</small>` : ""}</button>`).join("")}</div>`;
  const delta = x => Math.abs(x) < 0.05 ? `<span class="dim">no change</span>` : `<span class="${x > 0 ? "delta-pos" : "delta-neg"}">${signed(x, n1)}</span>`;
  const res = (id, r) => `<tr><td>${tName(id)}</td><td class="n">${n1(r.now0)} → ${n1(r.now1)}</td><td class="n">${delta(r.now1 - r.now0)}</td><td class="n">${n1(r.full0)} → ${n1(r.full1)}</td><td class="n">${delta(r.full1 - r.full0)}</td><td class="n">${r.size}/${ROSTER_MAX}</td><td class="n">${r.c}/${CENTER_MAX}</td></tr>`;
  const warn = (id, r) => (r.size > ROSTER_MAX ? `<p class="warnline">${tName(id)} would have ${r.size} players and must drop ${r.size - ROSTER_MAX}.</p>` : "") + (r.c > CENTER_MAX ? `<p class="warnline">${tName(id)} would have ${r.c} centers. The limit is ${CENTER_MAX}.</p>` : "");
  const sum = l => l.reduce((s, p) => s + p.ev, 0);
  return `<div class="controls"><span>Trade with</span><select data-sel="tradeB">${S.teams.filter(t => t.team_id !== A).map(t => `<option value="${t.team_id}" ${t.team_id === B ? "selected" : ""}>${h(t.team)} (${h(t.manager)})</option>`).join("")}</select>${any ? `<button class="chip" data-clear="1">Clear</button>` : ""}</div>
  <h2>You give</h2>${chips(ra, ui.selA, "a")}<h2>You get from ${tName(B)}</h2>${chips(rb, ui.selB, "b")}
  <h2>Result, per game</h2><div class="card">${any ? `<div class="wrap"><table class="t"><thead><tr><th>Team</th><th class="n" title="Best legal lineup with today's injuries">Healthy now</th><th class="n">Change</th><th class="n" title="Best legal lineup if everyone were healthy">Full strength</th><th class="n">Change</th><th class="n">Roster</th><th class="n">C</th></tr></thead><tbody>${res(A, a)}${res(B, b)}</tbody></table></div>${warn(A, a)}${warn(B, b)}<p class="note">You send ${n1(sum(out))} expected points a game and get back ${n1(sum(inc))}. The table shows what matters more: how each team's best legal 10 changes once slots are filled.</p>` : `<p class="note" style="margin:0">Tap players on both sides to see how each team's best lineup changes.</p>`}</div>
  <p class="note">The number on each chip is expected points per game. Whether the other manager would accept is a judgment call, so ask me in chat for that part.</p>`;
};

V.standings = () => {
  const rows = S.teams.map(t => ({ ...t, ...(S.D[t.team_id] || {}) }));
  const order = rows.slice().sort((a, b) => b.wins - a.wins || b.points_for - a.points_for); order.forEach((r, i) => r.rank = i + 1);
  const cols = [{ k: "rank", label: "Team", f: r => `<div class="pc"><span class="dim num" style="width:20px">${r.rank}</span><button class="link" data-team="${r.team_id}">${h(r.team)}</button></div><div class="sub" style="margin-left:22px">${h(r.manager)}</div>` },
    { k: "wins", label: "W-L", n: 1, f: r => `${r.wins}-${r.losses}`, s: r => r.wins - r.losses }, { k: "points_for", label: "PF", n: 1, f: r => n0(r.points_for) },
    { k: "exp_wins", label: "Proj W", n: 1, f: r => n1(r.exp_wins), title: "Average final wins across 10,000 simulated seasons" }, { k: "playoff", label: "Playoffs", n: 1, f: r => pct(r.playoff) }, { k: "title", label: "Title", n: 1, f: r => pct(r.title) },
    { k: "power_rank", label: "Power", n: 1, f: r => "#" + r.power_rank, title: "Rank by rating: half results so far, half roster strength" }];
  const luck = [{ k: "team", label: "Team", f: r => `<div class="pc"><span class="link" style="text-decoration:none">${h(r.team)}</span></div>` }, { k: "luck_adj", label: "Health luck", n: 1, f: r => `<span class="${r.luck_adj >= 0 ? "up" : "down"}">${signed(r.luck_adj)}</span>`, title: "Points scored minus a fully healthy roster's projection, compared with the league average" },
    { k: "luck_pts", label: "Raw", n: 1, f: r => signed(r.luck_pts) }, { k: "all_play", label: "All-play W", n: 1, f: r => n1(r.all_play), title: "Wins you'd expect if you played every team every week" },
    { k: "sched_luck", label: "Schedule luck", n: 1, f: r => `<span class="${r.sched_luck >= 0 ? "up" : "down"}">${signed(r.sched_luck, n1)}</span>`, title: "Actual wins minus all-play wins" }];
  const cls = r => r.team_id === S.me ? "me" : "";
  return `<h2>Standings and odds</h2><div class="card">${table("st", cols, rows, { sort: { k: "rank", dir: 1 }, cls })}</div><p class="note">Top ${S.m.playoff_teams} make the playoffs. Odds come from 10,000 simulated seasons and move with every update.</p>
  <h2>Luck</h2><div class="card">${table("luck", luck, rows, { sort: { k: "luck_adj", dir: -1 }, cls })}</div><p class="note">Health luck counts injuries as bad luck. Schedule luck is about who you happened to face.</p>`;
};

V.teams = () => `<div class="controls"><select data-sel="team">${S.teams.map(t => `<option value="${t.team_id}" ${t.team_id === ui.team ? "selected" : ""}>${h(t.team)} (${h(t.manager)})</option>`).join("")}</select></div>${teamPage(ui.team)}`;

V.players = () => {
  const q = ui.q.trim().toLowerCase();
  const rows = Object.values(S.P).filter(p => (ui.pf === "all" || (ui.pf === "fa" ? !p.team_id : p.team_id === S.me)) && (!q || p.player.toLowerCase().includes(q) || (p.nba_team || "").toLowerCase() === q));
  const st = (k, label) => ({ k, label, n: 1, f: p => n1(p[k]) });
  const cols = [{ k: "player", label: "Player", f: pBtn }, { k: "fantasy_team", label: "Team", f: p => p.team_id ? h(S.T[p.team_id]?.abbrev) : `<span class="dim">${p.fantasy_team === "Waivers" ? "WA" : "FA"}</span>`, s: p => p.team_id ? S.T[p.team_id]?.abbrev : "~" },
    { k: "games_played", label: "GP", n: 1 }, st("avg", "Avg"), st("l5", "L5"), st("proj_avg", "Proj"), st("ev", "Exp"), st("min", "Min"), st("pts", "PTS"), st("reb", "REB"), st("ast", "AST"), st("stl", "STL"), st("blk", "BLK"), st("tpm", "3PM"), st("tov", "TO"), { k: "pct_owned", label: "Own%", n: 1, f: p => n0(p.pct_owned) }];
  return `<div class="controls"><input type="search" id="q" placeholder="Search players" value="${h(ui.q)}" aria-label="Search players"><div class="seg">${[["all", "All"], ["fa", "Free agents"], ["mine", "Mine"]].map(([k, l]) => `<button data-set="pf=${k}" aria-pressed="${ui.pf === k}">${l}</button>`).join("")}</div></div><div class="card" id="ptable">${table("pl", cols, rows, { sort: { k: "avg", dir: -1 }, limit: 100, cls: p => p.team_id === S.me ? "me" : "" })}</div><p class="note">Every rostered player plus the top 60 free agents. Tap a column to sort, tap a name for his game log.</p>`;
};

V.moves = () => {
  const ev = {}; S.activity.forEach(a => (ev[a.event] = ev[a.event] || []).push(a));
  const list = Object.values(ev).filter(e => !ui.moveTeam || e.some(a => [a.team_id, a.from_id, a.to_id].includes(ui.moveTeam))).sort((a, b) => b[0].time.localeCompare(a[0].time)).slice(0, 80);
  const when = t => new Date(t).toLocaleString("en-US", { timeZone: "America/Toronto", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const line = a => a.kind === "Trade" ? `<div><b>${h(a.player)}</b> <span class="dim">${h(S.T[a.from_id]?.abbrev ?? "?")} → ${h(S.T[a.to_id]?.abbrev ?? "?")}</span></div>` : `<div><span class="${a.kind.startsWith("Add") ? "up" : "down"}">${h(a.kind)}</span> <b>${h(a.player)}</b></div>`;
  return `<div class="controls"><select data-sel="moveTeam"><option value="0">All teams</option>${S.teams.map(t => `<option value="${t.team_id}" ${t.team_id === ui.moveTeam ? "selected" : ""}>${h(t.team)}</option>`).join("")}</select></div><div class="grid">${list.map(e => { const tr = e.some(a => a.kind === "Trade"), ids = [...new Set(e.flatMap(a => tr ? [a.from_id, a.to_id] : [a.team_id]).filter(Boolean))]; return `<div class="card"><div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px"><b>${tr ? "Trade: " : ""}${ids.map(tName).join(" and ") || "League"}</b><span class="dim num" style="font-size:12px;white-space:nowrap">${h(when(e[0].time))}</span></div>${e.map(line).join("")}</div>`; }).join("") || `<p class="note">No moves.</p>`}</div>`;
};

V.trends = () => {
  const weeks = []; for (let w = 1; w < S.m.week; w++) weeks.push(w);
  const H = S.hist.days, byId = t => t.team_id;
  let labels, series, fmt = n0, invert = false, note = "";
  if (ui.metric === "weekly") { labels = weeks.map(w => "Wk " + w); series = S.teams.map(t => ({ id: byId(t), name: t.team, short: t.abbrev, values: weeks.map(w => S.matchups.find(x => x.week === w && x.team_id === t.team_id)?.pts ?? null) })); }
  else { const idx = { playoff: 4, rating: 3, rank: 6 }[ui.metric]; labels = H.map(d => dayLabel(d.date)); series = S.teams.map(t => ({ id: byId(t), name: t.team, short: t.abbrev, values: H.map(d => d.teams[t.team_id]?.[idx] ?? null) })); if (ui.metric === "playoff") fmt = pct; if (ui.metric === "rank") { fmt = x => "#" + x; invert = true; } if (H.length < 2) note = "This view gains one point a day, starting today. Come back tomorrow for the first line."; }
  const hi = ui.hi && ui.hi !== S.me ? ui.hi : 0;
  const own = Object.keys(S.hist.owned).sort(); let risers = "";
  if (own.length >= 2) { const a = S.hist.owned[own[Math.max(0, own.length - 4)]], b = S.hist.owned[own.at(-1)]; const rs = Object.values(S.P).filter(p => !p.team_id && b[p.player_id] != null).map(p => ({ ...p, ch: b[p.player_id] - (a[p.player_id] ?? 0) })).sort((x, y) => y.ch - x.ch).slice(0, 10);
    risers = table("ris", [{ k: "player", label: "Player", f: pBtn }, { k: "pct_owned", label: "Own%", n: 1, f: p => n0(p.pct_owned) }, { k: "ch", label: "Change", n: 1, f: p => `<span class="${p.ch >= 0 ? "up" : "down"}">${signed(p.ch, n1)}</span>` }, { k: "avg", label: "Avg", n: 1, f: p => n1(p.avg) }, { k: "l5", label: "L5", n: 1, f: p => n1(p.l5) }], rs); }
  else risers = `<p class="note" style="margin:0">Needs two days of history. This fills in tomorrow.</p>`;
  return `<div class="controls"><div class="seg">${[["weekly", "Weekly pts"], ["playoff", "Playoffs"], ["rating", "Rating"], ["rank", "Rank"]].map(([k, l]) => `<button data-set="metric=${k}" aria-pressed="${ui.metric === k}">${l}</button>`).join("")}</div><select data-sel="hi"><option value="0">Compare with…</option>${S.teams.filter(t => t.team_id !== S.me).map(t => `<option value="${t.team_id}" ${t.team_id === hi ? "selected" : ""}>${h(t.team)}</option>`).join("")}</select></div>
  <div class="card"><div class="legend"><span><span class="key" style="background:var(--me)"></span>${tName(S.me)}</span>${hi ? `<span><span class="key" style="background:var(--opp)"></span>${tName(hi)}</span>` : ""}<span><span class="key" style="background:var(--other)"></span>Other teams</span></div>${note ? `<p class="note">${note}</p>` : ""}${labels.length >= 2 ? lineChart(labels, series, hi, fmt, invert) : note ? "" : `<p class="note">Not enough weeks yet.</p>`}
  <details><summary>Show as a table</summary>${labels.length ? `<div class="wrap"><table class="t"><thead><tr><th>Team</th>${labels.map(l => `<th class="n">${h(l)}</th>`).join("")}</tr></thead><tbody>${series.map(s => `<tr class="${s.id === S.me ? "me" : ""}"><td>${h(s.name)}</td>${s.values.map(v => `<td class="n">${v == null ? "–" : fmt(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : ""}</details></div>
  <h2>Free agents gaining owners</h2><div class="card">${risers}</div>`;
};

/* ---------- line chart: my team and one comparison highlighted, the rest grey ---------- */
let chartData = null;
function lineChart(labels, series, hi, fmt, invert) {
  const W = 380, H = 250, L = 40, R = 40, Tp = 12, B = 24, vals = series.flatMap(s => s.values).filter(v => v != null);
  let lo = Math.min(...vals), up = Math.max(...vals); if (lo === up) { lo -= 1; up += 1; } const pad = (up - lo) * 0.08; lo -= pad; up += pad;
  const x = i => L + (labels.length === 1 ? 0.5 : i / (labels.length - 1)) * (W - L - R), y = v => { const f = (v - lo) / (up - lo); return Tp + (invert ? f : 1 - f) * (H - Tp - B); };
  const path = s => s.values.map((v, i) => v == null ? "" : `${i && s.values[i - 1] != null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const ticks = [0, 1, 2, 3].map(i => lo + pad + (up - lo - 2 * pad) * i / 3);
  const cls = s => s.id === S.me ? "me" : s.id === hi ? "opp" : "other";
  const ord = series.slice().sort((a, b) => (a.id === S.me) - (b.id === S.me) || (a.id === hi) - (b.id === hi));
  chartData = { labels, series, hi, fmt, x, W, H, Tp, B };
  const step = Math.ceil(labels.length / 7);
  return `<div class="chart" id="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Line chart, one line per team">${ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${h(fmt(t))}</text>`).join("")}${labels.map((l, i) => i % step ? "" : `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${h(l)}</text>`).join("")}
  ${ord.map(s => { const c = cls(s), last = s.values.findLastIndex(v => v != null); return `<path d="${path(s)}" fill="none" stroke="var(--${c})" stroke-width="${c === "other" ? 1.25 : 2}" stroke-linejoin="round" stroke-linecap="round"/>${c !== "other" && last >= 0 ? `<circle cx="${x(last)}" cy="${y(s.values[last])}" r="4" fill="var(--${c})" stroke="var(--surface)" stroke-width="2"/><text class="lab" x="${x(last) + 9}" y="${y(s.values[last]) + 4}">${h(s.short)}</text>` : ""}`; }).join("")}
  <line id="cross" y1="${Tp}" y2="${H - B}" stroke="var(--axis)" visibility="hidden"/></svg></div>`;
}
function chartHover(e) {
  const el = e.target.closest?.("#chart"); if (!el || !chartData) return false;
  const c = chartData, r = el.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * c.W;
  let i = 0, best = 1e9; c.labels.forEach((_, k) => { const dd = Math.abs(c.x(k) - px); if (dd < best) { best = dd; i = k; } });
  const cr = el.querySelector("#cross"); cr.setAttribute("x1", c.x(i)); cr.setAttribute("x2", c.x(i)); cr.setAttribute("visibility", "visible");
  const rank = c.series.filter(s => s.values[i] != null).sort((a, b) => b.values[i] - a.values[i]);
  const rows = rank.filter(s => s.id === S.me || s.id === c.hi || rank.indexOf(s) === 0).map(s => `${h(s.short)} <b>${h(c.fmt(s.values[i]))}</b>`);
  showTip(`<b>${h(c.labels[i])}</b><br>${rows.join("<br>")}`, e); return true;
}

/* ---------- player sheet ---------- */
function openPlayer(id) {
  const p = S.P[id]; if (!p) return;
  const gs = (S.games[id] || []).slice(-10), max = Math.max(1, ...gs.map(g => g.fpts)), up = (S.sched[p.nba_team] || []).filter(g => g.day >= S.m.today_day).slice(0, 6);
  const cell = (v, l) => `<div><b>${v}</b><span>${l}</span></div>`;
  $("#sheetBody").innerHTML = `<div class="sheethead"><div><h3>${h(p.player)}${statusTag(p)}</h3><div class="dim">${h(p.nba_team)} · ${h(p.positions)} · ${h(p.team_id ? S.T[p.team_id].team : p.fantasy_team || "Free agent")}${p.pct_owned != null ? ` · ${n0(p.pct_owned)}% owned` : ""}</div></div><button class="x" data-close="1" aria-label="Close">✕</button></div>
  <div class="line">${cell(n1(p.avg), "Avg")}${cell(n1(p.l5), "Last 5")}${cell(n1(p.proj_avg), "ESPN proj")}${cell(n1(p.ev), "Expected")}</div>
  ${p.pts != null ? `<div class="line">${cell(n1(p.pts), "PTS")}${cell(n1(p.reb), "REB")}${cell(n1(p.ast), "AST")}${cell(n1(p.min), "MIN")}${cell(n1(p.stl), "STL")}${cell(n1(p.blk), "BLK")}${cell(n1(p.tpm), "3PM")}${cell(n1(p.tov), "TO")}</div>` : ""}
  <h2>Last ${gs.length} games, fantasy points</h2>${gs.length ? `<div class="spark">${gs.map(g => `<i style="height:${Math.max(3, g.fpts / max * 100)}%" data-tip="${h(dayLabel(g.date))}: ${g.fpts} pts in ${g.min} min"></i>`).join("")}</div><details><summary>Show as a table</summary><table class="t"><thead><tr><th>Date</th><th class="n">Fantasy pts</th><th class="n">Min</th></tr></thead><tbody>${gs.slice().reverse().map(g => `<tr><td>${h(dayLabel(g.date))}</td><td class="n">${g.fpts}</td><td class="n">${g.min}</td></tr>`).join("")}</tbody></table></details>` : `<p class="note">No games logged.</p>`}
  <h2>Next games</h2><p class="note">${up.length ? up.map(g => `${h(dayLabel(g.date))} ${g.home ? "vs" : "@"} ${h(g.opp)}`).join(" · ") : "None in the next two weeks."}</p>`;
  const s = $("#sheet"); if (!s.open) s.showModal();
}

/* ---------- shell ---------- */
function showTip(html, e) { const t = $("#tip"); t.innerHTML = html; t.hidden = false; const w = t.offsetWidth, hh = t.offsetHeight; t.style.left = Math.max(6, Math.min(innerWidth - w - 6, e.clientX + 12)) + "px"; t.style.top = Math.max(6, e.clientY - hh - 12) + "px"; }
function stamp() { if (!S) return; const age = Math.round((Date.now() - new Date(S.m.pulled_at)) / 60000); $("#stamp").innerHTML = `Updated ${h(S.m.pulled_label)} · ${age < 60 ? age + " min ago" : age < 1440 ? Math.round(age / 60) + " h ago" : Math.round(age / 1440) + " d ago"}${age > 240 ? ` · <span class="stale">Updates look stuck</span>` : ""}`; }
function render(keepScroll) {
  const y = scrollY; $("#league").textContent = S.T[S.me].team + " · " + S.m.league.replace(/ Fantasy Basketball.*/, "");
  $("#tabs").innerHTML = TABS.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${ui.tab === k}">${l}</button>`).join("");
  chartData = null; $("#view").innerHTML = (V[ui.tab] || V.team)(); stamp();
  if (keepScroll) scrollTo(0, y); else { scrollTo(0, 0); $(`#tabs [aria-selected="true"]`)?.scrollIntoView({ inline: "center", block: "nearest" }); }
}
document.addEventListener("click", e => {
  const t = e.target, g = s => t.closest(s);
  let el;
  if ((el = g("[data-close]")) || t === $("#sheet")) return $("#sheet").close();
  if ((el = g("[data-p]"))) return openPlayer(+el.dataset.p);
  if ((el = g("[data-jump]"))) { const tg = document.getElementById(el.dataset.jump); if (tg) scrollTo({ top: tg.getBoundingClientRect().top + scrollY - $("header").offsetHeight - 8, behavior: "smooth" }); return; }
  if ((el = g("[data-tab]"))) { ui.tab = el.dataset.tab; history.replaceState(null, "", "#" + ui.tab); return render(); }
  if ((el = g("[data-team]"))) { ui.team = +el.dataset.team; ui.tab = "teams"; history.replaceState(null, "", "#teams"); return render(); }
  if ((el = g("th[data-k]"))) { const id = el.closest("table").dataset.table; if (!id) return; const cur = ui.sort[id]; ui.sort[id] = { k: el.dataset.k, dir: cur?.k === el.dataset.k ? -cur.dir : (el.classList.contains("n") ? -1 : 1) }; return render(true); }
  if ((el = g("[data-set]"))) { const [k, v] = el.dataset.set.split("="); ui[k] = k === "today" ? !!v : v; return render(true); }
  if ((el = g("[data-pick]"))) { const [side, id] = el.dataset.pick.split(":"), set = side === "a" ? ui.selA : ui.selB; set.has(+id) ? set.delete(+id) : set.add(+id); return render(true); }
  if (g("[data-clear]")) { ui.selA.clear(); ui.selB.clear(); return render(true); }
  if ((el = g("[data-mu]"))) { const id = +el.dataset.mu; ui.open.has(id) ? ui.open.delete(id) : ui.open.add(id); return render(true); }
});
document.addEventListener("change", e => { const el = e.target.closest("[data-sel]"); if (!el) return; ui[el.dataset.sel] = +el.value; if (el.dataset.sel === "tradeB") ui.selB.clear(); render(true); });
document.addEventListener("input", e => { if (e.target.id !== "q") return; ui.q = e.target.value; const pos = e.target.selectionStart; render(true); const q = $("#q"); q.focus(); q.setSelectionRange(pos, pos); });
const hover = e => { if (chartHover(e)) return; const el = e.target.closest?.("[data-tip]"); if (el) showTip(h(el.dataset.tip), e); else { $("#tip").hidden = true; $("#cross")?.setAttribute("visibility", "hidden"); } };
document.addEventListener("pointermove", hover); document.addEventListener("pointerdown", hover);
document.addEventListener("scroll", () => { $("#tip").hidden = true; }, { passive: true });

async function refresh(first) {
  const ok = await load();
  if (!ok) { if (first) $("#stamp").textContent = "No data yet. The first update hasn't finished."; return; }
  if (first) { const k = location.hash.slice(1); if (V[k]) ui.tab = k; render(); } else if (!$("#sheet").open && document.activeElement?.id !== "q") render(true);
}
refresh(true);
setInterval(stamp, 60000);
setInterval(() => { if (!document.hidden) refresh(false); }, 5 * 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && S && Date.now() - new Date(S.m.pulled_at) > 12 * 60000) refresh(false); });
