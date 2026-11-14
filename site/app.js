// Claude FC league dashboard. Ported from the original artifact dashboard; data comes from data/*.json,
// rebuilt by the GitHub workflow every 10-60 minutes.
const d3 = window.d3;
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ADD_LIMIT = 7, ROSTER_MAX = 13, CENTER_MAX = 4; // league settings
const ORDER = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'BE', 'IR'];

// Best legal lineup for one day: ESPN slots PG, SG, SF, PF, C, G (PG/SG), F (SF/PF), UTIL x3.
// Adding players from highest value down and keeping each one only if all chosen players can still be
// seated is optimal here (a matroid), so this is the lineup a perfect manager would set.
const LINEUP_SLOTS = [['PG'], ['SG'], ['SF'], ['PF'], ['C'], ['PG', 'SG'], ['SF', 'PF'], null, null, null];
function bestLineup(list) { // items need .positions ("PG,SG") and .v; returns the starters
  const sorted = list.filter(p => p && p.v != null && p.v > 0).slice().sort((a, b) => b.v - a.v);
  const pos = sorted.map(p => String(p.positions || '').split(','));
  const match = new Array(LINEUP_SLOTS.length).fill(-1), chosen = [];
  const can = (i, s) => !LINEUP_SLOTS[s] || LINEUP_SLOTS[s].some(x => pos[i].includes(x));
  const place = (i, seen) => { for (let s = 0; s < LINEUP_SLOTS.length; s++) { if (seen[s] || !can(i, s)) continue; seen[s] = true; if (match[s] < 0 || place(match[s], seen)) { match[s] = i; return true; } } return false; };
  sorted.forEach((p, i) => { if (chosen.length < LINEUP_SLOTS.length && place(i, [])) chosen.push(p); });
  return chosen;
}
const lineupSum = list => d3.sum(bestLineup(list), p => p.v);

// ---------- data & state ----------
const FILES = ['meta', 'teams', 'matchups', 'daily', 'players', 'game_log', 'nba_schedule', 'activity', 'player_pool', 'player_games', 'derived', 'history'];
let RAW = {}, DATA = {}, DER = { teams: [], ev: {} }, HIST = { days: [], owned: {} };
let EVM = new Map(), DM = new Map(), PINFO_M = new Map(), GAMES = new Set();
const PARAMS = {};
const P = () => PARAMS;
function setParams(o) { for (const [k, v] of Object.entries(o)) { if (v == null) delete PARAMS[k]; else PARAMS[k] = v; } draw(); }
const rows = id => DATA[id] || [];
const meta = () => (DATA.meta ? DATA.meta[0] : null);
const MY = () => (meta() ? meta().my_team_id : 2);
const PINFO = () => PINFO_M;
const r1 = x => (x == null || isNaN(x) ? null : Math.round(x * 10) / 10);
const val = p => EVM.get(p.player_id)?.ev ?? p.proj_avg ?? p.avg ?? 0; // expected points per game (season avg blended with median of last 5)
const med5 = pid => EVM.get(pid)?.l5 ?? null;
const aw = p => (p.slot === 'IR' || p.status === 'OUT' ? 0 : p.status === 'DTD' ? 0.75 : 1); // how much of him counts right now
const plays = (nba, d) => GAMES.has(nba + '|' + d);
const teamName = id => (rows('teams').find(t => t.team_id === id) || {}).team || '';
const teamAbbr = id => (rows('teams').find(t => t.team_id === id) || {}).abbrev || '';

async function load() {
  const got = await Promise.all(FILES.map(f => fetch('data/' + f + '.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null)));
  if (got.slice(0, 10).some(x => !x)) return false;
  FILES.forEach((f, i) => { RAW[f] = got[i]; });
  compute();
  return true;
}
function compute() {
  DATA = {};
  FILES.slice(0, 10).forEach(k => { DATA[k] = RAW[k]; });
  DER = RAW.derived || { teams: [], ev: {} }; HIST = RAW.history || { days: [], owned: {} };
  EVM = new Map(Object.entries(DER.ev || {}).map(([k, v]) => [Number(k), v]));
  DM = new Map((DER.teams || []).map(t => [t.team_id, t]));
  PINFO_M = new Map(rows('player_pool').map(p => [p.player_id, p]));
  GAMES = new Set(rows('nba_schedule').map(g => g.nba_team + '|' + g.day));
  DATA.week_board = cWeekBoard(); DATA.standings = cStandings(); DATA.roster = cRoster(); DATA.season_sched = cSeasonSched();
  DATA.games_by_team = cGames(); DATA.moves = cMoves(); DATA.rankings = cRankings(); DATA.day_scores = cDayScores();
  DATA.proj_daily = cProjDaily(); DATA.team_power = cTeamPower(); DATA.team_luck = cLuck(); DATA.stream_days = cStreamDays();
}

// ---------- calcs ----------
function cWeekBoard() {
  const m = meta(), name = new Map(rows('teams').map(t => [t.team_id, t.team]));
  const startsLeft = tid => { let n = 0; for (let d = m.today_day; d <= m.week_end_day; d++) n += bestLineup(rows('players').filter(p => p.team_id === tid && aw(p) > 0 && plays(p.nba_team, d)).map(p => ({ positions: p.positions, v: val(p) }))).length; return n; };
  return rows('matchups').filter(r => r.week === m.week && r.opp_id != null).map(r => {
    const a = DM.get(r.team_id) || {}, b = DM.get(r.opp_id) || {};
    return { team_id: r.team_id, team: name.get(r.team_id), opp_id: r.opp_id, opp: name.get(r.opp_id), home: r.home, pts: r.pts ?? 0, opp_pts: r.opp_pts ?? 0,
      starts_left: startsLeft(r.team_id), opp_starts_left: startsLeft(r.opp_id), proj_final: a.proj_final ?? r.pts, opp_proj_final: b.proj_final ?? r.opp_pts, win: a.win_prob ?? 0.5 };
  }).map((r, i, all) => { if (!r.home) { const h = all.find(x => x.home && x.team_id === r.opp_id); if (h) r.win = 1 - h.win; } return r; });
}
function cStandings() {
  return rows('teams').slice().sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses) || (b.points_for - a.points_for))
    .map((t, i) => ({ team_id: t.team_id, rank: i + 1, team: t.team, manager: t.manager, record: t.wins + '–' + t.losses, points_for: t.points_for }));
}
function cRoster() {
  const m = meta(), glog = d3.group(rows('game_log'), g => g.player_id), sched = d3.group(rows('nba_schedule'), g => g.nba_team);
  return rows('players').map(p => {
    const logs = (glog.get(p.player_id) || []).slice().sort((a, b) => a.day - b.day);
    const played = logs.filter(g => !(g.pts === 0 && g.slot === 'IR'));
    const last = played.length ? played[played.length - 1].pts : null;
    const week = logs.filter(g => g.team_id === p.team_id && g.day >= m.week_start_day && g.day <= m.week_end_day && g.slot !== 'BE' && g.slot !== 'IR').reduce((a, g) => a + g.pts, 0);
    const upcoming = (sched.get(p.nba_team) || []).filter(g => g.day >= m.today_day).sort((a, b) => a.day - b.day);
    return { player_id: p.player_id, team_id: p.team_id, slot: p.slot, slot_order: ORDER.indexOf(p.slot), player: p.player, positions: p.positions, nba_team: p.nba_team,
      status: p.status, avg: p.avg, games_played: p.games_played, proj_avg: p.proj_avg, med5: med5(p.player_id), exp: r1(val(p)), last_pts: last, week_pts: week,
      games_left: upcoming.filter(g => g.day <= m.week_end_day).length,
      next_games: upcoming.filter(g => g.day < m.today_day + 7).map(g => (g.day === m.today_day ? 'Today' : WD[new Date(g.date + 'T12:00:00Z').getUTCDay()]) + ' ' + (g.home ? 'vs ' : '@') + g.opp).join(' · ') };
  });
}
function cSeasonSched() {
  const m = meta(), t = new Map(rows('teams').map(x => [x.team_id, x]));
  const day0 = Date.UTC(2026, 9, 19, 12), fmt = d => new Date(day0 + d * 864e5).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return rows('matchups').filter(r => r.opp_id != null && t.get(r.opp_id) && r.week <= m.regular_weeks).map(r => {
    const s = r.week === 1 ? 1 : 7 * r.week - 7, e = r.week === 1 ? 6 : 7 * r.week - 1, done = r.week < m.week;
    return { row_id: r.team_id + '-' + r.week, team_id: r.team_id, week: r.week, dates: fmt(s) + '–' + fmt(e), opp: t.get(r.opp_id).team, opp_id: r.opp_id, opp_points_for: t.get(r.opp_id).points_for,
      res: done ? (r.pts > r.opp_pts ? 'W' : r.pts < r.opp_pts ? 'L' : 'T') : (r.week === m.week ? 'live' : ''), score: done || r.week === m.week ? d3.format(',')(r.pts) + '–' + d3.format(',')(r.opp_pts) : '' };
  });
}
function cGames() {
  const m = meta();
  const cnt = (tid, a, b) => { let g = 0, s = 0; for (let d = a; d <= b; d++) { const pl = rows('players').filter(p => p.team_id === tid && aw(p) > 0 && plays(p.nba_team, d)); g += pl.length; s += bestLineup(pl.map(p => ({ positions: p.positions, v: val(p) }))).length; } return [g, s]; };
  return rows('teams').map(t => { const [a, b] = cnt(t.team_id, m.today_day, m.week_end_day), [c, d] = cnt(t.team_id, m.week_end_day + 1, m.week_end_day + 7);
    return { team_id: t.team_id, team: t.team, this_games: a, this_starts: b, next_games: c, next_starts: d }; }).sort((x, y) => y.this_starts - x.this_starts);
}
function cMoves() {
  const name = new Map(rows('teams').map(t => [t.team_id, t.team])), groups = new Map();
  rows('activity').forEach(a => { if (!groups.has(a.event)) groups.set(a.event, []); groups.get(a.event).push(a); });
  const fmt = iso => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Toronto' });
  return [...groups.entries()].map(([event, rs]) => {
    const trade = rs.some(r => r.kind === 'Trade'); let teamsTxt, details, ids;
    if (trade) { ids = [...new Set(rs.filter(r => r.kind === 'Trade').map(r => r.to_id))]; teamsTxt = ids.map(i => name.get(i) || '?').join(' ↔ '); details = ids.map(i => (name.get(i) || '?') + ' get ' + rs.filter(r => r.kind === 'Trade' && r.to_id === i).map(r => r.player).join(', ')).join(' · ') + (rs.some(r => r.kind !== 'Trade') ? ' · dropped to make room: ' + rs.filter(r => r.kind !== 'Trade').map(r => r.player).join(', ') : ''); }
    else { const tid = rs[0].team_id; ids = tid ? [tid] : []; teamsTxt = name.get(tid) || 'Unknown'; details = rs.map(r => (r.kind.startsWith('Add') ? '+ ' : '− ') + r.player + (r.kind === 'Add (waiver)' ? ' (waivers)' : '')).join('   '); }
    return { event, time: rs[0].time, when: fmt(rs[0].time), kind: trade ? 'Trade' : 'Add/Drop', teams: teamsTxt, team_ids: ids, details };
  }).sort((a, b) => b.time.localeCompare(a.time));
}
const sgnS = v => (v == null ? '' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.round(v * 10) / 10));
const fmtDiff = sgnS;
function cRankings() {
  const m = meta(), days = []; for (let d = Math.max(1, m.today_day - 6); d <= m.today_day; d++) days.push(d);
  const byP = d3.group(rows('player_games'), g => g.player_id);
  return rows('player_pool').slice().sort((a, b) => (b.total_pts - a.total_pts) || (b.avg - a.avg)).map((p, i) => {
    const gs = (byP.get(p.player_id) || []).slice().sort((a, b) => a.day - b.day), last = gs[gs.length - 1], proj = p.proj_avg;
    const row = { player_id: p.player_id, rank: i + 1, player: p.player, team_id: p.team_id, fantasy_team: p.fantasy_team, nba_team: p.nba_team, positions: p.positions, status: p.status,
      games_played: p.games_played, total_pts: p.total_pts, avg: p.avg, proj_avg: proj, med5: med5(p.player_id), exp: r1(val(p)),
      diff_avg_n: proj && p.games_played ? Math.round((p.avg - proj) * 10) / 10 : null, last_fpts: last ? last.fpts : null, last_diff: last && proj ? sgnS(last.fpts - proj) : '',
      pct_owned: p.pct_owned, min: p.min, pts: p.pts, reb: p.reb, ast: p.ast, stl: p.stl, blk: p.blk, tpm: p.tpm, tov: p.tov, fg_pct: p.fg_pct };
    row.diff_avg = sgnS(row.diff_avg_n);
    const l5 = gs.filter(g => g.min > 0).slice(-5);
    row.fpm = p.min ? Math.round(p.avg / p.min * 100) / 100 : null;
    row.min_l5 = l5.length ? r1(d3.mean(l5, g => g.min)) : null;
    row.fpm_l5 = l5.length ? Math.round(d3.sum(l5, g => g.fpts) / d3.sum(l5, g => g.min) * 100) / 100 : null;
    row.diff_total_n = row.diff_avg_n == null ? null : Math.round((p.avg - proj) * p.games_played);
    row.diff_total = sgnS(row.diff_total_n);
    days.forEach(d => { const g = gs.find(x => x.day === d); row['d_' + d] = g && proj ? sgnS(g.fpts - proj) : ''; });
    return row;
  });
}
function cDayScores() {
  const p = new Map(rows('players').map(x => [x.player_id, x])), playedSet = new Set(rows('player_games').map(g => g.player_id + '-' + g.day));
  return rows('game_log').filter(g => !(g.pts === 0 && g.slot === 'IR')).map(g => {
    const pl = p.get(g.player_id) || {}, counted = g.slot !== 'BE' && g.slot !== 'IR', proj = pl.proj_avg ?? g.proj_avg ?? null;
    return { row_id: g.player_id + '-' + g.day, player_id: g.player_id, team_id: g.team_id, day: g.day, player: pl.player || g.player || String(g.player_id),
      slot: counted ? g.slot : (g.slot === 'IR' ? 'IR' : 'Bench'), pts: g.pts, proj_avg: proj,
      diff: !playedSet.has(g.player_id + '-' + g.day) && g.pts === 0 ? 'DNP' : proj ? sgnS(g.pts - proj) : '', counted };
  });
}
function cProjDaily() { // projection per team per day this week: days left from the model, days played from the players who played
  const m = meta(), pj = new Map(rows('players').map(p => [p.player_id, p])), out = [];
  const glog = d3.group(rows('game_log'), g => g.team_id + '|' + g.day);
  for (let d = m.week_start_day; d <= m.week_end_day; d++) rows('teams').forEach(t => {
    let proj;
    if (d >= m.today_day) proj = (DM.get(t.team_id)?.week_proj || {})[d] ?? 0;
    else proj = Math.round(lineupSum((glog.get(t.team_id + '|' + d) || []).filter(g => g.slot !== 'IR').map(g => { const p = pj.get(g.player_id) || g; return { positions: p.positions, v: EVM.get(g.player_id)?.ev ?? p.proj_avg ?? 0 }; })));
    out.push({ row_id: t.team_id + '-' + d, team_id: t.team_id, day: d, proj });
  });
  return out;
}
function cTeamPower() {
  const m = meta(), pj = new Map(rows('proj_daily').map(r => [r.team_id + '|' + r.day, r.proj]));
  const projOf = new Map([...rows('game_log').filter(g => g.proj_avg != null).map(g => [g.player_id, g.proj_avg]), ...rows('players').map(p => [p.player_id, val(p)])]);
  const todayDiff = tid => rows('game_log').filter(g => g.team_id === tid && g.day === m.today_day && g.slot !== 'BE' && g.slot !== 'IR').reduce((a, g) => a + g.pts - (projOf.get(g.player_id) || 0), 0);
  const sg = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.round(v));
  const rs = rows('teams').map(t => {
    const played = rows('daily').filter(r => r.team_id === t.team_id && r.day < m.today_day && r.day >= m.week_start_day);
    const vsn = played.reduce((a, r) => a + r.points - (pj.get(t.team_id + '|' + r.day) || 0), 0) + todayDiff(t.team_id);
    const wb = rows('week_board').find(r => r.team_id === t.team_id) || {}, dm = DM.get(t.team_id) || {};
    const weeks = rows('matchups').filter(r => r.team_id === t.team_id && r.week <= m.week).sort((a, b) => a.week - b.week);
    const fin = weeks.filter(r => r.week < m.week), season = d3.sum(weeks, r => r.pts);
    const done = rows('daily').filter(r => r.team_id === t.team_id && r.day < m.today_day && r.proj_full != null);
    const lk = list => list.reduce((a, r) => a + r.points - r.proj_full, 0), luckW = lk(done.filter(r => r.day >= m.week_start_day)), luckS = lk(done);
    const row = { team_id: t.team_id, team: t.team, manager: t.manager, record: t.wins + '–' + t.losses, wins: t.wins, losses: t.losses,
      vs_full_n: luckW, vs_full: sg(luckW), luck_season_n: luckS, luck_season: sg(luckS),
      week_pts: wb.pts ?? 0, week_proj: wb.proj_final ?? null, win: wb.win, opp: wb.opp || '', opp_id: wb.opp_id, opp_pts: wb.opp_pts ?? 0,
      status: wb.pts > wb.opp_pts ? 'Leading' : wb.pts < wb.opp_pts ? 'Trailing' : 'Tied', vs_proj_n: vsn, vs_proj: sg(vsn),
      season_pts: season, avg_week: fin.length ? Math.round(d3.mean(fin, r => r.pts)) : null, rating: dm.rating, strength_now: dm.strength_now, strength_full: dm.strength_full,
      exp_wins: dm.exp_wins, playoff: dm.playoff, title: dm.title, power_rank: dm.power_rank, all_play: dm.all_play, sched_luck: dm.sched_luck, adds_used: dm.adds_used ?? 0 };
    weeks.forEach(r => { row['w_' + r.week] = r.pts; });
    return row;
  });
  const rank = (key, cmp) => rs.slice().sort(cmp).forEach((r, i) => { r[key] = i + 1; });
  rank('week_rank', (a, b) => b.week_pts - a.week_pts);
  rank('season_rank', (a, b) => (b.wins - a.wins) || (b.season_pts - a.season_pts));
  return rs;
}
function cLuck() {
  const m = meta(), wkOf = d => (d <= 6 ? 1 : Math.floor(d / 7) + 1), sg = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.round(v)), out = [];
  for (let w = 0; w <= m.week; w++) {
    const start = out.length;
    rows('teams').forEach(t => {
      const ds = rows('daily').filter(r => r.team_id === t.team_id && r.day < m.today_day && r.proj_full != null && (w === 0 || wkOf(r.day) === w));
      if (!ds.length) return;
      const act = d3.sum(ds, r => r.points), pf = d3.sum(ds, r => r.proj_full), diff = act - pf;
      out.push({ row_id: w + '-' + t.team_id, week: w, team_id: t.team_id, team: t.team, days: ds.length, points: act, proj_full: pf, diff_n: diff, diff: sg(diff),
        per_day: sg(diff / ds.length), pct: pf ? Math.round(act / pf * 1000) / 10 : null });
    });
    const grp = out.slice(start), ratio = d3.sum(grp, r => r.points) / (d3.sum(grp, r => r.proj_full) || 1);
    grp.forEach(r => { r.vs_league_n = Math.round(r.points - r.proj_full * ratio); r.vs_league = sg(r.vs_league_n); });
  }
  return out;
}
function cStreamDays() {
  const m = meta(), mine = rows('players').filter(p => p.team_id === m.my_team_id && aw(p) > 0), out = [];
  for (let d = m.today_day; d <= m.week_end_day + 7; d++) {
    const list = mine.filter(p => plays(p.nba_team, d)), seated = bestLineup(list.map(p => ({ positions: p.positions, v: val(p) || 1 }))).length;
    const nba = rows('nba_schedule').filter(g => g.day === d).length / 2;
    out.push({ day: d, playing: list.length, nba_games: nba, open: nba ? Math.max(0, 10 - seated) : 0, week: d <= m.week_end_day ? 'this' : 'next' });
  }
  return out;
}

