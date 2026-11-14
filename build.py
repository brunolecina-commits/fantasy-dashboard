"""Turn the compact ESPN pull (raw.json) into the dashboard's dataset files.

Usage: python3 build.py raw.json out_dir
"""
import json, sys, datetime as dt, os

raw_path, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
d = json.load(open(raw_path))

DAY1 = dt.date(2026, 10, 20)          # scoring period 1 = Tue Oct 20, 2026
def day_date(sp): return (DAY1 + dt.timedelta(days=int(sp) - 1)).isoformat()
def week_days(mp):                    # matchups run Mon-Sun; week 1 is opening night (Tue Oct 20, day 1) to Sun Oct 25 (day 6)
    mp = int(mp)
    return (1, 6) if mp == 1 else (7 * mp - 7, 7 * mp - 1)

MANAGERS = {1: "Michael", 2: "Bruno", 3: "Muhammad", 4: "Jack", 5: "Ronak",
            6: "Prof. X", 7: "Ekansh", 8: "Ayaan", 9: "Blas", 10: "Kavin"}

ws, we = week_days(d["mp"])
from zoneinfo import ZoneInfo
_f = dt.datetime.fromtimestamp(d["at"] / 1000, dt.timezone.utc)
fetched = _f.isoformat()
_l = _f.astimezone(ZoneInfo("America/Toronto"))
pulled_label = _l.strftime("%a %b ") + str(_l.day) + _l.strftime(", ") + str(int(_l.strftime("%I"))) + _l.strftime(":%M %p ET")

meta = [{"league": d["lg"], "today_day": d["sp"], "today": day_date(d["sp"]),
         "week": d["mp"], "week_start_day": ws, "week_end_day": we,
         "week_start": day_date(ws), "week_end": day_date(we),
         "regular_weeks": d["reg"], "playoff_teams": d["po"], "pulled_at": fetched, "pulled_label": pulled_label,
         "my_team_id": 2}]

teams = [{"team_id": t[0], "team": t[1], "abbrev": t[2], "manager": MANAGERS.get(t[0], ""),
          "wins": t[3], "losses": t[4], "points_for": t[5]} for t in d["teams"]]

matchups = []
for wk, h, a, hs, as_ in d["sched"]:
    matchups.append({"week": wk, "team_id": h, "opp_id": a, "pts": hs, "opp_pts": as_, "home": True})
    matchups.append({"week": wk, "team_id": a, "opp_id": h, "pts": as_, "opp_pts": hs, "home": False})

full = {(t, dd): v for dd, t, v in d.get("tproj", [])}  # full-strength projection (every rostered player healthy)
daily = [{"team_id": int(tid), "day": int(sp), "date": day_date(sp), "points": pts, "proj_full": full.get((int(tid), int(sp)))}
         for tid, days in d["daily"].items() for sp, pts in days.items()]

players, log = [], []
for pid, name, tid, slot, el, pro, inj, avg, gp, pavg, g in d["pl"]:
    players.append({"player_id": pid, "player": name, "team_id": tid, "slot": slot,
                    "positions": el, "nba_team": pro, "status": inj or "Healthy",
                    "avg": avg, "games_played": gp, "proj_avg": pavg})
    for part in filter(None, g.split("|")):
        bits = part.split(":")      # day:pts:slot[:team that day]
        sp, pts, s = bits[:3]
        log.append({"player_id": pid, "team_id": int(bits[3]) if len(bits) > 3 else tid, "day": int(sp), "date": day_date(sp),
                    "pts": int(pts), "slot": s})
# players who were on a roster on a logged day but aren't rostered now (dropped since): keep their days on the team they were on
for pid, name, pro, el, pavg, g in d.get("ex", []):
    for part in filter(None, g.split("|")):
        sp, pts, s, t = part.split(":")
        log.append({"player_id": pid, "team_id": int(t), "day": int(sp), "date": day_date(sp),
                    "pts": int(pts), "slot": s, "player": name, "positions": el, "proj_avg": pavg})

