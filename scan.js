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
let watches = rd('watches.json', []); // נטען מחדש מהמסד בתחילת הריצה
const CITY = (c) => cfg.cities[c] || c;
const AIR = { elal: 'El Al' };

// --- כתובת חיפוש של Google Flights (כיוון אחד, מבוגר אחד, תיירים) ---
function tfs(date, from, to) {
  const s = (t) => Buffer.from(t, 'utf8');
  const field = (tag, buf) => Buffer.concat([Buffer.from([tag, buf.length]), buf]);
  const inner = Buffer.concat([field(0x12, s(date)), field(0x6a, field(0x12, s(from))), field(0x72, field(0x12, s(to)))]);
  return Buffer.concat([field(0x1a, inner), Buffer.from([0x42, 1, 1, 0x48, 1, 0x98, 1, 2])]).toString('base64');
}
const gfUrl = (date, from, to) => `https://www.google.com/travel/flights/search?tfs=${encodeURIComponent(tfs(date, from, to))}&hl=en&curr=ILS`;

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
        if (/Top flights|Other departing flights|Departing flights/.test(t) && /₪/.test(t)) {
          // מחכים שהדף יסיים לטעון: בלי "Fetching results" ומספר המחירים לא משתנה
          const settle = async (max) => {
            let last = -1;
            for (let j = 0; j < max; j++) {
              await p.waitForTimeout(1500);
              const tx = await p.evaluate(() => document.body.innerText);
              const n = (tx.match(/₪[\d,]+/g) || []).length;
              if (!/Fetching results|Loading results/.test(tx) && n === last) return;
              last = n;
            }
          };
          await settle(12);
          try { const more = p.getByText('View more flights'); if (await more.count()) { await more.first().click(); await settle(10); } } catch {}
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
const match = (w) => (x) => x.stops === 'Nonstop' && (!AIR[w.airline] || x.air.startsWith(AIR[w.airline]));
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
    if (Array.isArray(w)) { watches = w; wr('watches.json', w); }
    // לאן לשלוח התראות — נבחר באתר
    const r2 = await fetch(`${sb.url}/rest/v1/rpc/flight_get_settings`, { method: 'POST', headers: { apikey: sb.key, 'Content-Type': 'application/json' }, body: '{}' });
    if (r2.ok) { const st = await r2.json(); if (st && st.channels) notify.setChannels(st.channels); settings = st || {}; }
  } catch (e) { console.log('לא הצלחתי לטעון את הטיולים מהמסד, משתמש בקובץ:', e.message); }
}

// שער הדולר (יציג, מהבנק האירופי; גיבוי: exchangerate-api) — להצגת מחיר בדולרים באתר
async function getFx(prevFx) {
  const tries = [
    async () => { const d = await (await fetch('https://api.frankfurter.app/latest?from=USD&to=ILS', { redirect: 'follow' })).json(); return { rate: d.rates.ILS, date: d.date, src: 'הבנק המרכזי האירופי' }; },
    async () => { const d = await (await fetch('https://open.er-api.com/v6/latest/USD')).json(); return { rate: d.rates.ILS, date: new Date(d.time_last_update_unix * 1000).toISOString().slice(0, 10), src: 'exchangerate-api' }; },
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
  await loadWatches();
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
  const add = (from, to, date) => { legs[`${from}|${to}|${date}`] = { from, to, date, url: gfUrl(date, from, to) }; };
  for (const w of watches) { add(cfg.origin, w.city, w.out); add(w.city, cfg.origin, w.back); }
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
    const A = merged[`${cfg.origin}|${w.city}|${w.out}`], B = merged[`${w.city}|${cfg.origin}|${w.back}`];
    const a = A && pick(A.res, match(w)), b = B && pick(B.res, match(w));
    const price = a && b ? a.price + b.price : null;
    wOut[w.id] = { price, out: a, back: b, outUrl: A && A.url, backUrl: B && B.url, stale: !!((A && A.stale) || (B && B.stale)),
                   none: !!(A && B && A.status !== 'FAIL' && B.status !== 'FAIL' && price == null) };
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
      alerts.push({ w, price, a, b, why: under ? 'target' : 'drop', from: s.last });
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
      L.push(`${CITY(w.city)} ${he(w.out)} – ${he(w.back)}: ${p}${t}`);
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
  for (const { w, price, a, b, why, from } of alerts) {
    const air = AIR[w.airline] ? 'אל על' : 'טיסה ישירה';
    L.push(`🔔 ${CITY(w.city)} — ${air}`);
    L.push(from != null ? `המחיר ירד מ-${ils(from)} ל-${ils(price)}` : `המחיר עכשיו: ${ils(price)}`);
    if (why === 'target') L.push(`✅ מתחת למחיר שקבעת (${ils(w.target)})!`);
    L.push(`🛫 הלוך ${he(w.out)}, ${a.dep} (${a.air}) — ${ils(a.price)}`);
    L.push(`🛬 חזור ${he(w.back)}, ${b.dep} (${b.air}) — ${ils(b.price)}`);
    L.push('');
  }
  L.push('המחיר מ-Google Flights. לפני הזמנה — לבדוק באתר של החברה.');
  if (process.env.PAGE_URL) L.push(process.env.PAGE_URL);
  return L.join('\n');
}
