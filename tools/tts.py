"""Record natural-voice audio for speaking scripts with Kokoro (Apache-2.0 model, kokoro-onnx MIT).

Runs WITHOUT Firebase access: it only reads the todo file written by
`weekly.py speak-audio-todo` and writes base64 MP3 clips for `weekly.py speak-audio-write`.
Run it with the key removed from the environment:

  env -u FIREBASE_SA python3 tools/tts.py /tmp/todo.json /tmp/audio.json [--voice af_bella] [--male am_fenrir]   (Adam picked Bella and Fenrir)

Needs: pip install kokoro-onnx soundfile, and ffmpeg. Model files (~350 MB) are downloaded
once from the kokoro-onnx GitHub release into ~/.cache/kokoro.
"""
import base64, json, os, subprocess, sys, tempfile, urllib.request

REL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
CACHE = os.path.expanduser("~/.cache/kokoro")
FEMALE = ("sarah", "emma", "anna", "lisa", "kate", "amy", "jenny", "olivia", "mia", "w", "f", "she")

def model():
    os.makedirs(CACHE, exist_ok=True)
    for f in ("kokoro-v1.0.onnx", "voices-v1.0.bin"):
        p = os.path.join(CACHE, f)
        if not os.path.exists(p) or os.path.getsize(p) < 1_000_000:
            print("downloading", f, file=sys.stderr); urllib.request.urlretrieve(REL + f, p)
    from kokoro_onnx import Kokoro
    return Kokoro(os.path.join(CACHE, "kokoro-v1.0.onnx"), os.path.join(CACHE, "voices-v1.0.bin"))

def mp3(k, text, voice):
    import soundfile as sf
    a, sr = k.create(text.strip(), voice=voice, speed=1.0, lang="en-us")
    with tempfile.TemporaryDirectory() as d:
        w, m = os.path.join(d, "a.wav"), os.path.join(d, "a.mp3")
        sf.write(w, a, sr)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", w, "-ac", "1", "-b:a", "40k", m], check=True)
        return base64.b64encode(open(m, "rb").read()).decode()

def main():
    a = sys.argv[1:]
    if len(a) < 2: sys.exit(__doc__)
    if os.environ.get("FIREBASE_SA"): sys.exit("Remove FIREBASE_SA first: env -u FIREBASE_SA python3 tools/tts.py ...")
    opt = lambda k, d: a[a.index(k) + 1] if k in a else d
    fv, mv = opt("--voice", "af_bella"), opt("--male", "am_fenrir")
    todo = json.load(open(a[0], encoding="utf-8")); k = model(); out = []
    for it in todo:
        rec = dict(date=it["date"], voice=fv)
        if it.get("sens"): rec["sens"] = [mp3(k, s, fv) for s in it["sens"]]
        if it.get("turns"): rec["turns"] = [mp3(k, t["say"], fv if str(t.get("who", "")).lower().startswith(FEMALE) else mv) for t in it["turns"]]
        out.append(rec); print("recorded", it["date"], len(rec.get("sens", [])), "sentences", len(rec.get("turns", [])), "turns", file=sys.stderr)
    json.dump(out, open(a[1], "w"))

if __name__ == "__main__":
    main()
