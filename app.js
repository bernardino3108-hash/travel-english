"use strict";
/* ---------- state & storage ---------- */
const D = window.DATA;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } }
};
const S = Object.assign({ accent: "us", rate: 1, showPT: true, hideEN: false }, store.get("te_settings", {}));
const P = Object.assign({ xp: 0, streak: 0, last: "", done: {}, weak: [] }, store.get("te_progress", {}));
const saveS = () => store.set("te_settings", S);
const saveP = () => store.set("te_progress", P);
function addXP(n) {
  P.xp += n;
  const today = new Date().toISOString().slice(0, 10);
  if (P.last !== today) {
    const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    P.streak = P.last === y ? P.streak + 1 : 1; P.last = today;
  }
  saveP();
}
function markDone(id, act, pct) {
  const k = id + ":" + act;
  if (pct >= 0.7 && !(P.done[k] >= 0.7)) addXP(20);
  P.done[k] = Math.max(P.done[k] || 0, pct); saveP();
}
function addWeak(id, i) { const k = id + "#" + i; if (!P.weak.includes(k)) { P.weak.push(k); saveP(); } }
function clearWeak(id, i) { P.weak = P.weak.filter(x => x !== id + "#" + i); saveP(); }

/* ---------- data helpers ---------- */
const ACTS = [
  ["hear", "Ouvir e escolher", "Ouça a frase e marque o que foi dito"],
  ["dict", "Ditado", "Escreva o que você ouve"],
  ["cloze", "Complete a frase", "Preencha a palavra que falta"],
  ["order", "Ordene as palavras", "Monte a frase na ordem certa"],
  ["quiz", "Compreensão", "Perguntas sobre o diálogo"],
  ["cards", "Frases-chave", "Português para inglês e vice-versa"],
  ["say", "Fale as frases", "Repita as expressões em voz alta"],
  ["role", "Role-play", "Converse com o app, sua fala é reconhecida"]
];
D.dialogs.forEach(d => {
  let n = 0; d.items = [];
  d.lines.forEach(l => { if (l.en) { l.a = n++; l.id = d.id; d.items.push(l); } });
  d.speech = d.lines.filter(l => l.en);
  d.phrases.forEach(p => { p.a = n++; p.id = d.id; });
});
const byId = id => D.dialogs.find(d => d.id === id);
const T = it => (S.accent === "uk" && it.uk) ? it.uk : it.en;
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0;[a[i], a[j]] = [a[j], a[i]]; } return a; };
const sample = (a, n) => shuffle(a).slice(0, n);
const speakerName = (d, l) => d.roles[l.r].name;
const initial = n => n[0].toUpperCase();

/* ---------- audio ---------- */
const A = new Audio(); A.preload = "auto";
const packs = {}; let token = 0, curDone = null;
function getPack(pid) {
  const k = pid + "_" + S.accent;
  return packs[k] || (packs[k] = fetch(`audio/${k}.mp3`).then(r => { if (!r.ok) throw 0; return r.arrayBuffer(); }).catch(e => { delete packs[k]; throw e; }));
}
function stopAudio() {
  token++; A.pause(); try { speechSynthesis.cancel(); } catch { }
  if (curDone) { const f = curDone; curDone = null; f(); }
}
function ttsFallback(text, rate) {
  return new Promise(res => {
    try {
      const u = new SpeechSynthesisUtterance(text); u.lang = S.accent === "uk" ? "en-GB" : "en-US"; u.rate = rate;
      const v = speechSynthesis.getVoices().find(v => v.lang.replace("_", "-") === u.lang);
      if (v) u.voice = v;
      u.onend = u.onerror = () => res(); speechSynthesis.speak(u);
    } catch { res(); }
  });
}
/** Plays one clip. pid: pack id, idxTable: audio index object, i: index in pack. */
async function play(pid, table, i, text, rate = S.rate) {
  stopAudio(); const my = token;
  try {
    const buf = await getPack(pid); if (my !== token) return;
    const [o, l] = table[S.accent][i];
    const url = URL.createObjectURL(new Blob([buf.slice(o, o + l)], { type: "audio/mpeg" }));
    await new Promise((res, rej) => {
      curDone = res; A.onended = () => { curDone = null; res(); }; A.onerror = () => rej();
      A.src = url; A.playbackRate = rate; A.defaultPlaybackRate = rate;
      A.play().catch(rej);
    }).finally(() => URL.revokeObjectURL(url));
  } catch (e) {
    if (my === token) { await ttsFallback(text, rate); }
  }
}
const playLine = (d, l, rate) => play(d.id, d.audio, l.a, T(l), rate);
const playPhrase = (d, p, rate) => play(d.id, d.audio, p.a, T(p), rate);
const playBook = (it, rate) => play("book", D.bookAudio, it.i, T(it), rate);

