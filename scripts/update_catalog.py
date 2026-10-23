"""Rebuild data/catalog.json from TMDB: the most popular films that are included in a
Netflix, Videoland or Prime Video subscription in the Netherlands.

Needs the environment variable TMDB_API_KEY (v3 API key or v4 read access token).
Keeps existing Dutch descriptions (including ones translated by hand) when TMDB has none.
"""
import json, os, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

KEY = os.environ.get("TMDB_API_KEY", "").strip()
if not KEY:
    sys.exit("TMDB_API_KEY ontbreekt")
BEARER = len(KEY) > 40
PROVIDERS = {"netflix": "Netflix", "prime": "Amazon Prime Video", "videoland": "Videoland"}
PAGES = int(os.environ.get("PAGES", "10"))
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "catalog.json")


def api(path, **params):
    if not BEARER:
        params["api_key"] = KEY
    url = "https://api.themoviedb.org/3" + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Accept": "application/json", **({"Authorization": "Bearer " + KEY} if BEARER else {})})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(2 + attempt * 2)
                continue
            if e.code == 404:
                return None
            raise
        except urllib.error.URLError:
            time.sleep(2)
    return None


old = {}
try:
    for f in json.load(open(OUT, encoding="utf-8"))["films"]:
        old[f["tmdb"]] = f
except FileNotFoundError:
    pass

prov = api("/watch/providers/movie", watch_region="NL")["results"]
ids = {k: next(p["provider_id"] for p in prov if p["provider_name"] == n) for k, n in PROVIDERS.items()}
genres = {g["id"]: g["name"] for g in api("/genre/movie/list", language="nl")["genres"]}
print("providers", ids)

films = {}
for plat, pid in ids.items():
    for lang in ("nl-NL", "en-US"):
        for page in range(1, PAGES + 1):
            d = api("/discover/movie", watch_region="NL", with_watch_providers=pid, with_watch_monetization_types="flatrate",
                    sort_by="popularity.desc", include_adult="false", language=lang, page=page)
            for m in (d or {}).get("results", []):
                if not m.get("poster_path"):
                    continue
                f = films.setdefault(m["id"], {"tmdb": m["id"], "title": "", "title_en": "", "year": (m.get("release_date") or "")[:4],
                                               "genres": [genres[g] for g in m.get("genre_ids", []) if g in genres][:3],
                                               "nl": "", "en": "", "platforms": [], "vote": m.get("vote_average") or 0,
                                               "votes": m.get("vote_count") or 0, "popularity": m.get("popularity") or 0,
                                               "poster": m["poster_path"]})
                if plat not in f["platforms"]:
                    f["platforms"].append(plat)
                if lang == "nl-NL":
                    f["title"], f["nl"] = m.get("title") or "", m.get("overview") or ""
                else:
                    f["title_en"], f["en"] = m.get("title") or "", m.get("overview") or ""
            if page >= (d or {}).get("total_pages", 1):
                break
print(len(films), "films")


def details(tid):
    m = api(f"/movie/{tid}", language="en-US", append_to_response="recommendations,similar,keywords") or {}
    return tid, {"kw": [k["id"] for k in (m.get("keywords") or {}).get("keywords", [])],
                 "rel": [r["id"] for r in (m.get("recommendations") or {}).get("results", [])] +
                        [r["id"] for r in (m.get("similar") or {}).get("results", [])],
                 "runtime": m.get("runtime")}


with ThreadPoolExecutor(6) as ex:
    extra = dict(ex.map(details, list(films)))

df = {}
for e in extra.values():
    for k in e["kw"]:
        df[k] = df.get(k, 0) + 1

this_year = time.strftime("%Y")
out = []
for rank, f in enumerate(sorted(films.values(), key=lambda f: -f["popularity"])):
    e, prev = extra.get(f["tmdb"], {}), old.get(f["tmdb"], {})
    title = f["title"] or f["title_en"]
    if title and not any(c.isascii() for c in title.replace(" ", "")) and f["title_en"]:
        title = f["title_en"]  # non-Latin script without Dutch translation
    blurb, en = f["nl"], False
    if not blurb:
        if prev.get("blurb") and not prev.get("en"):
            blurb = prev["blurb"]  # keep earlier Dutch (hand) translation
        else:
            blurb, en = f["en"], bool(f["en"])
    o = {"id": f"t{f['tmdb']}", "tmdb": f["tmdb"], "title": title,
         "year": int(f["year"]) if f["year"].isdigit() else None, "genres": f["genres"], "blurb": blurb.replace("*", ""),
         "platforms": f["platforms"], "vote": round(f["vote"], 1), "votes": f["votes"], "rank": rank,
         "kw": [k for k in e.get("kw", []) if 2 <= df.get(k, 0) <= 60][:16],
         "rel": [], "new": f["year"] == this_year or f["tmdb"] not in old, "poster": f["poster"]}
    if en:
        o["en"] = True
    if e.get("runtime"):
        o["runtime"] = e["runtime"]
    rel = []
    for r in e.get("rel", []):
        if r in films and r != f["tmdb"] and f"t{r}" not in rel:
            rel.append(f"t{r}")
    o["rel"] = rel[:14]
    out.append(o)

json.dump({"updated": time.strftime("%Y-%m-%d"), "source": "TMDB", "region": "NL", "films": out},
          open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print("wrote", len(out), "films;", sum(1 for o in out if o.get("en")), "with English description;",
      sum(1 for o in out if o["tmdb"] not in old), "new")
