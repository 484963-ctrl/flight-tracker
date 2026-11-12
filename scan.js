// בודק ב-Google Flights את המחירים של הטיולים ב-watches.json,
// שומר ב-data/ ושולח התראה כשהמחיר יורד מתחת למחיר היעד.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const notify = require('./notify');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch { return d; } };
const wr = (f, v) => fs.writeFileSync(path.join(ROOT, f), JSON.stringify(v));
fs.mkdirSync(DATA, { recursive: true });

const cfg = rd('config.json', {});
let watches = rd('watches.json', []); // נטען מחדש מהמסד בתחילת הריצה (ומנורמל אחרי שהפונקציות מוגדרות)
const CITY = (c) => cfg.cities[c] || c;
const AIR = { elal: 'El Al' };

// --- נוסעים: מבוגרים (1), ילדים 2–11 (2), תינוקות על הברכיים (4) ---
const paxOf = (w) => { const p = w.pax || {}; return { adults: Math.max(1, Math.min(9, +p.adults || 1)), children: Math.max(0, Math.min(8, +p.children || 0)), infants: Math.max(0, Math.min(4, +p.infants || 0)) }; };
const paxBytes = (p) => [...Array(p.adults).fill(1), ...Array(p.children).fill(2), ...Array(p.infants).fill(4)];
const paxKey = (p) => (p.adults === 1 && !p.children && !p.infants) ? '' : `|a${p.adults}c${p.children}i${p.infants}`;
const paxText = (p) => [`${p.adults} ${p.adults === 1 ? 'מבוגר' : 'מבוגרים'}`, p.children ? `${p.children} ${p.children === 1 ? 'ילד' : 'ילדים'}` : '', p.infants ? `${p.infants} ${p.infants === 1 ? 'תינוק' : 'תינוקות'}` : ''].filter(Boolean).join(', ');
const paxCount = (p) => p.adults + p.children + p.infants;

// --- כתובת חיפוש של Google Flights (כיוון אחד, תיירים, ישיר) ---
function tfs(date, from, to, pax = { adults: 1, children: 0, infants: 0 }) {
  const s = (t) => Buffer.from(t, 'utf8');
  const field = (tag, buf) => Buffer.concat([Buffer.from([tag, buf.length]), buf]);
  // 0x28 0x00 = רק טיסות ישירות
  const inner = Buffer.concat([field(0x12, s(date)), Buffer.from([0x28, 0]), field(0x6a, field(0x12, s(from))), field(0x72, field(0x12, s(to)))]);
  return Buffer.concat([field(0x1a, inner), field(0x42, Buffer.from(paxBytes(pax))), Buffer.from([0x48, 1, 0x98, 1, 2])]).toString('base64');
}
// קישור לאנשים: הלוך-חזור, ישיר, בעברית
function gfRound(o, b, from, to, pax = { adults: 1, children: 0, infants: 0 }) {
  const s = (t) => Buffer.from(t, 'utf8');
  const f = (tag, buf) => Buffer.concat([Buffer.from([tag, buf.length]), buf]);
  const leg = (d, a, c) => f(0x1a, Buffer.concat([f(0x12, s(d)), Buffer.from([0x28, 0]), f(0x6a, f(0x12, s(a))), f(0x72, f(0x12, s(c)))]));
  const tfs = Buffer.concat([leg(o, from, to), leg(b, to, from), f(0x42, Buffer.from(paxBytes(pax))), Buffer.from([0x48, 1, 0x98, 1, 1])]).toString('base64');
  return `https://www.google.com/travel/flights/search?tfs=${encodeURIComponent(tfs)}&hl=iw&gl=IL&curr=ILS`;
}
const gfUrl = (date, from, to, pax) => `https://www.google.com/travel/flights/search?tfs=${encodeURIComponent(tfs(date, from, to, pax))}&hl=en&curr=ILS`;

