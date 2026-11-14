// Reads the built data files, writes derived.json (projections, odds, luck) and keeps the daily history.
// Usage: node analyze.mjs site/data history
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { bestLineup, expected, availability, avgOf, phi } from "./site/lib.js";

const [dataDir, histDir, rawPath] = [process.argv[2], process.argv[3], process.argv[4]];
const load = n => JSON.parse(readFileSync(`${dataDir}/${n}.json`, "utf8"));
const meta = load("meta")[0], teams = load("teams"), matchups = load("matchups"), daily = load("daily"),
  players = load("players"), sched = load("nba_schedule"), activity = load("activity"), pool = load("player_pool"), pgames = load("player_games");

// expected value per player
const gamesBy = {}; pgames.forEach(g => (gamesBy[g.player_id] = gamesBy[g.player_id] || []).push(g));
const poolBy = Object.fromEntries(pool.map(p => [p.player_id, p]));
const ev = {};
const evOf = p => {
  const g = (gamesBy[p.player_id] || []).sort((a, b) => a.day - b.day).slice(-5).map(x => x.fpts);
  const l5 = avgOf(g);
  return { ev: +expected(p, l5).toFixed(1), l5: l5 == null ? null : +l5.toFixed(1) };
};
pool.forEach(p => ev[p.player_id] = evOf(p));
players.forEach(p => { if (!ev[p.player_id]) ev[p.player_id] = evOf(p); });

const playsOn = {}; sched.forEach(g => (playsOn[g.day] = playsOn[g.day] || new Set()).add(g.nba_team));
const roster = id => players.filter(p => p.team_id === id);
const asItem = (p, w = 1) => ({ pos: p.positions.split(","), v: ev[p.player_id].ev * w });
const ids = teams.map(t => t.team_id), T = Object.fromEntries(teams.map(t => [t.team_id, t]));

// roster strength per game: healthy right now, and at full strength
const strength = {};
for (const id of ids) {
  const now = bestLineup(roster(id).map(p => asItem(p, availability(p.status)))).total;
  const full = bestLineup(roster(id).map(p => asItem(p))).total;
  strength[id] = { now, full, mix: 0.5 * now + 0.5 * full };
}

// weekly results so far
const done = matchups.filter(m => m.week < meta.week);
const weekly = {}; done.forEach(m => (weekly[m.team_id] = weekly[m.team_id] || []).push(m.pts));
const allPts = done.map(m => m.pts), leagueMean = avgOf(allPts) ?? 1300;
const meanMix = avgOf(ids.map(i => strength[i].mix));
const rating = {};
for (const id of ids) {
  const scaled = leagueMean * strength[id].mix / meanMix, wa = avgOf(weekly[id] || []);
  rating[id] = wa == null ? scaled : 0.5 * wa + 0.5 * scaled;
}

// this week: projected points for each remaining day
const dayPts = {}; daily.forEach(d => dayPts[d.team_id + ":" + d.day] = d.points);
const weekProj = {}, projFinal = {}, remaining = {};
for (const id of ids) {
  const live = matchups.find(m => m.week === meta.week && m.team_id === id)?.pts ?? 0;
  let rem = 0; weekProj[id] = {};
  for (let d = meta.today_day; d <= meta.week_end_day; d++) {
    const on = playsOn[d] || new Set();
    const p = bestLineup(roster(id).filter(x => on.has(x.nba_team)).map(x => asItem(x, availability(x.status)))).total;
    const left = d === meta.today_day ? Math.max(0, p - (dayPts[id + ":" + d] || 0)) : p;
    weekProj[id][d] = Math.round(p); rem += left;
  }
  remaining[id] = rem; projFinal[id] = live + rem;
}
const winProb = {};
matchups.filter(m => m.week === meta.week).forEach(m => {
  const sd = Math.sqrt((0.2 * remaining[m.team_id]) ** 2 + (0.2 * remaining[m.opp_id]) ** 2 + 100);
  winProb[m.team_id] = phi((projFinal[m.team_id] - projFinal[m.opp_id]) / sd);
});

