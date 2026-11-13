// חיבור טלגרם של משתמש: באתר הוא לוחץ על קישור t.me/<bot>?start=<קוד>, ואנחנו מקבלים "/start <קוד>".
// רץ כל דקה (בלולאה ב-track.yml). שומר מאיפה להמשיך ב-.tg-offset.
const fs = require('fs');
const E = process.env;
const cfg = JSON.parse(fs.readFileSync(__dirname + '/config.json', 'utf8')).supabase;
const KEY = E.TEXTMEBOT_APIKEY ? 'flights-scan:' + E.TEXTMEBOT_APIKEY : '';
(async () => {
  if (!E.TELEGRAM_TOKEN || !KEY) return;
  const api = `https://api.telegram.org/bot${E.TELEGRAM_TOKEN}`;
  const of = __dirname + '/.tg-offset';
  const offset = fs.existsSync(of) ? +fs.readFileSync(of, 'utf8') : 0;
  const u = await (await fetch(`${api}/getUpdates?timeout=0&offset=${offset}`, { signal: AbortSignal.timeout(15000) })).json();
  let next = offset;
  for (const x of u.result || []) {
    next = Math.max(next, x.update_id + 1);
    const m = x.message; if (!m || !m.text) continue;
    const code = (/^\/start\s+(\w+)/.exec(m.text) || [])[1];
    if (!code) continue;
    const r = await fetch(`${cfg.url}/rest/v1/rpc/ft_scan_tg`, { method: 'POST', headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: KEY, code, chat: String(m.chat.id) }) });
    const who = r.ok ? await r.json() : null;
    const text = who ? `✅ חוברת${who.name ? ', ' + who.name : ''}! מעכשיו תקבל כאן התראות על ירידות במחירי הטיסות שלך, וסיכום כל בוקר.` : 'הקוד לא מוכר. פותחים את הקישור מהאתר (בחלק "החשבון שלי") ולוחצים Start.';
    await fetch(`${api}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: m.chat.id, text }) });
    console.log('טלגרם: ' + (who ? 'חובר משתמש' : 'קוד לא מוכר'));
  }
  if (next !== offset) fs.writeFileSync(of, String(next));
})().catch((e) => console.log('tglink:', e.message));
