#!/usr/bin/env python3
"""Weekly recap helper for Claude's scheduled Monday run.

  python3 tools/weekly.py dump [YYYY-MM-DD]     # print last week's records (or the week of that Monday) as JSON
  python3 tools/weekly.py write MONDAY tips.json  # save Claude's suggestions to users/<uid>/weekly/<MONDAY>

Needs the env var FIREBASE_SA: the Firebase service-account key JSON (raw or base64).
Optional HOME_UID to pick the user when the project has more than one.
The page (index.html) shows users/<uid>/weekly/<monday>.tips in the weekly review.
"""
import base64, datetime as dt, json, os, subprocess, sys

def ensure_sdk():
    try:
        import firebase_admin  # noqa: F401
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "firebase-admin"])

def connect():
    ensure_sdk()
    import firebase_admin
    from firebase_admin import auth, credentials, firestore
    raw = os.environ.get("FIREBASE_SA", "").strip()
    if not raw:
        sys.exit("FIREBASE_SA is not set: add the Firebase service-account key to the cloud environment.")
    if not raw.startswith("{"):
        raw = base64.b64decode(raw).decode()
    firebase_admin.initialize_app(credentials.Certificate(json.loads(raw)))
    uid = os.environ.get("HOME_UID")
    if not uid:
        users = [u for u in auth.list_users().iterate_all()]
        if len(users) != 1:
            sys.exit(f"{len(users)} users in this project; set HOME_UID.")
        uid = users[0].uid
    return firestore.client().collection("users").document(uid)

TZ = dt.timezone(dt.timedelta(hours=8))  # Asia/Taipei

def monday(d):
    return d - dt.timedelta(days=d.weekday())

def dump(arg=None):
    u = connect()
    mon = dt.date.fromisoformat(arg) if arg else monday(dt.datetime.now(TZ).date()) - dt.timedelta(days=7)
    sun = mon + dt.timedelta(days=6)
    lo, hi = (mon - dt.timedelta(days=21)).isoformat(), (sun + dt.timedelta(days=14)).isoformat()
    inwk = lambda s: bool(s) and mon.isoformat() <= s <= sun.isoformat()
    days = {d.id: d.to_dict() for d in u.collection("days").stream() if lo <= d.id <= sun.isoformat()}
    def items(d):
        out = [dict(t=i.get("t"), done=bool(i.get("d")), doneOn=i.get("dn"), src="To-do") for i in d.get("items", []) if not i.get("k")]
        for p in d.get("projects", []):
            out += [dict(t=i.get("t"), done=bool(i.get("d")), doneOn=i.get("dn"), src=p.get("name")) for i in p.get("items", []) if not i.get("k")]
        return out
    week_days = [dict(date=k, mood=v.get("mood"), review=v.get("review"), weekNote=v.get("weekNote"), items=items(v)) for k, v in sorted(days.items()) if inwk(k)]
    prev = []
    for w in range(1, 4):
        a, b = (mon - dt.timedelta(days=7 * w)).isoformat(), (sun - dt.timedelta(days=7 * w)).isoformat()
        its = [i for k, v in days.items() if a <= k <= b for i in items(v)]
        prev.append(dict(week=a, planned=len(its), done=sum(i["done"] for i in its)))
    tasks = [t.to_dict() for t in u.collection("tasks").stream()]
    ms = lambda t: dt.datetime.fromtimestamp(t / 1000, TZ).date().isoformat() if t else None
    board = dict(
        doneThisWeek=[dict(title=t.get("title"), due=t.get("due")) for t in tasks if t.get("done") and inwk(ms(t.get("doneAt")) or t.get("due"))],
        open=[dict(title=t.get("title"), due=t.get("due"), column=t.get("bucket")) for t in tasks if not t.get("done") and not t.get("k")],
    )
    events = sorted([dict(date=e.get("date"), title=e.get("title"), kind=e.get("kind")) for e in (x.to_dict() for x in u.collection("events").stream())
                     if lo <= (e.get("date") or "") <= hi], key=lambda e: e["date"])
    gym = []
    for m in {mon.strftime("%Y-%m"), sun.strftime("%Y-%m")}:
        g = u.collection("gymlog").document(m).get()
        if g.exists:
            gym += [dict(date=e.get("date"), ex=e.get("exName"), sets=e.get("sets"), weight=e.get("weight"), rpe=e.get("rpe")) for e in g.to_dict().get("entries", []) if inwk(e.get("date"))]
    plan = (u.collection("gym").document("plan").get().to_dict() or {})
    spend = []
    for m in {mon.strftime("%Y-%m"), sun.strftime("%Y-%m")}:
        x = u.collection("expenses").document(m).get()
        if x.exists:
            spend += [dict(date=e.get("date"), amount=e.get("amount"), cat=e.get("cat"), note=e.get("note")) for e in x.to_dict().get("entries", []) if inwk(e.get("date")) and e.get("type") != "in"]
    out = dict(week=dict(monday=mon.isoformat(), sunday=sun.isoformat()), days=week_days, previousWeeks=prev, board=board,
               calendarMarks=events, gym=dict(entries=sorted(gym, key=lambda e: e["date"] or ""), program=plan.get("program")),
               spending=spend, kinds={"deadline": "⚑ deadline", "event": "★ key event", "busy": "◆ all-day plan"})
    print(json.dumps(out, ensure_ascii=False, indent=1, default=str))

def write(mon, path):
    dt.date.fromisoformat(mon)
    tips = json.load(open(path, encoding="utf-8"))
    if isinstance(tips, dict):
        tips = tips.get("tips", [])
    tips = [str(t).strip() for t in tips if str(t).strip()][:8]
    if not tips:
        sys.exit("no tips to write")
    u = connect()
    u.collection("weekly").document(mon).set(dict(monday=mon, tips=tips, by="Claude", at=int(dt.datetime.now().timestamp() * 1000)))
    print(f"saved {len(tips)} tips to weekly/{mon}")

if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["dump"]:
        dump(a[1] if len(a) > 1 else None)
    elif a[:1] == ["write"] and len(a) == 3:
        write(a[1], a[2])
    else:
        sys.exit(__doc__)
