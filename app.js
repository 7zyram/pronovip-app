/* PronoVIP – appli web (v1)
   Connexion, pronos du jour (gratuits + VIP), suivi perso, espace admin. */
(function () {
  "use strict";
  const C = window.PV_CONFIG;
  const app = document.getElementById("app");
  const toastEl = document.getElementById("toast");

  if (!window.supabase || !window.supabase.createClient) {
    app.innerHTML = '<div class="splash"><p>Impossible de charger l\'appli. Vérifie ta connexion puis recharge la page.</p></div>';
    return;
  }
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  // ---------- Utilitaires ----------
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = n => String(n).padStart(2, "0");
  const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const today = () => ymd(new Date());
  const addDays = (s, n) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + n); return ymd(d); };
  const num = v => { const n = Number(String(v).replace(",", ".")); return isFinite(n) ? n : NaN; };
  const fmtOdd = v => Number(v).toFixed(2).replace(".", ",");
  const fmtEur = v => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2).replace(".", ",") + " €";
  const fmtU = v => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2).replace(".", ",") + " u";
  const pct = v => Math.round(v * 100) + " %";
  const LEVELS = { confiance: "Confiance", equilibre: "Équilibré", audacieux: "Audacieux" };
  const RES = { attente: "En attente", gagne: "Gagné", perdu: "Perdu", rembourse: "Remboursé" };
  function dayLabel(s) {
    const t = today();
    if (s === t) return "Aujourd'hui";
    if (s === addDays(t, 1)) return "Demain";
    if (s === addDays(t, -1)) return "Hier";
    return new Date(s + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
  }
  let toastT;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { toastEl.hidden = true; }, 2800);
  }
  function errFr(e) {
    const m = (e && (e.message || e.error_description)) || String(e || "");
    if (/Invalid login credentials/i.test(m)) return "E-mail ou mot de passe incorrect.";
    if (/already registered|already been registered/i.test(m)) return "Un compte existe déjà avec cet e-mail.";
    if (/at least 6/i.test(m)) return "Mot de passe : 6 caractères minimum.";
    if (/Email not confirmed/i.test(m)) return "Confirme d'abord ton e-mail (regarde dans tes mails).";
    if (/rate limit|too many/i.test(m)) return "Trop d'essais, réessaie dans quelques minutes.";
    if (/Failed to fetch|NetworkError/i.test(m)) return "Pas de connexion internet.";
    return m || "Une erreur est survenue.";
  }
  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

  // ---------- État ----------
  const S = {
    session: null, profile: null, tab: "pronos", day: today(),
    pronos: [], teasers: [], stats: null, bets: [], betsLoaded: false, history: [], historyLoaded: false,
    prefill: null, authMode: "login", authMsg: "", authErr: "", recovery: false,
    confirmDel: null, loading: false, vipModal: false, vipOk: false
  };
  let installEvt = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; if (S.tab === "compte") render(); });

  const isVip = () => !!S.profile && (S.profile.is_admin || (S.profile.vip_until && new Date(S.profile.vip_until) > new Date()));
  const isAdmin = () => !!S.profile && S.profile.is_admin;

  // ---------- Données ----------
  async function loadProfile() {
    const uid = S.session.user.id;
    for (let i = 0; i < 3; i++) {
      const { data, error } = await sb.from("profiles").select("*").eq("id", uid).maybeSingle();
      if (error) throw error;
      if (data) { S.profile = data; return; }
      await new Promise(r => setTimeout(r, 600));
    }
    S.profile = { id: uid, email: S.session.user.email, is_admin: false, vip_until: null, monthly_budget: null };
  }
  async function loadDay() {
    S.loading = true; render();
    try {
      const [p, t, st] = await Promise.all([
        sb.from("pronos").select("*").eq("match_date", S.day).order("kickoff", { ascending: true, nullsFirst: false }).order("id", { ascending: true }),
        sb.rpc("vip_teasers", { d: S.day }),
        sb.rpc("pronos_stats")
      ]);
      if (p.error) throw p.error;
      S.pronos = p.data || [];
      S.teasers = t.error ? [] : (t.data || []);
      S.stats = st.error ? null : (Array.isArray(st.data) ? st.data[0] : st.data);
    } catch (e) { toast(errFr(e)); }
    S.loading = false; render();
  }
  async function loadHistory() {
    const [h, st] = await Promise.all([sb.rpc("pronos_history", { p_limit: 300 }), sb.rpc("pronos_stats")]);
    if (h.error) { toast(errFr(h.error)); return; }
    S.history = h.data || []; S.historyLoaded = true;
    if (!st.error) S.stats = Array.isArray(st.data) ? st.data[0] : st.data;
    render();
  }
  // Heure de début du match (heure du téléphone, l'appli vise la France)
  const started = p => new Date(p.match_date + "T" + (p.kickoff || "23:59") + ":00") <= new Date();
  const fmtStamp = s => new Date(s).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  async function loadBets() {
    const { data, error } = await sb.from("bets").select("*").order("bet_date", { ascending: false }).order("id", { ascending: false }).limit(500);
    if (error) { toast(errFr(error)); return; }
    S.bets = data || []; S.betsLoaded = true; render();
  }

  // ---------- Vues ----------
  const ICON = {
    ball: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7l4 3-1.5 4.5h-5L8 10z"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>',
    left: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
    right: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    lockSm: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></svg>',
    lock: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>'
  };
  const RG = '<div class="rg">18+ · Jouer comporte des risques : endettement, isolement, dépendance. Besoin d\'aide ? Appelle le <a href="tel:0974751313">09 74 75 13 13</a> (appel non surtaxé). Nos pronos sont des analyses, pas des garanties.</div>';

  function viewAuth() {
    if (S.recovery) {
      return `<div class="auth"><div class="auth-logo"><img src="icons/icon-192.png" alt=""><h1>Prono<span>VIP</span></h1></div>
      <form class="card" data-form="newpass">
        <h2 style="font-size:22px">Nouveau mot de passe</h2>
        <label class="f">Mot de passe<input type="password" name="password" autocomplete="new-password" minlength="6" required></label>
        ${S.authErr ? `<p class="err">${esc(S.authErr)}</p>` : ""}
        <button class="btn btn-main" type="submit">Enregistrer</button>
      </form></div>`;
    }
    const signup = S.authMode === "signup";
    return `<div class="auth">
      <div class="auth-logo"><img src="icons/icon-192.png" alt=""><h1>Prono<span>VIP</span></h1><p>Le foot analysé avant le coup d'envoi</p></div>
      <form class="card" data-form="${signup ? "signup" : "login"}" novalidate>
        <div class="seg" role="group" aria-label="Connexion ou inscription">
          <button type="button" data-act="mode" data-v="login" aria-pressed="${!signup}">Connexion</button>
          <button type="button" data-act="mode" data-v="signup" aria-pressed="${signup}">Inscription</button>
        </div>
        <label class="f">E-mail<input type="email" name="email" autocomplete="email" inputmode="email" value="${esc(S.authEmail || "")}" required></label>
        <label class="f">Mot de passe<input type="password" name="password" autocomplete="${signup ? "new-password" : "current-password"}" minlength="6" required></label>
        ${signup ? `<label class="check"><input type="checkbox" name="age" required><span>J'ai 18 ans ou plus et je sais que les paris comportent des risques.</span></label>` : ""}
        ${S.authErr ? `<p class="err">${esc(S.authErr)}</p>` : ""}
        ${S.authMsg ? `<p class="note" style="color:var(--grass-d);font-weight:600">${esc(S.authMsg)}</p>` : ""}
        <button class="btn btn-main" type="submit">${signup ? "Créer mon compte" : "Se connecter"}</button>
        ${signup ? "" : `<button class="btn btn-ghost btn-sm" type="button" data-act="forgot">Mot de passe oublié ?</button>`}
      </form>
      <p class="note" style="color:#fff;opacity:.85;margin-top:14px;text-align:center;max-width:400px">18+ · Jouer comporte des risques : endettement, isolement, dépendance. 09 74 75 13 13.<br><a style="color:#fff" href="cgv.html" target="_blank">CGV</a> · <a style="color:#fff" href="confidentialite.html" target="_blank">Confidentialité</a> · <a style="color:#fff" href="mentions-legales.html" target="_blank">Mentions légales</a> · <a style="color:#fff" href="jeu-responsable.html" target="_blank">Jeu responsable</a></p>
    </div>`;
  }

  function levelPill(l) { return `<span class="lvl lvl-${esc(l)}"><i></i>${esc(LEVELS[l] || l)}</span>`; }

  function viewStatsBand() {
    const s = S.stats;
    if (!s || !s.total) return "";
    const rate = s.gagnes / s.total, roi = s.profit / s.total;
    return `<section class="stats-band" aria-label="Bilan PronoVIP">
      <div class="k"><div class="l">Réussite</div><div class="v">${pct(rate)}</div></div>
      <div class="k"><div class="l">Pronos joués</div><div class="v">${s.total}</div></div>
      <div class="k"><div class="l">Rentabilité</div><div class="v ${roi >= 0 ? "pos" : "neg"}">${(roi >= 0 ? "+" : "−") + Math.abs(Math.round(roi * 100))} %</div></div>
      <p class="cap">Bilan PronoVIP sur tous les pronos terminés (mise fixe).</p>
    </section>`;
  }

  function viewProno(p) {
    return `<article class="prono">
      <div class="head">
        <div class="meta"><span>${esc(p.league)}${p.kickoff ? " · " + esc(p.kickoff) : ""}</span>${p.is_free ? '<span class="free-tag">Gratuit</span>' : '<span class="free-tag">VIP</span>'}</div>
        <div class="match">${esc(p.match)}</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${levelPill(p.level)}${p.result !== "attente" ? `<span class="res res-${esc(p.result)}">${RES[p.result]}</span>` : ""}</div>
      </div>
      <div class="body">
        <div class="pick"><div><div class="lbl">Notre prono</div><div class="p">${esc(p.pick)}</div></div>
          <div class="odd"><b>${fmtOdd(p.odd)}</b><small>cote</small></div></div>
        ${p.analysis ? `<p class="analysis">${esc(p.analysis)}</p>` : ""}
        <button class="btn btn-ghost btn-sm" data-act="track" data-id="${p.id}">+ Ajouter à mon suivi</button>
      </div>
    </article>`;
  }

  function viewLocked(t) {
    return `<article class="prono locked">
      <div class="head">
        <div class="meta"><span>${esc(t.league)}${t.kickoff ? " · " + esc(t.kickoff) : ""}</span><span class="free-tag">VIP</span></div>
        <div class="match">${esc(t.match)}</div>
        <div>${levelPill(t.level)}</div>
      </div>
      <div class="body">
        <div class="blur" aria-hidden="true"><div class="pick"><div><div class="lbl">Notre prono</div><div class="p">Prono réservé VIP</div></div><div class="odd"><b>1,00</b><small>cote</small></div></div>
          <p class="analysis">L'analyse complète de ce match est réservée aux membres VIP de PronoVIP.</p></div>
        <div class="lock-over">${ICON.lock}<b>Réservé aux VIP</b><button class="btn btn-gold btn-sm" data-act="vip">Devenir VIP · ${esc(C.VIP_PRICE)}</button></div>
      </div>
    </article>`;
  }

  function viewPronos() {
    const shownIds = new Set(S.pronos.map(p => p.id));
    const locked = isVip() ? [] : S.teasers.filter(t => !shownIds.has(t.id));
    let list;
    if (S.loading && !S.pronos.length) list = '<div class="empty">Chargement…</div>';
    else if (!S.pronos.length && !locked.length) list = `<div class="card empty"><b>Pas encore de prono</b>Les pronos de ${esc(dayLabel(S.day).toLowerCase())} arrivent bientôt. Reviens plus tard !</div>`;
    else list = S.pronos.map(viewProno).join("") + locked.map(viewLocked).join("");
    return `${viewStatsBand()}
      <div class="sec-h"><h2>Les pronos</h2>
        <div class="daynav"><button data-act="day" data-v="-1" aria-label="Jour précédent">${ICON.left}</button><span>${esc(dayLabel(S.day))}</span><button data-act="day" data-v="1" aria-label="Jour suivant">${ICON.right}</button></div>
      </div>
      ${list}
      ${!isVip() ? `<div class="card" style="display:flex;flex-direction:column;gap:10px;align-items:flex-start"><h3 style="font-size:20px">Tous les pronos du jour</h3><p class="note" style="font-size:15px">Avec le Pass VIP, tu débloques tous les matchs analysés et le canal Telegram privé. 30 jours, sans engagement.</p><button class="btn btn-gold" data-act="vip">Devenir VIP · ${esc(C.VIP_PRICE)}</button></div>` : ""}
      ${RG}`;
  }

  function betStats(bets) {
    let w = 0, l = 0, profit = 0, staked = 0, month = 0;
    const m = today().slice(0, 7);
    for (const b of bets) {
      const st = Number(b.stake), od = Number(b.odd);
      if (String(b.bet_date).slice(0, 7) === m) month += st;
      if (b.result === "gagne") { w++; profit += st * (od - 1); staked += st; }
      else if (b.result === "perdu") { l++; profit -= st; staked += st; }
    }
    return { w, l, profit, staked, month, rate: w + l ? w / (w + l) : null, roi: staked ? profit / staked : null, pending: bets.filter(b => b.result === "attente").length };
  }

  function viewSuivi() {
    if (!S.betsLoaded) return '<div class="empty">Chargement…</div>';
    const s = betStats(S.bets);
    const budget = S.profile && S.profile.monthly_budget ? Number(S.profile.monthly_budget) : null;
    const ratio = budget ? s.month / budget : 0;
    const pf = S.prefill || {};
    const budgetBlock = budget ? `
      <section class="card" style="display:flex;flex-direction:column;gap:8px">
        <div class="sec-h"><h3 style="font-size:20px">Mon budget du mois</h3><b>${s.month.toFixed(2).replace(".", ",")} / ${budget.toFixed(2).replace(".", ",")} €</b></div>
        <div class="bar ${ratio >= 1 ? "over" : ratio >= .8 ? "warn" : ""}"><div style="width:${Math.min(100, Math.round(ratio * 100))}%"></div></div>
        ${ratio >= 1 ? '<div class="alert">Budget du mois atteint. On s\'arrête là pour ce mois-ci.</div>' : ratio >= .8 ? '<div class="alert" style="background:#FFF3CC;color:#7A5A00">Attention : tu as utilisé plus de 80 % de ton budget du mois.</div>' : ""}
      </section>` : `<section class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px"><p class="note" style="font-size:15px">Fixe un budget par mois : l'appli te prévient à 80 %.</p><button class="btn btn-ghost btn-sm" data-act="tab" data-v="compte">Fixer</button></section>`;
    const list = S.bets.length ? S.bets.map(b => {
      const gain = b.result === "gagne" ? Number(b.stake) * (Number(b.odd) - 1) : b.result === "perdu" ? -Number(b.stake) : 0;
      return `<div class="bet">
        <div class="t"><div><div class="m">${esc(b.match)}</div><div class="s">${esc(b.pick)} · cote ${fmtOdd(b.odd)} · mise ${Number(b.stake).toFixed(2).replace(".", ",")} €</div><div class="s">${esc(dayLabel(String(b.bet_date)))}</div></div>
          ${b.result === "attente" ? '<span class="res res-attente">En attente</span>' : `<b class="${gain >= 0 ? "pos" : "neg"}" style="color:${gain > 0 ? "var(--grass)" : gain < 0 ? "var(--red)" : "var(--muted)"}">${fmtEur(gain)}</b>`}</div>
        <div class="acts">
          <button class="g" data-act="bres" data-id="${b.id}" data-v="gagne" aria-pressed="${b.result === "gagne"}">Gagné</button>
          <button class="p" data-act="bres" data-id="${b.id}" data-v="perdu" aria-pressed="${b.result === "perdu"}">Perdu</button>
          <button class="r" data-act="bres" data-id="${b.id}" data-v="rembourse" aria-pressed="${b.result === "rembourse"}">Remboursé</button>
          ${S.confirmDel === "b" + b.id ? `<button class="del" data-act="bdel" data-id="${b.id}">Confirmer ?</button>` : `<button class="del" data-act="askdel" data-v="b${b.id}" aria-label="Supprimer">Supprimer</button>`}
        </div></div>`;
    }).join("") : '<div class="empty"><b>Aucun pari</b>Ajoute ton premier pari ci-dessus, ou depuis un prono avec « Ajouter à mon suivi ».</div>';
    return `<div class="sec-h"><h2>Mon suivi</h2></div>
      <div class="kpis">
        <div class="k"><div class="l">Réussite</div><div class="v">${s.rate == null ? "–" : pct(s.rate)}</div></div>
        <div class="k"><div class="l">Bénéfice</div><div class="v ${s.profit >= 0 ? "pos" : "neg"}">${fmtEur(s.profit)}</div></div>
        <div class="k"><div class="l">Rentabilité</div><div class="v ${s.roi == null ? "" : s.roi >= 0 ? "pos" : "neg"}">${s.roi == null ? "–" : (s.roi >= 0 ? "+" : "−") + Math.abs(Math.round(s.roi * 100)) + " %"}</div></div>
      </div>
      ${budgetBlock}
      <form class="card form" data-form="bet">
        <h3 style="font-size:20px">Ajouter un pari</h3>
        <label class="f">Match<input type="text" name="match" placeholder="Lens – Lyon" value="${esc(pf.match || "")}" required maxlength="80"></label>
        <label class="f">Mon choix<input type="text" name="pick" placeholder="Les deux équipes marquent" value="${esc(pf.pick || "")}" required maxlength="80"></label>
        <div class="row2">
          <label class="f">Cote<input type="text" name="odd" inputmode="decimal" placeholder="1,50" value="${pf.odd ? fmtOdd(pf.odd) : ""}" required></label>
          <label class="f">Mise (€)<input type="text" name="stake" inputmode="decimal" placeholder="5" required></label>
        </div>
        <button class="btn btn-main" type="submit">Ajouter</button>
      </form>
      <section class="card"><h3 style="font-size:20px;margin-bottom:4px">Mes paris${s.pending ? ` · ${s.pending} en attente` : ""}</h3>${list}</section>
      ${RG}`;
  }

  function viewHistorique() {
    let list;
    if (!S.historyLoaded) list = '<div class="empty">Chargement…</div>';
    else if (!S.history.length) list = '<div class="card empty"><b>Historique vide</b>Les pronos apparaissent ici dès le coup d\'envoi, avec leur résultat.</div>';
    else {
      let last = "", out = "";
      for (const p of S.history) {
        const d = String(p.match_date);
        if (d !== last) { out += `<h3 class="h-day">${esc(dayLabel(d))}</h3>`; last = d; }
        out += `<div class="hrow">
          <div class="t"><div><div class="m">${esc(p.match)}</div>
            <div class="s">${esc(p.league)}${p.kickoff ? " · " + esc(p.kickoff) : ""} · ${p.is_free ? "Gratuit" : "VIP"} · ${esc(LEVELS[p.level] || p.level)}</div></div>
            <span class="res res-${esc(p.result)}">${RES[p.result] || esc(p.result)}</span></div>
          <div class="hp"><b>${esc(p.pick)}</b><span>cote ${fmtOdd(p.odd)}</span></div>
          <div class="stamp">${ICON.lockSm} Publié le ${esc(fmtStamp(p.created_at))}, verrouillé au coup d'envoi</div>
        </div>`;
      }
      list = `<section class="card">${out}</section>`;
    }
    return `${viewStatsBand()}
      <div class="sec-h"><h2>Historique</h2></div>
      <p class="note" style="font-size:15px">Tous nos pronos, gratuits et VIP, gagnés comme perdus. Chaque prono est publié avant le match et verrouillé au coup d'envoi : impossible de le modifier ou de le supprimer ensuite.</p>
      ${list}
      ${RG}`;
  }

  function viewCompte() {
    const p = S.profile || {};
    const vipTxt = p.is_admin ? "Admin" : isVip() ? "VIP jusqu'au " + new Date(p.vip_until).toLocaleDateString("fr-FR", { day: "numeric", month: "long" }) : "Gratuit";
    let install = "";
    if (!isStandalone()) {
      if (installEvt) install = `<section class="card form"><h3 style="font-size:20px">Installer l'appli</h3><p class="note" style="font-size:15px">Ajoute PronoVIP sur ton écran d'accueil.</p><button class="btn btn-main" data-act="install">Installer</button></section>`;
      else if (isIOS()) install = `<section class="card form"><h3 style="font-size:20px">Installer l'appli</h3><p class="note" style="font-size:15px">Dans Safari, appuie sur le bouton <b>Partager</b> puis sur <b>« Sur l'écran d'accueil »</b>.</p></section>`;
    }
    return `<div class="sec-h"><h2>Mon compte</h2></div>
      <section class="card form">
        <div class="sec-h"><div><div class="note">Connecté avec</div><b style="word-break:break-all">${esc(p.email || (S.session && S.session.user.email) || "")}</b></div><span class="pill ${isVip() ? "pill-vip" : ""}" style="${isVip() ? "" : "background:var(--soft)"}">${esc(vipTxt)}</span></div>
        ${!isVip() ? `<button class="btn btn-gold" data-act="vip">Devenir VIP · ${esc(C.VIP_PRICE)}</button><p class="note">Après ton achat, ton accès VIP est activé sur ce compte. Utilise la même adresse e-mail.</p>` : ""}
      </section>
      ${C.STRIPE_PORTAL && !p.is_admin ? `<section class="card form"><h3 style="font-size:20px">Mon abonnement</h3><p class="note" style="font-size:15px">Factures, carte bancaire, résiliation : tout se gère ici.</p><a class="btn btn-ghost" href="${esc(C.STRIPE_PORTAL + "?prefilled_email=" + encodeURIComponent(p.email || ""))}" target="_blank" rel="noopener">Gérer mon abonnement</a></section>` : ""}
      <form class="card form" data-form="budget">
        <h3 style="font-size:20px">Mon budget par mois</h3>
        <p class="note" style="font-size:15px">Fixe la somme maximum que tu t'autorises à miser par mois. On te prévient à 80 %.</p>
        <label class="f">Budget (€)<input type="text" name="budget" inputmode="decimal" placeholder="50" value="${p.monthly_budget ? esc(String(p.monthly_budget).replace(".", ",")) : ""}"></label>
        <button class="btn btn-main" type="submit">Enregistrer</button>
      </form>
      ${install}
      <button class="btn btn-ghost" data-act="logout">Se déconnecter</button>
      ${RG}
      <p class="note" style="text-align:center">Aide et infos : <a href="https://www.joueurs-info-service.fr" target="_blank" rel="noopener">joueurs-info-service.fr</a></p>
      <p class="note" style="text-align:center"><a href="cgv.html" target="_blank">CGV</a> · <a href="confidentialite.html" target="_blank">Confidentialité</a> · <a href="mentions-legales.html" target="_blank">Mentions légales</a> · <a href="jeu-responsable.html" target="_blank">Jeu responsable</a></p>`;
  }

  function viewAdmin() {
    return `<div class="sec-h"><h2>Admin</h2></div>
      <form class="card form" data-form="prono">
        <h3 style="font-size:20px">Publier un prono</h3>
        <div class="row2">
          <label class="f">Date<input type="date" name="match_date" value="${esc(S.day)}" required></label>
          <label class="f">Heure<input type="time" name="kickoff" required></label>
        </div>
        <label class="f">Championnat<input type="text" name="league" list="leagues" placeholder="Ligue 1" required maxlength="40"></label>
        <datalist id="leagues"><option>Ligue 1</option><option>Ligue 2</option><option>Premier League</option><option>Liga</option><option>Serie A</option><option>Bundesliga</option><option>Liga Portugal</option><option>Ligue des champions</option><option>Ligue Europa</option></datalist>
        <label class="f">Match<input type="text" name="match" placeholder="Lens – Lyon" required maxlength="80"></label>
        <label class="f">Prono<input type="text" name="pick" placeholder="Les deux équipes marquent" required maxlength="80"></label>
        <div class="row2">
          <label class="f">Cote<input type="text" name="odd" inputmode="decimal" placeholder="1,50" required></label>
          <label class="f">Niveau<select name="level"><option value="confiance">Confiance</option><option value="equilibre" selected>Équilibré</option><option value="audacieux">Audacieux</option></select></label>
        </div>
        <label class="f">Analyse (optionnel)<textarea name="analysis" maxlength="1200" placeholder="Pourquoi ce prono ?"></textarea></label>
        <label class="check"><input type="checkbox" name="is_free"><span>Prono gratuit (visible par tout le monde)</span></label>
        <button class="btn btn-main" type="submit">Publier</button>
      </form>
      <section class="card form">
        <div class="sec-h"><h3 style="font-size:20px">Résultats · ${esc(dayLabel(S.day))}</h3>
          <div class="daynav"><button data-act="day" data-v="-1" aria-label="Jour précédent">${ICON.left}</button><button data-act="day" data-v="1" aria-label="Jour suivant">${ICON.right}</button></div></div>
        ${S.pronos.length ? S.pronos.map(p => `<div class="bet">
          <div class="t"><div><div class="m">${esc(p.match)} ${p.is_free ? '<span class="free-tag" style="font-size:12px">Gratuit</span>' : ""}</div><div class="s">${esc(p.league)} · ${esc(p.pick)} · cote ${fmtOdd(p.odd)}</div></div><span class="res res-${esc(p.result)}">${RES[p.result]}</span></div>
          ${started(p) ? `<div class="acts">
            <button class="g" data-act="pres" data-id="${p.id}" data-v="gagne" aria-pressed="${p.result === "gagne"}">Gagné</button>
            <button class="p" data-act="pres" data-id="${p.id}" data-v="perdu" aria-pressed="${p.result === "perdu"}">Perdu</button>
            <button class="r" data-act="pres" data-id="${p.id}" data-v="rembourse" aria-pressed="${p.result === "rembourse"}">Remboursé</button>
          </div><p class="note">${ICON.lockSm} Verrouillé depuis le coup d'envoi. Résultat corrigeable pendant 24 h.</p>` : `<div class="acts"><span class="note">Résultat à mettre après le coup d'envoi.</span>
            ${S.confirmDel === "p" + p.id ? `<button class="del" data-act="pdel" data-id="${p.id}">Confirmer ?</button>` : `<button class="del" data-act="askdel" data-v="p${p.id}">Supprimer</button>`}
          </div>`}</div>`).join("") : '<p class="note">Aucun prono ce jour-là.</p>'}
      </section>
      <form class="card form" data-form="vip">
        <h3 style="font-size:20px">Activer un VIP</h3>
        <p class="note" style="font-size:15px">Après un paiement, mets l'e-mail du compte de la personne. Les jours s'ajoutent à son accès en cours. Mets 0 pour retirer l'accès.</p>
        <label class="f">E-mail du client<input type="email" name="email" required></label>
        <label class="f">Nombre de jours<input type="number" name="days" value="30" min="0" max="400" required></label>
        <button class="btn btn-gold" type="submit">Activer</button>
      </form>`;
  }

  function viewVipModal() {
    if (!S.vipModal) return "";
    const email = (S.profile && S.profile.email) || (S.session && S.session.user.email) || "";
    const uid = S.session ? S.session.user.id : "";
    const dis = S.vipOk ? "" : 'aria-disabled="true" tabindex="-1"';
    const consent = `<label class="check"><input type="checkbox" data-act="vipok" ${S.vipOk ? "checked" : ""}><span>J'ai 18 ans ou plus, j'accepte les <a href="cgv.html" target="_blank">CGV</a>. Je demande l'accès immédiat au contenu et je renonce à mon droit de rétractation de 14 jours.</span></label>`;
    let body;
    if (C.STRIPE_LINK) {
      const url = C.STRIPE_LINK + "?client_reference_id=" + encodeURIComponent(uid) + "&prefilled_email=" + encodeURIComponent(email);
      body = `<p class="note" style="font-size:15px">Tous les pronos du jour avec leur analyse, l'historique complet et le canal Telegram privé. <b>${esc(C.VIP_PRICE)} par mois, sans engagement</b> : tu résilies quand tu veux depuis ton compte.</p>
        <ol class="steps">
          <li><b>Paie en toute sécurité</b> par carte bancaire ou Apple Pay.</li>
          <li><b>Ton accès VIP s'active tout seul</b> en quelques secondes. Reviens dans l'appli : le badge VIP apparaît en haut.</li>
        </ol>
        ${consent}
        <a class="btn btn-gold paybtn" data-act="pay" href="${esc(url)}" target="_blank" rel="noopener" ${dis}>S'abonner · ${esc(C.VIP_PRICE)}/mois</a>
        <p class="note">Paiement sécurisé par Stripe. 18+ · Jouer comporte des risques : 09 74 75 13 13.</p>`;
    } else if (C.PAYPAL_URL) {
      const payUrl = C.PAYPAL_URL.replace(/\/+$/, "") + "/" + C.VIP_AMOUNT + "EUR";
      body = `<p class="note" style="font-size:15px">30 jours d'accès à tous les pronos du jour + le canal Telegram privé. Sans renouvellement automatique, rien à résilier.</p>
        <ol class="steps">
          <li><b>Copie ton e-mail PronoVIP</b> : on s'en sert pour activer ton accès.
            <div class="mailbox"><span>${esc(email)}</span><button class="btn btn-ghost btn-sm" data-act="copymail" data-v="${esc(email)}">Copier</button></div></li>
          <li><b>Paie avec PayPal</b> (carte bancaire ou compte PayPal) et <b>colle ton e-mail dans la note</b> du paiement.</li>
          <li><b>Ton accès VIP est activé sous 24 h</b> (en général bien plus vite). Le badge VIP apparaît en haut de l'appli.</li>
        </ol>
        ${consent}
        <a class="btn btn-gold paybtn" data-act="pay" href="${esc(payUrl)}" target="_blank" rel="noopener" ${dis}>Payer ${esc(C.VIP_PRICE)} avec PayPal</a>
        <p class="note">Paiement sécurisé par PayPal. 18+ · Jouer comporte des risques : 09 74 75 13 13.</p>`;
    } else body = `<p class="err">Le paiement arrive très bientôt.</p>`;
    return `<div class="modal" data-act="vipclose" role="dialog" aria-modal="true" aria-labelledby="vipt">
      <div class="sheet" data-stop="1">
        <button class="x" data-act="vipclose" aria-label="Fermer">×</button>
        <h2 id="vipt" style="font-size:30px">Pass VIP <span style="color:var(--amber)">· ${esc(C.VIP_PRICE)}${C.STRIPE_LINK ? "/mois" : ""}</span></h2>
        ${body}
      </div></div>`;
  }

  function viewShell() {
    const tabs = [["pronos", "Pronos", ICON.ball], ["historique", "Historique", ICON.list], ["suivi", "Mon suivi", ICON.chart], ["compte", "Compte", ICON.user]];
    if (isAdmin()) tabs.push(["admin", "Admin", ICON.gear]);
    const body = S.tab === "historique" ? viewHistorique() : S.tab === "suivi" ? viewSuivi() : S.tab === "compte" ? viewCompte() : S.tab === "admin" ? viewAdmin() : viewPronos();
    return `<header class="top"><div class="top-in"><img src="icons/icon-192.png" alt=""><div class="brand">Prono<span>VIP</span></div>
      <span class="pill ${isVip() ? "pill-vip" : "pill-free"}">${isAdmin() ? "Admin" : isVip() ? "VIP" : "Gratuit"}</span></div></header>
      <main id="main">${body}</main>
      ${viewVipModal()}<nav class="tabs" aria-label="Navigation"><div class="in">${tabs.map(([id, l, ic]) => `<button data-act="tab" data-v="${id}" ${S.tab === id ? 'aria-current="page"' : ""}>${ic}${l}</button>`).join("")}</div></nav>`;
  }

  function render() {
    const y = window.scrollY;
    app.innerHTML = S.session && !S.recovery ? viewShell() : viewAuth();
    window.scrollTo(0, y);
  }

  // ---------- Actions ----------
  async function setTab(t) {
    S.tab = t; S.confirmDel = null; window.scrollTo(0, 0); render();
    if (t === "suivi" && !S.betsLoaded) loadBets();
    if (t === "historique") loadHistory();
  }

  app.addEventListener("click", async e => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act, v = b.dataset.v, id = b.dataset.id ? Number(b.dataset.id) : null;
    if (act !== "askdel" && act !== "bdel" && act !== "pdel") S.confirmDel = null;
    try {
      if (act === "mode") { S.authMode = v; S.authErr = ""; S.authMsg = ""; render(); }
      else if (act === "forgot") {
        const email = app.querySelector('input[name=email]').value.trim();
        if (!email) { S.authErr = "Écris ton e-mail, puis appuie sur « Mot de passe oublié »."; render(); return; }
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
        if (error) throw error;
        S.authErr = ""; S.authMsg = "Si un compte existe, un e-mail pour changer ton mot de passe vient de partir."; render();
      }
      else if (act === "pay") { if (!S.vipOk) { e.preventDefault(); toast("Coche la case pour continuer."); } return; }
      else if (act === "vip") { S.vipModal = true; S.vipOk = false; render(); }
      else if (act === "vipclose") { if (e.target.closest("[data-stop]") && !e.target.closest(".x")) return; S.vipModal = false; render(); }
      else if (act === "vipok") { S.vipOk = b.checked; document.querySelectorAll(".paybtn").forEach(pb => { if (S.vipOk) { pb.removeAttribute("aria-disabled"); pb.removeAttribute("tabindex"); } else { pb.setAttribute("aria-disabled", "true"); pb.setAttribute("tabindex", "-1"); } }); return; }
      else if (act === "copymail") { try { await navigator.clipboard.writeText(v); toast("E-mail copié !"); } catch (_) { toast("Copie impossible : recopie-le à la main."); } }
      else if (act === "tab") setTab(v);
      else if (act === "day") { S.day = addDays(S.day, Number(v)); loadDay(); }
      else if (act === "track") {
        const p = S.pronos.find(x => x.id === id);
        if (p) { S.prefill = { match: p.match, pick: p.pick, odd: p.odd }; setTab("suivi"); toast("Il ne reste qu'à mettre ta mise."); }
      }
      else if (act === "bres") {
        const bet = S.bets.find(x => x.id === id); if (!bet) return;
        const nv = bet.result === v ? "attente" : v;
        const { error } = await sb.from("bets").update({ result: nv }).eq("id", id);
        if (error) throw error;
        bet.result = nv; render();
      }
      else if (act === "askdel") { S.confirmDel = v; render(); }
      else if (act === "bdel") {
        const { error } = await sb.from("bets").delete().eq("id", id);
        if (error) throw error;
        S.bets = S.bets.filter(x => x.id !== id); S.confirmDel = null; render(); toast("Pari supprimé.");
      }
      else if (act === "pres") {
        const p = S.pronos.find(x => x.id === id); if (!p) return;
        const nv = p.result === v ? "attente" : v;
        const { error } = await sb.from("pronos").update({ result: nv }).eq("id", id);
        if (error) throw error;
        p.result = nv; render(); sb.rpc("pronos_stats").then(r => { if (!r.error) { S.stats = Array.isArray(r.data) ? r.data[0] : r.data; } });
      }
      else if (act === "pdel") {
        const { error } = await sb.from("pronos").delete().eq("id", id);
        if (error) throw error;
        S.pronos = S.pronos.filter(x => x.id !== id); S.confirmDel = null; render(); toast("Prono supprimé.");
      }
      else if (act === "install" && installEvt) { installEvt.prompt(); installEvt = null; render(); }
      else if (act === "logout") { await sb.auth.signOut(); }
    } catch (err) { toast(errFr(err)); }
  });

  app.addEventListener("submit", async e => {
    const f = e.target.closest("form[data-form]");
    if (!f) return;
    e.preventDefault();
    const kind = f.dataset.form, fd = new FormData(f), btn = f.querySelector('button[type=submit]');
    const val = k => String(fd.get(k) || "").trim();
    if (btn) btn.disabled = true;
    try {
      if (kind === "login" || kind === "signup") {
        const email = val("email"), password = String(fd.get("password") || "");
        S.authErr = ""; S.authMsg = ""; S.authEmail = email;
        if (!email || !/.+@.+\..+/.test(email)) { S.authErr = "Mets une adresse e-mail valide."; render(); return; }
        if (password.length < 6) { S.authErr = "Mot de passe : 6 caractères minimum."; render(); return; }
        if (kind === "signup") {
          if (!fd.get("age")) { S.authErr = "Tu dois avoir 18 ans ou plus pour utiliser PronoVIP."; render(); return; }
          const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
          if (error) throw error;
          if (!data.session) { S.authMode = "login"; S.authMsg = "Compte créé ! Confirme ton e-mail (regarde dans tes mails), puis connecte-toi."; render(); }
        } else {
          const { error } = await sb.auth.signInWithPassword({ email, password });
          if (error) throw error;
        }
      }
      else if (kind === "newpass") {
        const { error } = await sb.auth.updateUser({ password: String(fd.get("password") || "") });
        if (error) throw error;
        S.recovery = false; S.authErr = ""; toast("Mot de passe changé."); await start();
      }
      else if (kind === "bet") {
        const odd = num(val("odd")), stake = num(val("stake"));
        if (!val("match") || !val("pick")) return toast("Remplis le match et ton choix.");
        if (!(odd >= 1)) return toast("La cote doit être un nombre, par exemple 1,50.");
        if (!(stake > 0)) return toast("La mise doit être un nombre, par exemple 5.");
        const { data, error } = await sb.from("bets").insert({ match: val("match"), pick: val("pick"), odd, stake, bet_date: today() }).select().single();
        if (error) throw error;
        S.bets.unshift(data); S.prefill = null; render(); toast("Pari ajouté.");
      }
      else if (kind === "budget") {
        const raw = val("budget"), b = raw ? num(raw) : null;
        if (raw && !(b > 0)) return toast("Le budget doit être un nombre, par exemple 50.");
        const { error } = await sb.from("profiles").update({ monthly_budget: b }).eq("id", S.session.user.id);
        if (error) throw error;
        S.profile.monthly_budget = b; render(); toast(b ? "Budget enregistré." : "Budget retiré.");
      }
      else if (kind === "prono") {
        const odd = num(val("odd"));
        if (!(odd >= 1)) return toast("La cote doit être un nombre, par exemple 1,50.");
        const row = { match_date: val("match_date") || S.day, kickoff: val("kickoff") || null, league: val("league"), match: val("match"), pick: val("pick"), odd, level: val("level") || "equilibre", is_free: !!fd.get("is_free"), analysis: val("analysis") || null };
        if (!row.league || !row.match || !row.pick) return toast("Remplis le championnat, le match et le prono.");
        if (!row.kickoff) return toast("Mets l'heure du match : le prono se verrouille au coup d'envoi.");
        const { error } = await sb.from("pronos").insert(row);
        if (error) throw error;
        f.reset(); toast("Prono publié !");
        S.day = row.match_date; loadDay();
      }
      else if (kind === "vip") {
        const days = parseInt(val("days"), 10);
        if (!(days >= 0)) return toast("Mets un nombre de jours.");
        const { data, error } = await sb.rpc("admin_set_vip", { p_email: val("email"), p_days: days });
        if (error) throw error;
        f.reset();
        toast(data ? "VIP actif jusqu'au " + new Date(data).toLocaleDateString("fr-FR", { day: "numeric", month: "long" }) + "." : "Accès VIP retiré.");
      }
    } catch (err) {
      if (kind === "login" || kind === "signup" || kind === "newpass") { S.authErr = errFr(err); render(); }
      else toast(errFr(err));
    } finally { if (btn && btn.isConnected) btn.disabled = false; }
  });

  // ---------- Démarrage ----------
  async function start() {
    try {
      await loadProfile();
      render();
      loadDay();
      if (S.tab === "suivi") loadBets();
    } catch (e) { toast(errFr(e)); render(); }
  }

  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || !S.session || !S.profile) return;
    const was = isVip();
    try { await loadProfile(); } catch (_) { return; }
    if (!was && isVip()) { S.vipModal = false; render(); toast("Bienvenue chez les VIP ! Tous les pronos sont débloqués."); loadDay(); }
    else render();
  });

  document.addEventListener("keydown", e => { if (e.key === "Escape" && S.vipModal) { S.vipModal = false; render(); } });

  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") { S.session = session; S.recovery = true; render(); return; }
    const was = S.session && S.session.user.id;
    S.session = session;
    if (!session) {
      Object.assign(S, { profile: null, pronos: [], teasers: [], bets: [], betsLoaded: false, tab: "pronos", prefill: null });
      render();
    } else if (session.user.id !== was && !S.recovery) {
      setTimeout(start, 0);
    }
  });

  sb.auth.getSession().then(({ data }) => {
    if (!data.session) render();
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
