#!/usr/bin/env python3
"""Measure detection accuracy against a labelled image set.

The detector is stochastic: re-running byte-identical input has swung the
true-positive rate by 30 points and a single frame by 80. So this harness always
runs a fixed-input replicate of the control arm in the same batch, and reports
the gap between those two arms as the noise floor. Any difference between real
arms that is smaller than that floor is not a result.

Usage:
    python3 eval/run_eval.py --trials 5
    python3 eval/run_eval.py --trials 5 --arms baseline,carriageway
    python3 eval/run_eval.py --trials 3 --images-root /path/to/images

Reads OPENAI_API_KEY from the environment or from a .env file in the repo root.
"""
import utils.session
import argparse, base64, io, json, os, re, statistics, sys, urllib.request, urllib.error
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "https://api.openai.com/v1/responses"
MODEL = "gpt-5-mini"
EDGE_WORDS = re.compile(r"kerb|curb|drain|gutter|shoulder|footpath|sidewalk|road edge|edge of the (road|carriageway)", re.I)


def load_key():
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if key:
        return key
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("OPENAI_API_KEY="):
                return line.split("=", 1)[1].strip()
    sys.exit("OPENAI_API_KEY not set (environment or .env)")


def prompts():
    """The live prompt is the control arm, read from the app so it cannot drift."""
    src = (ROOT / "static" / "standalone.js").read_text()
    m = re.search(r"const DETECT_PROMPT = `(.*?)`;", src, re.S)
    if not m:
        sys.exit("could not find DETECT_PROMPT in static/standalone.js")
    live = m.group(1)
    extra = ROOT / "eval" / "prompts"
    variants = {"baseline": live}
    if extra.is_dir():
        for f in sorted(extra.glob("*.txt")):
            variants[f.stem] = f.read_text().rstrip("\n")
    return variants


SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["is_pothole", "size", "confidence", "looks_like_speed_breaker", "description"],
    "properties": {
        "is_pothole": {"type": "boolean"},
        "size": {"type": ["string", "null"], "enum": ["small", "medium", "large", None]},
        "confidence": {"type": "number"},
        "looks_like_speed_breaker": {"type": "boolean"},
        "description": {"type": "string"},
    },
}