// ---------- DOM helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const txt = (tag, t, cls) => { const e = document.createElement(tag); if (t != null) e.textContent = t; if (cls) e.className = cls; return e; };
const dayLbl = d => { const dt = new Date(Date.UTC(2026, 9, 19 + d, 12)); return WD[dt.getUTCDay()] + ' ' + (dt.getUTCMonth() + 1) + '/' + dt.getUTCDate(); };
const tone = s => (String(s).startsWith('+') ? 'up' : String(s).startsWith('−') ? 'down' : '');
const pct = x => (x == null ? '–' : x > 0 && x < 0.01 ? '<1%' : x > 0.99 && x < 1 ? '>99%' : Math.round(x * 100) + '%');
const f0 = d3.format(',');
const dash0 = v => (v == null || v === '' ? '–' : String(v));
function makeTable(cols) {
  const table = document.createElement('table'), tr = document.createElement('tr');
  cols.forEach(([f, label, cls, title]) => { const th = txt('th', label, cls || ''); th.dataset.field = f; if (title) th.title = title; tr.append(th); });
  table.createTHead().append(tr);
  return { table, tbody: table.createTBody() };
}
function tile(label, el) { const d = txt('div', label); d.prepend(el); return d; }
function placeTip(tip, box, ev) {
  const [px, py] = d3.pointer(ev, box); tip.style.opacity = 1;
  tip.style.left = Math.max(0, Math.min(px + 12, box.clientWidth - tip.offsetWidth - 4)) + 'px'; tip.style.top = Math.max(0, py - tip.offsetHeight - 10) + 'px';
}
const swatch = c => { const s = document.createElement('i'); s.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:${c}`; return s; };

// ---------- colours & faces ----------
const NBA = { ATL: ['#E03A3E', '#C1D32F'], BOS: ['#007A33', '#BA9653'], BKN: ['#000000', '#777D84'], CHA: ['#1D1160', '#00788C'], CHI: ['#CE1141', '#000000'],
  CLE: ['#860038', '#FDBB30'], DAL: ['#00538C', '#B8C4CA'], DEN: ['#0E2240', '#FEC524'], DET: ['#C8102E', '#1D42BA'], GS: ['#1D428A', '#FFC72C'],
  HOU: ['#CE1141', '#000000'], IND: ['#002D62', '#FDBB30'], LAC: ['#C8102E', '#1D428A'], LAL: ['#552583', '#FDB927'], MEM: ['#5D76A9', '#12173F'],
  MIA: ['#98002E', '#F9A01B'], MIL: ['#00471B', '#EEE1C6'], MIN: ['#0C2340', '#236192'], NO: ['#0C2340', '#C8102E'], NY: ['#006BB6', '#F58426'],
  OKC: ['#007AC1', '#EF3B24'], ORL: ['#0077C0', '#C4CED4'], PHI: ['#006BB6', '#ED174C'], PHX: ['#1D1160', '#E56020'], POR: ['#E03A3E', '#000000'],
  SAC: ['#5A2D81', '#63727A'], SA: ['#000000', '#C4CED4'], TOR: ['#CE1141', '#000000'], UTAH: ['#002B5C', '#F9A01B'], WSH: ['#002B5C', '#E31837'] };
const nbaCol = t => NBA[t] || ['#55595f', '#8a8f96'];
const FT_COL = { 1: '#2a9d8f', 2: '#3b6fd8', 3: '#e76f51', 4: '#7b2cbf', 5: '#e9a23b', 6: '#2b9348', 7: '#d62e6b', 8: '#1f7a8c', 9: '#8d6e63', 10: '#c1121f', 0: '#8a8f96' };
const ftCol = id => FT_COL[id] ?? FT_COL[0];
function oklab(h) {
  const n = parseInt(h.slice(1), 16), [r, g, b] = [n >> 16 & 255, n >> 8 & 255, n & 255].map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const dE = (a, b) => { const x = oklab(a), y = oklab(b); return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
function pairCols(a, b) { // each team keeps its own colour unless the two are too alike to tell apart, then the second switches
  const ca = ftCol(a); let cb = ftCol(b);
  if (dE(ca, cb) < 20) cb = ['#e9a23b', '#3b6fd8', '#c1121f', '#2b9348', '#7b2cbf'].filter(c => c !== ca).sort((x, y) => dE(ca, y) - dE(ca, x))[0];
  return [ca, cb];
}
const initials = n => String(n || '').replace(/\b(Jr\.?|Sr\.?|II|III|IV)\b/g, '').trim().split(/\s+/).filter(Boolean).map(s => s[0]).slice(0, 2).join('').toUpperCase();
function avatar(name, nba, status, size) {
  const [a, b] = nbaCol(nba), s = document.createElement('span'); s.className = 'fx-av' + (size === 'lg' ? ' lg' : '');
  s.style.background = `linear-gradient(135deg, ${a} 0%, ${a} 55%, ${b} 100%)`; s.dataset.i = initials(name);
  if (status === 'OUT' || status === 'DTD') { const d = document.createElement('i'); d.className = 'fx-st ' + (status === 'OUT' ? 'out' : 'dtd'); s.append(d); }
  return s;
}
function nameCell(name, nba, status, sub) {
  const td = txt('td', null, 'fx-pc'), w = txt('span', null, 'w'), nm = txt('span', name);
  if (sub) { nm.textContent = ''; nm.className = 'nm2'; nm.append(txt('span', name), sub instanceof Node ? sub : txt('span', sub, 'sub')); }
  w.append(avatar(name, nba, status), nm); td.append(w); return td;
}
function teamDot(id) { const i = document.createElement('i'); i.className = 'fx-tdot'; i.style.background = ftCol(id); return i; }
function teamCell(name, id, cls) { const td = txt('td', null, 'fx-tc' + (cls ? ' ' + cls : '')); td.append(teamDot(id), txt('span', name)); return td; }

// ---------- tabs ----------
const TABS = ['me', 'week', 'stream', 'trade', 'standings', 'teams', 'players', 'moves', 'trends'];
let INLINE = null; // open in-place player detail: { pid, scope }
let tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'me';
function showTab(t) {
  if (INLINE && t !== tab) { closeInline(); INLINE = null; }
  tab = t; history.replaceState(null, '', '#' + t);
  document.querySelectorAll('.fx-tab').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t ? 'true' : 'false'));
  TABS.forEach(id => { document.getElementById(id).hidden = id !== t; });
  const sel = $('.fx-tab[aria-selected="true"]'), bar = $('.fx-tabs');
  if (sel && bar.scrollWidth > bar.clientWidth) bar.scrollTo({ left: sel.offsetLeft - bar.clientWidth / 2 + sel.clientWidth / 2, behavior: 'smooth' });
  draw();
}
document.querySelectorAll('.fx-tab').forEach(b => b.addEventListener('click', () => { const top = $('.fx-tabs').offsetTop; showTab(b.dataset.tab); if (window.scrollY > top) window.scrollTo({ top }); }));
document.querySelectorAll('.fx-jump button').forEach(b => b.addEventListener('click', () => { const el = document.getElementById(b.dataset.jump); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }));

// ---------- shared pieces ----------
function irAlert(host) {
  host.replaceChildren();
  const bad = rows('players').filter(p => p.team_id === MY() && p.slot === 'IR' && p.status !== 'OUT');
  if (!bad.length) return;
  const d = txt('div', null, 'fx-alert');
  d.append(txt('b', 'Adds and trades are blocked. '), bad.map(p => p.player).join(' and ') + (bad.length > 1 ? ' are' : ' is') + ' on IR but no longer listed as out (' + bad.map(p => (p.status === 'DTD' ? 'day-to-day' : 'healthy')).join(', ') + '). Move ' + (bad.length > 1 ? 'them' : 'him') + ' off IR in ESPN to unlock.');
  host.append(d);
}
function heroFor(host, tid) {
  host.replaceChildren();
  const r = rows('week_board').find(x => x.team_id === tid), st = rows('standings').find(x => x.team_id === tid), t = rows('teams').find(x => x.team_id === tid), tp = rows('team_power').find(x => x.team_id === tid) || {};
  if (!st || !t) return;
  host.style.setProperty('--team', ftCol(tid)); host.classList.add('fx-banded');
  const top = txt('div', null, 'fx-hero-top'), name = txt('div', null, 'fx-hero-name');
  name.append(txt('div', t.team, 'big'), txt('div', 'Manager: ' + t.manager, 'fx-note'));
  top.append(name);
  if (r) {
    const score = txt('div', null, 'fx-hero-score'), lead = r.pts - r.opp_pts;
    score.append(txt('div', 'Week ' + meta().week + ' vs ' + r.opp, 'fx-note'), txt('div', f0(r.pts) + ' – ' + f0(r.opp_pts), 'big'),
      txt('div', lead > 0 ? 'Leading by ' + f0(lead) : lead < 0 ? 'Trailing by ' + f0(-lead) : 'Tied', lead > 0 ? 'ok' : lead < 0 ? 'bad' : 'muted'));
    top.append(score);
  }
  const tiles = txt('div', null, 'tiles');
  if (r) tiles.append(tile('Projected final (you–them)', txt('b', f0(r.proj_final) + '–' + f0(r.opp_proj_final))), tile('Win chance', txt('b', pct(r.win))),
    tile('Starts left (you–them)', txt('b', r.starts_left + '–' + r.opp_starts_left)), tile('vs projection (wk)', txt('b', tp.vs_proj || '–', tone(tp.vs_proj))));
  tiles.append(tile('Record', txt('b', st.record)), tile('Standing', txt('b', '#' + st.rank)), tile('Playoff odds', txt('b', pct(tp.playoff))), tile('Title odds', txt('b', pct(tp.title))),
    tile('Power rank', txt('b', tp.power_rank ? '#' + tp.power_rank : '–')), tile('Adds used (wk)', txt('b', (tp.adds_used ?? 0) + ' / ' + ADD_LIMIT)), tile('Season points', txt('b', f0(st.points_for))));
  host.append(top, tiles);
}

// ---------- injured / out players: grouped at the bottom, collapsed by default (remembered) ----------
let INJ_OPEN = (() => { try { return localStorage.getItem('fx-inj-open') === '1'; } catch (e) { return false; } })();
const isOut = r => r.slot === 'IR' || r.status === 'OUT';
const injNames = list => list.map(r => r.player + (r.slot === 'IR' ? ' (IR)' : '')).join(', ');
function setInj(open) {
  INJ_OPEN = open; try { localStorage.setItem('fx-inj-open', open ? '1' : '0'); } catch (e) { /* still toggles */ }
  if (!open) { const a = document.querySelector('.fx-open'); if (a && a.closest('.fx-injrow, .fx-injgrp')) { closeInline(); INLINE = null; } }
  document.querySelectorAll('table.fx-hasinj').forEach(t => t.classList.toggle('inj-open', open));
  document.querySelectorAll('.fx-injtog button').forEach(b => b.setAttribute('aria-expanded', String(open)));
  document.querySelectorAll('details.fx-injgrp').forEach(d => { if (d.open !== open) d.open = open; });
}
function injHead(list) { const f = document.createDocumentFragment(); f.append(txt('span', '', 'car'), txt('span', 'Injured / out (' + list.length + ')', 'lbl'), txt('span', injNames(list), 'who')); return f; }
function injToggleRow(table, tbody, list) {
  const tr = document.createElement('tr'); tr.className = 'fx-injtog';
  const td = document.createElement('td'); td.colSpan = table.tHead.rows[0].cells.length;
  const b = txt('button'); b.type = 'button'; b.setAttribute('aria-expanded', String(INJ_OPEN)); b.append(injHead(list));
  b.addEventListener('click', e => { e.stopPropagation(); setInj(!INJ_OPEN); });
  td.append(b); tr.append(td); tbody.append(tr);
  table.classList.add('fx-hasinj'); table.classList.toggle('inj-open', INJ_OPEN);
}

function lastGames(td, games, n, marks) {
  const w = txt('span', null, 'fx-spark'), shown = games.slice(-n);
  const ms = (marks || []).filter(mk => mk.day != null && (!shown.length || mk.day > shown[0].day || games.length <= n || games[games.length - n - 1].day < mk.day));
  const bar = mk => { const i = txt('i', null, 'mk ' + mk.kind); i.title = (mk.kind === 'add' ? 'Added ' : 'Dropped ') + dayLbl(mk.label ?? mk.day); return i; };
  shown.forEach(g => {
    ms.filter(mk => !mk.done && g.day >= mk.day).forEach(mk => { w.append(bar(mk)); mk.done = true; });
    const b = txt('b', String(g.fpts)); b.title = dayLbl(g.day) + ' · ' + g.fpts + ' pts in ' + g.min + ' min'; if (g.fpts >= 35) b.className = 'hi'; else if (g.fpts < 20) b.className = 'lo'; b.append(txt('small', String(g.min))); w.append(b);
  });
  ms.filter(mk => !mk.done && shown.length).forEach(mk => w.append(bar(mk)));
  if (!games.length) w.append(txt('i', 'no games', 'ng'));
  td.append(w); return td;
}
let GBY = null;
const gamesOf = pid => { if (!GBY) GBY = d3.group(rows('player_games').filter(g => g.min > 0), g => g.player_id); return (GBY.get(pid) || []).slice().sort((a, b) => a.day - b.day); };

function rosterTable(host, tid) {
  host.replaceChildren();
  const rk = new Map(rows('rankings').map(r => [r.player_id, r]));
  const { table, tbody } = makeTable([['slot', 'Slot'], ['player', 'Player'], ['positions', 'Pos'], ['nba_team', 'NBA'], ['status', 'Status'], ['week_pts', 'This week', 'num'], ['last_pts', 'Last', 'num'],
    ['last5', 'Last 5 games (pts / min)'], ['avg', 'Avg', 'num'], ['med5', 'Med 5', 'num', 'Median of the last 5 games'], ['proj_avg', 'Proj', 'num'], ['exp', 'Exp', 'num', 'Expected points per game used in every projection'],
    ['diff_avg', '+/− per game', 'num'], ['diff_total', '+/− season', 'num'], ['games_played', 'GP', 'num'], ['games_left', 'Games left (wk)', 'num'], ['next_games', 'Next games'],
    ['min', 'MIN', 'num'], ['min_l5', 'MIN last 5', 'num'], ['fpm', 'Pts/min', 'num'], ['pts', 'PTS', 'num'], ['reb', 'REB', 'num'], ['ast', 'AST', 'num'], ['stl', 'STL', 'num'],
    ['blk', 'BLK', 'num'], ['tpm', '3PM', 'num'], ['tov', 'TO', 'num'], ['fg_pct', 'FG%', 'num'], ['pct_owned', 'Own %', 'num']]);
  table.classList.add('fx-click');
  const rr = rows('roster').filter(r => r.team_id === tid).sort((a, b) => a.slot_order - b.slot_order), outs = rr.filter(isOut);
  [...rr.filter(r => !isOut(r)), ...outs].forEach(r => {
    if (r === outs[0]) injToggleRow(table, tbody, outs);
    const tr = document.createElement('tr'); tr.dataset.key = r.player_id; if (isOut(r)) tr.className = 'fx-injrow';
    const x = rk.get(r.player_id) || {};
    tr.append(txt('td', r.slot === 'BE' ? 'Bench' : r.slot), nameCell(r.player, r.nba_team, r.status), txt('td', r.positions), txt('td', r.nba_team),
      txt('td', r.status, r.status === 'OUT' ? 'bad' : r.status === 'DTD' ? 'warn' : 'muted'), txt('td', String(r.week_pts), 'num'), txt('td', dash0(r.last_pts), 'num'),
      lastGames(txt('td'), gamesOf(r.player_id), 5), txt('td', dash0(r.avg), 'num'), txt('td', dash0(r1(r.med5)), 'num'), txt('td', dash0(r.proj_avg), 'num'), txt('td', dash0(r.exp), 'num'),
      txt('td', x.diff_avg || '', 'num ' + tone(x.diff_avg || '')), txt('td', x.diff_total || '', 'num ' + tone(x.diff_total || '')), txt('td', String(r.games_played), 'num'),
      txt('td', String(r.games_left), 'num'), txt('td', r.next_games));
    ['min', 'min_l5', 'fpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'tov', 'fg_pct', 'pct_owned'].forEach(f => tr.append(txt('td', dash0(x[f]), 'num')));
    tbody.append(tr);
  });
  table.addEventListener('click', ev => { if (ev.target.closest('.fx-inline')) return; const tr = ev.target.closest('tbody tr[data-key]'); if (tr) openPlayer(Number(tr.dataset.key), tr); });
  host.append(table);
}

// ---------- roster view: cards or spreadsheet (remembered) ----------
let ROSTER_VIEW = (() => { try { return localStorage.getItem('fx-roster-view') === 'sheet' ? 'sheet' : 'cards'; } catch (e) { return 'cards'; } })();
function applyRosterView() {
  [['me', '#me-cards', '#me-roster'], ['tm', '#tm-cards', '#tm-roster']].forEach(([k, c, t]) => {
    $(c).hidden = ROSTER_VIEW !== 'cards'; $(t).hidden = ROSTER_VIEW !== 'sheet';
    document.querySelectorAll('[data-view-for="' + k + '"] button').forEach(b => b.setAttribute('aria-pressed', b.dataset.view === ROSTER_VIEW ? 'true' : 'false'));
  });
}
document.querySelectorAll('[data-view-for] button[data-view]').forEach(b => b.addEventListener('click', () => {
  if (ROSTER_VIEW === b.dataset.view) return;
  ROSTER_VIEW = b.dataset.view; try { localStorage.setItem('fx-roster-view', ROSTER_VIEW); } catch (e) { /* still switches */ }
  if (INLINE) { closeInline(); INLINE = null; }
  applyRosterView();
}));

function playerCards(host, tid) {
  host.replaceChildren();
  const rk = new Map(rows('rankings').map(r => [r.player_id, r]));
  const all = rows('roster').filter(r => r.team_id === tid).sort((a, b) => a.slot_order - b.slot_order);
  all.forEach(r => {
    const x = rk.get(r.player_id) || {}, [a, b] = nbaCol(r.nba_team);
    const card = txt('div', null, 'fx-pcard' + (isOut(r) ? ' inj' : '')); card.dataset.pid = r.player_id; card.setAttribute('role', 'button'); card.tabIndex = 0;
    const top = txt('div', null, 'top'); top.style.background = `linear-gradient(120deg, ${a} 0%, ${a} 58%, ${b} 100%)`;
    top.append(avatar(r.player, r.nba_team, r.status, 'lg'));
    const id = txt('div', null, 'id'); id.append(txt('div', r.player, 'n'), txt('div', [r.slot === 'BE' ? 'Bench' : r.slot, r.positions, r.nba_team].join(' · '), 's')); top.append(id);
    if (r.status !== 'Healthy') top.append(txt('span', r.status, 'badge ' + (r.status === 'OUT' ? 'out' : 'dtd')));
    card.append(top);
    const st = txt('div', null, 'stats'), stat = (label, el) => { const d = txt('div'); d.append(el, txt('span', label)); st.append(d); };
    stat('Avg', txt('b', dash0(x.avg ?? r.avg))); stat('Med 5', txt('b', dash0(r1(r.med5)))); stat('+/−', txt('b', x.diff_avg || '–', tone(x.diff_avg || ''))); stat('This wk', txt('b', String(r.week_pts)));
    card.append(st, txt('div', r.next_games ? 'Next: ' + r.next_games.split(' · ').slice(0, 2).join(' · ') : 'No games in the next 7 days', 'foot'));
    host.append(card);
  });
  const outs = all.filter(isOut);
  if (outs.length) {
    const det = txt('details', null, 'fx-injgrp'); det.open = INJ_OPEN;
    const sum = txt('summary'); sum.append(injHead(outs));
    const g = txt('div', null, 'fx-cards');
    outs.forEach(r => { const c = host.querySelector(':scope > [data-pid="' + r.player_id + '"]'); if (c) g.append(c); });
    det.append(sum, g); host.append(det);
    det.addEventListener('toggle', () => { if (det.open !== INJ_OPEN) setInj(det.open); });
  }
}

// ---------- player detail, opened in place ----------
function closeInline() { document.querySelectorAll('.fx-inline').forEach(n => n.remove()); document.querySelectorAll('.fx-open').forEach(n => n.classList.remove('fx-open')); }
function inlineAt(pid, anchor) {
  closeInline(); anchor.classList.add('fx-open');
  if (anchor.tagName === 'TR') {
    const n = [...anchor.cells].reduce((s, c) => s + (c.colSpan || 1), 0), tr = document.createElement('tr'); tr.className = 'fx-inline'; tr.dataset.inline = pid;
    const td = document.createElement('td'); td.colSpan = n; const inner = txt('div', null, 'fx-inline-in');
    const wrap = anchor.closest('.fx-tbl-wrap') || anchor.closest('table').parentElement, w = Math.max(300, (wrap && wrap.clientWidth) || 600);
    inner.style.width = (w - 4) + 'px'; td.append(inner); tr.append(td); anchor.after(tr);
    playerDetail(inner, pid, w - 30); return tr;
  }
  const grid = anchor.parentElement, top = anchor.offsetTop; let last = anchor;
  for (let s = anchor.nextElementSibling; s && s.offsetTop === top && !s.classList.contains('fx-inline'); s = s.nextElementSibling) last = s;
  const box = txt('div', null, 'fx-inline fx-inline-card'); box.dataset.inline = pid;
  const inner = txt('div', null, 'fx-inline-in'); box.append(inner); last.after(box);
  playerDetail(inner, pid, Math.max(280, (grid.clientWidth || 600) - 30)); return box;
}
function openPlayer(pid, anchor) {
  if (INLINE && INLINE.pid === pid && anchor.classList.contains('fx-open')) { closeInline(); INLINE = null; return; } // second tap closes
  INLINE = { pid, scope: (anchor.closest('[id]') || {}).id || '' };
  const box = inlineAt(pid, anchor);
  setTimeout(() => { if (box.isConnected && box.getBoundingClientRect().bottom > window.innerHeight) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 30);
}
function reopenInline() {
  if (!INLINE) return;
  const host = document.getElementById(INLINE.scope);
  const a = host && host.querySelector('tr[data-key="' + INLINE.pid + '"], tr[data-pid="' + INLINE.pid + '"], [data-pid="' + INLINE.pid + '"]');
  if (a && a.offsetParent) inlineAt(INLINE.pid, a); else INLINE = null;
}
['#me-cards', '#tm-cards'].forEach(s => {
  $(s).addEventListener('click', ev => { const c = ev.target.closest('[data-pid]'); if (c && !ev.target.closest('.fx-inline')) openPlayer(Number(c.dataset.pid), c); });
  $(s).addEventListener('keydown', ev => { if (ev.key === 'Enter') { const c = ev.target.closest('[data-pid]'); if (c && !ev.target.closest('.fx-inline')) openPlayer(Number(c.dataset.pid), c); } });
});

function playerDetail(host, pid, width) {
  host.replaceChildren();
  const r = rows('rankings').find(x => x.player_id === pid) || (() => { const p = rows('players').find(x => x.player_id === pid); return p ? { ...p, fantasy_team: teamName(p.team_id), exp: r1(val(p)), med5: med5(pid) } : null; })();
  if (!r) return;
  const band = txt('div', null, 'fx-pband'), [a, b2] = nbaCol(r.nba_team); band.style.background = `linear-gradient(110deg, ${a} 0%, ${a} 60%, ${b2} 100%)`;
  band.append(avatar(r.player, r.nba_team, r.status, 'lg'));
  const t = txt('div'); t.append(txt('div', r.player, 'n'), txt('div', [r.team_id ? r.fantasy_team : (r.fantasy_team === 'Waivers' ? 'Waivers' : 'Free agent'), r.nba_team, r.positions, r.status === 'Healthy' ? '' : r.status].filter(Boolean).join(' · '), 's'));
  band.append(t); host.append(band);
  const sl = txt('div', null, 'fx-statline');
  [['Rank', 'rank'], ['Total', 'total_pts'], ['Avg', 'avg'], ['Med 5', 'med5'], ['Proj avg', 'proj_avg'], ['Expected', 'exp'], ['+/− per game', 'diff_avg'], ['MIN', 'min'], ['MIN last 5', 'min_l5'],
    ['PTS', 'pts'], ['REB', 'reb'], ['AST', 'ast'], ['STL', 'stl'], ['BLK', 'blk'], ['3PM', 'tpm'], ['TO', 'tov'], ['FG%', 'fg_pct'], ['Own %', 'pct_owned']]
    .forEach(([l, f]) => { const v = f === 'med5' ? r1(r[f]) : r[f]; sl.append(tile(l, txt('b', v == null || v === '' ? '—' : String(v), f === 'diff_avg' ? tone(v) : ''))); });
  host.append(sl);
  const wk = txt('div', null, 'fx-wkg'); host.append(wk); weekGames(wk, r);
  host.append(txt('h4', 'Every game this season', 'fx-ct'));
  const box = txt('div', null, 'fx-chart'); host.append(box);
  const gs = rows('player_games').filter(g => g.player_id === pid).sort((a, b) => a.day - b.day);
  if (!gs.length) { box.style.minHeight = '0'; box.append(txt('div', 'No games played yet this season.', 'fx-note')); return; }
  const proj = r.proj_avg, W = Math.max(280, width || box.clientWidth), H = 220, mg = { t: 22, r: 8, b: 28, l: 36 };
  const max = Math.max(d3.max(gs, g => g.fpts), proj || 0) * 1.1 || 1;
  const x = d3.scaleBand(gs.map(g => g.day), [mg.l, W - mg.r]).paddingInner(0.3).paddingOuter(0.15), y = d3.scaleLinear([0, max], [H - mg.b, mg.t]).nice();
  const svg = d3.select(box).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H);
  svg.append('g').selectAll('line').data(y.ticks(4)).join('line').attr('x1', mg.l).attr('x2', W - mg.r).attr('y1', d => y(d)).attr('y2', d => y(d)).attr('stroke', 'var(--chart-grid)');
  svg.append('g').selectAll('text').data(y.ticks(4)).join('text').attr('x', mg.l - 6).attr('y', d => y(d)).attr('dy', '0.32em').attr('text-anchor', 'end').attr('fill', 'var(--color-fg-muted)').style('font-size', '11px').text(f0);
  const bw = Math.min(30, x.bandwidth()), bx = g => x(g.day) + (x.bandwidth() - bw) / 2, tip = txt('div', null, 'fx-tip'); box.append(tip);
  svg.append('g').selectAll('path').data(gs).join('path').attr('d', g => { const h = Math.max(1, y(0) - y(g.fpts)), rr = Math.min(4, h, bw / 2); return `M${bx(g)},${y(0)}v${-(h - rr)}q0,${-rr} ${rr},${-rr}h${bw - 2 * rr}q${rr},0 ${rr},${rr}v${h - rr}z`; })
    .attr('fill', g => (proj == null || g.fpts >= proj ? 'var(--c-accent)' : 'var(--chart-muted)'))
    .on('pointermove pointerdown', (ev, g) => { tip.replaceChildren(txt('div', dayLbl(g.day), 'd'), txt('div', 'Fantasy points: ' + g.fpts), txt('div', 'Minutes: ' + g.min)); if (proj != null) tip.append(txt('div', 'vs projection: ' + fmtDiff(g.fpts - proj))); placeTip(tip, box, ev); })
    .on('pointerleave', () => { tip.style.opacity = 0; });
  if (proj != null) {
    if (gs.length <= 24) svg.append('g').selectAll('text').data(gs).join('text').attr('x', g => bx(g) + bw / 2).attr('y', g => y(g.fpts) - 6).attr('text-anchor', 'middle')
      .attr('fill', g => (g.fpts >= proj ? 'var(--color-ok)' : 'var(--color-bad)')).style('font-size', '11px').text(g => fmtDiff(g.fpts - proj));
    svg.append('line').attr('x1', mg.l).attr('x2', W - mg.r).attr('y1', y(proj)).attr('y2', y(proj)).attr('stroke', 'var(--chart-ref)').attr('stroke-width', 1.5).attr('stroke-dasharray', '4 4').style('pointer-events', 'none');
  }
  const step = Math.ceil(gs.length / Math.max(1, Math.floor((W - mg.l) / 56)));
  svg.append('g').selectAll('text').data(gs.filter((g, i) => i % step === 0)).join('text').attr('x', g => x(g.day) + x.bandwidth() / 2).attr('y', H - 8).attr('text-anchor', 'middle').attr('fill', 'var(--color-fg-muted)').style('font-size', '11px').text(g => dayLbl(g.day));
  host.append(txt('p', 'Blue bars beat his ESPN projection (dashed line), grey bars fell short; the label is the gap.', 'fx-note'));
}
// This week's games for one player, and whether he'd make his team's best lineup each day (a free agent is tested on my team).
function weekGames(host, r) {
  host.replaceChildren();
  const m = meta(), today = m.today_day, owner = r.team_id || m.my_team_id, ownerName = owner === m.my_team_id ? 'your' : (teamName(owner) || 'his team') + "'s";
  const sched = new Map(rows('nba_schedule').filter(g => g.nba_team === r.nba_team).map(g => [g.day, g])), played = new Map(rows('player_games').filter(g => g.player_id === r.player_id).map(g => [g.day, g]));
  const mates = rows('players').filter(p => p.team_id === owner && p.player_id !== r.player_id && aw(p) > 0), me = { player_id: r.player_id, positions: r.positions, v: val(r) };
  const fits = d => bestLineup(mates.filter(p => plays(p.nba_team, d)).map(p => ({ player_id: p.player_id, positions: p.positions, v: val(p) })).concat([me])).some(p => p.player_id === r.player_id);
  let left = 0, starts = 0; const row = txt('div', null, 'fx-wkg-row');
  d3.range(m.week_start_day, m.week_end_day + 1).forEach(d => {
    const g = played.get(d), s = sched.get(d), past = d < today, cell = txt('div', null, 'fx-wkg-d' + (d === today ? ' today' : '') + (!g && !s ? ' none' : ''));
    cell.append(txt('div', d === today ? 'Today' : dayLbl(d), 'dl'));
    if (g && (past || d === today)) { cell.append(txt('div', g.min > 0 ? g.fpts + ' pts' : 'DNP', 'op')); if (g.min > 0 && r.proj_avg) cell.append(txt('div', fmtDiff(g.fpts - r.proj_avg) + ' vs proj', 'ft ' + (g.fpts >= r.proj_avg ? 'ok' : 'bad'))); }
    else if (s && !past) { left++; cell.append(txt('div', (s.home ? 'vs ' : '@ ') + s.opp, 'op')); if (r.status === 'OUT') cell.append(txt('div', 'Out', 'ft bad')); else { const f = fits(d); if (f) starts++; cell.append(txt('div', f ? 'Starts' : 'Would sit', 'ft ' + (f ? 'ok' : 'muted'))); } }
    else cell.append(txt('div', past ? '—' : 'No game', 'op muted'));
    row.append(cell);
  });
  const who = r.team_id ? ownerName + ' best lineup' : 'your best lineup if you added him';
  host.append(txt('h4', 'Games this week · ' + dayLbl(m.week_start_day) + ' to ' + dayLbl(m.week_end_day), 'fx-wkg-h'), row,
    txt('p', left + ' game' + (left === 1 ? '' : 's') + ' left' + (r.status === 'OUT' ? '' : '; makes ' + who + ' in ' + starts + ' of them') + '.', 'fx-note'));
}

function lineupGrid(host, tid) {
  host.replaceChildren();
  const m = meta(), ps = rows('players').filter(p => p.team_id === tid).sort((a, b) => ORDER.indexOf(a.slot) - ORDER.indexOf(b.slot) || val(b) - val(a));
  const days = d3.range(m.today_day, m.today_day + 7), g = new Map(rows('nba_schedule').map(r => [r.nba_team + '|' + r.day, r]));
  const table = txt('table', null, 'fx-lineup'), hr = document.createElement('tr');
  hr.append(txt('th', 'Player'), txt('th', 'Slot'), txt('th', 'Status'));
  days.forEach(d => { const th = txt('th', d === m.today_day ? 'Today' : dayLbl(d), 'num' + (d === m.today_day ? ' today' : '')); if (d === m.week_end_day + 1) th.style.borderLeft = '3px solid var(--color-fg-muted)'; hr.append(th); });
  table.createTHead().append(hr);
  const tb = table.createTBody(), counts = days.map(() => 0), projDay = days.map(() => []), outPs = ps.filter(isOut);
  [...ps.filter(p => !isOut(p)), ...outPs].forEach(p => {
    const out = isOut(p);
    if (p === outPs[0]) injToggleRow(table, tb, outPs);
    const tr = document.createElement('tr'); if (out) tr.className = 'out fx-injrow';
    tr.append(nameCell(p.player, p.nba_team, p.status), txt('td', p.slot === 'BE' ? 'Bench' : p.slot), txt('td', p.status === 'Healthy' ? '' : p.status, 'st ' + (p.status === 'OUT' ? 'bad' : p.status === 'DTD' ? 'warn' : '')));
    days.forEach((d, i) => {
      const gm = g.get(p.nba_team + '|' + d);
      if (gm && !out) { counts[i]++; projDay[i].push({ positions: p.positions, v: val(p) * aw(p) }); }
      const td = txt('td', gm ? (gm.home ? 'vs ' : '@') + gm.opp : '·', 'g ' + (gm ? 'has' : 'none') + (d === m.today_day ? ' today' : '')); if (d === m.week_end_day + 1) td.style.borderLeft = '3px solid var(--color-fg-muted)'; tr.append(td);
    });
    tb.append(tr);
  });
  const tf = table.createTFoot(), fr = document.createElement('tr'), sr = document.createElement('tr'), pr = document.createElement('tr');
  fr.append(txt('td', 'Healthy players with a game'), txt('td', ''), txt('td', ''));
  sr.append(txt('td', 'Starts (of 10)'), txt('td', ''), txt('td', ''));
  pr.append(txt('td', 'Projected points'), txt('td', ''), txt('td', ''));
  days.forEach((d, i) => {
    const c = counts[i], s = bestLineup(projDay[i]).length, nb = d === m.week_end_day + 1 ? '3px solid var(--color-fg-muted)' : '';
    const a1 = txt('td', String(c), 'g ' + (c > 10 ? 'warn' : c < 10 ? 'bad' : 'ok') + (d === m.today_day ? ' today' : '')), a2 = txt('td', String(s), 'g ' + (s < 10 ? 'bad' : '') + (d === m.today_day ? ' today' : '')), a3 = txt('td', String(Math.round(lineupSum(projDay[i])) || '–'), 'g' + (d === m.today_day ? ' today' : ''));
    [a1, a2, a3].forEach(c2 => { c2.style.borderLeft = nb; }); fr.append(a1); sr.append(a2); pr.append(a3);
  });
  tf.append(fr, sr, pr);
  host.append(table, txt('p', 'Above 10 healthy players means someone sits; "Starts" is how many of the 10 slots can be filled by position. Projected points = the best legal lineup that day by expected points (day-to-day players at 75%). The thick line marks the start of next week.', 'fx-note'));
}

function schedTable(host, tid) {
  host.replaceChildren();
  const cur = meta().week, { table, tbody } = makeTable([['week', 'Wk', 'num'], ['dates', 'Dates'], ['opp', 'Opponent'], ['opp_points_for', 'Opp. points', 'num'], ['result', 'Result']]);
  rows('season_sched').filter(r => r.team_id === tid).sort((a, b) => a.week - b.week).forEach(r => {
    const tr = document.createElement('tr'); tr.dataset.key = r.row_id; if (r.week === cur) tr.className = 'me';
    const res = txt('td'); if (r.res) { res.append(txt('span', r.res === 'live' ? 'Live' : r.res, 'fx-res ' + r.res), txt('span', ' ' + r.score, 'fx-note-i')); }
    tr.append(txt('td', String(r.week), 'num'), txt('td', r.dates), teamCell(r.opp, r.opp_id), txt('td', f0(r.opp_points_for), 'num'), res);
    tbody.append(tr);
  });
  host.append(table);
}
function movesTable(host, filterFn) {
  host.replaceChildren();
  const list = rows('moves').filter(filterFn);
  if (!list.length) { host.append(txt('p', 'No moves yet.', 'fx-note')); return; }
  const { table, tbody } = makeTable([['when', 'When'], ['kind', 'Type'], ['teams', 'Team(s)'], ['details', 'Details']]);
  list.forEach(r => {
    const tr = document.createElement('tr'); tr.dataset.key = r.event;
    const det = txt('td', r.details); det.style.whiteSpace = 'normal'; det.style.minWidth = '14rem';
    const tm = txt('td'); r.team_ids.forEach((id, i) => { if (i) tm.append(' ↔ '); tm.append(teamDot(id), txt('span', teamName(id) || '?')); });
    tr.append(txt('td', r.when), txt('td', r.kind, r.kind === 'Trade' ? 'ok' : ''), tm, det);
    tbody.append(tr);
  });
  host.append(table);
}

// Matchup panel: both sides' numbers, points by day (tap a day for who scored), running total.
function matchPanel(host, mu, dayParam, opts = {}) {
  host.replaceChildren();
  if (!mu) { host.append(txt('p', 'No matchup this week.', 'fx-note')); return; }
  const m = meta(), focus = opts.focus ?? MY(), flip = mu.opp_id === focus;
  const ids = flip ? [mu.opp_id, mu.team_id] : [mu.team_id, mu.opp_id], names = ids.map(teamName), cols = pairCols(ids[0], ids[1]);
  const wb = id => rows('week_board').find(r => r.team_id === id) || {};
  const days = d3.range(m.week_start_day, m.week_end_day + 1), val2 = new Map(rows('daily').map(r => [r.team_id + '|' + r.day, r]));
  const pd = P()[dayParam], selDay = pd != null && days.includes(Number(pd)) && Number(pd) <= m.today_day ? Number(pd) : null;
  if (opts.title !== false) host.append(txt('h3', names[0] + ' vs ' + names[1], 'fx-ct'));
  const sides = txt('div', null, 'fx-mstats');
  ids.forEach((tid, side) => {
    const w = wb(tid), box = txt('div', null, 'side'), h = txt('h4', null, 'fx-mdh'), sw = document.createElement('i'); sw.style.background = cols[side]; h.append(sw, names[side]); box.append(h);
    const tiles = txt('div', null, 'tiles');
    tiles.append(tile('Score', txt('b', f0(w.pts ?? 0))), tile('Projected final', txt('b', f0(w.proj_final ?? 0))), tile('Win chance', txt('b', pct(w.win))), tile('Starts left', txt('b', String(w.starts_left ?? 0))));
    const tpr = rows('team_power').find(r => r.team_id === tid); if (tpr) tiles.append(tile('vs projection (wk)', txt('b', tpr.vs_proj, tone(tpr.vs_proj))));
    const best = rows('daily').filter(r => r.team_id === tid && r.points > 0 && r.day >= m.week_start_day && r.day <= m.week_end_day).sort((a, b) => b.points - a.points)[0];
    if (best) tiles.append(tile('Best day (' + dayLbl(best.day) + ')', txt('b', f0(best.points))));
    const top = rows('roster').filter(r => r.team_id === tid).sort((a, b) => b.week_pts - a.week_pts)[0];
    if (top && top.week_pts > 0) tiles.append(tile('Top scorer: ' + top.player, txt('b', String(top.week_pts))));
    box.append(tiles); sides.append(box);
  });
  host.append(sides);
  const wp = wb(ids[0]).win ?? 0.5, prob = txt('div', null, 'fx-wp'); prob.style.margin = '0 0 4px';
  const pa = document.createElement('i'), pb = document.createElement('i'); pa.style.cssText = `width:${wp * 100}%;background:${cols[0]}`; pb.style.cssText = `width:${(1 - wp) * 100}%;background:${cols[1]}`; prob.append(pa, pb);
  host.append(prob, txt('p', names[0] + ' wins ' + pct(wp) + ' of the time, using the same projection as the projected finals.', 'fx-note'));

  const leg = txt('div', null, 'fx-legend');
  names.forEach((n, i) => { const s = txt('span', n); s.prepend(swatch(cols[i])); leg.append(s); });
  const lg2 = txt('span', 'Pale bar / dashed tick = projection'); lg2.prepend(swatch('var(--chart-muted)')); leg.append(lg2);
  host.append(txt('h4', 'Points by day', 'fx-ct'), txt('p', 'Tap a day to see who scored; tap it again or press Esc to clear.', 'fx-note'), leg);
  const box = txt('div', null, 'fx-chart fx-daychart'); host.append(box);
  const pjm = new Map(rows('proj_daily').map(r => [r.team_id + '|' + r.day, r.proj]));
  const W = Math.max(280, box.clientWidth || host.clientWidth - 40), H = 240, mg = { t: 8, r: 8, b: 28, l: 38 };
  const max = Math.max(d3.max(rows('daily').filter(r => ids.includes(r.team_id) && r.day >= m.week_start_day && r.day <= m.week_end_day), r => r.points) || 1, d3.max(rows('proj_daily').filter(r => ids.includes(r.team_id)), r => r.proj) || 0);
  const x = d3.scaleBand(days, [mg.l, W - mg.r]).paddingInner(0.25).paddingOuter(0.1), xi = d3.scaleBand([0, 1], [0, x.bandwidth()]).padding(0.08), y = d3.scaleLinear([0, max], [H - mg.b, mg.t]).nice();
  const svg = d3.select(box).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H);
  svg.append('g').selectAll('line').data(y.ticks(4)).join('line').attr('x1', mg.l).attr('x2', W - mg.r).attr('y1', d => y(d)).attr('y2', d => y(d)).attr('stroke', 'var(--chart-grid)');
  svg.append('g').selectAll('text').data(y.ticks(4)).join('text').attr('x', mg.l - 6).attr('y', d => y(d)).attr('dy', '0.32em').attr('text-anchor', 'end').attr('fill', 'var(--color-fg-muted)').style('font-size', '11px').text(f0);
  const short = W < 480;
  svg.append('g').selectAll('text').data(days).join('text').attr('x', d => x(d) + x.bandwidth() / 2).attr('y', H - 8).attr('text-anchor', 'middle')
    .attr('fill', d => (d === m.today_day || d === selDay ? 'var(--color-fg)' : 'var(--color-fg-muted)')).style('font-size', '11px').style('font-weight', d => (d === selDay ? 600 : 400))
    .text(d => (d === m.today_day ? 'Today' : short ? dayLbl(d).split(' ')[0] : dayLbl(d)));
  const tip = txt('div', null, 'fx-tip'); box.append(tip);
  const bw = Math.min(30, xi.bandwidth()), bars = [], ghosts = [];
  days.forEach(d => ids.forEach((tid, i) => { const r = val2.get(tid + '|' + d); if (r && (d < m.today_day || r.points > 0) && d <= m.today_day) bars.push({ d, i, r }); const p = pjm.get(tid + '|' + d); if (p) ghosts.push({ d, i, p }); }));
  const gx = g => x(g.d) + xi(g.i) + (xi.bandwidth() - bw) / 2;
  const rtop = (x0, y0, w, h) => { const rr = Math.min(4, h, w / 2); return `M${x0},${y0 + h}v${-(h - rr)}q0,${-rr} ${rr},${-rr}h${w - 2 * rr}q${rr},0 ${rr},${rr}v${h - rr}z`; };
  svg.append('g').selectAll('path').data(ghosts).join('path').attr('d', g => rtop(gx(g), y(g.p), bw, Math.max(1, y(0) - y(g.p)))).attr('fill', g => cols[g.i]).attr('opacity', g => (selDay != null && g.d !== selDay ? 0.07 : 0.22)).style('pointer-events', 'none');
  svg.append('g').selectAll('path').data(bars).join('path').attr('d', b => rtop(gx(b), y(b.r.points), bw, Math.max(1, y(0) - y(b.r.points)))).attr('fill', b => cols[b.i]).attr('opacity', b => (selDay != null && b.d !== selDay ? 0.35 : 1)).style('pointer-events', 'none');
  const ty = g => Math.round(y(g.p)) + 0.5, tickOp = g => (selDay != null && g.d !== selDay ? 0.3 : 1), tg = svg.append('g').style('pointer-events', 'none');
  tg.selectAll('line.h').data(ghosts).join('line').attr('class', 'h').attr('x1', g => gx(g) - 3).attr('x2', g => gx(g) + bw + 3).attr('y1', ty).attr('y2', ty).attr('stroke', 'var(--color-panel)').attr('stroke-width', 3).attr('stroke-opacity', 0.55).attr('opacity', tickOp);
  tg.selectAll('line.t').data(ghosts).join('line').attr('class', 't').attr('x1', g => gx(g) - 3).attr('x2', g => gx(g) + bw + 3).attr('y1', ty).attr('y2', ty).attr('stroke', g => d3.color(cols[g.i]).darker(0.6)).attr('stroke-width', 1.5).attr('stroke-dasharray', '3 2').attr('opacity', tickOp);
  // one hit area per day: hover shows both teams, tap selects the day
  svg.append('g').selectAll('rect').data(days).join('rect').attr('x', d => x(d) - x.step() * x.paddingInner() / 2).attr('width', x.step()).attr('y', mg.t).attr('height', H - mg.b - mg.t).attr('fill', 'transparent').style('cursor', d => (d <= m.today_day ? 'pointer' : 'default'))
    .on('pointermove', (ev, d) => {
      tip.replaceChildren(txt('div', (d === m.today_day ? 'Today' : dayLbl(d)) + (d <= m.today_day ? ' · tap for players' : ' · projected'), 'd'));
      ids.forEach((t, j) => { const a = (val2.get(t + '|' + d) || {}).points ?? 0, p = pjm.get(t + '|' + d); const l = txt('div', names[j] + ': ' + (d > m.today_day ? (p ? 'proj ' + f0(p) : 'no games') : f0(a) + (p ? ' (proj ' + f0(p) + ', ' + fmtDiff(a - p) + ')' : ''))); l.prepend(swatch(cols[j])); tip.append(l); });
      placeTip(tip, box, ev);
    })
    .on('pointerleave', () => { tip.style.opacity = 0; })
    .on('click', (ev, d) => { if (d <= m.today_day) setParams({ [dayParam]: selDay === d ? null : d }); });

  cumChart(host, ids, names, cols, days, val2, m);

  if (selDay == null) return;
  host.append(txt('h4', dayLbl(selDay) + ': who scored', 'fx-ct'), txt('p', 'Starters first (only their points count), then bench and IR in grey. +/− is the game minus ESPN\'s projected points per game; DNP means he didn\'t play. Each player counts for the team he was on that day.', 'fx-note'));
  const grid = txt('div', null, 'fx-mstats');
  ids.forEach((tid, side) => {
    const col = txt('div'), h = txt('h4', null, 'fx-mdh'), sw = document.createElement('i'); sw.style.background = cols[side];
    const tot = (val2.get(tid + '|' + selDay) || {}).points; h.append(sw, names[side] + (tot != null ? ' · ' + tot + ' pts' : '')); col.append(h);
    const list = rows('day_scores').filter(r => r.team_id === tid && r.day === selDay).sort((a, b) => (b.counted - a.counted) || (b.pts - a.pts));
    const { table, tbody } = makeTable([['player', 'Player'], ['slot', 'Slot'], ['pts', 'Pts', 'num'], ['proj_avg', 'Proj', 'num'], ['diff', '+/−', 'num']]);
    list.forEach(r => { const tr = document.createElement('tr'); if (!r.counted) tr.className = 'bench'; const pi = PINFO().get(r.player_id) || {};
      tr.append(nameCell(r.player, pi.nba_team, pi.status), txt('td', r.slot), txt('td', String(r.pts), 'num'), txt('td', dash0(r.proj_avg), 'num'), txt('td', r.diff, 'num ' + tone(r.diff))); tbody.append(tr); });
    const stt = list.filter(r => r.counted && r.diff !== 'DNP' && r.proj_avg != null);
    if (stt.length) { const pts = d3.sum(stt, r => r.pts), proj = r1(d3.sum(stt, r => r.proj_avg)), diff = pts - proj, tr = document.createElement('tr'); tr.className = 'total';
      tr.append(txt('td', 'Starters total'), txt('td', stt.length + ' played'), txt('td', String(pts), 'num'), txt('td', String(proj), 'num'), txt('td', fmtDiff(diff), 'num ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : ''))); table.createTFoot().append(tr); }
    if (!list.length) col.append(txt('p', 'No player detail for that day (it covers the last two weeks).', 'fx-note')); else { const w = txt('div', null, 'fx-tbl-wrap'); w.append(table); col.append(w); }
    grid.append(col);
  });
  host.append(grid);
}
function cumChart(host, ids, names, cols, days, val2, m) {
  host.append(txt('h4', 'Running total', 'fx-ct'), txt('p', 'Each team\'s actual points so far, day by day.', 'fx-note'));
  const box = txt('div', null, 'fx-chart'); host.append(box);
  const played = days.filter(d => d < m.today_day || (d === m.today_day && ids.some(t => ((val2.get(t + '|' + d) || {}).points || 0) > 0)));
  const series = ids.map((tid, i) => { let run = 0; const act = [{ d: days[0] - 1, v: 0 }]; played.forEach(d => { run += (val2.get(tid + '|' + d) || {}).points || 0; act.push({ d, v: run }); }); return { i, act, total: run }; });
  const W = Math.max(280, box.clientWidth || host.clientWidth - 40), H = 220, mg = { t: 12, r: 50, b: 28, l: 44 };
  const x = d3.scalePoint([days[0] - 1, ...days], [mg.l, W - mg.r]), y = d3.scaleLinear([0, d3.max(series, s => s.total) || 1], [H - mg.b, mg.t]).nice();
  const svg = d3.select(box).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H);
  svg.append('g').selectAll('line').data(y.ticks(4)).join('line').attr('x1', mg.l).attr('x2', W - mg.r).attr('y1', d => y(d)).attr('y2', d => y(d)).attr('stroke', 'var(--chart-grid)');
  svg.append('g').selectAll('text').data(y.ticks(4)).join('text').attr('x', mg.l - 6).attr('y', d => y(d)).attr('dy', '0.32em').attr('text-anchor', 'end').attr('fill', 'var(--color-fg-muted)').style('font-size', '11px').text(f0);
  svg.append('g').selectAll('text').data(days).join('text').attr('x', d => x(d)).attr('y', H - 8).attr('text-anchor', 'middle').attr('fill', d => (d === m.today_day ? 'var(--color-fg)' : 'var(--color-fg-muted)')).style('font-size', '11px').text(d => (d === m.today_day ? 'Today' : dayLbl(d).split(' ')[0]));
  const line = d3.line().x(p => x(p.d)).y(p => y(p.v));
  series.forEach(s => {
    svg.append('path').attr('d', line(s.act)).attr('fill', 'none').attr('stroke', cols[s.i]).attr('stroke-width', 2.5).attr('stroke-linejoin', 'round');
    svg.append('g').selectAll('circle').data(s.act.slice(1)).join('circle').attr('cx', p => x(p.d)).attr('cy', p => y(p.v)).attr('r', 3.5).attr('fill', cols[s.i]).attr('stroke', 'var(--color-panel)').attr('stroke-width', 1.5);
    const last = s.act[s.act.length - 1]; s.lx = x(last.d); s.ly = y(last.v);
  });
  const lab = series.map(s => ({ s, y: s.ly })).sort((a, b) => a.y - b.y);
  if (lab.length === 2 && lab[1].y - lab[0].y < 14) { const mid = (lab[0].y + lab[1].y) / 2; lab[0].y = mid - 7; lab[1].y = mid + 7; }
  lab.forEach(l => svg.append('text').attr('x', l.s.lx + 6).attr('y', l.y).attr('dy', '0.32em').attr('fill', cols[l.s.i]).style('font-size', '12px').style('font-weight', 600).text(f0(l.s.total)));
  const tip = txt('div', null, 'fx-tip'); box.append(tip);
  const cross = svg.append('line').attr('y1', mg.t).attr('y2', H - mg.b).attr('stroke', 'var(--chart-muted)').attr('visibility', 'hidden');
  svg.append('g').selectAll('rect').data(played).join('rect').attr('x', d => x(d) - x.step() / 2).attr('width', x.step()).attr('y', mg.t).attr('height', H - mg.b - mg.t).attr('fill', 'transparent')
    .on('pointermove pointerdown', (ev, d) => {
      const a = series.map(s => (s.act.find(p => p.d === d) || {}).v || 0);
      tip.replaceChildren(txt('div', dayLbl(d) + ' · total so far', 'd'));
      series.forEach((s, j) => { const l = txt('div', names[j] + ': ' + f0(a[j])); l.prepend(swatch(cols[j])); tip.append(l); });
      const gap = a[0] - a[1]; tip.append(txt('div', gap === 0 ? 'Tied' : names[gap > 0 ? 0 : 1] + ' by ' + f0(Math.abs(gap)), 'd'));
      cross.attr('x1', x(d)).attr('x2', x(d)).attr('visibility', 'visible'); placeTip(tip, box, ev);
    })
    .on('pointerleave', () => { tip.style.opacity = 0; cross.attr('visibility', 'hidden'); });
}

// ---------- season trend ----------
function seasonTrend(host, tid) {
  host.replaceChildren();
  const cur = meta().week, all = rows('matchups').filter(r => r.week >= 1 && r.week <= cur && r.opp_id != null);
  const weeks = [...new Set(all.map(r => r.week))].sort((a, b) => a - b);
  if (!weeks.length) { host.append(txt('p', 'No weeks played yet.', 'fx-note')); return; }
  const done = w => w < cur, nTeams = new Set(all.map(r => r.team_id)).size;
  const mine = weeks.map(w => {
    const wk = all.filter(x => x.week === w), r = wk.find(x => x.team_id === tid) || {}, pts = wk.map(x => x.pts);
    const beat = pts.filter(p => p < r.pts).length, tie = pts.filter(p => p === r.pts).length - 1, res = r.pts > r.opp_pts ? 'W' : r.pts < r.opp_pts ? 'L' : 'T';
    return { w, pts: r.pts || 0, opp: r.opp_pts || 0, opp_id: r.opp_id, done: done(w), avg: d3.mean(pts), lo: d3.min(pts), hi: d3.max(pts), rank: 1 + pts.filter(p => p > r.pts).length, n: pts.length, beat, lost: pts.length - 1 - beat - tie, res };
  });
  const fin = mine.filter(d => d.done), live = mine.find(d => !d.done), sgn = v => (v > 0 ? '+' : v < 0 ? '−' : '±') + f0(Math.abs(Math.round(v)));
  const resWord = d => (d.done ? { W: 'Won', L: 'Lost', T: 'Tied' }[d.res] : { W: 'Leading', L: 'Trailing', T: 'Tied' }[d.res]);
  const wins = fin.filter(d => d.res === 'W').length, losses = fin.filter(d => d.res === 'L').length, apW = d3.sum(fin, d => d.beat), apL = d3.sum(fin, d => d.lost), luck = wins - d3.sum(fin, d => d.beat / (d.n - 1));
  const leagueAvg = key => { const mm = new Map(); all.filter(r => done(r.week)).forEach(r => mm.set(r.team_id, [...(mm.get(r.team_id) || []), r[key]])); return [...mm].map(([t, a]) => [t, d3.mean(a)]).sort((p, q) => q[1] - p[1]); };
  const rk = key => leagueAvg(key).findIndex(([t]) => t === tid) + 1;
  let streak = ''; for (let i = fin.length - 1; i >= 0; i--) { if (!streak || fin[i].res === streak[0]) streak += fin[i].res; else break; }
  const best = fin.length ? fin.reduce((a, b) => (b.pts > a.pts ? b : a)) : null, worst = fin.length ? fin.reduce((a, b) => (b.pts < a.pts ? b : a)) : null;
  const tiles = txt('div', null, 'fx-tr-tiles');
  const tileT = (label, v, sub, cls, title) => { const d = txt('div', null, 'fx-tr-tile'); if (title) d.title = title; d.append(txt('span', label, 'l'), txt('b', v, cls || ''), txt('span', sub || '', 'd')); tiles.append(d); };
  if (live) tileT('This week', f0(live.pts) + '–' + f0(live.opp), resWord(live) + ' vs ' + teamName(live.opp_id), live.res === 'W' ? 'up' : live.res === 'L' ? 'down' : '');
  if (fin.length) {
    tileT('Record', wins + '–' + losses, streak ? 'Streak ' + streak.length + streak[0] : '', '', 'Finished weeks only');
    tileT('Points / week', f0(Math.round(d3.mean(fin, d => d.pts))), '#' + rk('pts') + ' of ' + nTeams);
    tileT('Against / week', f0(Math.round(d3.mean(fin, d => d.opp))), '#' + rk('opp_pts') + ' most faced', '', 'How much opponents scored. #1 = toughest schedule so far');
    tileT('All-play', apW + '–' + apL, 'Luck ' + (luck >= 0 ? '+' : '−') + Math.abs(luck).toFixed(1) + ' wins', '', 'Record vs every team every week. Luck = real wins minus that');
    tileT('Best week', f0(best.pts), 'Week ' + best.w);
    if (fin.length > 1) tileT('Worst week', f0(worst.pts), 'Week ' + worst.w);
  }
  host.append(tiles);
  const head = txt('div', null, 'fx-tr-head'); head.append(txt('h3', 'Points per week', 'fx-ct'));
  const leg = txt('div', null, 'fx-legend'), col = ftCol(tid);
  const sw = (css, label) => { const s = txt('span'); const i = document.createElement('i'); i.style.cssText = css; s.append(i, label); leg.append(s); };
  sw(`background:${col};height:3px;width:16px;border-radius:2px`, teamName(tid)); sw('border-top:2px dashed var(--color-fg-muted);width:16px', 'League avg'); sw('background:var(--chart-grid);width:14px;height:10px;border-radius:2px', 'League range');
  sw('width:10px;height:10px;border-radius:50%;background:var(--color-ok)', 'Win'); sw('width:10px;height:10px;border-radius:50%;background:var(--color-bad)', 'Loss');
  if (live) sw(`width:8px;height:8px;border-radius:50%;border:2px solid ${col};background:var(--color-panel)`, 'This week so far');
  head.append(leg); host.append(head);
  const box = txt('div', null, 'fx-chart fx-trend'); host.append(box);
  const W = Math.max(300, box.clientWidth || host.clientWidth - 40), H = 240, mg = { t: 24, r: 16, b: 28, l: 44 };
  const pad = Math.min(60, (W - mg.l - mg.r) / (weeks.length * 2)), x = d3.scalePoint(weeks, [mg.l + pad, W - mg.r - pad]);
  const hi = d3.max(mine, d => Math.max(d.hi, d.pts)), lo = d3.min(mine, d => Math.min(d.lo, d.pts)), y = d3.scaleLinear([Math.max(0, lo - (hi - lo) * 0.15 - 40), hi + (hi - lo) * 0.1 + 40], [H - mg.b, mg.t]).nice(4);
  const svg = d3.select(box).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H).attr('role', 'img').attr('aria-label', 'Points per week for ' + teamName(tid));
  const cap = sel => sel.attr('fill', 'var(--color-fg-muted)').style('font-size', '11px');
  svg.append('g').selectAll('line').data(y.ticks(4)).join('line').attr('x1', mg.l).attr('x2', W - mg.r).attr('y1', d => y(d)).attr('y2', d => y(d)).attr('stroke', 'var(--chart-grid)');
  cap(svg.append('g').selectAll('text').data(y.ticks(4)).join('text').attr('x', mg.l - 8).attr('y', d => y(d)).attr('dy', '0.32em').attr('text-anchor', 'end').text(f0));
  cap(svg.append('g').selectAll('text').data(weeks).join('text').attr('x', w => x(w)).attr('y', H - 8).attr('text-anchor', 'middle').text(w => 'Week ' + w));
  if (weeks.length > 1) svg.append('path').attr('d', d3.area().x(d => x(d.w)).y0(d => y(d.lo)).y1(d => y(d.hi))(mine)).attr('fill', 'var(--chart-grid)').attr('opacity', 0.8);
  const line = d3.line().x(d => x(d.w)).y(d => y(d.v));
  svg.append('path').attr('d', line(mine.map(d => ({ w: d.w, v: d.avg })))).attr('fill', 'none').attr('stroke', 'var(--color-fg-muted)').attr('stroke-width', 1.5).attr('stroke-dasharray', '4 4');
  const lastDone = fin[fin.length - 1];
  if (fin.length > 1) svg.append('path').attr('d', line(fin.map(d => ({ w: d.w, v: d.pts })))).attr('fill', 'none').attr('stroke', col).attr('stroke-width', 2.5);
  if (live && lastDone) svg.append('path').attr('d', line([{ w: lastDone.w, v: lastDone.pts }, { w: live.w, v: live.pts }])).attr('fill', 'none').attr('stroke', col).attr('stroke-width', 2).attr('stroke-dasharray', '3 4').attr('opacity', 0.8);
  svg.append('g').selectAll('circle').data(mine).join('circle').attr('cx', d => x(d.w)).attr('cy', d => y(d.pts)).attr('r', d => (d.done ? 6 : 5))
    .attr('fill', d => (!d.done ? 'var(--color-panel)' : d.res === 'W' ? 'var(--color-ok)' : d.res === 'L' ? 'var(--color-bad)' : 'var(--color-fg-muted)')).attr('stroke', d => (d.done ? 'var(--color-panel)' : col)).attr('stroke-width', 2);
  svg.append('g').selectAll('text').data(mine).join('text').attr('x', d => x(d.w)).attr('y', d => y(d.pts) - 12).attr('text-anchor', 'middle').attr('fill', 'var(--color-fg)').style('font-size', '11.5px').style('font-weight', 600).text(d => f0(d.pts));
  const tip = txt('div', null, 'fx-tip'); box.append(tip);
  const step = weeks.length > 1 ? x.step() : W;
  svg.append('g').selectAll('rect').data(mine).join('rect').attr('x', d => x(d.w) - step / 2).attr('width', step).attr('y', 0).attr('height', H).attr('fill', 'transparent')
    .on('pointermove pointerdown', (ev, d) => { tip.replaceChildren(txt('div', 'Week ' + d.w + ' vs ' + teamName(d.opp_id) + (d.done ? '' : ' · so far'), 'd'), txt('div', f0(d.pts) + '–' + f0(d.opp) + ' · ' + resWord(d) + ' by ' + f0(Math.abs(Math.round(d.pts - d.opp)))), txt('div', '#' + d.rank + ' of ' + d.n + ' · league avg ' + f0(Math.round(d.avg)) + ' (' + sgn(d.pts - d.avg) + ')', 'd')); placeTip(tip, box, ev); })
    .on('pointerleave', () => { tip.style.opacity = 0; });
  host.append(txt('h3', 'Week by week', 'fx-ct'));
  const { table, tbody } = makeTable([['week', 'Wk', 'num'], ['opp', 'Opponent'], ['score', 'Score', 'num'], ['res', 'Result'], ['rank', 'Rank', 'num'], ['allplay', 'All-play', 'num'], ['vsavg', 'vs avg', 'num']]);
  table.classList.add('fx-tr-tbl');
  mine.slice().reverse().forEach(d => {
    const tr = document.createElement('tr'), rtd = txt('td'); rtd.append(txt('span', d.done ? d.res : 'Live', 'fx-res ' + (d.done ? d.res : 'live')), txt('span', ' ' + sgn(d.pts - d.opp), 'fx-note-i'));
    tr.append(txt('td', String(d.w), 'num'), teamCell(teamName(d.opp_id), d.opp_id), txt('td', f0(d.pts) + '–' + f0(d.opp), 'num'), rtd, txt('td', d.rank + '/' + d.n, 'num'), txt('td', d.beat + '–' + d.lost, 'num'), txt('td', sgn(d.pts - d.avg), 'num ' + (d.pts > d.avg ? 'up' : d.pts < d.avg ? 'down' : '')));
    tbody.append(tr);
  });
  const wrap = txt('div', null, 'fx-tbl-wrap'); wrap.append(table); host.append(wrap);
  host.append(txt('p', 'All-play = record if this team played all ' + (nTeams - 1) + ' others every week. This week is in progress and not counted in the tiles.', 'fx-note'));
}

// ---------- MY TEAM ----------
function drawMe() {
  const tid = MY();
  irAlert($('#me-alert')); heroFor($('#me-hero'), tid);
  matchPanel($('#me-match'), rows('week_board').find(r => r.team_id === tid), 'myday', { title: false });
  playerCards($('#me-cards'), tid); rosterTable($('#me-roster'), tid); lineupGrid($('#me-lineup'), tid); seasonTrend($('#me-trend'), tid); schedTable($('#me-sched'), tid);
  movesTable($('#me-moves'), r => r.team_ids.includes(tid));
}

// ---------- THIS WEEK ----------
function curMatch() { const mm = P().match; if (mm != null) return Number(mm); const r = rows('week_board').find(x => x.home && (x.team_id === MY() || x.opp_id === MY())); return r ? r.team_id : null; }
$('#board').addEventListener('click', ev => { const c = ev.target.closest('[data-match]'); if (c) { setParams({ match: Number(c.dataset.match), mday: null }); $('#wk-match-h').scrollIntoView({ behavior: 'smooth', block: 'start' }); } });
$('#board').addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { const c = ev.target.closest('[data-match]'); if (c) { ev.preventDefault(); setParams({ match: Number(c.dataset.match), mday: null }); } } });
function powerTable(host, cols, sortKey, asc) {
  host.replaceChildren();
  const { table, tbody } = makeTable(cols), my = MY();
  rows('team_power').slice().sort((a, b) => (asc ? a[sortKey] - b[sortKey] : b[sortKey] - a[sortKey])).forEach(r => {
    const tr = document.createElement('tr'); if (r.team_id === my) tr.className = 'me';
    cols.forEach(([f, , cls, , fmt]) => {
      if (f === 'team') { tr.append(teamCell(r.team, r.team_id)); return; }
      if (f === 'opp') { tr.append(r.opp_id ? teamCell(r.opp, r.opp_id) : txt('td', '')); return; }
      let c = cls || ''; if (f === 'status') c += r.status === 'Leading' ? ' ok' : r.status === 'Trailing' ? ' bad' : '';
      if (['vs_proj', 'vs_full', 'luck_season'].includes(f)) c += ' ' + tone(r[f]);
      if (f === 'sched_luck') c += r[f] > 0.05 ? ' up' : r[f] < -0.05 ? ' down' : '';
      const v = fmt ? fmt(r[f], r) : r[f]; tr.append(txt('td', v == null ? '' : String(v), c));
    });
    tbody.append(tr);
  });
  host.append(table);
}
function drawWeek() {
  const m = meta(), my = MY(), sel = curMatch();
  $('#wk-intro').textContent = 'Week ' + m.week + ' (' + dayLbl(m.week_start_day) + ' to ' + dayLbl(m.week_end_day) + '): every matchup, how each team is doing, and the games left.';
  const box = $('#board'); box.replaceChildren();
  rows('week_board').filter(r => r.home).sort((a, b) => (b.team_id === my || b.opp_id === my) - (a.team_id === my || a.opp_id === my)).forEach(r => {
    const card = txt('div', null, 'fx-card' + (r.team_id === my || r.opp_id === my ? ' mine' : '') + (r.team_id === sel || r.opp_id === sel ? ' sel' : ''));
    card.dataset.match = r.team_id; card.setAttribute('role', 'button'); card.tabIndex = 0;
    const g = txt('div', null, 'fx-match'), leader = r.pts === r.opp_pts ? 0 : (r.pts > r.opp_pts ? r.team_id : r.opp_id), cols = pairCols(r.team_id, r.opp_id);
    [[r.team, r.team_id, 'pts'], [r.opp, r.opp_id, 'opp_pts']].forEach(([nm, tid, f]) => {
      const d = txt('div', null, 'nm' + (tid === my ? ' me' : '')), dot = teamDot(tid); dot.style.background = cols[tid === r.team_id ? 0 : 1]; d.append(dot, txt('span', nm)); g.append(d);
      const sc = txt('div', f0(r[f]), 'sc'); if (leader && leader !== tid) sc.style.color = 'var(--color-fg-muted)'; g.append(sc);
    });
    const wp = txt('div', null, 'fx-wp'), a = document.createElement('i'), b = document.createElement('i');
    a.style.cssText = `width:${r.win * 100}%;background:${cols[0]}`; b.style.cssText = `width:${(1 - r.win) * 100}%;background:${cols[1]}`; wp.append(a, b);
    g.append(wp, txt('div', 'Projected ' + f0(r.proj_final) + '–' + f0(r.opp_proj_final) + ' · ' + (r.win >= 0.5 ? teamAbbr(r.team_id) + ' ' + pct(r.win) : teamAbbr(r.opp_id) + ' ' + pct(1 - r.win)), 'pj'));
    card.append(g); box.append(card);
  });
  matchPanel($('#lg-match'), rows('week_board').find(r => (r.team_id === sel || r.opp_id === sel) && r.home), 'mday', { focus: MY() });
  powerTable($('#power-week'), [['week_rank', '#', 'num'], ['team', 'Team'], ['week_pts', 'Pts', 'num', '', f0], ['vs_proj', '+/− vs proj', 'num'], ['vs_full', 'vs full strength', 'num'], ['week_proj', 'Proj final', 'num', '', f0], ['win', 'Win %', 'num', '', pct], ['status', 'vs opponent'], ['opp', 'Opponent']], 'week_rank', true);
  const gc = $('#gamecount'); gc.replaceChildren();
  const { table, tbody } = makeTable([['team', 'Team'], ['this_starts', 'Starts left this wk', 'num'], ['this_games', 'Games left this wk', 'num'], ['next_starts', 'Starts next wk', 'num'], ['next_games', 'Games next wk', 'num']]);
  rows('games_by_team').forEach(r => { const tr = document.createElement('tr'); if (r.team_id === my) tr.className = 'me'; tr.append(teamCell(r.team, r.team_id), txt('td', String(r.this_starts), 'num'), txt('td', String(r.this_games), 'num'), txt('td', String(r.next_starts), 'num'), txt('td', String(r.next_games), 'num')); tbody.append(tr); });
  gc.append(table);
}

// ---------- STREAMING ----------
const dayOfTime = t => Math.floor((Date.parse(t) - Date.UTC(2026, 9, 19, 4)) / 864e5);
const effDay = t => Math.floor((Date.parse(t) - Date.UTC(2026, 9, 19, 4) + 5 * 36e5) / 864e5); // moves after 7 PM Toronto count from the next day
function torontoHour() { const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' })); return { h: d.getHours(), wkend: [0, 6].includes(d.getDay()) }; }
function streamWin() { const w = P().swin; if (w === 'this' || w === 'next') return w; const m = meta(); return m.week_end_day - m.today_day >= 2 ? 'this' : 'next'; }
function countToday() { if (P().stoday != null) return P().stoday === '1'; const t = torontoHour(); return t.h < (t.wkend ? 13 : 19); }
function drawStream() {
  const m = meta(), my = MY(), pool = PINFO(), byName = new Map([...pool.values()].map(p => [p.player, p]));
  irAlert($('#st-alert'));
  const mineAll = rows('players').filter(p => p.team_id === my), mine = mineAll.filter(p => aw(p) > 0);
  const tp = rows('team_power').find(r => r.team_id === my) || {}, adds = tp.adds_used ?? 0, centers = mineAll.filter(p => p.slot !== 'IR' && p.positions.split(',').includes('C')).length;
  const sd = rows('stream_days'), today = countToday();
  const st = $('#st-status'); st.replaceChildren(); st.style.setProperty('--team', ftCol(my)); st.classList.add('fx-banded');
  const tiles = txt('div', null, 'tiles');
  tiles.append(tile('Adds used this week', txt('b', adds + ' / ' + ADD_LIMIT)), tile('Adds left', txt('b', String(ADD_LIMIT - adds), ADD_LIMIT - adds <= 1 ? 'down' : '')),
    tile('Centers (IR not counted)', txt('b', centers + ' / ' + CENTER_MAX, centers >= CENTER_MAX ? 'down' : '')), tile('Roster spots', txt('b', mineAll.filter(p => p.slot !== 'IR').length + ' / ' + ROSTER_MAX)),
    tile('Empty starts left this week', txt('b', String(d3.sum(sd.filter(r => r.week === 'this' && (r.day > m.today_day || today)), r => r.open)))), tile('Empty starts next week', txt('b', String(d3.sum(sd.filter(r => r.week === 'next'), r => r.open)))));
  st.append(tiles);

  // open spots by day
  const dh = $('#st-days'); dh.replaceChildren();
  { const t = txt('table', null, 'fx-days'), r1r = document.createElement('tr'), r2 = document.createElement('tr'), r3 = document.createElement('tr');
    r1r.append(txt('th', '')); r2.append(txt('td', 'My players playing', 'muted')); r3.append(txt('td', 'Open spots', 'muted'));
    sd.forEach(r => { const wk = r.day === m.week_end_day + 1;
      const th = txt('th', r.day === m.today_day ? 'Today' : dayLbl(r.day), 'num'); if (wk) th.classList.add('wk'); r1r.append(th);
      const a = txt('td', String(r.playing), 'num'); if (wk) a.classList.add('wk'); r2.append(a);
      const o = r.nba_games ? txt('td', String(r.open), 'num open ' + (r.open >= 5 ? 'hi' : r.open >= 2 ? 'mid' : 'lo')) : txt('td', 'No games', 'num open lo'); if (wk) o.classList.add('wk'); r3.append(o); });
    t.createTHead().append(r1r); const tb = t.createTBody(); tb.append(r2, r3); dh.append(t);
    dh.append(txt('p', 'The thick line marks the start of next week (' + dayLbl(m.week_end_day + 1) + ').', 'fx-note')); }

  // best pickups: points each free agent adds to my best legal lineup on the days he plays
  const win = streamWin(), pos = P().spos || '';
  const from = win === 'this' ? m.today_day + (today ? 0 : 1) : m.week_end_day + 1, to = win === 'this' ? m.week_end_day : m.week_end_day + 7, days = d3.range(from, to + 1);
  const ctl = $('#st-ctl'); ctl.replaceChildren();
  const seg = (opts, cur, key) => { const s = txt('div', null, 'fx-seg'); opts.forEach(([v, l]) => { const b = txt('button', l); b.type = 'button'; b.setAttribute('aria-pressed', String(cur === v)); b.addEventListener('click', () => setParams({ [key]: v })); s.append(b); }); return s; };
  ctl.append(seg([['this', 'Rest of this week'], ['next', 'Next week']], win, 'swin'));
  if (win === 'this') ctl.append(seg([['1', 'Count today'], ['0', 'Skip today']], today ? '1' : '0', 'stoday'));
  const ps = txt('select'); ps.setAttribute('aria-label', 'Position'); [['', 'All positions'], ['PG', 'PG'], ['SG', 'SG'], ['SF', 'SF'], ['PF', 'PF'], ['C', 'C']].forEach(([v, l]) => ps.append(new Option(l, v, false, v === pos))); ps.addEventListener('change', () => setParams({ spos: ps.value || null }));
  const pl = txt('label', 'Position '); pl.append(ps); ctl.append(pl);
  $('#st-best-note').textContent = (win === 'this' ? 'Today only counts if you add before the day\'s first tip-off, since moves lock for the whole day. ' : '') + '"+Pts" is what he adds to your best legal lineup on the days he plays, so a player whose games land on full days scores zero. Days in brackets are days your lineup is already full. A "Spike" tag means his last game was far above his average: check his minutes before buying.';
  const base = new Map(days.map(d => [d, bestLineup(mine.filter(p => plays(p.nba_team, d)).map(p => ({ positions: p.positions, v: val(p) * aw(p) })))]));
  const rkm = new Map(rows('rankings').map(r => [r.player_id, r]));
  const fa = rows('player_pool').filter(p => !p.team_id && p.status !== 'OUT' && (!pos || p.positions.split(',').includes(pos))).map(p => {
    let gain = 0, fills = 0, g = 0; const ds = [];
    days.forEach(d => { if (!plays(p.nba_team, d)) return; g++; const b = base.get(d), add = d3.sum(bestLineup([...b, { positions: p.positions, v: val(p) * aw(p) }]), q => q.v) - d3.sum(b, q => q.v); if (add > 0.05) { gain += add; fills++; } ds.push((add > 0.05 ? '' : '(') + (d === m.today_day ? 'Today' : WD[new Date(Date.UTC(2026, 9, 19 + d, 12)).getUTCDay()]) + (add > 0.05 ? '' : ')')); });
    const gs = gamesOf(p.player_id), last = gs[gs.length - 1];
    return { p, gain, fills, g, days: ds.join(' '), spike: p.games_played >= 4 && last && last.fpts >= 1.6 * p.avg && last.fpts >= 30, capped: p.positions.split(',').includes('C') && centers >= CENTER_MAX, min_l5: (rkm.get(p.player_id) || {}).min_l5 };
  }).filter(r => r.g > 0).sort((a, b) => b.gain - a.gain || val(b.p) - val(a.p)).slice(0, 40);
  const bh = $('#st-best'); bh.replaceChildren();
  { const { table, tbody } = makeTable([['player', 'Player'], ['gain', '+Pts', 'num', 'Points added to your lineup over the window'], ['fills', 'Open-day games', 'num'], ['games', 'Games', 'num'], ['days', 'Days'], ['exp', 'Exp/gm', 'num'], ['avg', 'Avg', 'num'], ['med5', 'Med 5', 'num'], ['min_l5', 'Min last 5', 'num'], ['own', 'Own %', 'num']]);
    table.classList.add('fx-click');
    fa.forEach(r => {
      const tr = document.createElement('tr'); tr.dataset.pid = r.p.player_id; if (r.capped) tr.className = 'climit';
      const sub = txt('span', null, 'sub'); sub.append(r.p.positions + ' · ' + r.p.nba_team + (r.p.fantasy_team === 'Waivers' ? ' · waivers' : ''));
      if (r.spike) sub.append(txt('span', 'Spike', 'fx-tag spike')); if (r.capped) sub.append(txt('span', 'C limit', 'fx-tag'));
      tr.append(nameCell(r.p.player, r.p.nba_team, r.p.status, sub), txt('td', '+' + Math.round(r.gain), 'num'), txt('td', String(r.fills), 'num'), txt('td', String(r.g), 'num'), txt('td', r.days, 'muted'),
        txt('td', dash0(r1(val(r.p))), 'num'), txt('td', dash0(r.p.avg), 'num'), txt('td', dash0(r1(med5(r.p.player_id))), 'num'), txt('td', dash0(r.min_l5), 'num'), txt('td', dash0(r.p.pct_owned), 'num'));
      tbody.append(tr);
    });
    table.addEventListener('click', e => { if (e.target.closest('.fx-inline')) return; const tr = e.target.closest('tbody tr[data-pid]'); if (tr) openPlayer(Number(tr.dataset.pid), tr); });
    bh.append(table); if (!fa.length) bh.append(txt('p', 'No free agents play in this window.', 'fx-note')); }

  // who to drop
  const xd = d3.range(m.today_day + (today ? 0 : 1), m.week_end_day + 8), dayList = new Map(xd.map(d => [d, mine.filter(p => plays(p.nba_team, d))]));
  const drops = mineAll.filter(p => p.slot !== 'IR' && p.status !== 'OUT').map(p => {
    let keep = 0, starts = 0, g = 0;
    xd.forEach(d => { if (!plays(p.nba_team, d)) return; g++; const all = dayList.get(d).map(q => ({ pid: q.player_id, positions: q.positions, v: val(q) * aw(q) })), w = bestLineup(all); if (w.some(q => q.pid === p.player_id)) starts++; keep += d3.sum(w, q => q.v) - lineupSum(all.filter(q => q.pid !== p.player_id)); });
    return { p, keep, starts, g, own: (pool.get(p.player_id) || {}).pct_owned };
  }).sort((a, b) => a.keep - b.keep);
  const xh = $('#st-drop'); xh.replaceChildren();
  { const { table, tbody } = makeTable([['player', 'Player'], ['keep', 'Pts he\'d add', 'num'], ['starts', 'Games he\'d start', 'num'], ['games', 'Games', 'num'], ['exp', 'Exp/gm', 'num'], ['med5', 'Med 5', 'num'], ['own', 'Own %', 'num']]);
    table.classList.add('fx-click');
    drops.forEach(r => { const tr = document.createElement('tr'); tr.dataset.pid = r.p.player_id;
      tr.append(nameCell(r.p.player, r.p.nba_team, r.p.status, (r.p.slot === 'BE' ? 'Bench' : r.p.slot) + ' · ' + r.p.positions + ' · ' + r.p.nba_team), txt('td', String(Math.round(r.keep)), 'num'), txt('td', String(r.starts), 'num'), txt('td', String(r.g), 'num'),
        txt('td', dash0(r1(val(r.p))), 'num'), txt('td', dash0(r1(med5(r.p.player_id))), 'num'), txt('td', dash0(r.own), 'num' + (r.own >= 50 ? ' amber' : ''))); tbody.append(tr); });
    table.addEventListener('click', e => { if (e.target.closest('.fx-inline')) return; const tr = e.target.closest('tbody tr[data-pid]'); if (tr) openPlayer(Number(tr.dataset.pid), tr); });
    xh.append(table); }

  // my add/drop history
  const acts = rows('activity').filter(a => a.team_id === my), gotIn = d3.group(rows('activity').filter(a => a.kind === 'Trade' && a.to_id === my), a => a.time);
  const ev = d3.groups(acts.filter(a => a.kind !== 'Trade'), a => a.time).map(([t, list]) => ({ t, day: dayOfTime(t), eff: effDay(t), adds: list.filter(a => a.kind.startsWith('Add')).map(a => a.player), drops: list.filter(a => a.kind === 'Drop').map(a => a.player), got: (gotIn.get(t) || []).map(a => a.player) })).sort((a, b) => b.t.localeCompare(a.t));
  const restTo = m.week_end_day, sched = d3.group(rows('nba_schedule'), g => g.nba_team), gcount = (nba, a, b) => (sched.get(nba) || []).filter(g => g.day >= a && g.day <= b).length;
  const avgOfG = gs => (gs.length ? r1(d3.mean(gs, g => g.fpts)) : null), sgn = v => (v == null ? null : (v > 0 ? '+' : '') + v), tone2 = (v, t) => (v == null ? '' : v >= t ? 'up' : v <= -t ? 'down' : '');
  const num = (v, cls) => txt('td', v == null ? '–' : String(v), 'num' + (cls ? ' ' + cls : ''));
  const myEvents = name => ev.filter(e => e.adds.includes(name) || e.drops.includes(name)).map(e => ({ day: e.eff, label: e.day, kind: e.adds.includes(name) ? 'add' : 'drop' })).sort((a, b) => a.day - b.day);
  const spark = (gs, marks) => lastGames(txt('td'), gs, 5, (marks || []).map(x2 => ({ ...x2 })));
  const tbl = (host, cols, fill) => { const { table, tbody } = makeTable(cols); table.classList.add('fx-click'); fill(tbody, table); table.addEventListener('click', e => { if (e.target.closest('.fx-inline')) return; const tr = e.target.closest('tbody tr[data-pid]'); if (tr) openPlayer(Number(tr.dataset.pid), tr); }); host.append(table); };

  const mh = $('#st-mine'); mh.replaceChildren();
  const added = new Map(); ev.slice().reverse().forEach(e => e.adds.forEach(n => added.set(n, e)));
  const picked = mineAll.filter(p => added.has(p.player)).map(p => { const e = added.get(p.player), started = rows('game_log').filter(g => g.player_id === p.player_id && g.team_id === my && g.day >= e.eff && g.slot !== 'BE' && g.slot !== 'IR'); return { p, e, started, since: gamesOf(p.player_id).filter(g => g.day >= e.eff) }; }).sort((a, b) => b.e.t.localeCompare(a.e.t));
  if (picked.length) tbl(mh, [['player', 'Player'], ['fy', 'For you', 'num'], ['savg', 'Avg since add', 'num'], ['avg', 'Season avg', 'num'], ['last', 'Last 5 games (pts / min)'], ['min_l5', 'Min last 5', 'num'], ['fpm_l5', 'Pts per min', 'num'], ['g', 'Games this wk · next', 'num']], tb => picked.forEach(r => {
    const tr = document.createElement('tr'), x2 = rkm.get(r.p.player_id) || {}; tr.dataset.pid = r.p.player_id;
    tr.append(nameCell(r.p.player, r.p.nba_team, r.p.status, 'Added ' + dayLbl(r.e.day) + (r.e.drops.length ? ' for ' + r.e.drops.join(', ') : '')), num(d3.sum(r.started, q => q.pts) + ' (' + r.started.length + ')'), num(avgOfG(r.since)), num(r.p.avg),
      spark(gamesOf(r.p.player_id), myEvents(r.p.player)), num(x2.min_l5), num(x2.fpm_l5), txt('td', gcount(r.p.nba_team, m.today_day, restTo) + ' · ' + gcount(r.p.nba_team, restTo + 1, restTo + 7), 'num'));
    tb.append(tr);
  }));
  else mh.append(txt('p', 'No streamers on your roster.', 'fx-note'));

  const ch = $('#st-cut'); ch.replaceChildren();
  const cut = []; { const seen = new Set(); ev.forEach(e => e.drops.forEach(n => { if (!seen.has(n)) { seen.add(n); cut.push({ n, e }); } })); }
  if (cut.length) tbl(ch, [['player', 'Player'], ['before', 'Avg before', 'num'], ['after', 'Avg since', 'num'], ['last', 'Last 5 games (pts / min)'], ['repl', 'You added instead'], ['edge', 'Swap edge', 'num']], (tb, table) => {
    const hurt = ({ n }) => { const pi = byName.get(n); return !pi || pi.status === 'OUT' || !gamesOf(pi.player_id).length; }, inj = cut.filter(hurt);
    [...cut.filter(x2 => !hurt(x2)), ...inj].forEach(({ n, e }) => {
      if (inj.length && n === inj[0].n) injToggleRow(table, tb, inj.map(x2 => ({ player: x2.n })));
      const pi = byName.get(n), gs = pi ? gamesOf(pi.player_id) : [], ba = avgOfG(gs.filter(x2 => x2.day < e.eff)), after = gs.filter(x2 => x2.day >= e.eff), aa = avgOfG(after);
      const rp = e.adds.map(a => byName.get(a)).filter(Boolean)[0], ra = rp ? avgOfG(gamesOf(rp.player_id).filter(x2 => x2.day >= e.eff)) : null, edge = ra != null && aa != null ? r1(ra - aa) : null;
      const now = !pi ? 'free agent' : pi.team_id === my ? 'back on your team' : pi.team_id ? pi.fantasy_team : pi.fantasy_team.toLowerCase();
      const tr = document.createElement('tr'); if (pi) tr.dataset.pid = pi.player_id; if (pi && pi.team_id && pi.team_id !== my) tr.className = 'taken'; if (inj.some(x2 => x2.n === n)) tr.classList.add('fx-injrow');
      tr.append(nameCell(n, pi ? pi.nba_team : '', pi ? pi.status : '', (e.got.length ? 'Dropped in trade ' : 'Dropped ') + dayLbl(e.day) + ' · now ' + now), num(ba), num(aa == null ? null : aa + ' (' + after.length + ')', aa != null && ba != null ? tone2(aa - ba, 3) : ''),
        pi ? spark(gs, myEvents(n)) : txt('td', 'no recent stats', 'muted'), txt('td', e.adds.length ? e.adds.join(', ') + (ra != null ? ' · ' + ra : '') : e.got.length ? 'Trade: ' + e.got.join(', ') : '–', 'muted'), num(sgn(edge), tone2(edge, 0.1)));
      tb.append(tr);
    });
  });
  else ch.append(txt('p', 'You haven\'t dropped anyone yet.', 'fx-note'));
}

// ---------- TRADE MACHINE ----------
const TR = { a: new Set(), b: new Set() };
$('#tr-team').addEventListener('change', () => { TR.b.clear(); setParams({ trp: Number($('#tr-team').value) }); });
$('#tr-clear').addEventListener('click', () => { TR.a.clear(); TR.b.clear(); draw(); });
function drawTrade() {
  const my = MY(), sel = $('#tr-team'), others = rows('teams').filter(t => t.team_id !== my);
  if (sel.options.length !== others.length) sel.replaceChildren(...others.map(t => new Option(t.team + ' (' + t.manager + ')', t.team_id)));
  const B = Number(P().trp ?? others[0].team_id); sel.value = String(B);
  $('#tr-b-h').textContent = 'You get from ' + teamName(B);
  const list = (host, tid, set) => {
    host.replaceChildren(); const wrap = txt('div', null, 'fx-pick');
    rows('players').filter(p => p.team_id === tid).sort((a, b) => val(b) - val(a)).forEach(p => {
      const lab = txt('label', null, set.has(p.player_id) ? 'on' : ''), cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = set.has(p.player_id);
      cb.addEventListener('change', () => { if (cb.checked) set.add(p.player_id); else set.delete(p.player_id); draw(); });
      const nm = txt('span', null, 'nm'); nm.append(txt('b', p.player), txt('small', [p.positions, p.nba_team, p.slot === 'IR' ? 'IR' : '', p.status !== 'Healthy' ? p.status : ''].filter(Boolean).join(' · ')));
      const v = txt('span', String(r1(val(p))), 'v'); v.append(txt('small', 'exp/gm'));
      lab.append(cb, avatar(p.player, p.nba_team, p.status), nm, v); wrap.append(lab);
    });
    host.append(wrap);
  };
  list($('#tr-a'), my, TR.a); list($('#tr-b'), B, TR.b);
  const res = $('#tr-res'); res.replaceChildren();
  const ra = rows('players').filter(p => p.team_id === my), rb = rows('players').filter(p => p.team_id === B);
  const out = ra.filter(p => TR.a.has(p.player_id)), inc = rb.filter(p => TR.b.has(p.player_id));
  if (!out.length && !inc.length) { res.append(txt('p', 'Tick players on both sides to see the result.', 'fx-note')); return; }
  const calc = (r, minus, plus) => { const after = r.filter(p => !minus.includes(p)).concat(plus.map(p => ({ ...p, slot: p.slot === 'IR' ? 'IR' : 'BE' })));
    const f = (l, now) => lineupSum(l.map(p => ({ positions: p.positions, v: val(p) * (now ? aw(p) : 1) })));
    return { now0: f(r, 1), now1: f(after, 1), full0: f(r, 0), full1: f(after, 0), size: after.filter(p => p.slot !== 'IR').length, c: after.filter(p => p.slot !== 'IR' && p.positions.split(',').includes('C')).length }; };
  const a = calc(ra, out, inc), b = calc(rb, inc, out);
  const { table, tbody } = makeTable([['team', 'Team'], ['now', 'Best lineup now (per game)', 'num'], ['dnow', 'Change', 'num'], ['full', 'At full strength', 'num'], ['dfull', 'Change', 'num'], ['size', 'Roster', 'num'], ['c', 'Centers', 'num']]);
  const delta = v => (Math.abs(v) < 0.05 ? '±0' : (v > 0 ? '+' : '−') + Math.abs(v).toFixed(1));
  [[my, a], [B, b]].forEach(([id, r]) => { const tr = document.createElement('tr'); if (id === my) tr.className = 'me';
    tr.append(teamCell(teamName(id), id), txt('td', r.now0.toFixed(1) + ' → ' + r.now1.toFixed(1), 'num'), txt('td', delta(r.now1 - r.now0), 'num ' + tone(delta(r.now1 - r.now0))), txt('td', r.full0.toFixed(1) + ' → ' + r.full1.toFixed(1), 'num'), txt('td', delta(r.full1 - r.full0), 'num ' + tone(delta(r.full1 - r.full0))),
      txt('td', r.size + ' / ' + ROSTER_MAX, 'num' + (r.size > ROSTER_MAX ? ' bad' : '')), txt('td', r.c + ' / ' + CENTER_MAX, 'num' + (r.c > CENTER_MAX ? ' bad' : ''))); tbody.append(tr); });
  const wrap = txt('div', null, 'fx-tbl-wrap'); wrap.append(table); res.append(wrap);
  [[my, a], [B, b]].forEach(([id, r]) => { if (r.size > ROSTER_MAX) res.append(txt('p', teamName(id) + ' would have ' + r.size + ' players and must drop ' + (r.size - ROSTER_MAX) + '.', 'fx-warn-line')); if (r.c > CENTER_MAX) res.append(txt('p', teamName(id) + ' would have ' + r.c + ' centers; the limit is ' + CENTER_MAX + '.', 'fx-warn-line')); });
  const sum = l => d3.sum(l, p => val(p));
  res.append(txt('p', 'You send ' + sum(out).toFixed(1) + ' expected points a game and get ' + sum(inc).toFixed(1) + ' back. What matters more is the table: how each team\'s best legal 10 changes once slots are filled. "Now" counts today\'s injuries (IR and out at zero, day-to-day at 75%).', 'fx-note'));
}

// ---------- STANDINGS ----------
$('#luck-week').addEventListener('change', () => setParams({ luck: Number($('#luck-week').value) }));
function drawStandings() {
  $('#po-n').textContent = meta().playoff_teams;
  powerTable($('#power'), [['power_rank', '#', 'num'], ['team', 'Team'], ['manager', 'Manager'], ['record', 'W–L'], ['rating', 'Rating (pts/wk)', 'num', '', f0], ['strength_now', 'Strength now', 'num', 'Best legal lineup per game with today\'s injuries'], ['strength_full', 'At full strength', 'num'],
    ['exp_wins', 'Proj. wins', 'num'], ['playoff', 'Playoffs', 'num', '', pct], ['title', 'Title', 'num', '', pct]], 'power_rank', true);
  const m = meta(), wcols = []; for (let w = 1; w <= m.week; w++) wcols.push(['w_' + w, 'Wk ' + w + (w === m.week ? ' (live)' : ''), 'num', '', v => (v == null ? '' : f0(v))]);
  powerTable($('#power-season'), [['season_rank', '#', 'num'], ['team', 'Team'], ['manager', 'Manager'], ['record', 'W–L'], ['season_pts', 'Total', 'num', '', f0], ['avg_week', 'Per week', 'num', '', v => (v == null ? '–' : f0(v))],
    ['all_play', 'All-play wins', 'num'], ['sched_luck', 'Schedule luck', 'num', '', v => (v == null ? '' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1))], ['luck_season', '+/− vs full strength', 'num']].concat(wcols), 'season_rank', true);
  const host = $('#luck'), sel = $('#luck-week'); host.replaceChildren();
  const all = rows('team_luck'), weeks = [0].concat(d3.range(1, m.week + 1).filter(w => all.some(r => r.week === w)));
  const opts = weeks.map(w => [w, w === 0 ? 'Season so far' : 'Week ' + w + (w === m.week ? ' (so far, through ' + dayLbl(m.today_day - 1) + ')' : '')]);
  if (sel.options.length !== opts.length || [...sel.options].some((o, i) => o.text !== opts[i][1])) sel.replaceChildren(...opts.map(([v, t]) => new Option(t, v)));
  const pw = Number(P().luck), w = weeks.includes(pw) ? pw : 0; sel.value = String(w);
  const list = all.filter(r => r.week === w).sort((a, b) => b.vs_league_n - a.vs_league_n);
  if (!list.length) { host.append(txt('p', 'No finished days yet.', 'fx-note')); return; }
  const { table, tbody } = makeTable([['rank', '#', 'num'], ['team', 'Team'], ['vs_league', '+/− vs league avg', 'num'], ['points', 'Points', 'num'], ['proj_full', 'Full-strength projection', 'num'], ['diff', '+/−', 'num'], ['per_day', '+/− per day', 'num'], ['pct', '% of projection', 'num'], ['days', 'Days', 'num']]);
  list.forEach((r, i) => { const tr = document.createElement('tr'); if (r.team_id === MY()) tr.className = 'me';
    tr.append(txt('td', String(i + 1), 'num'), teamCell(r.team, r.team_id), txt('td', r.vs_league, 'num ' + tone(r.vs_league)), txt('td', f0(r.points), 'num'), txt('td', f0(Math.round(r.proj_full)), 'num'), txt('td', r.diff, 'num ' + tone(r.diff)),
      txt('td', r.per_day, 'num ' + tone(r.per_day)), txt('td', r.pct == null ? '—' : r.pct + '%', 'num'), txt('td', String(r.days), 'num')); tbody.append(tr); });
  host.append(table);
}

// ---------- TEAMS ----------
$('#team-sel').addEventListener('change', () => setParams({ team: Number($('#team-sel').value), tday: null }));
function drawTeams() {
  const sel = $('#team-sel');
  if (sel.options.length !== rows('teams').length) sel.replaceChildren(...rows('teams').slice().sort((a, b) => (b.team_id === MY()) - (a.team_id === MY()) || a.team.localeCompare(b.team)).map(t => new Option(t.team + ' (' + t.manager + ')', t.team_id)));
  const tid = Number(P().team ?? MY()); sel.value = String(tid);
  heroFor($('#tm-hero'), tid);
  matchPanel($('#tm-match'), rows('week_board').find(r => r.team_id === tid), 'tday', { title: false, focus: tid });
  seasonTrend($('#tm-trend'), tid); playerCards($('#tm-cards'), tid); rosterTable($('#tm-roster'), tid); lineupGrid($('#tm-lineup'), tid); schedTable($('#tm-sched'), tid);
  movesTable($('#tm-moves'), r => r.team_ids.includes(tid));
}

// ---------- PLAYERS ----------
let plQ = '';
$('#pl-q').addEventListener('input', () => { plQ = $('#pl-q').value; drawPlayers(); });
$('#pl-pos').addEventListener('change', () => setParams({ pos: $('#pl-pos').value || null }));
$('#pl-owner').addEventListener('change', () => setParams({ owner: $('#pl-owner').value }));
const RK_COLS = [['rank', '#', 'num'], ['player', 'Player'], ['fantasy_team', 'Fantasy team'], ['nba_team', 'NBA'], ['positions', 'Pos'], ['status', 'Status'], ['games_played', 'GP', 'num'], ['total_pts', 'Total', 'num'],
  ['avg', 'Avg', 'num'], ['med5', 'Med 5', 'num'], ['proj_avg', 'Proj avg', 'num'], ['exp', 'Exp', 'num'], ['diff_avg', '+/− per game', 'num'], ['last_fpts', 'Last', 'num'], ['last_diff', 'Last +/−', 'num'], '__days__',
  ['pct_owned', 'Own %', 'num'], ['min', 'MIN', 'num'], ['min_l5', 'MIN last 5', 'num'], ['fpm', 'Pts/min', 'num'], ['pts', 'PTS', 'num'], ['reb', 'REB', 'num'], ['ast', 'AST', 'num'], ['stl', 'STL', 'num'], ['blk', 'BLK', 'num'], ['tpm', '3PM', 'num'], ['tov', 'TO', 'num'], ['fg_pct', 'FG%', 'num']];
const sortVal = (r, f) => (f === 'diff_avg' ? r.diff_avg_n : (f.startsWith('d_') || f === 'last_diff') ? (r[f] === '' ? null : Number(String(r[f]).replace('−', '-'))) : r[f]);
$('#rankings').addEventListener('click', ev => {
  if (ev.target.closest('.fx-inline')) return;
  const th = ev.target.closest('th[data-field]');
  if (th) { const f = th.dataset.field, cur = P().sort || 'rank', dir = Number(P().dir || 1); setParams({ sort: f, dir: cur === f ? -dir : (['rank', 'player', 'fantasy_team', 'nba_team', 'positions', 'status'].includes(f) ? 1 : -1) }); return; }
  const tr = ev.target.closest('tr[data-key]'); if (tr) { const id = Number(tr.dataset.key); setParams({ player: Number(P().player) === id ? null : id }); }
});
['#hot', '#cold'].forEach(s => $(s).addEventListener('click', ev => { if (ev.target.closest('.fx-inline')) return; const tr = ev.target.closest('tbody tr[data-pid]'); if (tr) openPlayer(Number(tr.dataset.pid), tr); }));
function playerList() {
  const owner = P().owner || 'all', pos = P().pos || '', q = plQ.trim().toLowerCase(), f = P().sort || 'rank', dir = Number(P().dir || 1);
  return rows('rankings').filter(r => (owner === 'all' || (owner === 'fa' ? !r.team_id : r.team_id === Number(owner))) && (!pos || r.positions.split(',').includes(pos)) && (!q || (r.player + ' ' + r.fantasy_team + ' ' + r.nba_team).toLowerCase().includes(q)))
    .sort((a, b) => { const x = sortVal(a, f), y = sortVal(b, f); if (x == null && y == null) return a.rank - b.rank; if (x == null) return 1; if (y == null) return -1; return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir || a.rank - b.rank; });
}
function drawPlayers() {
  const sel = $('#pl-owner');
  if (!sel.options.length) { sel.append(new Option('All players (rostered + free agents)', 'all')); rows('teams').slice().sort((a, b) => (b.team_id === MY()) - (a.team_id === MY()) || a.team.localeCompare(b.team)).forEach(t => sel.append(new Option(t.team, String(t.team_id)))); sel.append(new Option('Free agents & waivers only', 'fa')); }
  sel.value = P().owner || 'all'; $('#pl-pos').value = P().pos || '';
  const base = playerList().filter(r => r.games_played >= 2 && r.diff_avg_n != null).sort((a, b) => b.diff_avg_n - a.diff_avg_n);
  [['hot', base.slice(0, 8)], ['cold', base.slice().reverse().slice(0, 8)]].forEach(([kind, list]) => {
    const host = $('#' + kind); host.replaceChildren();
    const { table, tbody } = makeTable([['player', 'Player'], ['fantasy_team', 'Team'], ['avg', 'Avg', 'num'], ['proj_avg', 'Proj', 'num'], ['diff_avg', '+/−', 'num']]); table.classList.add('fx-click');
    list.forEach(r => { const tr = document.createElement('tr'); tr.dataset.pid = r.player_id; tr.append(nameCell(r.player, r.nba_team, r.status), teamCell(r.team_id ? r.fantasy_team : (r.fantasy_team === 'Waivers' ? 'Waivers' : 'Free agent'), r.team_id), txt('td', String(r.avg), 'num'), txt('td', String(r.proj_avg), 'num'), txt('td', r.diff_avg, 'num ' + tone(r.diff_avg))); tbody.append(tr); });
    const w = txt('div', null, 'fx-tbl-wrap'); w.append(table); host.append(w);
    if (!list.length) host.append(txt('p', 'Nobody with 2+ games matches these filters.', 'fx-note'));
  });
  const tbl = $('#rankings'), thead = tbl.tHead, tb = tbl.tBodies[0]; thead.replaceChildren(); tb.replaceChildren();
  const m = meta(), days = d3.range(Math.max(1, m.today_day - 6), m.today_day + 1), cols = [];
  RK_COLS.forEach(c => { if (c === '__days__') days.forEach(d => cols.push(['d_' + d, (d === m.today_day ? 'Today' : dayLbl(d)) + ' +/−', 'num'])); else cols.push(c); });
  const hr = document.createElement('tr');
  cols.forEach(([f, label, cls]) => { const th = txt('th', label, cls || ''); th.dataset.field = f; if ((P().sort || 'rank') === f) th.setAttribute('aria-sort', Number(P().dir || 1) > 0 ? 'ascending' : 'descending'); hr.append(th); });
  thead.append(hr);
  const selP = P().player != null ? Number(P().player) : null, list = playerList();
  $('#pl-count').textContent = 'Showing ' + list.length + ' players' + (sel.selectedIndex >= 0 ? ' · ' + sel.options[sel.selectedIndex].text : '');
  list.forEach(r => {
    const tr = document.createElement('tr'); tr.dataset.key = r.player_id; if (r.player_id === selP) tr.className = 'sel'; if (r.team_id === MY()) tr.classList.add('me');
    cols.forEach(([fld, , cls]) => {
      const v = fld === 'med5' ? r1(r[fld]) : r[fld]; let c = cls || '';
      if (fld === 'diff_avg' || fld === 'last_diff' || fld.startsWith('d_')) c += ' ' + tone(v);
      if (fld === 'status') c += v === 'OUT' ? ' bad' : v === 'DTD' ? ' warn' : ' muted';
      if (fld === 'player') tr.append(nameCell(r.player, r.nba_team, r.status));
      else if (fld === 'fantasy_team') tr.append(teamCell(r.team_id ? r.fantasy_team : r.fantasy_team === 'Waivers' ? 'Waivers' : 'Free agent', r.team_id));
      else tr.append(txt('td', v == null ? '' : String(v), c));
    });
    tb.append(tr);
    if (r.player_id === selP) { const dr = document.createElement('tr'); dr.className = 'fx-inline'; const td = document.createElement('td'); td.colSpan = cols.length; const inner = txt('div', null, 'fx-inline-in'); const wrapW = $('#rk-wrap').clientWidth || 600; inner.style.width = (wrapW - 4) + 'px'; td.append(inner); dr.append(td); tb.append(dr); playerDetail(inner, r.player_id, wrapW - 30); }
  });
}

// ---------- TRANSACTIONS ----------
$('#move-kind').addEventListener('change', () => drawMoves());
$('#move-q').addEventListener('input', () => drawMoves());
function drawMoves() { const kind = $('#move-kind').value, q = $('#move-q').value.trim().toLowerCase(); movesTable($('#movelist'), r => (kind === 'all' || r.kind === kind) && (!q || (r.teams + ' ' + r.details).toLowerCase().includes(q))); }

// ---------- TRENDS ----------
function drawTrends() {
  const m = meta(), my = MY(), metric = P().tm || 'weekly', hi = Number(P().thi || 0);
  const ctl = $('#tr-ctl'); ctl.replaceChildren();
  const s = txt('div', null, 'fx-seg');
  [['weekly', 'Weekly points'], ['playoff', 'Playoff odds'], ['rating', 'Rating'], ['rank', 'Power rank']].forEach(([v, l]) => { const b = txt('button', l); b.type = 'button'; b.setAttribute('aria-pressed', String(metric === v)); b.addEventListener('click', () => setParams({ tm: v })); s.append(b); });
  const cs = txt('select'); cs.append(new Option('Compare with…', '0')); rows('teams').filter(t => t.team_id !== my).forEach(t => cs.append(new Option(t.team, t.team_id, false, t.team_id === hi))); cs.addEventListener('change', () => setParams({ thi: Number(cs.value) || null }));
  ctl.append(s, cs);
  const H_ = HIST.days || [], weeks = d3.range(1, m.week);
  let labels, series, fmt = f0, invert = false, note = '';
  if (metric === 'weekly') { labels = weeks.map(w => 'Week ' + w); series = rows('teams').map(t => ({ id: t.team_id, name: t.team, short: t.abbrev, values: weeks.map(w => rows('matchups').find(x => x.week === w && x.team_id === t.team_id)?.pts ?? null) })); }
  else { const idx = { playoff: 4, rating: 3, rank: 6 }[metric]; labels = H_.map(d => { const dt = new Date(d.date + 'T12:00:00'); return (dt.getMonth() + 1) + '/' + dt.getDate(); });
    series = rows('teams').map(t => ({ id: t.team_id, name: t.team, short: t.abbrev, values: H_.map(d => d.teams[t.team_id]?.[idx] ?? null) }));
    if (metric === 'playoff') fmt = pct; if (metric === 'rank') { fmt = v => '#' + v; invert = true; }
    if (H_.length < 2) note = 'This view gains one point a day; the first was saved on ' + (H_[0] ? H_[0].date : 'today') + '. The line appears once a second day is saved.'; }
  const host = $('#trend-chart'); host.replaceChildren();
  const cmpCols = hi ? pairCols(my, hi) : [ftCol(my)], colOf = id => (id === my ? cmpCols[0] : id === hi ? cmpCols[1] : 'var(--chart-muted)');
  const leg = txt('div', null, 'fx-legend');
  [[my, teamName(my)], ...(hi ? [[hi, teamName(hi)]] : []), [-1, 'Other teams']].forEach(([id, n]) => { const sp = txt('span', n); sp.prepend(swatch(id === -1 ? 'var(--chart-muted)' : colOf(id))); leg.append(sp); });
  host.append(leg); if (note) host.append(txt('p', note, 'fx-note'));
  if (labels.length >= 2) {
    const box = txt('div', null, 'fx-chart'); host.append(box);
    const W = Math.max(300, box.clientWidth || 600), H = 300, mg = { t: 14, r: 56, b: 28, l: 46 }, vals = series.flatMap(x2 => x2.values).filter(v => v != null);
    let lo = d3.min(vals), up = d3.max(vals); if (lo === up) { lo -= 1; up += 1; }
    const x = d3.scalePoint(labels.map((_, i) => i), [mg.l, W - mg.r]), y = d3.scaleLinear([lo, up], invert ? [mg.t, H - mg.b] : [H - mg.b, mg.t]).nice();
    const svg = d3.select(box).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H).attr('role', 'img').attr('aria-label', 'One line per team');
    svg.append('g').selectAll('line').data(y.ticks(5)).join('line').attr('x1', mg.l).attr('x2', W - mg.r).attr('y1', d => y(d)).attr('y2', d => y(d)).attr('stroke', 'var(--chart-grid)');
    svg.append('g').selectAll('text').data(y.ticks(5)).join('text').attr('x', mg.l - 6).attr('y', d => y(d)).attr('dy', '0.32em').attr('text-anchor', 'end').attr('fill', 'var(--color-fg-muted)').style('font-size', '11px').text(fmt);
    const stepL = Math.ceil(labels.length / Math.max(1, Math.floor((W - mg.l - mg.r) / 60)));
    svg.append('g').selectAll('text').data(labels.map((l, i) => [l, i]).filter(([, i]) => i % stepL === 0)).join('text').attr('x', ([, i]) => x(i)).attr('y', H - 8).attr('text-anchor', 'middle').attr('fill', 'var(--color-fg-muted)').style('font-size', '11px').text(([l]) => l);
    const line = d3.line().defined(v => v != null).x((v, i) => x(i)).y(v => y(v));
    const order = series.slice().sort((a, b) => (a.id === my) - (b.id === my) || (a.id === hi) - (b.id === hi));
    order.forEach(s2 => { const hl = s2.id === my || s2.id === hi;
      svg.append('path').attr('d', line(s2.values)).attr('fill', 'none').attr('stroke', colOf(s2.id)).attr('stroke-width', hl ? 2.5 : 1.25).attr('stroke-linejoin', 'round');
      const li = s2.values.findLastIndex(v => v != null);
      if (li >= 0) { svg.append('circle').attr('cx', x(li)).attr('cy', y(s2.values[li])).attr('r', hl ? 4 : 2.5).attr('fill', colOf(s2.id)).attr('stroke', 'var(--color-panel)').attr('stroke-width', 1.5);
        if (hl) svg.append('text').attr('x', x(li) + 8).attr('y', y(s2.values[li])).attr('dy', '0.32em').attr('fill', 'var(--color-fg)').style('font-size', '12px').style('font-weight', 600).text(s2.short); } });
    const tip = txt('div', null, 'fx-tip'); box.append(tip);
    const cross = svg.append('line').attr('y1', mg.t).attr('y2', H - mg.b).attr('stroke', 'var(--chart-muted)').attr('visibility', 'hidden');
    svg.append('rect').attr('x', mg.l - 10).attr('width', W - mg.l - mg.r + 20).attr('y', mg.t).attr('height', H - mg.t - mg.b).attr('fill', 'transparent')
      .on('pointermove pointerdown', ev => { const [px] = d3.pointer(ev); const i = d3.minIndex(labels, (_, k) => Math.abs(x(k) - px)); cross.attr('x1', x(i)).attr('x2', x(i)).attr('visibility', 'visible');
        const rk = series.filter(s2 => s2.values[i] != null).sort((a, b) => (invert ? a.values[i] - b.values[i] : b.values[i] - a.values[i]));
        tip.replaceChildren(txt('div', labels[i], 'd')); rk.forEach((s2, k) => { const l = txt('div', (k + 1) + '. ' + s2.short + '  ' + fmt(s2.values[i])); l.prepend(swatch(colOf(s2.id))); if (s2.id === my || s2.id === hi) l.style.fontWeight = 600; tip.append(l); }); placeTip(tip, box, ev); })
      .on('pointerleave', () => { tip.style.opacity = 0; cross.attr('visibility', 'hidden'); });
  }
  const det = txt('details'), sum = txt('summary', 'Show as a table'); sum.className = 'fx-note'; sum.style.cursor = 'pointer'; det.append(sum);
  if (labels.length) { const { table, tbody } = makeTable([['team', 'Team']].concat(labels.map((l, i) => ['c' + i, l, 'num']))); series.forEach(s2 => { const tr = document.createElement('tr'); if (s2.id === my) tr.className = 'me'; tr.append(teamCell(s2.name, s2.id)); s2.values.forEach(v => tr.append(txt('td', v == null ? '–' : fmt(v), 'num'))); tbody.append(tr); }); const w = txt('div', null, 'fx-tbl-wrap'); w.append(table); det.append(w); }
  host.append(det);
  const rh = $('#risers'); rh.replaceChildren();
  const own = Object.keys(HIST.owned || {}).sort();
  if (own.length < 2) { rh.append(txt('p', 'Needs two days of ownership history; this fills in after tomorrow\'s first update.', 'fx-note')); return; }
  const a = HIST.owned[own[Math.max(0, own.length - 4)]], b = HIST.owned[own[own.length - 1]];
  const rs = rows('player_pool').filter(p => !p.team_id && b[p.player_id] != null).map(p => ({ p, ch: b[p.player_id] - (a[p.player_id] ?? 0) })).sort((x2, y2) => y2.ch - x2.ch).slice(0, 12);
  const { table, tbody } = makeTable([['player', 'Player'], ['own', 'Own %', 'num'], ['ch', 'Change', 'num'], ['avg', 'Avg', 'num'], ['med5', 'Med 5', 'num'], ['exp', 'Exp', 'num']]); table.classList.add('fx-click');
  rs.forEach(r => { const tr = document.createElement('tr'); tr.dataset.pid = r.p.player_id; tr.append(nameCell(r.p.player, r.p.nba_team, r.p.status, r.p.positions + ' · ' + r.p.nba_team), txt('td', dash0(r.p.pct_owned), 'num'), txt('td', (r.ch >= 0 ? '+' : '−') + Math.abs(r.ch).toFixed(1), 'num ' + (r.ch > 0 ? 'up' : r.ch < 0 ? 'down' : '')), txt('td', dash0(r.p.avg), 'num'), txt('td', dash0(r1(med5(r.p.player_id))), 'num'), txt('td', dash0(r1(val(r.p))), 'num')); tbody.append(tr); });
  table.addEventListener('click', e => { if (e.target.closest('.fx-inline')) return; const tr = e.target.closest('tbody tr[data-pid]'); if (tr) openPlayer(Number(tr.dataset.pid), tr); });
  rh.append(table);
}

// ---------- tap any column header to sort / flip ----------
const SORTS = new Map();
const hdrRow = t => t.tHead.rows[t.tHead.rows.length - 1];
const tblKey = t => ((t.closest('[id]') || {}).id || '') + '|' + [...hdrRow(t).cells].map(c => c.dataset.field).join(',');
const cellVal = td => { const s = (td ? td.textContent : '').trim(); if (!s || s === '–' || s === '—' || s === '·') return null; const n = s.replace(/,/g, '').replace(/^#/, '').replace(/^−/, '-').replace(/^\+/, '').replace(/ .*$/, ''); return /^-?\d+(\.\d+)?%?$/.test(n) ? parseFloat(n) : s.toLowerCase(); };
const ORDERED = new Set(['when', 'dates']);
function sortTable(t, f, dir) {
  const tb = t.tBodies[0]; if (!tb) return;
  const ths = [...hdrRow(t).cells], ci = ths.findIndex(c => c.dataset.field === f); if (ci < 0) return;
  const det = tb.querySelector('tr.fx-inline'), tog = tb.querySelector('tr.fx-injtog');
  const rs = [...tb.rows].filter(r => !r.classList.contains('fx-inline') && !r.classList.contains('fx-injtog') && !r.classList.contains('fx-injrow')), injs = [...tb.rows].filter(r => r.classList.contains('fx-injrow'));
  rs.forEach((r, i) => { if (r.dataset.i == null) r.dataset.i = i; });
  rs.sort((a, b) => { if (ORDERED.has(f)) return (a.dataset.i - b.dataset.i) * dir; const x = cellVal(a.cells[ci]), y = cellVal(b.cells[ci]); if (x == null && y == null) return a.dataset.i - b.dataset.i; if (x == null) return 1; if (y == null) return -1; const c = (typeof x === 'number' && typeof y === 'number') ? x - y : String(x).localeCompare(String(y)); return c * dir || a.dataset.i - b.dataset.i; });
  rs.forEach(r => tb.append(r)); if (tog) tb.append(tog); injs.forEach(r => tb.append(r));
  if (det) { const a = tb.querySelector('tr.fx-open'); if (a) a.after(det); else det.remove(); }
  ths.forEach(c => c.removeAttribute('aria-sort')); ths[ci].setAttribute('aria-sort', dir > 0 ? 'ascending' : 'descending');
}
const sortableTables = () => [...document.querySelectorAll('.fx-page:not([hidden]) table')].filter(t => t.id !== 'rankings' && t.tHead && hdrRow(t) && hdrRow(t).cells[0] && hdrRow(t).cells[0].dataset.field);
function applySorts() { sortableTables().forEach(t => { const s = SORTS.get(tblKey(t)); if (s) sortTable(t, s.f, s.dir); }); }
document.addEventListener('click', ev => {
  const th = ev.target.closest('th[data-field]'); if (!th) return;
  const t = th.closest('table'); if (!t || t.id === 'rankings' || !sortableTables().includes(t)) return;
  ev.stopPropagation();
  const k = tblKey(t), f = th.dataset.field, s = SORTS.get(k); let dir;
  if (s && s.f === f) dir = -s.dir;
  else { const ci = [...hdrRow(t).cells].indexOf(th), v = [...t.tBodies[0].rows].filter(r => !r.classList.contains('fx-inline') && !r.classList.contains('fx-injtog')).map(r => cellVal(r.cells[ci])).filter(x => x != null);
    const cmp = (p, q) => (typeof p === 'number' && typeof q === 'number' ? p - q : String(p).localeCompare(String(q)));
    const asc = ORDERED.has(f) || v.every((x, i) => i === 0 || cmp(v[i - 1], x) <= 0), desc = !ORDERED.has(f) && v.every((x, i) => i === 0 || cmp(v[i - 1], x) >= 0);
    dir = v.length > 1 && asc ? -1 : v.length > 1 && desc ? 1 : typeof v[0] === 'number' ? -1 : 1; }
  SORTS.set(k, { f, dir }); sortTable(t, f, dir);
}, true);

// ---------- Esc clears selections ----------
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape') return;
  if (INLINE) { closeInline(); INLINE = null; }
  const p = P(); if (p.myday != null || p.mday != null || p.tday != null || p.player != null) setParams({ myday: null, mday: null, tday: null, player: null });
});

// ---------- draw ----------
function stamp() {
  const m = meta(); if (!m) return;
  const age = Math.round((Date.now() - new Date(m.pulled_at)) / 60000), el = $('#asof'); el.replaceChildren();
  el.append('updated ' + m.pulled_label + ' (' + (age < 1 ? 'just now' : age < 60 ? age + ' min ago' : age < 1440 ? Math.round(age / 60) + ' h ago' : Math.round(age / 1440) + ' d ago') + ')');
  if (age > 240) el.append(' · ', txt('span', 'Updates look stuck: the ESPN cookies may have expired', 'stale'));
  $('#lgname').textContent = m.league;
}
function draw() {
  if (!meta()) return;
  stamp();
  const scrollY = window.scrollY;
  GBY = null;
  ({ me: drawMe, week: drawWeek, stream: drawStream, trade: drawTrade, standings: drawStandings, teams: drawTeams, players: drawPlayers, moves: drawMoves, trends: drawTrends })[tab]();
  applyRosterView(); applySorts(); reopenInline();
  window.scrollTo(0, scrollY);
}
async function start() {
  document.querySelectorAll('.fx-tab').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false'));
  TABS.forEach(id => { document.getElementById(id).hidden = id !== tab; });
  if (!(await load())) { $('#asof').textContent = 'no data yet: the first update hasn\'t finished'; return; }
  draw();
}
let lastW = window.innerWidth;
window.addEventListener('resize', () => { if (Math.abs(window.innerWidth - lastW) > 40) { lastW = window.innerWidth; draw(); } });
setInterval(stamp, 60000);
setInterval(async () => { // pick up new data quietly while the page is open
  if (document.hidden || !meta()) return;
  const m2 = await fetch('data/meta.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (m2 && m2[0] && m2[0].pulled_at !== meta().pulled_at && !document.activeElement?.matches('input, select')) { if (await load()) draw(); }
}, 3 * 60000);
start();