/* ---------- speech recognition & comparison ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function stopRec() { if (rec) { try { rec.abort(); } catch { } rec = null; } }
function listen() {
  return new Promise((res, rej) => {
    if (!SR) return rej("nosr");
    stopAudio(); stopRec();
    const r = new SR(); rec = r; r.lang = S.accent === "uk" ? "en-GB" : "en-US";
    r.interimResults = false; r.maxAlternatives = 3; let got = false;
    r.onresult = e => { got = true; res([...e.results[0]].map(a => a.transcript)); };
    r.onerror = e => { if (!got) { got = true; rej(e.error); } };
    r.onend = () => { rec = null; if (!got) { got = true; res([]); } };
    try { r.start(); } catch (e) { rej("start"); }
  });
}
const ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
function numWords(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[n / 10 | 0] + (n % 10 ? " " + ONES[n % 10] : "");
  if (n < 1000) return ONES[n / 100 | 0] + " hundred" + (n % 100 ? " " + numWords(n % 100) : "");
  return String(n);
}
const CONTR = { "i'm": "i am", "you're": "you are", "we're": "we are", "they're": "they are", "it's": "it is", "that's": "that is", "there's": "there is", "what's": "what is", "let's": "let us", "don't": "do not", "doesn't": "does not", "didn't": "did not", "can't": "cannot", "won't": "will not", "i'll": "i will", "we'll": "we will", "you'll": "you will", "i've": "i have", "we've": "we have", "i'd": "i would", "you'd": "you would", "isn't": "is not", "aren't": "are not", "wasn't": "was not", "couldn't": "could not", "haven't": "have not", "hasn't": "has not", "shouldn't": "should not", "it'll": "it will", "he's": "he is", "she's": "she is", "okay": "ok", "ma'am": "madam", "who's": "who is", "i'd": "i would", "that'll": "that will", "we'd": "we would", "wouldn't": "would not" };
function norm(s) {
  s = s.toLowerCase().replace(/[’‘]/g, "'").replace(/(\d)\.(\d)/g, "$1 point $2").replace(/\d+/g, m => numWords(+m));
  s = s.replace(/-/g, " ").replace(/[^a-z' ]/g, " ");
  return s.split(/\s+/).filter(Boolean).flatMap(w => (CONTR[w] || w).split(" "));
}
function align(target, heard) {
  const n = target.length, m = heard.length, dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = target[i] === heard[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ok = new Array(n).fill(false); let i = 0, j = 0;
  while (i < n && j < m) { if (target[i] === heard[j]) { ok[i] = true; i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
  return ok;
}
/** Compares what the learner said with the target text. Returns {score, html}. */
function compare(text, heardList) {
  text = text.replace(/\s*\([^)]*\)/g, "");
  const raw = text.replace(/[’‘]/g, "'").split(/\s+/);
  const tgt = norm(text); let best = null;
  (heardList.length ? heardList : [""]).forEach(h => {
    const ok = align(tgt, norm(h)); const sc = tgt.length ? ok.filter(Boolean).length / tgt.length : 0;
    if (!best || sc > best.sc) best = { sc, ok, h };
  });
  // map normalized tokens back to display words (approx: per raw word)
  let k = 0;
  const html = raw.map(w => {
    const toks = norm(w).length || 0; if (!toks) return esc(w);
    const good = best.ok.slice(k, k + toks).every(Boolean); k += toks;
    return `<span class="${good ? "g" : "r"}">${esc(w)}</span>`;
  }).join(" ");
  return { score: best.sc, html, heard: best.h };
}

/* ---------- ui helpers ---------- */
const app = $("#app");
const ICO = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="12" rx="3" fill="currentColor"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>'
};
const pct = x => Math.round(x * 100);
function dlgProgress(d) { return ACTS.filter(a => P.done[d.id + ":" + a[0]] >= 0.7).length; }
function syncControls() {
  $$("[data-accent]").forEach(b => b.setAttribute("aria-pressed", b.dataset.accent === S.accent));
  $$("[data-rate]").forEach(b => b.setAttribute("aria-pressed", +b.dataset.rate === S.rate));
}
document.addEventListener("click", e => {
  const a = e.target.closest("[data-accent]"), r = e.target.closest("[data-rate]");
  if (a) { S.accent = a.dataset.accent; saveS(); syncControls(); stopAudio(); route(true); }
  if (r) { S.rate = +r.dataset.rate; saveS(); syncControls(); }
});

