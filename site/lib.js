// Shared by the page (browser) and analyze.mjs (Node).
// ESPN's 10 starting slots: PG, SG, SF, PF, C, G, F and 3 UTIL.
export const SL = [["PG"], ["SG"], ["SF"], ["PF"], ["C"], ["PG", "SG"], ["SF", "PF"], null, null, null];
export const ADD_LIMIT = 7, ROSTER_MAX = 13, CENTER_MAX = 4;

// Best legal lineup from a list of {pos:[...], v}. Greedy by value with augmenting paths, which is optimal here.
export function bestLineup(list) {
  const s = list.filter(p => p.v > 0).sort((a, b) => b.v - a.v), m = SL.map(() => -1), used = [];
  const can = (i, k) => !SL[k] || SL[k].some(x => s[i].pos.includes(x));
  const place = (i, seen) => {
    for (let k = 0; k < SL.length; k++) {
      if (seen[k] || !can(i, k)) continue;
      seen[k] = true;
      if (m[k] < 0 || place(m[k], seen)) { m[k] = i; return true; }
    }
    return false;
  };
  s.forEach((p, i) => { if (used.length < SL.length && place(i, [])) used.push(p); });
  return { total: used.reduce((a, p) => a + p.v, 0), used, count: used.length };
}

export const avgOf = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

export const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Expected fantasy points per game: season average blended with the MEDIAN of the last 5 games
// (so one big night doesn't drive it), leaning on ESPN's projection while the sample is small.
export function expected(p, last5) {
  const gp = p.games_played || 0, avg = p.avg || 0, proj = p.proj_avg || avg;
  const w = Math.min(gp, 10) / 12;
  const form = last5 != null ? 0.6 * avg + 0.4 * last5 : avg;
  return w * form + (1 - w) * proj;
}

// How much of a player to count right now.
export const availability = status => status === "Healthy" ? 1 : status === "DTD" ? 0.75 : 0;

export const phi = z => { // normal CDF
  const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
};
