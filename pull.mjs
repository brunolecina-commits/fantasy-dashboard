// Pulls the league from ESPN's fantasy API using the two login cookies (ESPN_S2, ESPN_SWID env vars)
// and prints the compact league JSON to stdout. Usage: node pull.mjs > raw.json
const S2 = process.env.ESPN_S2, SWID = process.env.ESPN_SWID;
if (!S2 || !SWID) { console.error("Missing ESPN_S2 or ESPN_SWID"); process.exit(2); }
const SEASON = 2027, LEAGUE = 2002554146;
const host = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/" + SEASON;
const base = `${host}/segments/0/leagues/${LEAGUE}`;
const cookie = `espn_s2=${S2}; SWID=${SWID}`;
const j = async (u, h) => {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(u, { headers: { Cookie: cookie, Accept: "application/json", "User-Agent": "Mozilla/5.0 fantasy-dashboard", ...(h || {}) } });
    if (r.ok) return r.json();
    if (r.status === 401 || r.status === 403) { console.error(`ESPN refused the request (${r.status}). The cookies are probably wrong or expired.`); process.exit(3); }
    if (attempt >= 3) { console.error(`ESPN request failed with status ${r.status}: ${u.split("?")[0]}`); process.exit(4); }
    await new Promise(res => setTimeout(res, 2000 * attempt));
  }
};

const L = await j(`${base}?view=mRoster&view=mTeam&view=mMatchupScore&view=mStatus&view=mSettings`);
const sp = L.scoringPeriodId, mp = L.status.currentMatchupPeriod;
const P = await j(`${host}?view=proTeamSchedules_wl`);
const pro = {}; P.settings.proTeams.forEach(t => pro[t.id] = t.abbrev);
const eligN = { 0: "PG", 1: "SG", 2: "SF", 3: "PF", 4: "C" };
const slotN = { 0: "PG", 1: "SG", 2: "SF", 3: "PF", 4: "C", 5: "G", 6: "F", 11: "UTIL", 12: "BE", 13: "IR" };
const players = {}, names = {};
for (const t of L.teams) for (const e of t.roster.entries) {
  const p = e.playerPoolEntry.player;
  const st = k => (p.stats || []).find(s => s.statSplitTypeId === 0 && s.statSourceId === k && s.seasonId === SEASON);
  const a = st(0), pr = st(1);
  names[p.id] = p.fullName;
  players[p.id] = { n: p.fullName, t: t.id, slot: slotN[e.lineupSlotId] ?? String(e.lineupSlotId), el: p.eligibleSlots.filter(x => x <= 4).map(x => eligN[x]).join(","), pro: pro[p.proTeamId] || "FA", inj: p.injuryStatus || "ACTIVE", avg: +(a?.appliedAverage || 0).toFixed(1), gp: a?.stats?.["42"] || 0, pavg: +(pr?.appliedAverage || 0).toFixed(1), g: {} };
}
const wk1 = mp === 1 ? 1 : 7 * mp - 14; // game log covers this week and last week (Mon-Sun matchups; week 1 = days 1-6)
// full-strength projection per team per day: best legal lineup from EVERY player rostered that day (IR and injured included)
// whose NBA team played, by ESPN's season projection per game. Actual minus this = luck, injuries counted as bad luck.
const proG = {}; P.settings.proTeams.forEach(t => proG[t.id] = t.proGamesByScoringPeriod || {});
const SL = [["PG"], ["SG"], ["SF"], ["PF"], ["C"], ["PG", "SG"], ["SF", "PF"], null, null, null];
const bestSum = (list) => { const s = list.slice().sort((a, b) => b.v - a.v), m = SL.map(() => -1); let n = 0, tot = 0;
  const can = (i, k) => !SL[k] || SL[k].some(x => s[i].pos.includes(x));
  const place = (i, seen) => { for (let k = 0; k < SL.length; k++) { if (seen[k] || !can(i, k)) continue; seen[k] = true; if (m[k] < 0 || place(m[k], seen)) { m[k] = i; return true; } } return false; };
  s.forEach((p, i) => { if (n < SL.length && place(i, [])) { n++; tot += p.v; } }); return Math.round(tot); };
