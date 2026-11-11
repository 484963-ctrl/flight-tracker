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

// הטיולים נשמרים במסד (Supabase) — מה שהוגדר באתר
async function loadWatches() {
  const sb = cfg.supabase;
  if (!sb) return;
  try {
    const r = await fetch(`${sb.url}/rest/v1/rpc/flight_get_watches`, { method: 'POST', headers: { apikey: sb.key, 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const w = await r.json();
    if (Array.isArray(w)) { watches = w; wr('watches.json', w); }
  } catch (e) { console.log('לא הצלחתי לטעון את הטיולים מהמסד, משתמש בקובץ:', e.message); }
}

(async () => {
  await loadWatches();
  const now = new Date();
  const prev = rd('data/latest.json', {});
  const legsPrev = prev.legs || {};
  const wHist = rd('data/watch-history.json', {});
  const state = rd('data/state.json', {});

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
  await browser.close();
  console.log();

  // שומרים גם חיפושים ישנים שלא נבדקו הפעם (הסקירה היומית); דף שלא נטען — המחיר הקודם, מסומן כישן
  const merged = { ...legsPrev };
  for (const [k, r] of Object.entries(legs)) merged[k] = r.status === 'FAIL' && legsPrev[k] && legsPrev[k].res.length ? { ...legsPrev[k], stale: true } : r;
  const okCount = Object.values(legs).filter((r) => r.status === 'OK').length;
  if (keys.length && okCount < keys.length * 0.3) { console.log(`רק ${okCount}/${keys.length} נטענו — לא שומרים`); return; }

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
  for (const id of Object.keys(state)) if (!watches.find((w) => w.id === id)) delete state[id];

  wr('data/latest.json', { updated: now.toISOString(), ok: okCount, total: keys.length, overviewAt: overviewDue ? now.toISOString() : prev.overviewAt, legs: merged, watches: wOut });
  wr('data/watch-history.json', wHist);
  wr('data/state.json', state);
  console.log(`נבדקו ${okCount}/${keys.length}. התראות: ${alerts.length}`);

  if (alerts.length) await notify.send(message(alerts));
  else if (process.env.TEST_NOTIFY) await notify.send('✈️ בדיקה: מעקב הטיסות מחובר ועובד.\nתקבל הודעה כשמחיר של טיול שלך יירד מתחת למחיר היעד.' + (process.env.PAGE_URL ? '\n\n' + process.env.PAGE_URL : ''));
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