// season simulation
let seed = 20261114; const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
const N = 10000, SD = 0.1, future = matchups.filter(m => m.home && m.week > meta.week && m.week <= meta.regular_weeks);
const cur = matchups.filter(m => m.home && m.week === meta.week && m.week <= meta.regular_weeks);
const tally = Object.fromEntries(ids.map(i => [i, { w: 0, po: 0, title: 0 }]));
const score = id => rating[id] * (1 + SD * gauss());
for (let s = 0; s < N; s++) {
  const w = {}, pf = {}; ids.forEach(i => { w[i] = T[i].wins; pf[i] = T[i].points_for; });
  for (const m of cur) { const a = m.team_id, b = m.opp_id, aw = rnd() < winProb[a]; w[aw ? a : b]++; pf[a] += projFinal[a] - (matchups.find(x => x.week === meta.week && x.team_id === a)?.pts ?? 0); pf[b] += projFinal[b] - (matchups.find(x => x.week === meta.week && x.team_id === b)?.pts ?? 0); }
  for (const m of future) { const a = score(m.team_id), b = score(m.opp_id); w[a >= b ? m.team_id : m.opp_id]++; pf[m.team_id] += a; pf[m.opp_id] += b; }
  const order = ids.slice().sort((a, b) => w[b] - w[a] || pf[b] - pf[a]);
  ids.forEach(i => tally[i].w += w[i]);
  const po = order.slice(0, meta.playoff_teams); po.forEach(i => tally[i].po++);
  let alive = po;
  while (alive.length > 1) { const next = []; for (let i = 0; i < alive.length / 2; i++) { const a = alive[i], b = alive[alive.length - 1 - i]; next.push(score(a) >= score(b) ? a : b); } alive = next; }
  if (alive[0] != null) tally[alive[0]].title++;
}

// luck
const luckPts = {}; ids.forEach(i => luckPts[i] = 0);
daily.forEach(d => { if (d.day < meta.today_day && d.proj_full != null) luckPts[d.team_id] += d.points - d.proj_full; });
const luckMean = avgOf(ids.map(i => luckPts[i]));
const allPlay = {}; ids.forEach(i => allPlay[i] = 0);
const byWeek = {}; done.forEach(m => (byWeek[m.week] = byWeek[m.week] || []).push(m));
Object.values(byWeek).forEach(ms => ms.forEach(m => { allPlay[m.team_id] += ms.filter(o => o.team_id !== m.team_id && o.pts < m.pts).length / (ms.length - 1); }));

// adds used this matchup (week starts midnight Eastern)
const weekStart = new Date(meta.week_start + "T05:00:00Z").getTime();
const adds = {}; ids.forEach(i => adds[i] = 0);
activity.forEach(a => { if (a.kind.startsWith("Add") && a.team_id && new Date(a.time).getTime() >= weekStart) adds[a.team_id]++; });

const power = ids.slice().sort((a, b) => rating[b] - rating[a]);
const r1 = x => +x.toFixed(1);
const derived = {
  ev,
  teams: ids.map(i => ({
    team_id: i, rating: Math.round(rating[i]), strength_now: r1(strength[i].now), strength_full: r1(strength[i].full),
    weekly_avg: Math.round(avgOf(weekly[i] || []) ?? 0), proj_final: Math.round(projFinal[i]), win_prob: +(winProb[i] ?? 0.5).toFixed(3),
    exp_wins: r1(tally[i].w / N), playoff: +(tally[i].po / N).toFixed(3), title: +(tally[i].title / N).toFixed(3),
    power_rank: power.indexOf(i) + 1, luck_pts: Math.round(luckPts[i]), luck_adj: Math.round(luckPts[i] - luckMean),
    all_play: r1(allPlay[i]), sched_luck: r1(T[i].wins - allPlay[i]), adds_used: adds[i], week_proj: weekProj[i],
  })),
};
writeFileSync(`${dataDir}/derived.json`, JSON.stringify(derived));

// daily history: one snapshot per Eastern date, written the first time a new date is seen
mkdirSync(histDir, { recursive: true });
const hp = `${histDir}/history.json`;
const hist = existsSync(hp) ? JSON.parse(readFileSync(hp, "utf8")) : { days: [], owned: {} };
if (!hist.days.some(d => d.date === meta.today)) {
  hist.days.push({ date: meta.today, teams: Object.fromEntries(derived.teams.map(t => [t.team_id, [T[t.team_id].wins, T[t.team_id].losses, Math.round(T[t.team_id].points_for), t.rating, t.playoff, t.title, t.power_rank]])) });
  hist.owned[meta.today] = Object.fromEntries(pool.filter(p => p.pct_owned > 0.5).map(p => [p.player_id, p.pct_owned]));
  const keep = Object.keys(hist.owned).sort().slice(-21); hist.owned = Object.fromEntries(keep.map(k => [k, hist.owned[k]]));
  writeFileSync(hp, JSON.stringify(hist));
  if (rawPath && existsSync(rawPath)) { // settled full-strength projections, so later pulls can skip those days
    const raw = JSON.parse(readFileSync(rawPath, "utf8"));
    writeFileSync(`${histDir}/tproj.json`, JSON.stringify(raw.tproj.filter(x => x[0] < raw.sp - 1)));
  }
  console.log("history: added", meta.today);
}
writeFileSync(`${dataDir}/history.json`, JSON.stringify(hist));
console.log("derived ok;", derived.teams.map(t => `${T[t.team_id].abbrev} ${Math.round(t.playoff * 100)}%`).join(", "));