def encode(path, max_dim=2000, quality=85):
    from PIL import Image
    im = Image.open(path)
    im = im.convert("RGB")
    scale = min(1.0, max_dim / max(im.size))
    if scale < 1.0:
        im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def call(key, prompt, data_url):
    body = {
        "model": MODEL,
        "reasoning": {"effort": "minimal"},
        "input": [{"role": "user", "content": [
            {"type": "input_image", "image_url": data_url},
            {"type": "input_text", "text": prompt},
        ]}],
        "text": {"format": {"type": "json_schema", "name": "assessment", "schema": SCHEMA, "strict": True},
                 "verbosity": "low"},
    }
    req = urllib.request.Request(API, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {key}"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                data = json.loads(r.read())
            msg = next(o for o in data.get("output", []) if o.get("type") == "message")
            txt = next(c for c in msg["content"] if c.get("type") == "output_text")["text"]
            return json.loads(txt)
        except Exception as e:
            if attempt == 2:
                return {"error": str(e)[:160]}
    return {"error": "unreachable"}


def wilson(hits, n):
    """95% interval. With single-digit trial counts a bare ratio reads far more precise than it is."""
    if n == 0:
        return (0.0, 0.0)
    p, z = hits / n, 1.96
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    m = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5) / d
    return (max(0.0, c - m), min(1.0, c + m))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=5)
    ap.add_argument("--arms", default="", help="comma-separated prompt arms; default all")
    ap.add_argument("--images-root", default=str(ROOT / "eval" / "images"))
    ap.add_argument("--labels", default=str(ROOT / "eval" / "labels.json"))
    ap.add_argument("--gates", default="0.5,0.6,0.65,0.7,0.75")
    ap.add_argument("--concurrency", type=int, default=5)
    ap.add_argument("--out", default=str(ROOT / "eval" / "results"))
    args = ap.parse_args()

    key = load_key()
    labels = json.loads(Path(args.labels).read_text())["images"]
    root = Path(args.images_root)
    missing = [i["path"] for i in labels if not (root / i["path"]).exists()]
    if missing:
        sys.exit(f"{len(missing)} labelled images not found under {root}, first: {missing[0]}\n"
                 f"Images are not committed (licence and size). See eval/README.md.")

    variants = prompts()
    chosen = [a for a in (args.arms.split(",") if args.arms else variants) if a]
    unknown = [a for a in chosen if a not in variants]
    if unknown:
        sys.exit(f"unknown arm(s): {unknown}. Available: {sorted(variants)}")
    # The control arm runs twice on identical bytes. That second run is the noise floor.
    arms = [(a, variants[a]) for a in chosen] + [("baseline_replicate", variants["baseline"])]

    encoded = {i["path"]: encode(root / i["path"]) for i in labels}
    jobs = [(arm, prompt, i, t) for arm, prompt in arms for i in labels for t in range(args.trials)]
    print(f"{len(jobs)} calls: {len(arms)} arms x {len(labels)} images x {args.trials} trials")

    rows = []
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        for (arm, _, img, trial), res in zip(jobs, pool.map(
                lambda j: call(key, j[1], encoded[j[2]["path"]]), jobs)):
            rows.append({"arm": arm, "image": img["path"], "label": img["label"], "trial": trial, **res})
            if len(rows) % 25 == 0:
                print(f"  {len(rows)}/{len(jobs)}")

    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "raw.jsonl").write_text("\n".join(json.dumps(r) for r in rows))

    gates = [float(g) for g in args.gates.split(",")]
    accepted = lambda r, g: bool(r.get("is_pothole")) and float(r.get("confidence") or 0) >= g

    print("\n=== accept rates at gate 0.5 (95% interval) ===")
    summary = {}
    for arm, _ in arms:
        arm_rows = [r for r in rows if r["arm"] == arm and "error" not in r]
        by_label = defaultdict(list)
        for r in arm_rows:
            by_label[r["label"]].append(r)
        line = {}
        for label in ("pothole", "not_pothole"):
            rs = by_label.get(label, [])
            hits = sum(1 for r in rs if accepted(r, 0.5))
            lo, hi = wilson(hits, len(rs))
            line[label] = f"{hits}/{len(rs)} ({lo:.0%}-{hi:.0%})"
        edge = sum(1 for r in arm_rows if r["label"] == "not_pothole" and accepted(r, 0.5)
                   and EDGE_WORDS.search(r.get("description") or ""))
        line["edge_language_in_false_positives"] = edge
        summary[arm] = line
        print(f"  {arm:22} found {line['pothole']:22} false {line['not_pothole']:22} edge-worded FPs: {edge}")

    print("\n=== gate sweep (found real / false alarms) ===")
    sweep = {}
    for arm, _ in arms:
        arm_rows = [r for r in rows if r["arm"] == arm and "error" not in r]
        pos = [r for r in arm_rows if r["label"] == "pothole"]
        neg = [r for r in arm_rows if r["label"] == "not_pothole"]
        sweep[arm] = {}
        cells = []
        for g in gates:
            tp = sum(1 for r in pos if accepted(r, g))
            fp = sum(1 for r in neg if accepted(r, g))
            sweep[arm][g] = {"tp": tp, "of_pos": len(pos), "fp": fp, "of_neg": len(neg)}
            cells.append(f"{g}: {tp}/{len(pos)} vs {fp}/{len(neg)}")
        print(f"  {arm:22} " + "  |  ".join(cells))

    ctrl = summary.get("baseline", {})
    rep = summary.get("baseline_replicate", {})
    print("\n=== noise floor ===")
    print(f"  baseline           {ctrl.get('pothole')} / {ctrl.get('not_pothole')}")
    print(f"  same input, again  {rep.get('pothole')} / {rep.get('not_pothole')}")
    print("  Any arm difference smaller than this gap is not a result.")

    errs = [r for r in rows if "error" in r]
    if errs:
        print(f"\n{len(errs)} call(s) failed, e.g. {errs[0]['error']}")
    (outdir / "summary.json").write_text(json.dumps(
        {"trials": args.trials, "gate_0.5": summary, "gate_sweep": sweep}, indent=1, default=str))
    print(f"\nwrote {outdir}/raw.jsonl and {outdir}/summary.json")


if __name__ == "__main__":
    main()