/* ---------- router ---------- */
window.addEventListener("hashchange", () => route());
function route(keep) {
  stopAudio(); stopRec();
  const h = location.hash.replace(/^#\/?/, "").split("/");
  const root = h[0] || "home";
  $$("[data-nav]").forEach(a => a.classList.toggle("on", a.dataset.nav === (root === "d" ? "home" : root)));
  const sc = window.scrollY;
  if (root === "d" && byId(h[1])) viewDialog(byId(h[1]), h[2] || "listen");
  else if (root === "book") viewBook();
  else if (root === "mix") viewMix();
  else if (root === "me") viewMe();
  else viewHome();
  if (keep) window.scrollTo(0, sc); else window.scrollTo(0, 0);
}

/* ---------- views ---------- */
function viewHome() {
  const cats = [...new Set(D.dialogs.map(d => d.cat))];
  const total = D.dialogs.length * ACTS.length, done = D.dialogs.reduce((s, d) => s + dlgProgress(d), 0);
  app.innerHTML = `
    <h1>Do check-in ao reencontro</h1>
    <p class="lead">${D.dialogs.length} situações de viagem, com atrasos, imprevistos e encontros inesperados. Ouça em sotaque americano (US) ou britânico (UK) no topo da página e pratique falando.</p>
    <div class="stats">
      <div class="stat"><b>${P.xp}</b><span>pontos</span></div>
      <div class="stat"><b>${P.streak}</b><span>dias seguidos</span></div>
      <div class="stat"><b>${done}/${total}</b><span>atividades</span></div>
    </div>
    <div class="hero-actions"><a class="btn" href="#/mix">Revisão do dia</a><a class="btn ghost" href="#/book">Banco de frases</a></div>
    ${cats.map(c => `<div class="cat">${esc(c)}</div><div class="grid">${D.dialogs.filter(d => d.cat === c).map(d => {
    const n = dlgProgress(d);
    return `<a class="card" href="#/d/${d.id}"><h3>${esc(d.pt)}</h3><div class="en">${esc(d.en)}</div>
        <div class="meta"><span>${d.items.length} falas</span><span>${n}/${ACTS.length}</span></div><div class="bar"><i style="width:${n / ACTS.length * 100}%"></i></div></a>`;
  }).join("")}</div>`).join("")}`;
}

function viewDialog(d, tab) {
  const tabs = [["listen", "Ouvir"], ["role", "Falar"], ["act", "Exercícios"], ["phr", "Frases"]];
  const cur = ["listen", "role", "phr"].includes(tab) ? tab : "act";
  app.innerHTML = `
    <div class="crumb"><a href="#/">← Todas as situações</a><span class="tag">${esc(d.cat)}</span></div>
    <h1>${esc(d.pt)}</h1><p class="lead">${esc(d.en)}</p>
    <div class="tabs" role="tablist">${tabs.map(t => `<button role="tab" aria-selected="${t[0] === cur}" data-tab="${t[0]}">${t[1]}</button>`).join("")}</div>
    <div id="pane"></div>`;
  $$("[data-tab]").forEach(b => b.onclick = () => { location.hash = `#/d/${d.id}/${b.dataset.tab}`; });
  const pane = $("#pane");
  if (cur === "listen") paneListen(d, pane);
  else if (cur === "role") paneRole(d, pane);
  else if (cur === "phr") panePhrases(d, pane);
  else paneActivities(d, pane, tab);
}

/* --- listen --- */
function bubbles(d) {
  return d.lines.map((l, i) => {
    if (!l.en) return `<div class="scene">${esc(l.scene_pt)} · ${esc(l.scene)}</div>`;
    const me = l.r % 2 === 1, nm = speakerName(d, l);
    return `<div class="row ${me ? "me" : ""}"><span class="who" title="${esc(nm)}">${initial(nm)}</span>
      <button class="bub ${S.hideEN ? "blur" : ""}" data-i="${i}"><div class="name">${esc(nm)}</div><div class="t">${esc(T(l))}</div>${S.showPT ? `<div class="pt">${esc(l.pt)}</div>` : ""}</button></div>`;
  }).join("");
}
function paneListen(d, pane) {
  pane.innerHTML = `
    <div class="toolbar">
      <button class="btn" id="all">${ICO.play} Ouvir tudo</button>
      <button class="chip" id="tpt" aria-pressed="${S.showPT}">Português</button>
      <button class="chip" id="ten" aria-pressed="${S.hideEN}">Esconder inglês (só ouvir)</button>
    </div>
    ${d.note ? `<p class="note">${esc(d.note)}</p>` : ""}
    <div class="chat" id="chat">${bubbles(d)}</div>
    <p class="note">Toque em uma fala para ouvir só ela. Use 0.75× no topo para ouvir mais devagar.</p>`;
  const mark = i => { $$(".bub", pane).forEach(b => b.classList.toggle("playing", +b.dataset.i === i)); const b = $(`.bub[data-i="${i}"]`, pane); if (b) b.scrollIntoView({ block: "center", behavior: "smooth" }); };
  $("#tpt").onclick = () => { S.showPT = !S.showPT; saveS(); paneListen(d, pane); };
  $("#ten").onclick = () => { S.hideEN = !S.hideEN; saveS(); paneListen(d, pane); };
  $("#chat").onclick = async e => {
    const b = e.target.closest(".bub"); if (!b) return;
    const i = +b.dataset.i; mark(i); await playLine(d, d.lines[i]); mark(-1);
  };
  let playing = false;
  $("#all").onclick = async () => {
    const btn = $("#all");
    if (playing) { stopAudio(); return; }
    playing = true; btn.innerHTML = ICO.stop + " Parar";
    stopAudio(); const my = token;
    for (let i = 0; i < d.lines.length; i++) {
      const l = d.lines[i]; if (!l.en) continue;
      mark(i); await playLine(d, l); if (my !== token) break;
      await new Promise(r => setTimeout(r, 350)); if (my !== token) break;
    }
    playing = false; mark(-1); const b2 = $("#all"); if (b2) b2.innerHTML = ICO.play + " Ouvir tudo";
  };
}

/* --- phrases --- */
function panePhrases(d, pane) {
  pane.innerHTML = `<div class="panel">${d.phrases.map((p, i) => `
    <div class="phr"><button class="icon" data-p="${i}" aria-label="Ouvir">${ICO.play}</button>
    <div><div class="en">${esc(T(p))}</div><div class="pt">${esc(p.pt)}</div></div>
    <button class="icon" data-s="${i}" aria-label="Falar">${ICO.mic}</button></div>
    <div id="fb${i}"></div>`).join("")}</div>
    <p class="note">Ouça, depois toque no microfone e diga a frase. O app mostra as palavras que você acertou.</p>`;
  pane.onclick = async e => {
    const pb = e.target.closest("[data-p]"), sb = e.target.closest("[data-s]");
    if (pb) playPhrase(d, d.phrases[+pb.dataset.p]);
    if (sb) speakCheck(sb, d.phrases[+sb.dataset.s], $("#fb" + sb.dataset.s));
  };
}
async function speakCheck(btn, item, out, after) {
  btn.classList.add("rec");
  out.innerHTML = `<div class="note">Ouvindo… fale agora.</div>`;
  try {
    const heard = await listen(); btn.classList.remove("rec");
    const c = compare(T(item), heard);
    out.innerHTML = `<div class="fb ${c.score >= .8 ? "ok" : "bad"}"><div class="diff">${c.html}</div>
      <div>${pct(c.score)}% · ${heard.length ? "Entendi: “" + esc(c.heard) + "”" : "Não ouvi nada. Tente de novo, mais perto do microfone."}</div></div>`;
    if (after) after(c);
  } catch (err) {
    btn.classList.remove("rec");
    out.innerHTML = `<div class="warn">${err === "nosr" ? "Este navegador não reconhece voz. Use Chrome, Edge ou Safari. Enquanto isso, ouça e repita em voz alta." :
      err === "not-allowed" ? "O microfone está bloqueado. Libere a permissão do microfone no navegador." : "Não consegui ouvir (" + esc(err) + "). Tente de novo."}</div>`;
  }
}

/* --- role-play --- */
function paneRole(d, pane) {
  pane.innerHTML = `<div class="panel"><h3>Escolha seu personagem</h3>
    <p class="lead">O app fala as falas do outro personagem. Quando chegar sua vez, diga a frase.</p>
    <div class="hero-actions">${d.roles.map((r, i) => `<button class="btn ${i ? "ghost" : ""}" data-r="${i}">${esc(r.name)}</button>`).join("")}</div>
    ${SR ? "" : `<div class="warn" style="margin-top:12px">Este navegador não tem reconhecimento de voz. Você ainda pode treinar: ouça, repita em voz alta e marque como feito.</div>`}</div>`;
  pane.onclick = e => { const b = e.target.closest("[data-r]"); if (b) runRole(d, pane, +b.dataset.r); };
}
function runRole(d, pane, me) {
  pane.innerHTML = `<div class="toolbar"><button class="chip" id="hint" aria-pressed="true">Mostrar minha fala</button><button class="btn sm ghost" id="back">Trocar personagem</button></div>
    <div class="chat" id="log"></div><div id="ctl"></div>`;
  $("#back").onclick = () => paneRole(d, pane);
  let hint = true; $("#hint").onclick = e => { hint = !hint; e.target.setAttribute("aria-pressed", hint); const t = $("#myline"); if (t) t.classList.toggle("blur", !hint); };
  const log = $("#log"), ctl = $("#ctl"); let i = 0, tot = 0, cnt = 0;
  stopAudio(); const my = token;
  const bub = (l, nm, mine) => { const x = document.createElement("div"); x.className = "row" + (mine ? " me" : ""); x.innerHTML = `<span class="who">${initial(nm)}</span><div class="bub"><div class="name">${esc(nm)}</div><div class="t">${esc(T(l))}</div>${S.showPT ? `<div class="pt">${esc(l.pt)}</div>` : ""}</div>`; log.appendChild(x); x.scrollIntoView({ block: "center", behavior: "smooth" }); return x; };
  async function step() {
    if (my !== token) return;
    while (i < d.lines.length) {
      const l = d.lines[i];
      if (!l.en) { log.insertAdjacentHTML("beforeend", `<div class="scene">${esc(l.scene_pt)} · ${esc(l.scene)}</div>`); i++; continue; }
      if (l.r !== me) { const x = bub(l, speakerName(d, l), false); x.querySelector(".bub").classList.add("playing"); await playLine(d, l); if (my !== token) return; x.querySelector(".bub").classList.remove("playing"); i++; await new Promise(r => setTimeout(r, 250)); if (my !== token) return; continue; }
      // my turn
      ctl.innerHTML = `<div class="panel center"><div class="note">Sua vez: ${esc(d.roles[me].name)}</div>
        <div class="bub ${hint ? "" : "blur"}" id="myline" style="margin:8px 0"><div class="t">${esc(T(l))}</div><div class="pt">${esc(l.pt)}</div></div>
        <div class="inline" style="justify-content:center"><button class="btn sm ghost" id="mod">${ICO.play} Ouvir modelo</button>
        ${SR ? `<button class="mic" id="mic" aria-label="Falar">${ICO.mic}</button>` : `<button class="btn sm" id="said">Falei em voz alta</button>`}
        <button class="btn sm ghost" id="skip">Pular</button></div><div id="res"></div></div>`;
      $("#mod").onclick = () => playLine(d, l);
      await new Promise(go => {
        $("#skip").onclick = () => { cnt++; go(); };
        if ($("#said")) $("#said").onclick = () => { cnt++; tot += 1; go(); };
        if ($("#mic")) $("#mic").onclick = () => speakCheck($("#mic"), l, $("#res"), c => {
          if (c.score >= .8) { tot += c.score; cnt++; clearWeak(d.id, l.a); addXP(5); setTimeout(go, 1100); }
          else { addWeak(d.id, l.a); }
        });
      });
      if (my !== token) return;
      ctl.innerHTML = ""; bub(l, d.roles[me].name, true); i++;
    }
    const p = cnt ? tot / cnt : 0;
    ctl.innerHTML = `<div class="panel center"><div class="score">${pct(p)}%</div><p>Role-play concluído. Pontuação média das suas falas.</p>
      <div class="hero-actions" style="justify-content:center"><button class="btn" id="again">Repetir</button><a class="btn ghost" href="#/d/${d.id}/act">Exercícios</a></div></div>`;
    markDone(d.id, "role", SR ? p : 1); $("#again").onclick = () => paneRole(d, pane);
  }
  step();
}

/* --- activities --- */
function paneActivities(d, pane, tab) {
  const run = ACTS.find(a => a[0] === tab);
  if (run && tab !== "role") return runActivity(d, pane, tab);
  pane.innerHTML = `<div class="act-grid">${ACTS.filter(a => a[0] !== "role").map(a => {
    const v = P.done[d.id + ":" + a[0]];
    return `<button class="act" data-a="${a[0]}"><b>${a[1]}</b><span>${a[2]}</span><span class="${v >= .7 ? "done" : ""}">${v != null ? "Melhor: " + pct(v) + "%" : "Ainda não feito"}</span></button>`;
  }).join("")}</div>`;
  pane.onclick = e => { const b = e.target.closest("[data-a]"); if (b) location.hash = `#/d/${d.id}/${b.dataset.a}`; };
}
const STOP = new Set("the a an and or but to of in on at for with is are was were be been am i you he she it we they me my your his her our their this that these those do does did will would can could have has had not no yes so if as by from up out about there here what when where how who which than then them us".split(" "));
function mkListen(d, n = 6) {
  return sample(d.items, n).map(l => {
    const pool = shuffle(d.items.filter(x => x !== l && Math.abs(x.en.length - l.en.length) < 60)).slice(0, 3);
    return { kind: "mc", audio: () => playLine(d, l), prompt: "Ouça e escolha a frase que você ouviu.", opts: shuffle([l, ...pool]).map(x => T(x)), ans: T(l), ref: [d.id, l.a], noText: true };
  });
}
function mkDict(d, n = 5) {
  return sample(d.items.filter(l => norm(l.en).length >= 4 && norm(l.en).length <= 14), n).map(l => ({ kind: "type", audio: () => playLine(d, l), prompt: "Ouça e escreva o que você ouviu.", target: T(l), mode: "dict", pt: l.pt, ref: [d.id, l.a] }));
}
function mkCloze(d, n = 7) {
  const out = [];
  sample(d.items, 40).forEach(l => {
    if (out.length >= n) return;
    const txt = T(l), words = txt.match(/[A-Za-z']+/g) || [];
    const cands = words.filter(w => w.length >= 4 && !STOP.has(w.toLowerCase()));
    if (words.length < 4 || !cands.length) return;
    const w = cands[Math.random() * cands.length | 0];
    out.push({ kind: "type", audio: () => playLine(d, l), prompt: "Complete a frase.", display: txt.replace(w, "_____"), target: w, mode: "word", pt: l.pt, ref: [d.id, l.a] });
  });
  return out;
}
function mkOrder(d, n = 5) {
  return sample(d.items.filter(l => { const k = T(l).split(/\s+/).length; return k >= 4 && k <= 10; }), n).map(l => ({ kind: "order", audio: () => playLine(d, l), prompt: "Monte a frase.", target: T(l), pt: l.pt, ref: [d.id, l.a] }));
}
function mkQuiz(d) { return d.quiz.map(q => ({ kind: "mc", prompt: q.q, opts: shuffle(q.o), ans: q.o[q.a] })); }
function mkCards(d, n = 8) {
  const pool = D.dialogs.flatMap(x => x.phrases.map(p => ({ p, x })));
  const mine = d.phrases.map(p => ({ p, x: d }));
  return sample(mine.concat(sample(mine, 2)), n).slice(0, n).map((c, k) => {
    const other = sample(pool.filter(o => o.p !== c.p), 3);
    if (k % 2 === 0) return { kind: "mc", prompt: "Como se diz em inglês?  " + c.p.pt, opts: shuffle([c.p, ...other.map(o => o.p)]).map(T), ans: T(c.p) };
    return { kind: "mc", audio: () => playPhrase(c.x, c.p), prompt: "Ouça. O que significa?", opts: shuffle([c.p, ...other.map(o => o.p)]).map(p => p.pt), ans: c.p.pt, noText: true };
  });
}
function mkSay(d) { return d.phrases.map(p => ({ kind: "speak", audio: () => playPhrase(d, p), prompt: "Ouça e repita.", target: T(p), pt: p.pt })); }
const MAKERS = { hear: mkListen, dict: mkDict, cloze: mkCloze, order: mkOrder, quiz: mkQuiz, cards: mkCards, say: mkSay };

function runActivity(d, pane, act) {
  const qs = MAKERS[act](d);
  const title = ACTS.find(a => a[0] === act)[1];
  runQuestions(pane, title, qs, res => markDone(d.id, act, res), `#/d/${d.id}/act`, () => runActivity(d, pane, act));
}

/** Generic runner: shows questions one at a time. */
function runQuestions(pane, title, qs, onEnd, backHref, again) {
  let i = 0, right = 0, answered = false;
  const next = () => {
    if (i >= qs.length) {
      const r = right / qs.length; onEnd(r);
      pane.innerHTML = `<div class="panel center"><h2>${esc(title)}</h2><div class="score">${pct(r)}%</div><p>${right} de ${qs.length} certas. ${r >= .7 ? "Muito bem! +20 pontos." : "Repita para chegar a 70%."}</p>
      <div class="hero-actions" style="justify-content:center"><button class="btn" id="again">Repetir</button><a class="btn ghost" href="${backHref}">Voltar</a></div></div>`;
      $("#again").onclick = again; return;
    }
    answered = false; const q = qs[i];
    pane.innerHTML = `<div class="panel"><div class="q-top"><span>${esc(title)}</span><span>${i + 1} / ${qs.length}</span></div>
      <p class="q-prompt">${esc(q.prompt)}</p>
      ${q.audio ? `<button class="btn sm ghost" id="aud">${ICO.play} Ouvir</button>` : ""}
      <div id="body" style="margin-top:12px"></div><div id="fb"></div><div style="margin-top:14px" id="nx"></div></div>`;
    if (q.audio) { $("#aud").onclick = q.audio; setTimeout(q.audio, 200); }
    const finish = (ok, msg) => {
      if (answered) return; answered = true; if (ok) { right++; addXP(2); if (q.ref) clearWeak(...q.ref); } else if (q.ref) addWeak(...q.ref);
      $("#fb").innerHTML = msg ? `<div class="fb ${ok ? "ok" : "bad"}">${msg}</div>` : "";
      $("#nx").innerHTML = `<button class="btn" id="go">${i + 1 === qs.length ? "Ver resultado" : "Próxima"}</button>`; $("#go").onclick = () => { i++; next(); }; $("#go").focus();
    };
    const body = $("#body");
    if (q.kind === "mc") {
      body.innerHTML = `<div class="opts">${q.opts.map((o, k) => `<button class="opt" data-k="${k}">${esc(o)}</button>`).join("")}</div>`;
      body.onclick = e => {
        const b = e.target.closest(".opt"); if (!b || answered) return; const ok = q.opts[+b.dataset.k] === q.ans;
        $$(".opt", body).forEach(x => { x.disabled = true; if (q.opts[+x.dataset.k] === q.ans) x.classList.add("ok"); }); if (!ok) b.classList.add("bad");
        finish(ok, ok ? "Correto!" : "A resposta certa está em verde.");
      };
    } else if (q.kind === "type") {
      body.innerHTML = `${q.display ? `<p class="q-prompt" style="font-size:1.3rem">${esc(q.display)}</p>` : ""}<div class="note">${esc(q.pt || "")}</div>
        <input class="input" id="inp" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${q.mode === "word" ? "Palavra que falta" : "Escreva a frase"}" aria-label="Resposta"><div style="margin-top:10px"><button class="btn" id="chk">Conferir</button></div>`;
      const check = () => {
        const v = $("#inp").value.trim(); if (!v) return;
        if (q.mode === "word") { const ok = v.toLowerCase() === q.target.toLowerCase(); finish(ok, ok ? "Correto!" : `Resposta: <b>${esc(q.target)}</b>`); }
        else { const c = compare(q.target, [v]); const ok = c.score >= .85; finish(ok, `<div class="diff">${c.html}</div><div>${pct(c.score)}% · ${esc(q.target)}</div>`); }
        $("#inp").disabled = true; $("#chk").disabled = true;
      };
      $("#chk").onclick = check; $("#inp").onkeydown = e => { if (e.key === "Enter") check(); }; $("#inp").focus();
    } else if (q.kind === "order") {
      const toks = q.target.split(/\s+/); let pool = shuffle(toks.map((t, k) => ({ t, k }))); let built = [];
      const draw = () => {
        body.innerHTML = `<div class="note">${esc(q.pt)}</div><div class="words" id="built">${built.map(x => `<button class="w" data-b="${x.k}">${esc(x.t)}</button>`).join("")}</div>
          <div class="words" style="border-style:solid">${pool.map(x => `<button class="w" data-p="${x.k}">${esc(x.t)}</button>`).join("")}</div>
          <button class="btn" id="chk" ${pool.length ? "disabled" : ""}>Conferir</button>`;
        if (!pool.length) $("#chk").onclick = () => { const ok = built.map(x => x.t).join(" ") === toks.join(" "); finish(ok, ok ? "Correto!" : `Frase certa: <b>${esc(q.target)}</b>`); $$(".w", body).forEach(w => w.disabled = true); $("#chk").disabled = true; };
      };
      body.onclick = e => {
        if (answered) return; const p = e.target.closest("[data-p]"), b = e.target.closest("[data-b]");
        if (p) { const x = pool.find(z => z.k === +p.dataset.p); pool = pool.filter(z => z !== x); built.push(x); draw(); }
        if (b) { const x = built.find(z => z.k === +b.dataset.b); built = built.filter(z => z !== x); pool.push(x); draw(); }
      };
      draw();
    } else if (q.kind === "speak") {
      body.innerHTML = `<div class="bub" style="margin-bottom:8px"><div class="t">${esc(q.target)}</div><div class="pt">${esc(q.pt)}</div></div>
        <div class="center">${SR ? `<button class="mic" id="mic" aria-label="Falar">${ICO.mic}</button>` : `<button class="btn" id="said">Repeti em voz alta</button>`}</div><div id="res"></div>`;
      if ($("#said")) $("#said").onclick = () => finish(true, "Boa! Continue repetindo em voz alta.");
      if ($("#mic")) $("#mic").onclick = () => speakCheck($("#mic"), { en: q.target }, $("#res"), c => { if (c.score >= .8) setTimeout(() => finish(true, ""), 900); else { $("#nx").innerHTML = `<button class="btn ghost" id="sk">Pular</button>`; $("#sk").onclick = () => finish(false, ""); } });
    }
  };
  next();
}

/* --- phrasebook --- */
function viewBook() {
  app.innerHTML = `<h1>Banco de frases</h1><p class="lead">Expressões dos seus cadernos, dos diálogos e de pesquisas: avião, aeroporto, atrasos, trânsito, restaurante e fala natural. Toque no alto-falante para ouvir no sotaque escolhido.</p>
    ${D.book.map((g, gi) => `<div class="cat">${esc(g.name)}</div><div class="panel">${g.items.map((it, k) => `
      <div class="phr"><button class="icon" data-i="${it.i}" aria-label="Ouvir">${ICO.play}</button>
      <div><div class="en">${esc(g.name.startsWith("Inglês americano") ? (S.accent === "uk" ? it.uk : it.en.split("=")[0]) : T(it))}</div><div class="pt">${esc(it.pt)}${g.name.startsWith("Inglês americano") ? " · " + (S.accent === "uk" ? "US: " + esc(it.en.split("=")[0]) : "UK: " + esc(it.uk)) : ""}</div></div>
      <button class="icon" data-s="${it.i}" aria-label="Falar">${ICO.mic}</button></div><div id="fb${it.i}"></div>`).join("")}</div>`).join("")}`;
  const all = D.book.flatMap(g => g.items);
  app.onclick = e => {
    const pb = e.target.closest("[data-i]"), sb = e.target.closest("[data-s]");
    if (pb) playBook(all[+pb.dataset.i]);
    if (sb) { const it = all[+sb.dataset.s]; speakCheck(sb, it.en.includes(" = ") ? { en: S.accent === "uk" ? it.uk : it.en.split("=")[0].trim() } : it, $("#fb" + it.i)); }
  };
}

/* --- review mix --- */
function viewMix() {
  const weak = P.weak.map(k => { const [id, i] = k.split("#"); const d = byId(id); return d && d.items.find(l => l.a === +i) ? { d, l: d.items.find(l => l.a === +i) } : null; }).filter(Boolean);
  app.innerHTML = `<h1>Revisão do dia</h1><p class="lead">Dez exercícios misturados de todas as situações. Frases em que você errou voltam aqui primeiro.</p>
    <div class="stats"><div class="stat"><b>${weak.length}</b><span>frases para revisar</span></div></div>
    <div class="hero-actions"><button class="btn" id="go">Começar revisão</button></div><div id="pane" style="margin-top:16px"></div>`;
  $("#go").onclick = () => {
    const pane = $("#pane"); $("#go").hidden = true;
    const src = weak.length >= 4 ? sample(weak, 10) : sample(weak.concat(sample(D.dialogs.flatMap(d => d.items.map(l => ({ d, l }))), 14)), 10);
    const qs = src.map(({ d, l }, k) => {
      const kind = k % 3;
      if (kind === 0) { const pool = shuffle(d.items.filter(x => x !== l)).slice(0, 3); return { kind: "mc", audio: () => playLine(d, l), prompt: "Ouça e escolha a frase.", opts: shuffle([l, ...pool]).map(T), ans: T(l), ref: [d.id, l.a] }; }
      if (kind === 1 && norm(l.en).length <= 14 && norm(l.en).length >= 4) return { kind: "type", audio: () => playLine(d, l), prompt: "Ditado: escreva o que ouviu.", target: T(l), mode: "dict", pt: l.pt, ref: [d.id, l.a] };
      const txt = T(l), words = (txt.match(/[A-Za-z']+/g) || []).filter(w => w.length >= 4 && !STOP.has(w.toLowerCase()));
      if (words.length) { const w = words[0]; return { kind: "type", audio: () => playLine(d, l), prompt: "Complete a frase.", display: txt.replace(w, "_____"), target: w, mode: "word", pt: l.pt, ref: [d.id, l.a] }; }
      return { kind: "speak", audio: () => playLine(d, l), prompt: "Ouça e repita.", target: txt, pt: l.pt };
    });
    runQuestions(pane, "Revisão", qs, r => { if (r >= .7) addXP(10); }, "#/mix", viewMix);
  };
}

/* --- progress --- */
function viewMe() {
  app.innerHTML = `<h1>Seu progresso</h1>
    <div class="stats"><div class="stat"><b>${P.xp}</b><span>pontos</span></div><div class="stat"><b>${P.streak}</b><span>dias seguidos</span></div><div class="stat"><b>${P.weak.length}</b><span>para revisar</span></div></div>
    <div class="panel">${D.dialogs.map(d => { const n = dlgProgress(d); return `<div class="phr" style="grid-template-columns:1fr auto"><a href="#/d/${d.id}">${esc(d.pt)}</a><span class="tag">${n}/${ACTS.length}</span></div>`; }).join("")}</div>
    <div class="panel"><h3>Levar o progresso para outro aparelho</h3>
    <p class="note">O progresso fica salvo neste navegador. Para usar em outro celular ou computador, copie o código abaixo e cole lá.</p>
    <textarea class="input" id="code" aria-label="Código de progresso" spellcheck="false"></textarea>
    <div class="hero-actions"><button class="btn sm" id="exp">Gerar código</button><button class="btn sm ghost" id="imp">Carregar código</button><button class="btn sm ghost" id="rst">Zerar progresso</button></div><div id="msg" class="note"></div></div>`;
  $("#exp").onclick = () => { $("#code").value = btoa(unescape(encodeURIComponent(JSON.stringify(P)))); $("#code").select(); $("#msg").textContent = "Copie o código acima."; };
  $("#imp").onclick = () => { try { const o = JSON.parse(decodeURIComponent(escape(atob($("#code").value.trim())))); Object.assign(P, { xp: 0, streak: 0, last: "", done: {}, weak: [] }, o); saveP(); viewMe(); $("#msg").textContent = "Progresso carregado."; } catch { $("#msg").textContent = "Código inválido."; } };
  $("#rst").onclick = () => { if ($("#rst").dataset.sure) { Object.assign(P, { xp: 0, streak: 0, last: "", done: {}, weak: [] }); saveP(); viewMe(); } else { $("#rst").dataset.sure = 1; $("#rst").textContent = "Toque de novo para confirmar"; } };
}

/* ---------- boot ---------- */
syncControls(); route();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { });
try { speechSynthesis.getVoices(); } catch { }