function days(a, b) {
  const out = [];
  for (let d = new Date(a + 'T12:00:00Z'); d <= new Date(b + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

function parse(text) {
  const L = text.split('\n').map((x) => x.trim());
  const res = [];
  for (let i = 0; i < L.length; i++) {
    if (!/^₪[\d,]+$/.test(L[i])) continue;
    const blk = L.slice(Math.max(0, i - 14), i);
    const ti = blk.findIndex((x) => /^\d{1,2}:\d\d\s[AP]M/.test(x));
    if (ti < 0) continue;
    const b = blk.slice(ti);
    const clean = (x) => (x || '').replace(/ /g, ' ');
    res.push({
      dep: clean(b[0]), arr: clean(b[2]),
      air: (b[3] || '').replace(/Operated by.*/, '').trim(),
      stops: b.find((x) => /Nonstop|\d stops?/.test(x)) || '',
      price: +L[i].replace(/[₪,]/g, ''),
    });
  }
  return res.sort((a, b) => a.price - b.price);
}

async function scanOne(ctx, url) {
  let none = 0; // "אין תוצאות" — מאמינים רק אם זה חזר פעמיים
  for (let k = 0; k < 3; k++) {
    const p = await ctx.newPage();
    try {
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      for (let i = 0; i < 30; i++) {
        await p.waitForTimeout(1000);
        const t = await p.evaluate(() => document.body.innerText);
        if (/No results returned|No options matching/i.test(t)) { if (++none >= 2) { await p.close(); return { status: 'NONE', res: [] }; } break; }
        if (/^₪[\d,]+$/m.test(t) && /\d{1,2}:\d\d\s[AP]M/.test(t)) { // יש כבר טיסות עם מחיר בדף
          // מחכים שהדף יסיים לטעון: בלי "Fetching results" ומספר המחירים לא משתנה
          const settle = async (max) => {
            let last = -1;
            for (let j = 0; j < max; j++) {
              await p.waitForTimeout(1500);
              const tx = await p.evaluate(() => document.body.innerText);
              const n = (tx.match(/₪[\d,]+/g) || []).length;
              if (n > 0 && n === last) return true; // מספר המחירים לא השתנה — הדף סיים להיטען
              last = n;
            }
            return false;
          };
          // גוגל עוד טוען — לא שומרים תוצאה חלקית, מנסים שוב
          if (!(await settle(20))) break;
          try { const more = p.getByText('View more flights'); if (await more.count()) { await more.first().click(); if (!(await settle(14))) break; } } catch {}
          const res = parse(await p.evaluate(() => document.body.innerText));
          await p.close();
          if (res.length) return { status: 'OK', res: res.filter((x, i) => i < 4 || x.stops === 'Nonstop' || x.air.startsWith('El Al')) };
          break;
        }
      }
    } catch {}
    await p.close().catch(() => {});
  }
  return { status: 'FAIL', res: [] };
}

// הטיסה הכי זולה שמתאימה לטיול: ישירה, ואם נבחרה חברה — רק שלה
// --- אפשרויות של טיול: חברות, גמישות בתאריכים, שעות המראה ---
const AIR_HE = { 'El Al': 'אל על', Israir: 'ישראייר', Arkia: 'ארקיע', Lufthansa: 'לופטהנזה', SWISS: 'סוויס', ITA: 'ITA', Austrian: 'אוסטריאן', 'Wizz Air': 'ויז אייר', easyJet: 'איזיג׳ט', Ryanair: 'ריינאייר', Aegean: 'אג׳יאן' };
const cap = (v) => Math.min(3, Math.max(0, +v || 0));
const ba = (val, flex, dir, side) => val != null ? cap(val) : (!dir || dir === 'both' || dir === side) ? cap(flex) : 0;
function norm(w) {
  const airlines = Array.isArray(w.airlines) ? w.airlines : w.airline === 'elal' ? ['El Al'] : [];
  return { ...w, airlines, flexOut: Math.min(3, Math.max(0, +w.flexOut || 0)), flexBack: Math.min(3, Math.max(0, +w.flexBack || 0)), outHours: w.outHours || null, backHours: w.backHours || null,
    // כמה גמישות לפני התאריך ואחריו (בימים; 0.25 = 6 שעות). תיקים ישנים: flex + כיוון
    outBefore: ba(w.flexOutBefore, w.flexOut, w.flexOutDir, 'before'), outAfter: ba(w.flexOutAfter, w.flexOut, w.flexOutDir, 'after'),
    backBefore: ba(w.flexBackBefore, w.flexBack, w.flexBackDir, 'before'), backAfter: ba(w.flexBackAfter, w.flexBack, w.flexBackDir, 'after'),
    noShabbat: w.noShabbat !== false };
}
const depHour = (dep) => { const m = /(\d{1,2}):(\d\d)\s*([AP])M/.exec(dep || ''); if (!m) return null; return (+m[1] % 12) + (m[3] === 'P' ? 12 : 0) + +m[2] / 60; };
const inHours = (dep, r) => { if (!r) return true; const h = depHour(dep); return h != null && h >= r[0] && h < r[1]; };
const match = (w, hours) => (x) => x.stops === 'Nonstop'
  && (!w.airlines.length || w.airlines.some((a) => x.air.toLowerCase().includes(a.toLowerCase())))
  && inHours(x.dep, hours);
const shift = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const around = (d, before, after) => { const today = new Date().toISOString().slice(0, 10); const o = []; for (let i = -Math.ceil(before); i <= Math.ceil(after); i++) { const x = shift(d, i); if (x >= today) o.push(x); } return o; };
// גמישות בשעות/ימים: flex בימים (0.25 = 6 שעות, 0.5 = 12 שעות). הטיסה צריכה להמריא
// מ-flex לפני תחילת היום שנבחר ועד flex אחרי סופו
// הטיסה צריכה להמריא מ-before לפני תחילת היום שנבחר ועד after אחרי סופו (בימים)
const inFlex = (d, base, before, after, dep) => {
  if (!before && !after) return d === base;
  const h = depHour(dep); if (h == null) return false;
  const t = (new Date(d + 'T12:00:00Z') - new Date(base + 'T12:00:00Z')) / 36e5 + h;
  return t >= -before * 24 && t < 24 + after * 24;
};
// שבת וחג (shabbat.mjs) — נטען בתחילת הריצה
let shabbatOk = () => true;
const airLabel = (w) => !w.airlines.length ? 'כל החברות' : w.airlines.map((a) => AIR_HE[a] || a).join(', ');
const pick = (res, fn) => (res || []).find(fn) || null; // res ממוין לפי מחיר

let settings = {};
// הטיולים נשמרים במסד (Supabase) — מה שהוגדר באתר
async function loadWatches() {
  const sb = cfg.supabase;
  if (!sb) return;
  try {
    const r = await fetch(`${sb.url}/rest/v1/rpc/flight_get_watches`, { method: 'POST', headers: { apikey: sb.key, 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const w = await r.json();
    if (Array.isArray(w)) { watches = w.map(norm); wr('watches.json', w); }
    // לאן לשלוח התראות — נבחר באתר
    const r2 = await fetch(`${sb.url}/rest/v1/rpc/flight_get_settings`, { method: 'POST', headers: { apikey: sb.key, 'Content-Type': 'application/json' }, body: '{}' });
    if (r2.ok) { const st = await r2.json(); if (st && st.channels) notify.setChannels(st.channels); settings = st || {}; }
  } catch (e) { console.log('לא הצלחתי לטעון את הטיולים מהמסד, משתמש בקובץ:', e.message); }
}

// שער הדולר להצגת מחיר בדולרים באתר: קודם שער השוק העדכני (מתעדכן כל דקה בשעות המסחר),
// ואם הוא לא זמין — השער היציג של בנק ישראל, ואחריו הבנק המרכזי האירופי
async function getFx(prevFx) {
  const tries = [
    async () => {
      const d = await (await fetch('https://query1.finance.yahoo.com/v8/finance/chart/ILS=X?interval=1m&range=1d', { headers: { 'User-Agent': 'Mozilla/5.0' } })).json();
      const m = d.chart.result[0].meta;
      return { rate: m.regularMarketPrice, t: new Date(m.regularMarketTime * 1000).toISOString(), src: 'שער השוק' };
    },
    async () => { const d = await (await fetch('https://boi.org.il/PublicApi/GetExchangeRate?key=USD')).json(); return { rate: d.currentExchangeRate, t: d.lastUpdate, src: 'שער יציג, בנק ישראל' }; },
    async () => { const d = await (await fetch('https://api.frankfurter.app/latest?from=USD&to=ILS', { redirect: 'follow' })).json(); return { rate: d.rates.ILS, t: d.date + 'T14:00:00Z', src: 'הבנק המרכזי האירופי' }; },
  ];
  for (const t of tries) { try { const r = await t(); if (r.rate > 1 && r.rate < 10) return r; } catch {} }
  return prevFx || null;
}

// מצב הערוצים לאתר: מחובר? מתי נשלח לאחרונה? הצליח?
function saveChannelStatus() {
  const prev = rd('data/channels.json', {});
  const conf = notify.configured();
  const out = {};
  for (const k of ['telegram', 'whatsapp', 'email']) out[k] = { configured: conf[k], last: notify.status[k] || (prev[k] && prev[k].last) || null };
  wr('data/channels.json', out);
}

(async () => {
  try { shabbatOk = (await import('./shabbat.mjs')).makeChecker(cfg.shabbat || {}); } catch (e) { console.log('שבת: לא נטען —', e.message); }
  await loadWatches();
  watches = watches.map(norm);
  const now = new Date();
  const prev = rd('data/latest.json', {});
  const legsPrev = prev.legs || {};
  const wHist = rd('data/watch-history.json', {});
  const state = rd('data/state.json', {});
  const sys = (state._sys = state._sys || {});
  const notes = []; // הודעות מערכת: פער בבדיקות, סיכום בוקר
  // הבדיקות נעצרו לזמן ארוך? מודיעים שחזרו לעבוד
  if (prev.updated && now - new Date(prev.updated) > 90 * 60e3 && sys.gapFor !== prev.updated) {
    const h = Math.round((now - new Date(prev.updated)) / 36e5 * 10) / 10;
    notes.push(`⚠️ הבדיקות של המחירים לא רצו ${h} שעות (תקלה אצל GitHub). עכשיו הן חזרו לעבוד.`);
    sys.gapFor = prev.updated;
  }

  // אילו חיפושים צריך: שני כיוונים לכל טיול, ופעם ביום גם סקירת כל התאריכים
  const legs = {};
  // המחיר בגוגל הוא לכל הנוסעים יחד — חיפוש נפרד לכל הרכב נוסעים
  const add = (from, to, date, pax) => { legs[`${from}|${to}|${date}${pax ? paxKey(pax) : ''}`] = { from, to, date, pax: pax || null, url: gfUrl(date, from, to, pax) }; };
  for (const w of watches) {
    const p = paxOf(w);
    for (const d of around(w.out, w.outBefore, w.outAfter)) add(cfg.origin, w.city, d, p);
    for (const d of around(w.back, w.backBefore, w.backAfter)) add(w.city, cfg.origin, d, p);
  }
  const ov = cfg.overview;
  const overviewDue = ov && ov.on && (process.env.FULL || !prev.overviewAt || now - new Date(prev.overviewAt) > 20 * 3600e3);
  if (overviewDue) for (const c of Object.keys(cfg.cities)) {
    for (const d of days(ov.outFrom, ov.outTo)) add(cfg.origin, c, d);
    for (const d of days(ov.backFrom, ov.backTo)) add(c, cfg.origin, d);
  }

  const keys = Object.keys(legs);
  console.log(`${watches.length} טיולים, ${keys.length} חיפושים${overviewDue ? ' (כולל סקירה יומית)' : ''}`);
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const ctx = await browser.newContext({ locale: 'en-US' });
  let idx = 0;
  await Promise.all(Array.from({ length: +(process.env.PARALLEL || 5) }, async () => {
    while (idx < keys.length) {
      const k = keys[idx++];
      const r = await scanOne(ctx, legs[k].url);
      process.stdout.write(r.status === 'OK' ? '.' : r.status === 'NONE' ? 'o' : 'x');
      legs[k] = { ...legs[k], ...r, t: now.toISOString() };
    }
  }));
  // סבב שני לחיפושים שלא נטענו — בדפדפן חדש, אחד אחד
  const failed = keys.filter((k) => legs[k].status === 'FAIL');
  if (failed.length) {
    process.stdout.write(' | סבב שני: ');
    const ctx2 = await browser.newContext({ locale: 'en-US' });
    for (const k of failed) {
      const r = await scanOne(ctx2, legs[k].url);
      process.stdout.write(r.status === 'OK' ? '.' : r.status === 'NONE' ? 'o' : 'x');
      if (r.status !== 'FAIL') legs[k] = { ...legs[k], ...r, t: now.toISOString() };
    }
  }
  await browser.close();
  console.log();

  // שומרים גם חיפושים ישנים שלא נבדקו הפעם (הסקירה היומית); דף שלא נטען — המחיר הקודם, מסומן כישן
  const merged = { ...legsPrev };
  for (const [k, r] of Object.entries(legs)) merged[k] = r.status === 'FAIL' && legsPrev[k] && legsPrev[k].res.length ? { ...legsPrev[k], stale: true } : r;
  // סימון לכל טיסה אם היא בסדר מבחינת שבת וחג (לטבלת "כל התאריכים" באתר)
  for (const r of Object.values(merged)) for (const x of r.res || []) x.sh = shabbatOk(r.date, x.dep, x.arr, r.from, r.to);
  const okCount = Object.values(legs).filter((r) => r.status === 'OK').length;
  if (keys.length && okCount < keys.length * 0.3) {
    console.log(`רק ${okCount}/${keys.length} נטענו — לא שומרים`);
    sys.fails = (sys.fails || 0) + 1;
    if (sys.fails === 3) notes.push('⚠️ שלוש בדיקות ברצף לא הצליחו לקרוא מחירים מגוגל. ממשיכים לנסות כל חצי שעה — אודיע כשזה יסתדר.');
    wr('data/state.json', state);
    if (notes.length) await notify.send(notes.join('\n\n'));
    return;
  }
  if (sys.fails >= 3) notes.push('✅ קריאת המחירים מגוגל חזרה לעבוד.');
  sys.fails = 0;

  const alerts = [];
  const wOut = {};
  for (const w of watches) {
    // הצירוף הכי זול מכל התאריכים האפשריים (לפי הגמישות), בשעות ובחברות שנבחרו
    let best = null, anyMissing = false, allLoaded = true, options = 0;
    const outs = around(w.out, w.outBefore, w.outAfter).map((d) => { const A = merged[`${cfg.origin}|${w.city}|${d}${paxKey(paxOf(w))}`]; if (!A || A.status === 'FAIL') allLoaded = false; const m = match(w, w.outHours); return { d, A, f: A && pick(A.res, (x) => m(x) && inFlex(d, w.out, w.outBefore, w.outAfter, x.dep) && (!w.noShabbat || shabbatOk(d, x.dep, x.arr, cfg.origin, w.city))) }; });
    const backs = around(w.back, w.backBefore, w.backAfter).map((d) => { const B = merged[`${w.city}|${cfg.origin}|${d}${paxKey(paxOf(w))}`]; if (!B || B.status === 'FAIL') allLoaded = false; const m = match(w, w.backHours); return { d, B, f: B && pick(B.res, (x) => m(x) && inFlex(d, w.back, w.backBefore, w.backAfter, x.dep) && (!w.noShabbat || shabbatOk(d, x.dep, x.arr, w.city, cfg.origin))) }; });
    for (const o of outs) for (const k of backs) {
      if (k.d <= o.d || !o.f || !k.f) continue;
      options++;
      const p = o.f.price + k.f.price;
      if (!best || p < best.price) best = { price: p, o, k };
    }
    const price = best ? best.price : null;
    const a = best && best.o.f, b = best && best.k.f;
    wOut[w.id] = { price, out: a, back: b, outDate: best && best.o.d, backDate: best && best.k.d, options,
                   outUrl: best && best.o.A.url, backUrl: best && best.k.B.url,
                   stale: !!(best && (best.o.A.stale || best.k.B.stale)), none: allLoaded && price == null };
    if (price == null) continue;
    const h = (wHist[w.id] = wHist[w.id] || []);
    if (!h.length || h[h.length - 1].price !== price) h.push({ t: now.toISOString(), price });

    // התראה: מתחת ליעד (פעם ראשונה, או ירידה נוספת), או — בלי יעד — כל ירידה משמעותית
    const s = (state[w.id] = state[w.id] || {});
    const minDrop = cfg.alertMinDrop || 30;
    // התראה על כל ירידה (₪30 ומעלה) מאז הבדיקה הקודמת; ובנוסף — כשהמחיר עובר אל מתחת ליעד
    const under = w.target && price <= w.target;
    const firstUnder = under && !s.under;
    if (firstUnder || (s.last != null && s.last - price >= minDrop))
      alerts.push({ w, price, a, b, od: wOut[w.id].outDate, bd: wOut[w.id].backDate, why: under ? 'target' : 'drop', from: s.last });
    if (w.target) s.under = under ? true : price > w.target + minDrop ? false : s.under;
    s.last = price;
  }
  for (const id of Object.keys(state)) if (id !== '_sys' && !watches.find((w) => w.id === id)) delete state[id];

  // סיכום בוקר (מ-8:00 שעון ישראל, פעם ביום) — גם סימן שהמערכת חיה
  const il = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(now);
  const ilDate = `${il.find((x) => x.type === 'year').value}-${il.find((x) => x.type === 'month').value}-${il.find((x) => x.type === 'day').value}`;
  const ilHour = +il.find((x) => x.type === 'hour').value % 24;
  if (ilHour >= 8 && sys.daily !== ilDate && watches.length) {
    const L = ['☀️ בוקר טוב! המחירים של הטיולים שלך הבוקר:', ''];
    for (const w of watches) {
      const r = wOut[w.id];
      const p = r && r.price != null ? ils(r.price) : 'אין מחיר כרגע';
      const t = w.target ? (r && r.price != null && r.price <= w.target ? ` ✅ מתחת ליעד (${ils(w.target)})` : ` · יעד ${ils(w.target)}`) : '';
      const dd = r && r.outDate ? `${he(r.outDate)} – ${he(r.backDate)}` : `${he(w.out)} – ${he(w.back)}`;
      const pp = paxOf(w), pn = paxCount(pp);
      L.push(`${CITY(w.city)} ${dd}${pn > 1 ? ` (${pn} נוסעים)` : ''}: ${p}${t}`);
    }
    L.push('', 'המערכת בודקת כל חצי שעה ותשלח הודעה על כל ירידה.');
    if (process.env.PAGE_URL) L.push(process.env.PAGE_URL);
    notes.push(L.join('\n'));
    sys.daily = ilDate;
  }

  const fx = await getFx(prev.fx);
  wr('data/latest.json', { updated: now.toISOString(), fx, ok: okCount, total: keys.length, overviewAt: overviewDue ? now.toISOString() : prev.overviewAt, legs: merged, watches: wOut });
  wr('data/watch-history.json', wHist);
  wr('data/state.json', state);
  console.log(`נבדקו ${okCount}/${keys.length}. התראות: ${alerts.length}`);

  if (alerts.length) await notify.send(message(alerts));
  if (notes.length) await notify.send(notes.join('\n\n'));
  // "שלח הודעת בדיקה" מהאתר
  const testReq = settings.testAt && settings.testAt !== sys.testDone;
  if (testReq) { sys.testDone = settings.testAt; wr('data/state.json', state); }
  if (!alerts.length && (process.env.TEST_NOTIFY || testReq)) await notify.send('✈️ בדיקה: מעקב הטיסות מחובר ועובד.\nתקבל הודעה על כל ירידה במחיר של טיול שלך, וסיכום כל בוקר.' + (process.env.PAGE_URL ? '\n\n' + process.env.PAGE_URL : ''));
  saveChannelStatus();
})();

const DAY = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'שבת'];
const he = (d) => { const [, m, day] = d.split('-'); const w = new Date(d + 'T12:00:00Z').getUTCDay(); return `${w === 6 ? 'שבת' : 'יום ' + DAY[w]} ${+day}.${+m}`; };
const ils = (n) => '₪' + n.toLocaleString('en-US');
function message(alerts) {
  const L = [];
  for (const { w, price, a, b, od, bd, why, from } of alerts) {
    L.push(`🔔 ${CITY(w.city)} — ${airLabel(w)} (ישיר) · ${paxText(paxOf(w))}`);
    L.push(from != null ? `המחיר ירד מ-${ils(from)} ל-${ils(price)}` : `המחיר עכשיו: ${ils(price)}`);
    if (why === 'target') L.push(`✅ מתחת למחיר שקבעת (${ils(w.target)})!`);
    L.push(`🛫 הלוך ${he(od)}, ${a.dep} (${a.air}) — ${ils(a.price)}`);
    L.push(`🛬 חזור ${he(bd)}, ${b.dep} (${b.air}) — ${ils(b.price)}`);
    if (paxCount(paxOf(w)) > 1) L.push(`💰 לכל ${paxCount(paxOf(w))} הנוסעים · בערך ${ils(Math.round(price / paxCount(paxOf(w))))} לנוסע`);
    L.push(`🔎 בגוגל טיסות: ${gfRound(od, bd, cfg.origin, w.city, paxOf(w))}`);
    L.push('');
  }
  L.push('המחיר מ-Google Flights. לפני הזמנה — לבדוק באתר של החברה.');
  if (process.env.PAGE_URL) L.push(process.env.PAGE_URL);
  return L.join('\n');
}
