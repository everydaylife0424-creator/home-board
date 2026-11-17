#!/usr/bin/env python3
"""Weekly recap helper for Claude's scheduled Monday run.

  python3 tools/weekly.py dump [YYYY-MM-DD]     # print last week's records (or the week of that Monday) as JSON
  python3 tools/weekly.py write MONDAY tips.json  # save Claude's suggestions to users/<uid>/weekly/<MONDAY>
  python3 tools/weekly.py toeic-dump [MONDAY]     # TOEIC plan tasks for that week (default: this week), errors, mocks, words already used
  python3 tools/weekly.py toeic-write sets.json   # save daily question sets to users/<uid>/toeic/set_<date> (answered sets are kept)
  python3 tools/weekly.py speak-dump [MONDAY]     # speaking: stage, which weekdays need scripts, last weeks' tries (accuracy, missed words, transcripts)
  python3 tools/weekly.py speak-audio-todo [--all] > todo.json   # scripts that still need natural-voice audio (sentences split like the app)
  python3 tools/weekly.py speak-audio-write audio.json          # save tools/tts.py output to speakaudio/<date>
  python3 tools/weekly.py speak-write scripts.json  # save speak/<date> scripts, or {"date","fb"} feedback on past ones (practice records are kept)

Needs the env var FIREBASE_SA: the Firebase service-account key JSON (raw or base64).
Optional HOME_UID to pick the user when the project has more than one.
The page (index.html) shows users/<uid>/weekly/<monday>.tips in the weekly review.
"""
import base64, datetime as dt, json, os, re, subprocess, sys

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


# ---- TOEIC: keep these tables in step with tc_t in index.html (zh) ----
TC_T = dict(
    base=["單字 30＋Part 5 二十題", "聽力：YouTube Part 3 兩組＋錯句跟讀｜Part 5 十題｜單字 10", "單字 30＋Part 6 兩篇", "聽力：YouTube Part 4 兩組＋錯句跟讀｜Part 5 十題｜單字 10", "單字 30＋Part 7 單篇 5 篇", "官方題本半份（聽力、閱讀輪流）＋檢討", "本週單字複習"],
    strat=["Part 7 多篇 3 組（計時）", "聽力：YouTube Part 3、4 先看選項練 3 組｜Part 5 十題｜單字 10", "Part 5 難題 30 題（限時 9 分鐘）", "聽力：YouTube Part 2 二十五題＋跟讀｜Part 6 一篇｜單字 10", "單字 30＋Part 7 單篇計時 8 篇", "官方題本半份＋整理錯題", "本週單字複習"],
    mock=["錯題本重做＋Part 5 二十題", "官方題本整份模考（計時 2 小時）", "單字 30＋Part 7 計時 5 篇", "聽力：YouTube 最弱的 Part 兩組｜Part 5 十題｜單字 10", "錯題本重做＋Part 6 兩篇", "官方題本整份模考（計時 2 小時）", None],
    diag="官方題本整份模考（起點，計時 2 小時）＋把分數記下來", eve="只複習錯題本和單字，早點睡", exam="多益考試 💪")
WHYS = ["單字", "文法", "沒聽懂", "換句話說沒對到", "時間不夠", "粗心"]