schedule = []
for team, s in d["games"].items():
    for g in filter(None, s.split(",")):
        i = g.find("v") if "v" in g else g.find("@")
        sp, ha, opp = g[:i], g[i], g[i + 1:]
        schedule.append({"nba_team": team, "day": int(sp), "date": day_date(sp),
                         "home": ha == "v", "opp": opp})

# league activity: 178 FA add, 180 waiver add, 179/181/239 drop, 244 trade
names = {str(p[0]): p[1] for p in d["pl"]}
names.update({str(k): v for k, v in d["names"].items()})
KIND = {"178": "Add", "180": "Add (waiver)", "179": "Drop", "181": "Drop", "239": "Drop", "244": "Trade", "245": "Drop"}  # 245 = dropped to make room in a trade
activity, owner = [], {}
for n, (ts, msgs) in enumerate(sorted(d["act"], key=lambda a: a[0])):
    when = dt.datetime.fromtimestamp(ts / 1000, dt.timezone.utc).isoformat()
    for m in msgs.split("|"):
        typ, pid, frm, to = (m.split(":") + ["", ""])[:4]
        frm = int(frm) if frm.lstrip("-").isdigit() else None
        to = int(to) if to.lstrip("-").isdigit() else None
        if typ == "244":
            team, f, t = frm, frm, to
        elif typ in ("178", "180"):
            team, f, t = to, None, to
        elif typ == "245":  # dropped as part of a trade: team is in `from`
            team = frm
            f, t = team, None
        else:  # drops: team is in `to` for 179/181; 239 carries none, so use the last known owner
            team = to if to and to > 0 else owner.get(pid)
            f, t = team, None
        if typ in ("244", "178", "180"):
            owner[pid] = t
        activity.append({"event": f"e{n:03d}", "time": when, "kind": KIND.get(typ, typ),
                         "team_id": team, "player": names.get(pid, pid),
                         "from_id": f, "to_id": t})


# player pool: every rostered player plus the top free agents, with real stat lines
team_name = {t[0]: t[1] for t in d["teams"]}
pool, pgames = [], []
for row in d.get("pool", []):
    pid, name, tid, fa, pro, el, inj, own, rank, gp, tot, avg, pavg, ptot, line, g = row[:16]
    pline = row[16] if len(row) > 16 else "0,0,0,0,0,0,0,0"
    pts, reb, ast, stl, blk, tpm, tov, mins, fgp = [float(x) for x in line.split(",")]
    p_pts, p_reb, p_ast, p_stl, p_blk, p_tpm, p_tov, p_min = [float(x) for x in pline.split(",")]
    pool.append({"player_id": pid, "player": name, "team_id": tid,
                 "fantasy_team": team_name.get(tid) if tid else ("Waivers" if fa == "W" else "Free agent"),
                 "nba_team": pro, "positions": el, "status": inj or "Healthy", "pct_owned": own,
                 "espn_rank": rank or None, "games_played": gp, "total_pts": tot, "avg": avg,
                 "proj_avg": pavg or None, "proj_total": ptot or None,
                 "pts": pts, "reb": reb, "ast": ast, "stl": stl, "blk": blk, "tpm": tpm, "tov": tov,
                 "min": mins, "fg_pct": fgp,
                 "proj_pts": p_pts, "proj_reb": p_reb, "proj_ast": p_ast, "proj_stl": p_stl, "proj_blk": p_blk,
                 "proj_tpm": p_tpm, "proj_tov": p_tov, "proj_min": p_min})
    for part in filter(None, g.split("|")):
        sp, fp, mn = part.split(":")
        if int(mn) <= 0:
            continue  # did not play
        pgames.append({"player_id": pid, "day": int(sp), "date": day_date(sp), "fpts": int(fp), "min": int(mn)})

files = {"meta": meta, "teams": teams, "matchups": matchups, "daily": daily,
         "players": players, "game_log": log, "nba_schedule": schedule, "activity": activity, "player_pool": pool, "player_games": pgames}
for k, v in files.items():
    json.dump(v, open(os.path.join(out, f"{k}.json"), "w"), ensure_ascii=False)
    print(k, len(v))