const tproj = [], ex = {}; // ex: players who were on a roster on a logged day but are not rostered now
// Settled days older than the game-log window are read from the saved history instead of being fetched again.
const { existsSync, readFileSync } = await import("node:fs");
const saved = existsSync("history/tproj.json") ? JSON.parse(readFileSync("history/tproj.json", "utf8")) : [];
const savedBy = {}; saved.forEach(x => (savedBy[x[0]] = savedBy[x[0]] || []).push(x));
for (let d = 1; d <= sp; d++) {
  if (d < wk1 && d < sp - 1 && (savedBy[d] || []).length === L.teams.length) { tproj.push(...savedBy[d]); continue; }
  const D = await j(`${base}?view=mRoster&scoringPeriodId=${d}`);
  for (const t of D.teams) { const cand = [];
    for (const e of t.roster.entries) {
      const p = e.playerPoolEntry.player;
      if (d >= wk1) { const g = (p.stats || []).find(s => s.statSplitTypeId === 5 && s.scoringPeriodId === d && s.statSourceId === 0);
        if (g) { const rec = [+(g.appliedTotal || 0).toFixed(0), slotN[e.lineupSlotId] ?? "", t.id]; if (players[p.id]) players[p.id].g[d] = rec; else { const pr2 = (p.stats || []).find(s => s.statSplitTypeId === 0 && s.statSourceId === 1 && s.seasonId === SEASON); (ex[p.id] = ex[p.id] || { n: p.fullName, pro: pro[p.proTeamId] || "FA", el: p.eligibleSlots.filter(x => x <= 4).map(x => eligN[x]).join(","), pavg: +(pr2?.appliedAverage || 0).toFixed(1), g: {} }).g[d] = rec; } } }
      if ((proG[p.proTeamId]?.[d] || []).length) { const pr = (p.stats || []).find(s => s.statSplitTypeId === 0 && s.statSourceId === 1 && s.seasonId === SEASON);
        if (pr?.appliedAverage) cand.push({ pos: p.eligibleSlots.filter(x => x <= 4).map(x => eligN[x]), v: pr.appliedAverage }); }
    }
    tproj.push([d, t.id, bestSum(cand)]);
  }
}
const games = {};
P.settings.proTeams.forEach(t => { const out = []; for (let d = sp; d <= sp + 14; d++) (t.proGamesByScoringPeriod?.[d] || []).forEach(g => { const home = g.homeProTeamId === t.id; out.push(d + (home ? "v" : "@") + pro[home ? g.awayProTeamId : g.homeProTeamId]); }); games[t.abbrev] = out.join(","); });
const S = await j(`${base}?view=mScoreboard&view=mMatchup`);
const daily = {}; S.schedule.filter(x => x.matchupPeriodId <= mp).forEach(x => [x.home, x.away].forEach(s => { if (s) daily[s.teamId] = Object.assign(daily[s.teamId] || {}, s.pointsByScoringPeriod || {}); }));
const f = { topics: { filterType: { value: ["ACTIVITY_TRANSACTIONS"] }, limit: 200, limitPerMessageSet: { value: 25 }, offset: 0, sortMessageDate: { sortPriority: 1, sortAsc: false }, sortFor: { sortPriority: 2, sortAsc: false }, filterIncludeMessageTypeIds: { value: [178, 180, 179, 239, 181, 244, 245] } } };
const A = await j(`${base}/communication/?view=kona_league_communication`, { "x-fantasy-filter": JSON.stringify(f) });
const act = (A.topics || []).map(t => [t.date, t.messages.map(m => [m.messageTypeId, m.targetId, m.from ?? "", m.to ?? ""].join(":")).join("|")]);
const need = [...new Set(act.flatMap(a => a[1].split("|").map(x => +x.split(":")[1])))].filter(id => !names[id]);
const extra = {};
if (need.length) { const arr = await j(`${host}/players?view=players_wl`, { "x-fantasy-filter": JSON.stringify({ filterIds: { value: need } }) }); (Array.isArray(arr) ? arr : []).forEach(p => extra[p.id] = p.fullName); }
// player pool: all rostered players + top 60 free agents/waivers, with last 10 games
const kq = async (status, limit) => ((await j(`${base}?view=kona_player_info&scoringPeriodId=${sp}`, { "x-fantasy-filter": JSON.stringify({ players: { filterStatus: { value: status }, limit, sortAppliedStatTotal: { sortAsc: false, sortPriority: 1, value: "00" + SEASON }, filterStatsForTopScoringPeriodIds: { value: 10, additionalValue: ["00" + SEASON, "10" + SEASON] } } }) })).players || []);
const r1 = x => +(+x || 0).toFixed(1);
const pool = [...await kq(["ONTEAM"], 200), ...await kq(["FREEAGENT", "WAIVERS"], 60)].map(e => { const p = e.player; const s = k => (p.stats || []).find(x => x.id === k); const a = s("00" + SEASON), pr = s("10" + SEASON); const av = a?.averageStats || {};
  const g = (p.stats || []).filter(x => x.statSplitTypeId === 5 && x.seasonId === SEASON && x.statSourceId === 0).sort((x, y) => x.scoringPeriodId - y.scoringPeriodId).map(x => x.scoringPeriodId + ":" + Math.round(x.appliedTotal || 0) + ":" + Math.round(x.stats?.["40"] || 0)).join("|");
  return [p.id, p.fullName, e.onTeamId || 0, e.status === "ONTEAM" ? "" : e.status === "WAIVERS" ? "W" : "FA", pro[p.proTeamId] || "FA", p.eligibleSlots.filter(x => x <= 4).map(x => eligN[x]).join(","), p.injuryStatus === "ACTIVE" || !p.injuryStatus ? "" : p.injuryStatus === "DAY_TO_DAY" ? "DTD" : p.injuryStatus, r1(p.ownership?.percentOwned), e.ratings?.["0"]?.totalRanking || 0, a?.stats?.["42"] || 0, Math.round(a?.appliedTotal || 0), r1(a?.appliedAverage), r1(pr?.appliedAverage), Math.round(pr?.appliedTotal || 0), [0, 6, 3, 2, 1, 17, 11, 40].map(k => r1(av[k])).concat([r1((av[19] || 0) * 100)]).join(","), g, [0, 6, 3, 2, 1, 17, 11, 40].map(k => r1((pr?.averageStats || {})[k])).join(",")]; });