def tc_task(c, d):
    start, date = dt.date.fromisoformat(c["start"]), dt.date.fromisoformat(c["date"])
    if d < start or d > date: return None
    if d == date: return TC_T["exam"]
    if d == date - dt.timedelta(days=1): return TC_T["eve"]
    first_sat = start + dt.timedelta(days=(5 - start.weekday()) % 7)
    if d == first_sat: return TC_T["diag"]
    W = max(1, -(-(date - start).days // 7)); w = (d - start).days // 7; mock_w = 2 if W >= 6 else 1; base_w = max(1, round((W - mock_w) * 0.57))
    ph = "mock" if w >= W - mock_w else "base" if w < base_w else "strat"
    return TC_T[ph][d.weekday()]

def toeic_dump(arg=None):
    u = connect()
    c = (u.collection("settings").document("main").get().to_dict() or {}).get("toeic")
    if not c or not c.get("date"):
        print(json.dumps(dict(plan=None, note="No TOEIC plan yet (settings.toeic). Nothing to write."), ensure_ascii=False)); return
    c.setdefault("start", dt.datetime.now(TZ).date().isoformat())
    mon = dt.date.fromisoformat(arg) if arg else monday(dt.datetime.now(TZ).date())
    docs = [x.to_dict() for x in u.collection("toeic").stream()]
    sets = {x["date"]: x for x in docs if x.get("type") == "set"}
    week = []
    for i in range(7):
        d = mon + dt.timedelta(days=i); t = tc_task(c, d)
        week.append(dict(date=d.isoformat(), task=t, needsSet=bool(t) and "官方題本" not in t and "複習" not in t and "考試" not in t and "睡" not in t,
                         hasSet=d.isoformat() in sets, answered=bool(sets.get(d.isoformat(), {}).get("done"))))
    errs = sorted([x for x in docs if x.get("type") == "err"], key=lambda x: x.get("at") or 0)
    since = (mon - dt.timedelta(days=14)).isoformat()
    recent = [x for x in errs if (x.get("date") or "") >= since]
    count = lambda xs, f: {k: sum(1 for x in xs if f(x) == k) for k in sorted({f(x) for x in xs})}
    out = dict(plan=dict(date=c["date"], start=c["start"], base=c.get("base"), target=c.get("target")), week=week,
               errors=dict(total=len(errs), last14ByPart=count(recent, lambda x: f"Part {x.get('part')}"), last14ByWhy=count(recent, lambda x: WHYS[int(x.get("why") or 0)]),
                           recent=[dict(date=x.get("date"), part=x.get("part"), why=WHYS[int(x.get("why") or 0)], note=x.get("note")) for x in errs[-25:]]),
               mocks=sorted([dict(date=x.get("date"), L=x.get("L"), R=x.get("R")) for x in docs if x.get("type") == "mock"], key=lambda x: x["date"]),
               setScores=[dict(date=d, score=s.get("score"), of=sum(len(b.get("qs", [])) for b in s.get("blocks", []))) for d, s in sorted(sets.items()) if s.get("done")],
               wordsUsed=sorted({v.get("w") for s in sets.values() for v in s.get("vocab", []) if v.get("w")}),
               listenUsed=[dict(date=d, **v) for d, s in sorted(sets.items()) for v in s.get("listen", [])])
    print(json.dumps(out, ensure_ascii=False, indent=1))

def toeic_write(path):
    data = json.load(open(path, encoding="utf-8"))
    sets = data.get("sets", data) if isinstance(data, dict) else data
    u = connect(); n = 0
    for st in sets:
        d = dt.date.fromisoformat(st["date"]).isoformat()
        blocks = []
        for b in st.get("blocks", []):
            qs = [q for q in b.get("qs", []) if q.get("q") is not None and isinstance(q.get("opts"), list) and 2 <= len(q["opts"]) <= 4 and isinstance(q.get("a"), int) and 0 <= q["a"] < len(q["opts"])]
            if qs: blocks.append({**{k: b[k] for k in ("part", "passage", "pzh", "script") if b.get(k)}, "qs": qs})
        vocab = [v for v in st.get("vocab", []) if v.get("w") and v.get("zh")]
        listen = [{k: str(v[k]) for k in ("title", "url", "note") if v.get(k)} for v in st.get("listen", [])
                  if re.match(r"https://(www\.youtube\.com/watch\?v=|youtu\.be/)[\w-]{11}", v.get("url") or "")]
        if not blocks and not vocab and not listen: print(f"skip {d}: nothing valid"); continue
        ref = u.collection("toeic").document("set_" + d); old = ref.get()
        if old.exists and old.to_dict().get("done"): print(f"keep {d}: already answered"); continue
        ref.set(dict(id="set_" + d, type="set", date=d, vocab=vocab, listen=listen, blocks=blocks, ans={}, done=False, by="Claude", at=int(dt.datetime.now().timestamp() * 1000)))
        n += 1; print(f"saved set_{d}: {len(vocab)} words, {len(listen)} videos, {sum(len(b['qs']) for b in blocks)} questions")
    print(f"{n} sets written")

SP_MODES = ("read", "retell", "answer", "talk")

def speak_dump(arg=None):
    u = connect()
    c = (u.collection("settings").document("main").get().to_dict() or {}).get("speak")
    if not c or not c.get("start"):
        print(json.dumps(dict(plan=None, note="Speaking not started yet (settings.speak). Nothing to write."), ensure_ascii=False)); return
    mon = dt.date.fromisoformat(arg) if arg else monday(dt.datetime.now(TZ).date())
    docs = {x.id: x.to_dict() for x in u.collection("speak").stream()}
    stage = int(c.get("stage") or 1)
    week = [dict(date=(mon + dt.timedelta(days=i)).isoformat(), hasScript=(mon + dt.timedelta(days=i)).isoformat() in docs) for i in range(5)]
    since = (mon - dt.timedelta(days=21)).isoformat()
    past = []
    for d, x in sorted(docs.items()):
        if d < since or d >= mon.isoformat(): continue
        past.append(dict(date=d, mode=x.get("mode"), kind=x.get("kind"), title=x.get("title"), hasFeedback=bool(x.get("fb")),
                         tries=[{k: t.get(k) for k in ("acc", "wpm", "n", "sec", "miss", "said")} for t in (x.get("tries") or [])][-3:]))
    print(json.dumps(dict(plan=dict(start=c["start"], stage=stage, since=c.get("since")), modeForStage={1: "read", 2: "retell", 3: "answer (job) / talk (conversation)"}[stage],
                          week=week, past=past, titlesUsed=sorted({x.get("title") for x in docs.values() if x.get("title")})), ensure_ascii=False, indent=1))

def speak_write(path):
    data = json.load(open(path, encoding="utf-8"))
    items = data.get("scripts", data) if isinstance(data, dict) else data
    u = connect(); n = f = 0
    for it in items:
        d = dt.date.fromisoformat(it["date"]).isoformat(); ref = u.collection("speak").document(d); old = ref.get(); o = old.to_dict() if old.exists else {}
        if set(it) <= {"date", "fb"}:
            if old.exists and it.get("fb"): ref.set({**o, "fb": it["fb"]}); f += 1; print(f"feedback {d}")
            continue
        mode = it.get("mode") or "read"
        if mode not in SP_MODES: print(f"skip {d}: bad mode {mode}"); continue
        body = {k: it[k] for k in ("title", "kind", "text", "q", "tips", "sample", "turns", "fb") if it.get(k)}
        if mode in ("read", "retell") and not body.get("text"): print(f"skip {d}: no text"); continue
        if mode == "answer" and not body.get("q"): print(f"skip {d}: no question"); continue
        if mode == "talk":
            body["turns"] = [t for t in body.get("turns", []) if t.get("say")]
            if not body["turns"]: print(f"skip {d}: no turns"); continue
        keep = {k: o[k] for k in ("tries", "steps", "done") if k in o}
        ref.set(dict(id=d, type="script", date=d, mode=mode, by="Claude", at=int(dt.datetime.now().timestamp() * 1000), **body, **keep))
        n += 1; print(f"saved speak/{d}: {mode} · {body.get('title','')}")
    print(f"{n} scripts written, {f} feedback notes")

SENT = re.compile(r'[^.!?]+[.!?]+["\u201d\u2019)]*\s*|[^.!?]+$')

def speak_audio_todo(all_=False):
    u = connect(); today = dt.datetime.now(TZ).date().isoformat()
    have = {d.id for d in u.collection("speakaudio").stream()}
    out = []
    for d in u.collection("speak").stream():
        x = d.to_dict()
        if x.get("type") != "script" or (d.id in have and not all_) or (d.id < today and not all_): continue
        it = dict(date=d.id)
        if x.get("text") and x.get("mode") in ("read", "retell", None): it["sens"] = SENT.findall(x["text"]) or [x["text"]]
        if x.get("turns"): it["turns"] = [dict(who=t.get("who", ""), say=t.get("say", "")) for t in x["turns"]]
        if len(it) > 1: out.append(it)
    print(json.dumps(out, ensure_ascii=False, indent=1))

def speak_audio_write(path):
    u = connect(); n = 0
    for it in json.load(open(path)):
        body = {k: it[k] for k in ("sens", "turns", "voice") if it.get(k)}
        size = len(json.dumps(body))
        if size > 950_000: print(f"skip {it['date']}: {size} bytes is too big for one document"); continue
        u.collection("speakaudio").document(it["date"]).set(dict(date=it["date"], at=int(dt.datetime.now().timestamp() * 1000), **body)); n += 1
        print(f"saved speakaudio/{it['date']}: {len(body.get('sens', []))} sentences, {len(body.get('turns', []))} turns, {size // 1024} KB")
    print(f"{n} audio docs written")

if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["dump"]:
        dump(a[1] if len(a) > 1 else None)
    elif a[:1] == ["write"] and len(a) == 3:
        write(a[1], a[2])
    elif a[:1] == ["toeic-dump"]:
        toeic_dump(a[1] if len(a) > 1 else None)
    elif a[:1] == ["toeic-write"] and len(a) == 2:
        toeic_write(a[1])
    elif a[:1] == ["speak-audio-todo"]:
        speak_audio_todo("--all" in a)
    elif a[:1] == ["speak-audio-write"] and len(a) == 2:
        speak_audio_write(a[1])
    elif a[:1] == ["speak-dump"]:
        speak_dump(a[1] if len(a) > 1 else None)
    elif a[:1] == ["speak-write"] and len(a) == 2:
        speak_write(a[1])
    else:
        sys.exit(__doc__)
