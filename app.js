import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection, setDoc, deleteDoc, updateDoc, addDoc,
  getDoc, onSnapshot, query, where, arrayUnion, arrayRemove, deleteField }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCCYNpJ2KNUQmLT3ueMj9Cc1viqa11HYj0",
  authDomain: "filmswipe-7ed41.firebaseapp.com",
  projectId: "filmswipe-7ed41",
  storageBucket: "filmswipe-7ed41.firebasestorage.app",
  messagingSenderId: "1054016642507",
  appId: "1:1054016642507:web:608bd8f239b66a074a6a4e"
};
const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

const PLAT = {
  netflix:  {name:"Netflix",     short:"Netflix",   c:"var(--nf)"},
  videoland:{name:"Videoland",   short:"Videoland", c:"var(--vl)"},
  prime:    {name:"Prime Video", short:"Prime",     c:"var(--pv)"}
};
const LABEL = {match:"Matches", watch:"Nu kijken", like:"Leuk", seen:"Gezien", nope:"Niet leuk"};
const POS = v => v === "like" || v === "watch";
const IMG = (p, size) => p ? `https://image.tmdb.org/t/p/${size}${p}` : "";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const store = { get(k){ try { return localStorage.getItem(k); } catch { return null; } }, set(k, v){ try { localStorage.setItem(k, v); } catch {} } };

/* ---------- state ---------- */
let me = null;                    // {uid, name, photo}
let films = [], byId = new Map(), catalogMeta = null;
let mySwipes = new Map();         // personal: filmId -> {v,t}
let groups = [];                  // groups I'm in
let groupSwipes = new Map();      // gid -> Map(filmId -> {v,t,by})
let groupVotes = new Map();       // gid -> Map(filmId -> {uid: v})
let mode = store.get("fs-mode") || "me";
let filter = new Set(Object.keys(PLAT));
try { const s = JSON.parse(store.get("fs-filter")); if (Array.isArray(s) && s.length) filter = new Set(s.filter(p => PLAT[p])); } catch {}
let busy = false, pendingRender = false, pinTop = null, listTab = "watch";
let unsubs = [], groupUnsubs = new Map();

const curGroup = () => mode === "me" ? null : groups.find(g => g.id === mode) || null;
const curSwipes = () => { const g = curGroup(); return g ? (groupSwipes.get(g.id) || new Map()) : mySwipes; };
const firstName = n => String(n || "").split(" ")[0] || "Iemand";