process.stdout.write(JSON.stringify({ lg: L.settings.name, sp, mp, reg: L.settings.scheduleSettings.matchupPeriodCount, po: L.settings.scheduleSettings.playoffTeamCount, at: Date.now(),
  teams: L.teams.map(t => [t.id, (t.name || "").trim(), t.abbrev, t.record.overall.wins, t.record.overall.losses, t.record.overall.pointsFor]),
  sched: L.schedule.map(m => [m.matchupPeriodId, m.home?.teamId, m.away?.teamId, m.home?.totalPointsLive ?? m.home?.totalPoints, m.away?.totalPointsLive ?? m.away?.totalPoints]),
  daily,
  pl: Object.entries(players).map(([id, p]) => [+id, p.n, p.t, p.slot, p.el, p.pro, p.inj === "ACTIVE" ? "" : p.inj === "DAY_TO_DAY" ? "DTD" : p.inj, p.avg, p.gp, p.pavg, Object.entries(p.g).filter(([d, g]) => g[0] !== 0 || g[1] !== "IR").map(([d, g]) => d + ":" + g[0] + ":" + g[1] + ":" + g[2]).join("|")]),
  games, act, names: extra, pool, tproj,
  ex: Object.entries(ex).map(([id, p]) => [+id, p.n, p.pro, p.el, p.pavg, Object.entries(p.g).filter(([d, g]) => g[0] !== 0 || g[1] !== "IR").map(([d, g]) => d + ":" + g[0] + ":" + g[1] + ":" + g[2]).join("|")]) }));