function hash(str){ let h = 2166136261; for (const ch of str){ h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function grad(f){
  const h = hash(f.id) % 360, h2 = (h + 35 + hash(f.title) % 50) % 360;
  return `linear-gradient(165deg, hsl(${h} 62% 34%) 0%, hsl(${h2} 58% 18%) 55%, hsl(${h2} 40% 8%) 100%)`;
}

/* ---------- catalog ---------- */
async function loadCatalog(){
  try {
    const r = await fetch("data/catalog.json", {cache: "no-cache"});
    const d = await r.json();
    catalogMeta = {updated: d.updated, source: d.source};
    films = (d.films || []).filter(f => f && f.id && f.title);
    indexCatalog();
    const fan = document.querySelectorAll("#fan div");
    films.slice(0, 3).forEach((f, i) => { if (fan[i]) fan[i].style.backgroundImage = `url('${IMG(f.poster, "w342")}')`; });
  } catch (e) { console.error(e); toast("De filmlijst laden lukte niet. Controleer je verbinding."); }
  render();
}

/* ---------- recommendations ----------
   Per mode a taste model: related films (TMDB recommended/similar) of what you liked weigh most,
   shared keywords and genres add up (dislikes subtract), plus a small quality/popularity prior and
   seeded randomness. Popularity-first until 3 likes. Every 6th card is an exploration pick. */
let relIdx = new Map(), model = null, modelKey = "", reasons = new Map();
function indexCatalog(){
  byId = new Map(films.map(f => [f.id, f]));
  relIdx = new Map();
  const add = (a, b) => { if (!byId.has(a) || !byId.has(b) || a === b) return; (relIdx.get(a) || relIdx.set(a, new Set()).get(a)).add(b); };
  films.forEach(f => (f.rel || []).forEach(r => { add(f.id, r); add(r, f.id); }));
  modelKey = "";
}
function tasteSignals(){
  const sw = curSwipes(), likes = new Map(), nopes = new Map();
  sw.forEach((s, id) => { if (POS(s.v)) likes.set(id, 1); else if (s.v === "nope") nopes.set(id, 1); });
  const g = curGroup();
  if (g){ // in "samen" mode, each member's own likes count too, a bit lighter
    (groupVotes.get(g.id) || new Map()).forEach((vs, id) => {
      const vals = Object.values(vs || {});
      if (vals.some(POS) && !likes.has(id)) likes.set(id, 0.6);
      if (vals.length && vals.every(v => v === "nope") && !nopes.has(id)) nopes.set(id, 0.6);
    });
  }
  return {likes, nopes};
}
function buildModel(){
  const {likes, nopes} = tasteSignals();
  const key = films.length + "|" + mode + "|" + [...likes.keys()].join(",") + "|" + [...nopes.keys()].join(",") + "|" + curSwipes().size;
  if (key === modelKey) return model;
  modelKey = key;
  const kw = new Map(), gw = new Map();
  const bump = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  let nl = 0, nn = 0;
  likes.forEach((w, id) => { const f = byId.get(id); if (!f) return; nl += w; (f.kw||[]).forEach(k => bump(kw, k, w)); (f.genres||[]).forEach(g => bump(gw, g, w)); });
  nopes.forEach((w, id) => { const f = byId.get(id); if (!f) return; nn += w; (f.kw||[]).forEach(k => bump(kw, k, -0.6*w)); (f.genres||[]).forEach(g => bump(gw, g, -0.5*w)); });
  model = {likes: nl, nopes: nn, kw, gw, likeMap: likes, nopeMap: nopes, n: curSwipes().size};
  return model;
}
function scoreFilm(f, m){
  let s = 0, because = null, best = -1;
  const rel = relIdx.get(f.id);
  if (rel) rel.forEach(r => {
    const lw = m.likeMap.get(r);
    if (lw){ s += 3 * lw; const l = byId.get(r); if (l && lw >= best){ best = lw; because = l; } }
    else if (m.nopeMap.has(r)) s -= 1.5;
  });
  const kws = f.kw || [];
  if (kws.length){ let k = 0; kws.forEach(x => k += m.kw.get(x) || 0); s += 1.6 * k / Math.sqrt(kws.length + 2); }
  const gs = f.genres || [];
  if (gs.length){ let g = 0; gs.forEach(x => g += m.gw.get(x) || 0); s += 2.2 * g / gs.length / (m.likes + m.nopes + 1) * 3; }
  s += 0.35 * Math.max(-2, Math.min(2, (f.vote || 6.5) - 6.5));
  s += 0.8 * (1 - Math.min(1, (f.rank ?? 528) / 528));
  s += ((hash(f.id + "|" + m.n) % 1000) / 1000) * 0.9;
  return {s, because};
}
function deck(){
  const sw = curSwipes();
  const d = films.filter(f => !sw.has(f.id) && (f.platforms||[]).some(p => filter.has(p)));
  const m = buildModel();
  reasons = new Map();
  let out;
  if (!m || m.likes < 3){
    const k = f => (f.rank ?? 999) + hash(f.id + "x") % 60;
    out = d.sort((a,b) => k(a) - k(b));
    if (m) m.top = null;
  } else {
    const sc = new Map(d.map(f => { const r = scoreFilm(f, m); if (r.because) reasons.set(f.id, r.because); return [f.id, r.s]; }));
    const ranked = [...d].sort((a,b) => sc.get(b.id) - sc.get(a.id));
    const explore = [...d].sort((a,b) => ((a.rank ?? 999) + hash(a.id + m.n) % 120) - ((b.rank ?? 999) + hash(b.id + m.n) % 120));
    const used = new Set(); out = [];
    let ri = 0, ei = 0;
    while (out.length < d.length){
      let f = null;
      if (out.length % 6 === 5){ while (ei < explore.length && used.has(explore[ei].id)) ei++; f = explore[ei]; if (f) reasons.delete(f.id); }
      if (!f){ while (ri < ranked.length && used.has(ranked[ri].id)) ri++; f = ranked[ri]; }
      if (!f) break;
      used.add(f.id); out.push(f);
    }
    m.top = new Set(ranked.slice(0, Math.max(10, Math.round(ranked.length * 0.08))).map(f => f.id));
  }
  if (pinTop){ const i = out.findIndex(f => f.id === pinTop); if (i > 0) out.unshift(out.splice(i, 1)[0]); }
  return out;
}

/* ---------- card ---------- */
function titleSize(t){ const n = t.length; return n < 10 ? 64 : n < 16 ? 54 : n < 24 ? 44 : n < 34 ? 36 : 30; }
function metaLine(f){ return [f.year, f.vote ? "★ " + Number(f.vote).toFixed(1) : "", (f.genres||[]).join(" · ")].filter(Boolean).join("  ·  "); }
function platBadges(f){ return (f.platforms||[]).map(p => PLAT[p] ? `<span class="badge" style="--c:${PLAT[p].c}"><span class="dot"></span>${PLAT[p].name}</span>` : "").join(""); }
function cardHTML(f){
  const ts = titleSize(f.title), longest = Math.max(...f.title.split(/\s+/).map(w => w.length));
  const g = curGroup();
  let badge = "";
  if (model && model.top && model.top.has(f.id)) badge = `<span class="badge forme">${g ? "Voor jullie" : "Voor jou"}</span>`;
  else if (f.new) badge = '<span class="badge new">Nieuw</span>';
  let why = reasons.get(f.id) ? `<div class="why">Omdat ${g ? "jullie" : "je"} <b>${esc(reasons.get(f.id).title)}</b> leuk ${g ? "vonden" : "vond"}</div>` : "";
  if (g){ // show partner interest in samen mode
    const vs = (groupVotes.get(g.id) || new Map()).get(f.id) || {};
    const fans = Object.entries(vs).filter(([u, v]) => POS(v)).map(([u]) => u === me.uid ? "jij" : firstName(g.memberNames?.[u]));
    if (fans.length) why = `<div class="why">${esc(fans.join(" en "))} ${fans.length > 1 ? "vinden" : (fans[0] === "jij" ? "vindt" : "vindt")} deze leuk</div>` + why;
  }
  return `<div class="poster${f.poster ? " img" : ""}" style="--g:${grad(f)}">${f.poster ? `<div class="pimg real" style="background-image:url('${IMG(f.poster, "w780")}')"></div>` : ""}</div>
    ${f.poster ? "" : `<div class="year" aria-hidden="true">${esc(f.year||"")}</div>`}
    <div class="top">${badge}${platBadges(f)}</div>
    <div class="stamp like">Leuk</div><div class="stamp nope">Nee</div><div class="stamp seen">Gezien</div><div class="stamp watch">Nu kijken</div>
    <div class="info">
      ${why}
      <div class="meta">${esc(metaLine(f))}</div>
      <h2 class="title" style="font-size:min(${ts}px, ${(ts/4).toFixed(1)}vw, calc((min(100vw, 520px) - 84px) / ${(longest * 0.72).toFixed(2)}))">${esc(f.title)}</h2>
      ${f.blurb ? `<p class="blurb">${esc(f.blurb)}</p><span class="more">Tik om alles te lezen</span>` : `<p class="blurb none">Nog geen omschrijving.</p>`}
    </div>`;
}

function render(){
  if (!me) return;
  if (busy){ pendingRender = true; return; }
  pendingRender = false;
  renderMode(); renderTally(); renderChips();
  const stage = $("#stage"); stage.innerHTML = "";
  const d = deck();
  ["#bLike","#bNope","#bSeen","#bWatch"].forEach(s => $(s).disabled = !d.length);
  $("#bUndo").disabled = !curSwipes().size;
  if (!films.length) return empty("Films laden", "De filmlijst wordt opgehaald.");
  if (!filter.size) return empty("Kies een platform", "Zet hierboven minstens één platform aan.");
  if (!d.length) return empty("Alles geswipet", "Je hebt alles op deze platforms beoordeeld. Begin van de maand komen er nieuwe films bij.");
  const shown = d.slice(0, 3).reverse();
  shown.forEach((f, i) => {
    const depth = shown.length - 1 - i;
    const el = document.createElement("div");
    el.className = "card"; el.dataset.id = f.id; el.innerHTML = cardHTML(f);
    el.style.transform = `translateY(${depth*12}px) scale(${1 - depth*0.045})`;
    el.style.zIndex = 10 - depth;
    if (depth === 0){ el.setAttribute("aria-label", f.title); attachDrag(el, f); }
    else el.style.filter = `brightness(${1 - depth*0.18})`;
    stage.appendChild(el);
  });
  d.slice(3, 6).forEach(f => { if (f.poster){ const im = new Image(); im.src = IMG(f.poster, "w780"); } });
}
function empty(h, p){ $("#stage").innerHTML = `<div class="empty"><h2>${esc(h)}</h2><p>${esc(p)}</p></div>`; }

function renderTally(){
  const c = {like:0, seen:0, nope:0, watch:0};
  curSwipes().forEach(s => { if (c[s.v] !== undefined) c[s.v]++; });
  const left = deck().length, liked = c.like + c.watch, tuned = (model?.likes || 0) >= 3;
  const g = curGroup();
  const nm = g ? matchesFor(g).length : 0;
  $("#tally").innerHTML = (g ? `<span style="color:var(--like)"><b style="color:var(--like)">${nm}</b> matches</span>` : "") +
    `<span style="color:var(--gold)"><b style="color:var(--gold)">${c.watch}</b> nu kijken</span><span><b>${c.like}</b> leuk</span><span><b>${left}</b> te gaan</span>` +
    `<span style="color:${tuned ? "var(--like)" : "var(--muted)"}">${tuned ? "● op maat" : "nog " + Math.max(1, 3 - liked) + " ♥ tot op maat"}</span>`;
}
function renderChips(){
  const sw = curSwipes();
  $("#chips").innerHTML = Object.entries(PLAT).map(([k,p]) => {
    const n = films.filter(f => (f.platforms||[]).includes(k) && !sw.has(f.id)).length;
    return `<button class="chip" type="button" data-p="${k}" style="--c:${p.c}" aria-pressed="${filter.has(k)}"><span class="dot"></span><span class="long">${p.name}</span><span class="short">${p.short}</span> <span style="font-family:var(--mono);font-size:11px;opacity:.7">${n}</span></button>`;
  }).join("");
}
$("#chips").addEventListener("click", e => {
  const b = e.target.closest(".chip"); if (!b || busy) return;
  const p = b.dataset.p; filter.has(p) ? filter.delete(p) : filter.add(p);
  store.set("fs-filter", JSON.stringify([...filter]));
  pinTop = null; render();
});

/* ---------- mode menu ---------- */
function avatarHTML(name, photo, grp){
  return `<span class="avatar${grp ? " grp" : ""}">${photo ? `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer">` : esc(String(name||"?").slice(0,1))}</span>`;
}
function renderMode(){
  const g = curGroup();
  $("#modeName").textContent = g ? g.name : firstName(me.name);
  $("#modeAvatar").outerHTML = `<span class="avatar${g ? " grp" : ""}" id="modeAvatar">${g ? "♥" : (me.photo ? `<img src="${esc(me.photo)}" alt="" referrerpolicy="no-referrer">` : esc(me.name.slice(0,1)))}</span>`;
  $("#modeList").innerHTML =
    `<button class="prof-item" type="button" data-mode="me" aria-current="${mode === "me"}">${avatarHTML(me.name, me.photo)}Alleen ${esc(firstName(me.name))}${mode === "me" ? "<small>actief</small>" : ""}</button>` +
    groups.map(gr => `<button class="prof-item" type="button" data-mode="${esc(gr.id)}" aria-current="${mode === gr.id}"><span class="avatar grp">♥</span>${esc(gr.name)}${mode === gr.id ? "<small>actief</small>" : `<small>${gr.members.length}</small>`}</button>`).join("");
}
function toggleMenu(open){ const m = $("#modeMenu"); open = open ?? m.hidden; m.hidden = !open; $("#modeBtn").setAttribute("aria-expanded", open); }
$("#modeBtn").addEventListener("click", e => { e.stopPropagation(); toggleMenu(); });
$("#modeMenu").addEventListener("click", e => {
  e.stopPropagation();
  const b = e.target.closest("[data-mode]"); if (!b) return;
  setMode(b.dataset.mode); toggleMenu(false);
  const g = curGroup();
  toast(g ? `Samen swipen in ${g.name}` : "Je swipet nu voor jezelf");
});
document.addEventListener("click", () => toggleMenu(false));
function setMode(m){
  mode = m; store.set("fs-mode", m); pinTop = null; modelKey = "";
  listTab = curGroup() ? "match" : "watch";
  render();
}

/* ---------- drag & fly ---------- */
const TH = 100;
function attachDrag(el, f){
  let sx=0, sy=0, dx=0, dy=0, t0=0, active=false, downOnInfo=false;
  const st = {}; ["like","nope","seen","watch"].forEach(k => st[k] = el.querySelector(".stamp." + k));
  const next = () => el.previousElementSibling;
  el.addEventListener("pointerdown", e => {
    if (busy || e.button > 0) return;
    active = true; sx = e.clientX; sy = e.clientY; dx = dy = 0; t0 = performance.now();
    downOnInfo = !!e.target.closest(".info");
    el.setPointerCapture(e.pointerId); el.classList.add("dragging");
  });
  el.addEventListener("pointermove", e => {
    if (!active) return;
    dx = e.clientX - sx; dy = e.clientY - sy;
    el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx/16}deg)`;
    const up = -dy > Math.abs(dx), down = dy > Math.abs(dx), vert = up || down;
    st.like.style.opacity = vert ? 0 : Math.max(0, Math.min(1, dx/TH));
    st.nope.style.opacity = vert ? 0 : Math.max(0, Math.min(1, -dx/TH));
    st.seen.style.opacity = up ? Math.max(0, Math.min(1, -dy/TH)) : 0;
    st.watch.style.opacity = down ? Math.max(0, Math.min(1, dy/TH)) : 0;
    const n = next(); if (n){ const p = Math.min(1, Math.hypot(dx,dy)/TH); n.style.transition="none"; n.style.transform = `translateY(${12-12*p}px) scale(${0.955+0.045*p})`; n.style.filter = `brightness(${0.82+0.18*p})`; }
  });
  const end = () => {
    if (!active) return; active = false; el.classList.remove("dragging");
    const dt = Math.max(1, performance.now() - t0), vx = dx/dt, vy = dy/dt;
    let v = null;
    if (-dy > Math.abs(dx) && (-dy > TH || vy < -0.7)) v = "seen";
    else if (dy > Math.abs(dx) && (dy > TH || vy > 0.7)) v = "watch";
    else if (dx > TH || (vx > 0.7 && dx > 30)) v = "like";
    else if (dx < -TH || (vx < -0.7 && dx < -30)) v = "nope";
    if (v) fly(el, f, v, dx, dy);
    else if (Math.hypot(dx, dy) < 8 && downOnInfo && f.blurb){ el.style.transform = ""; Object.values(st).forEach(s => s.style.opacity = 0); openDetail(f); }
    else {
      el.style.transform = ""; Object.values(st).forEach(s => s.style.opacity = 0);
      const n = next(); if (n){ n.style.transition=""; n.style.transform = "translateY(12px) scale(.955)"; n.style.filter = "brightness(.82)"; }
    }
  };
  el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
}
function fly(el, f, v, dx=0, dy=0){
  if (busy) return; busy = true;
  const w = window.innerWidth, reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.querySelector(".stamp."+v).style.opacity = 1;
  el.classList.remove("dragging");
  el.style.transition = reduce ? "opacity .25s" : "transform .5s cubic-bezier(.3,.7,.3,1), opacity .5s";
  if (reduce) el.style.opacity = 0;
  else if (v === "seen") el.style.transform = `translate(${dx}px, ${-window.innerHeight*1.1}px) rotate(${dx/16}deg) scale(.9)`;
  else if (v === "watch") el.style.transform = `translate(${dx}px, ${window.innerHeight*1.1}px) rotate(${-dx/16}deg) scale(.9)`;
  else { const s = v === "like" ? 1 : -1; el.style.transform = `translate(${s*w*1.3}px, ${dy + 80}px) rotate(${s*32}deg)`; }
  const n = el.previousElementSibling;
  if (n){ n.style.transition = "transform .45s cubic-bezier(.2,.8,.3,1), filter .45s"; n.style.transform = "translateY(0) scale(1)"; n.style.filter = "brightness(1)"; }
  setTimeout(() => { busy = false; commit(f, v); }, reduce ? 260 : 430);
}
function buttonSwipe(v){
  if (busy) return;
  const el = $("#stage .card:last-child"); if (!el) return;
  const f = byId.get(el.dataset.id); if (!f) return;
  el.style.transition = "transform .12s ease-out";
  el.querySelector(".stamp."+v).style.opacity = 1;
  const vert = v === "seen" || v === "watch", oy = v === "seen" ? -14 : v === "watch" ? 14 : 0, ox = vert ? 0 : (v === "like" ? 18 : -18);
  el.style.transform = vert ? `translateY(${oy}px)` : `translateX(${ox}px) rotate(${ox/6}deg)`;
  setTimeout(() => fly(el, f, v, ox, oy), 110);
}

/* ---------- persistence ---------- */
let queue = Promise.resolve();
function enqueue(fn){ queue = queue.then(fn).catch(err => { console.error(err); toast("Opslaan lukte niet. Controleer je verbinding."); }); }

function writeSwipe(id, v){ // v === null removes
  const g = curGroup(), t = Date.now();
  const local = curSwipes();
  if (v === null) local.delete(id); else local.set(id, {v, t, by: me.uid});
  if (g){
    if (!groupSwipes.has(g.id)) groupSwipes.set(g.id, local);
    const ref = doc(db, "groups", g.id, "swipes", id);
    enqueue(() => v === null ? deleteDoc(ref) : setDoc(ref, {v, t, by: me.uid}));
  } else {
    const ref = doc(db, "users", me.uid, "swipes", id);
    enqueue(() => v === null ? deleteDoc(ref) : setDoc(ref, {v, t}));
    groups.forEach(gr => { // mirror personal verdicts so matches can be found
      const vref = doc(db, "groups", gr.id, "votes", id);
      enqueue(() => setDoc(vref, {[me.uid]: v === null ? deleteField() : v}, {merge: true}));
      const vm = groupVotes.get(gr.id) || new Map(); const cur = {...(vm.get(id) || {})};
      if (v === null) delete cur[me.uid]; else cur[me.uid] = v;
      vm.set(id, cur); groupVotes.set(gr.id, vm);
    });
    if (POS(v)) checkMatch(id);
  }
}
function commit(f, v){
  if (pinTop === f.id) pinTop = null;
  writeSwipe(f.id, v);
  render();
}
function undo(){
  if (busy) return;
  const sw = curSwipes(); if (!sw.size) return;
  let last = null; sw.forEach((s, id) => { if (!last || s.t > last.t) last = {id, t:s.t}; });
  if (!last) return;
  writeSwipe(last.id, null); pinTop = last.id;
  render();
  const top = $("#stage .card:last-child");
  if (top && !matchMedia("(prefers-reduced-motion: reduce)").matches){
    top.style.transition = "none"; top.style.transform = "translate(-120%, -40px) rotate(-25deg)";
    requestAnimationFrame(() => requestAnimationFrame(() => { top.style.transition = ""; top.style.transform = ""; }));
  }
}

/* ---------- matches ---------- */
function matchesFor(g){
  const vm = groupVotes.get(g.id) || new Map(), out = [];
  if (g.members.length < 2) return out;
  vm.forEach((vs, id) => {
    if (!byId.has(id)) return;
    if (g.members.every(u => POS(vs?.[u]))) out.push({id, vs});
  });
  return out;
}
let matchFilm = null, matchGroup = null;
function checkMatch(id){
  for (const g of groups){
    if (g.members.length < 2) continue;
    const vs = (groupVotes.get(g.id) || new Map()).get(id) || {};
    if (g.members.every(u => POS(vs[u]))){
      const f = byId.get(id); if (!f) return;
      matchFilm = f; matchGroup = g;
      const others = g.members.filter(u => u !== me.uid).map(u => firstName(g.memberNames?.[u]));
      $("#mPoster").style.backgroundImage = `url('${IMG(f.poster, "w342")}')`;
      $("#mText").innerHTML = `Jij en ${esc(others.join(" en "))} willen allebei <b>${esc(f.title)}</b> zien.`;
      setTimeout(() => { $("#match").hidden = false; $("#mClose").focus(); }, 380);
      return;
    }
  }
}
$("#mClose").addEventListener("click", () => { $("#match").hidden = true; });
$("#mWatch").addEventListener("click", () => {
  $("#match").hidden = true;
  if (!matchFilm || !matchGroup) return;
  const ref = doc(db, "groups", matchGroup.id, "swipes", matchFilm.id);
  enqueue(() => setDoc(ref, {v: "watch", t: Date.now(), by: me.uid}));
  toast(`${matchFilm.title} staat bij Nu kijken in ${matchGroup.name}`);
});

// Copy personal verdicts into a group's votes (after joining or creating a group, or if a write was missed).
const backfilled = new Set();
let mySwipesLoaded = false;
async function backfillVotes(gid){
  if (backfilled.has(gid) || !me || !mySwipesLoaded || !groupVotes.has(gid)) return;
  backfilled.add(gid);
  const vm = groupVotes.get(gid) || new Map(), todo = [];
  mySwipes.forEach((s, id) => { if ((vm.get(id) || {})[me.uid] !== s.v) todo.push([id, s.v]); });
  vm.forEach((vs, id) => { if (vs && vs[me.uid] && !mySwipes.has(id)) todo.push([id, null]); });
  const res = await writeMany(todo.map(([id, v]) => () => setDoc(doc(db, "groups", gid, "votes", id), {[me.uid]: v === null ? deleteField() : v}, {merge: true})));
  if (res.failed){ backfilled.delete(gid); console.error("vote backfill", res); }
}
// Run many single-document writes with limited parallelism; report failures instead of throwing.
async function writeMany(tasks, onDone){
  let failed = 0, code = "";
  const q = [...tasks];
  await Promise.all(Array.from({length: 8}, async () => {
    while (q.length){
      const t = q.shift();
      try { await t(); } catch (err) { failed++; code = err.code || err.message || "fout"; console.error(err); }
      onDone && onDone();
    }
  }));
  return {failed, code};
}

/* ---------- toast ---------- */
let toastT;
function toast(msg){
  let t = $(".toast"); if (!t){ t = document.createElement("div"); t.className = "toast"; t.setAttribute("role","status"); document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3200);
}

/* ---------- detail sheet ---------- */
let detailFilm = null;
function openDetail(f){
  detailFilm = f;
  $("#dPoster").setAttribute("style", `--g:${grad(f)};${f.poster ? `background:url('${IMG(f.poster, "w342")}') center/cover` : ""}`);
  $("#dMeta").textContent = metaLine(f);
  $("#dTitle").textContent = f.title;
  $("#dPlat").innerHTML = platBadges(f);
  $("#dBody").textContent = f.blurb || "";
  $("#detail").hidden = false; $("#dClose").focus();
}
function closeDetail(){ const sh = $("#dSheet"); sh.classList.remove("snap","dragging"); sh.style.transform = ""; $("#detail").style.background = ""; $("#detail").hidden = true; detailFilm = null; }
function slideClose(){
  const sh = $("#dSheet");
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return closeDetail();
  sh.classList.add("snap"); sh.style.transform = "translateY(105%)";
  setTimeout(closeDetail, 240);
}
(() => {
  const sh = $("#dSheet"), body = $("#dBody"), wrap = $("#detail");
  let y0 = 0, t0 = 0, dy = 0, dragging = false, eligible = false;
  sh.addEventListener("touchstart", e => {
    if (e.touches.length !== 1 || e.target.closest("button")) { eligible = false; return; }
    eligible = !body.contains(e.target) || body.scrollTop <= 0;
    y0 = e.touches[0].clientY; t0 = performance.now(); dy = 0; dragging = false;
  }, {passive: true});
  sh.addEventListener("touchmove", e => {
    if (!eligible) return;
    dy = e.touches[0].clientY - y0;
    if (!dragging){
      if (dy > 6 && (!body.contains(e.target) || body.scrollTop <= 0)){ dragging = true; sh.classList.remove("snap"); sh.classList.add("dragging"); }
      else if (dy < -6){ eligible = false; return; }
      else return;
    }
    e.preventDefault();
    const d = Math.max(0, dy);
    sh.style.transform = `translateY(${d}px)`;
    wrap.style.background = `rgba(5,4,7,${Math.max(0.15, 0.72 - d / 600)})`;
  }, {passive: false});
  const end = () => {
    if (!dragging) return; dragging = false; sh.classList.remove("dragging");
    const v = dy / Math.max(1, performance.now() - t0);
    if (dy > 110 || (v > 0.6 && dy > 40)) slideClose();
    else { sh.classList.add("snap"); sh.style.transform = ""; wrap.style.background = ""; }
  };
  sh.addEventListener("touchend", end); sh.addEventListener("touchcancel", end);
})();
$("#dClose").addEventListener("click", slideClose);
$("#detail").addEventListener("click", e => {
  if (e.target.id === "detail") return slideClose();
  const b = e.target.closest("button[data-v]"); if (!b || !detailFilm) return;
  const v = b.dataset.v; closeDetail(); setTimeout(() => buttonSwipe(v), 60);
});

/* ---------- lists ---------- */
function renderList(){
  const g = curGroup(), sw = curSwipes();
  $("#panelTitle").textContent = g ? g.name : "Lijst van " + firstName(me.name);
  const tabs = g ? ["match", "watch", "like", "seen", "nope"] : ["watch", "like", "seen", "nope"];
  if (!tabs.includes(listTab)) listTab = tabs[0];
  const counts = {like:0, seen:0, nope:0, watch:0, match: g ? matchesFor(g).length : 0};
  sw.forEach(s => { if (counts[s.v] !== undefined) counts[s.v]++; });
  const COL = {match:"var(--like)", watch:"var(--gold)", like:"var(--like)", seen:"var(--seen)", nope:"var(--nope)"};
  $("#tabs").innerHTML = tabs.map(t => `<button class="tab" role="tab" type="button" data-v="${t}" style="--c:${COL[t]}" aria-selected="${t === listTab}"><span>${t === "match" ? "Matches" : LABEL[t]}</span><small>${counts[t]}</small></button>`).join("");
  let items = [];
  if (listTab === "match"){
    items = matchesFor(g).map(({id, vs}) => ({f: byId.get(id), vs, t: 0}))
      .sort((a, b) => Object.values(b.vs).filter(v => v === "watch").length - Object.values(a.vs).filter(v => v === "watch").length || (a.f.rank ?? 999) - (b.f.rank ?? 999));
  } else {
    sw.forEach((s, id) => { if (s.v === listTab){ const f = byId.get(id); if (f) items.push({f, t:s.t}); } });
    items.sort((a,b) => b.t - a.t);
  }
  const BTN = {
    match: [["watch","Nu kijken","var(--gold)"], ["seen","Gezien","var(--seen)"]],
    watch: [["seen","Gezien","var(--seen)"], ["like","Terug naar Leuk","var(--like)"]],
    like:  [["seen","Gezien","var(--seen)"], ["watch","Nu kijken","var(--gold)"]],
    seen:  [["like","Leuk","var(--like)"]],
    nope:  [["like","Toch leuk","var(--like)"]]
  }[listTab];
  const emptyText = {
    match: "Nog geen matches. Swipe allebei voor jezelf (kies 'Alleen jij' bovenin): films die jullie allebei leuk vinden komen hier.",
    watch: "Nog geen films om nu te kijken. Veeg een film naar beneden of druk op ▶ Nu kijken.",
  }[listTab] || `Nog niets onder "${LABEL[listTab]}". Swipe een paar films en ze verschijnen hier.`;
  $("#list").innerHTML = items.length ? items.map(({f, vs}) => {
    let who = "";
    if (vs){ const w = Object.entries(vs).filter(([u, v]) => v === "watch").map(([u]) => u === me.uid ? "jij" : firstName(g.memberNames?.[u])); if (w.length) who = `<div class="who" style="color:var(--gold)">▶ ${esc(w.join(" en "))} ${w.length > 1 ? "willen" : "wil"} hem nu kijken</div>`; }
    if (g && listTab !== "match"){ const s = sw.get(f.id); if (s?.by && s.by !== me.uid) who += `<div class="who">Geswipet door ${esc(firstName(g.memberNames?.[s.by]))}</div>`; }
    const done = listTab === "match" ? (sw.get(f.id)?.v) : null;
    return `
    <div class="row">
      <div class="swatch" style="--g:${grad(f)};${f.poster ? `background:url('${IMG(f.poster, "w185")}') center/cover` : ""}">${f.poster ? "" : esc(f.year||"")}</div>
      <div class="row-t">
        <b>${esc(f.title)}</b>
        <div class="row-meta">${(f.platforms||[]).map(p => PLAT[p] ? `<span class="p" style="--c:${PLAT[p].c}"><i></i>${PLAT[p].name}</span>` : "").join("")}</div>
        <div class="row-meta">${f.genres?.length ? `<span>${esc(f.genres.slice(0,2).join(" · "))}</span>` : ""}${f.vote ? `<span class="r">★ ${Number(f.vote).toFixed(1)}</span>` : ""}</div>
        ${who}
        ${done ? `<div class="who">In jullie lijst: ${esc(LABEL[done])}</div>` : ""}
        <div class="row-btns">
          ${BTN.map(([to, label, c]) => `<button class="mini on" type="button" style="--c:${c}" data-id="${esc(f.id)}" data-to="${to}">${label}</button>`).join("")}
          ${listTab === "match" ? "" : `<button class="mini" type="button" data-id="${esc(f.id)}" data-to="">Opnieuw swipen</button>`}
        </div>
      </div>
    </div>`; }).join("")
    : `<div class="list-empty">${esc(emptyText)}</div>`;
  $("#sync").textContent = catalogMeta ? `Filmlijst van ${new Date(catalogMeta.updated).toLocaleDateString("nl-NL", {day:"numeric", month:"long"})} · ${films.length} films · data en posters: TMDB` : "";
}
$("#list").addEventListener("click", e => {
  const b = e.target.closest(".mini"); if (!b) return;
  writeSwipe(b.dataset.id, b.dataset.to || null);
  render(); renderList();
});
$("#tabs").addEventListener("click", e => { const t = e.target.closest(".tab"); if (t){ listTab = t.dataset.v; renderList(); } });
$("#openList").addEventListener("click", () => { $("#panel").hidden = false; renderList(); $("#closeList").focus(); });
$("#closeList").addEventListener("click", () => { $("#panel").hidden = true; render(); });

/* ---------- groups ---------- */
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from(crypto.getRandomValues(new Uint32Array(6)), x => CODE_CHARS[x % CODE_CHARS.length]).join("");
const inviteLink = code => location.origin + location.pathname + "#join=" + code;

function renderGroups(){
  const parts = groups.map(g => `
    <div class="card2">
      <h3>${esc(g.name)}</h3>
      <div class="members">${g.members.map(u => `<span class="member">${avatarHTML(g.memberNames?.[u] || "?", null, true)}${esc(u === me.uid ? "Jij" : (g.memberNames?.[u] || "Lid"))}</span>`).join("")}</div>
      <p>${groupSwipes.get(g.id)?.size || 0} films samen geswipet · ${matchesFor(g).length} matches</p>
      <p>Laat iemand meedoen met deze code of stuur de link:</p>
      <div class="code">${esc(g.inviteCode)}</div>
      <div class="row-btns" style="margin:0">
        <button class="btn" type="button" data-copy="${esc(g.inviteCode)}">Kopieer uitnodigingslink</button>
        <button class="btn ghost" type="button" data-use="${esc(g.id)}">Samen swipen</button>
        ${g.owner === me.uid ? `<button class="btn danger" type="button" data-del="${esc(g.id)}">Verwijderen</button>` : `<button class="btn danger" type="button" data-leave="${esc(g.id)}">Verlaten</button>`}
      </div>
      ${(groupSwipes.get(g.id)?.size || 0) === 0 && oldImport ? `<button class="btn ghost" type="button" data-import="${esc(g.id)}">Swipes uit de oude app overnemen (${Object.keys(oldImport).length})</button>` : ""}
      <div class="install" data-confirm="${esc(g.id)}" hidden></div>
    </div>`);
  parts.push(`
    <div class="card2">
      <h3>Meedoen met een groep</h3>
      <p>Heb je een code gekregen? Vul hem hier in.</p>
      <form class="field" id="joinForm"><input id="joinCode" class="codein" maxlength="6" placeholder="ABC123" autocomplete="off" aria-label="Uitnodigingscode"><button class="btn" type="submit">Meedoen</button></form>
    </div>
    <div class="card2">
      <h3>Nieuwe groep maken</h3>
      <p>Bijvoorbeeld voor jou en je vriendin. Daarna nodig je de ander uit met de code.</p>
      <form class="field" id="newGroup"><input id="groupName" maxlength="40" placeholder="Wessel & Sanne" autocomplete="off" aria-label="Naam van de groep"><button class="btn" type="submit">Maken</button></form>
    </div>`);
  $("#glist").innerHTML = parts.join("");
}
let oldImport = null;
fetch("data/import-samen.json").then(r => r.ok ? r.json() : null).then(d => { oldImport = d && Object.keys(d).length ? d : null; }).catch(() => {});
$("#openGroups").addEventListener("click", () => { toggleMenu(false); renderGroups(); $("#gpanel").hidden = false; $("#closeGroups").focus(); });
$("#closeGroups").addEventListener("click", () => { $("#gpanel").hidden = true; render(); });
$("#glist").addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.copy){
    const link = inviteLink(b.dataset.copy), text = `Swipe je mee op Filmswipe? Open ${link} of vul code ${b.dataset.copy} in.`;
    try {
      if (navigator.share) await navigator.share({title: "Filmswipe", text});
      else { await navigator.clipboard.writeText(text); toast("Uitnodiging gekopieerd"); }
    } catch { /* cancelled */ }
  } else if (b.dataset.import){
    const gid = b.dataset.import, entries = Object.entries(oldImport || {}).filter(([id]) => byId.has(id));
    b.disabled = true; b.textContent = `Bezig… 0/${entries.length}`;
    let done = 0;
    const res = await writeMany(entries.map(([id, [v, t]]) => () => setDoc(doc(db, "groups", gid, "swipes", id), {v, t: t || Date.now(), by: me.uid})),
      () => { done++; b.textContent = `Bezig… ${done}/${entries.length}`; });
    if (!res.failed){ toast(`${entries.length} swipes overgenomen. Kies bovenin de groep om ze te zien.`); b.remove(); }
    else { b.disabled = false; b.textContent = `${res.failed} niet gelukt (${res.code}). Tik om opnieuw te proberen`; }
  } else if (b.dataset.use){
    setMode(b.dataset.use); $("#gpanel").hidden = true;
  } else if (b.dataset.leave || b.dataset.del){
    const id = b.dataset.leave || b.dataset.del, box = document.querySelector(`[data-confirm="${id}"]`);
    if (!b.dataset.sure){ b.dataset.sure = "1"; b.textContent = "Zeker weten? Tik nog eens"; return; }
    const g = groups.find(x => x.id === id); if (!g) return;
    try {
      if (b.dataset.del){ await deleteDoc(doc(db, "invites", g.inviteCode)).catch(() => {}); await deleteDoc(doc(db, "groups", id)); toast("Groep verwijderd"); }
      else { await updateDoc(doc(db, "groups", id), {members: arrayRemove(me.uid)}); toast("Je hebt de groep verlaten"); }
      if (mode === id) setMode("me");
    } catch (err) { console.error(err); toast("Dat lukte niet. Probeer het opnieuw."); }
  }
});
$("#glist").addEventListener("submit", async e => {
  e.preventDefault();
  if (e.target.id === "newGroup"){
    const name = $("#groupName").value.trim() || `${firstName(me.name)} & co`;
    try {
      const code = newCode();
      const ref = await addDoc(collection(db, "groups"), {name, owner: me.uid, members: [me.uid], memberNames: {[me.uid]: me.name}, inviteCode: code, created: Date.now()});
      await setDoc(doc(db, "invites", code), {gid: ref.id});
      toast(`Groep ${name} gemaakt. Deel de code ${code}.`);
    } catch (err) { console.error(err); toast("Groep maken lukte niet. Probeer het opnieuw."); }
  } else if (e.target.id === "joinForm"){
    joinWithCode($("#joinCode").value);
  }
});
async function joinWithCode(raw){
  const code = String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 6){ toast("Een code heeft 6 tekens."); return; }
  try {
    const inv = await getDoc(doc(db, "invites", code));
    if (!inv.exists()){ toast("Deze code bestaat niet (meer). Vraag een nieuwe."); return; }
    const gid = inv.data().gid;
    await updateDoc(doc(db, "groups", gid), {members: arrayUnion(me.uid), [`memberNames.${me.uid}`]: me.name, joinCode: code});
    toast("Je doet mee! Swipe eerst voor jezelf, dan verschijnen jullie matches.");
    store.set("fs-pending-join", "");
    $("#gpanel").hidden = true;
  } catch (err) { console.error(err); toast("Meedoen lukte niet. Controleer de code."); }
}

/* ---------- keyboard ---------- */
$("#bLike").addEventListener("click", () => buttonSwipe("like"));
$("#bNope").addEventListener("click", () => buttonSwipe("nope"));
$("#bSeen").addEventListener("click", () => buttonSwipe("seen"));
$("#bWatch").addEventListener("click", () => buttonSwipe("watch"));
$("#bUndo").addEventListener("click", undo);
document.addEventListener("keydown", e => {
  if (e.target.closest && e.target.closest("input, textarea")) return;
  if (!$("#match").hidden){ if (e.key === "Escape") $("#match").hidden = true; return; }
  if (!$("#detail").hidden){ if (e.key === "Escape") closeDetail(); return; }
  if (!$("#modeMenu").hidden){ if (e.key === "Escape") toggleMenu(false); return; }
  if (!$("#panel").hidden || !$("#gpanel").hidden){ if (e.key === "Escape"){ $("#panel").hidden = true; $("#gpanel").hidden = true; render(); } return; }
  if (!me) return;
  if (e.key === "ArrowRight"){ e.preventDefault(); buttonSwipe("like"); }
  else if (e.key === "ArrowLeft"){ e.preventDefault(); buttonSwipe("nope"); }
  else if (e.key === "ArrowUp"){ e.preventDefault(); buttonSwipe("seen"); }
  else if (e.key === "ArrowDown"){ e.preventDefault(); buttonSwipe("watch"); }
  else if (e.key === "z" || e.key === "Z" || e.key === "Backspace"){ undo(); }
});
if (matchMedia("(pointer: coarse)").matches) $("#hint").textContent = "→ leuk · ← nee · ↑ gezien · ↓ nu kijken";

/* ---------- auth & subscriptions ---------- */
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
$("#installHint").textContent = standalone ? "" : isIOS
  ? "Tip: open deze pagina in Safari, tik op Deel en kies 'Zet op beginscherm'. Dan opent Filmswipe als app, zonder balk."
  : "Tip: kies in het menu van je browser 'App installeren' of 'Toevoegen aan startscherm'. Dan opent Filmswipe als app.";

const joinMatch = location.hash.match(/join=([A-Za-z0-9]{6})/);
if (joinMatch){ store.set("fs-pending-join", joinMatch[1].toUpperCase()); history.replaceState(null, "", location.pathname); }

$("#gLogin").addEventListener("click", async () => {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({prompt: "select_account"});
  $("#loginErr").hidden = true;
  try { await signInWithPopup(auth, provider); }
  catch (err) {
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/web-storage-unsupported"].includes(err.code)) {
      try { await signInWithRedirect(auth, provider); return; } catch (e2) { err = e2; }
    }
    if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") return;
    console.error(err);
    $("#loginErr").textContent = err.code === "auth/unauthorized-domain"
      ? "Dit webadres is nog niet toegestaan in Firebase (Geautoriseerde domeinen)."
      : "Inloggen lukte niet. Probeer het opnieuw.";
    $("#loginErr").hidden = false;
  }
});
getRedirectResult(auth).catch(err => console.error(err));
$("#logout").addEventListener("click", () => { toggleMenu(false); signOut(auth); });

function stopAll(){ unsubs.forEach(u => u()); unsubs = []; groupUnsubs.forEach(arr => arr.forEach(u => u())); groupUnsubs = new Map(); }
onAuthStateChanged(auth, async user => {
  stopAll();
  mySwipesLoaded = false; backfilled.clear();
  if (!user){
    me = null; mySwipes = new Map(); groups = [];
    $("#app").hidden = true; $("#login").hidden = false;
    return;
  }
  me = {uid: user.uid, name: user.displayName || user.email || "Ik", photo: user.photoURL || ""};
  $("#login").hidden = true; $("#app").hidden = false;
  setDoc(doc(db, "users", me.uid), {name: me.name, photo: me.photo, email: user.email || "", seen: Date.now()}, {merge: true}).catch(console.error);
  if (mode !== "me" && !mode) mode = "me";
  render();
  unsubs.push(onSnapshot(collection(db, "users", me.uid, "swipes"), snap => {
    const m = new Map(); snap.docs.forEach(d => { const x = d.data(); if (x && x.v) m.set(d.id, {v: x.v, t: x.t || 0}); });
    mySwipes = m; modelKey = ""; render(); if (!$("#panel").hidden) renderList();
    if (!snap.metadata.fromCache && !mySwipesLoaded){ mySwipesLoaded = true; groups.forEach(g => backfillVotes(g.id)); }
  }, err => { console.error(err); toast("Je swipes laden lukte niet."); }));
  unsubs.push(onSnapshot(query(collection(db, "groups"), where("members", "array-contains", me.uid)), snap => {
    groups = snap.docs.map(d => ({id: d.id, ...d.data()})).filter(g => Array.isArray(g.members)).sort((a, b) => (a.created || 0) - (b.created || 0));
    const ids = new Set(groups.map(g => g.id));
    groupUnsubs.forEach((arr, gid) => { if (!ids.has(gid)){ arr.forEach(u => u()); groupUnsubs.delete(gid); groupSwipes.delete(gid); groupVotes.delete(gid); } });
    groups.forEach(g => {
      if (groupUnsubs.has(g.id)) return;
      const arr = [];
      arr.push(onSnapshot(collection(db, "groups", g.id, "swipes"), s => {
        const m = new Map(); s.docs.forEach(d => { const x = d.data(); if (x && x.v) m.set(d.id, {v: x.v, t: x.t || 0, by: x.by}); });
        groupSwipes.set(g.id, m); modelKey = ""; render(); if (!$("#panel").hidden) renderList();
      }, console.error));
      arr.push(onSnapshot(collection(db, "groups", g.id, "votes"), s => {
        const m = new Map(); s.docs.forEach(d => m.set(d.id, d.data() || {}));
        groupVotes.set(g.id, m); modelKey = ""; render(); if (!$("#panel").hidden) renderList();
        if (!s.metadata.fromCache) backfillVotes(g.id);
      }, console.error));
      groupUnsubs.set(g.id, arr);
    });
    if (mode !== "me" && !ids.has(mode) && !snap.metadata.fromCache) setMode("me");
    render();
    if (!$("#gpanel").hidden) renderGroups();
  }, err => console.error(err)));
  const pending = store.get("fs-pending-join");
  if (pending) joinWithCode(pending);
});

loadCatalog();
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
