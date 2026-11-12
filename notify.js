// שליחת התראות: טלגרם, וואטסאפ (CallMeBot) ומייל (Gmail).
// כל ערוץ פועל רק אם הוגדרו לו הסודות ב-GitHub (Settings → Secrets → Actions).
const fs = require('fs');
const path = require('path');
const E = process.env;

async function telegram(text) {
  if (!E.TELEGRAM_TOKEN) return 'טלגרם: לא הוגדר';
  const api = `https://api.telegram.org/bot${E.TELEGRAM_TOKEN}`;
  let chat = E.TELEGRAM_CHAT_ID;
  const f = path.join(__dirname, 'data', 'telegram-chat.txt');
  if (!chat && fs.existsSync(f)) chat = fs.readFileSync(f, 'utf8').trim();
  if (!chat) {
    // מוצאים את הצ׳אט לבד, אחרי ששלחת לבוט הודעה כלשהי
    const u = await (await fetch(`${api}/getUpdates`)).json();
    const m = (u.result || []).map((x) => x.message || x.channel_post).filter(Boolean).pop();
    if (!m) return 'טלגרם: צריך לשלוח לבוט הודעה (למשל "שלום") ואז זה יעבוד';
    chat = String(m.chat.id);
    fs.writeFileSync(f, chat);
  }
  const r = await fetch(`${api}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  return 'טלגרם: ' + (r.ok ? 'נשלח' : 'שגיאה ' + r.status);
}

async function whatsapp(text) {
  // TextMeBot: נשלח מהוואטסאפ שחובר אצלם, לכל המספרים ב-WHATSAPP_TO (מופרדים בפסיק)
  if (E.TEXTMEBOT_APIKEY) {
    const to = (E.WHATSAPP_TO || E.WHATSAPP_PHONE || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!to.length) return 'וואטסאפ: חסר WHATSAPP_TO';
    const res = [];
    for (const [i, n] of to.entries()) {
      if (i) await new Promise((r) => setTimeout(r, 6000)); // לפחות 5 שניות בין הודעות — המלצת TextMeBot כדי שוואטסאפ לא יחסום
      const u = `https://api.textmebot.com/send.php?recipient=${encodeURIComponent(n)}&apikey=${encodeURIComponent(E.TEXTMEBOT_APIKEY)}&text=${encodeURIComponent(text)}`;
      const r = await fetch(u);
      const body = await r.text();
      res.push(r.ok && !/error|invalid/i.test(body) ? 'נשלח' : 'שגיאה ' + r.status + ' ' + body.slice(0, 80));
    }
    return 'וואטסאפ: ' + res.join(', ');
  }
  if (!E.WHATSAPP_PHONE || !E.WHATSAPP_APIKEY) return 'וואטסאפ: לא הוגדר';
  const u = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(E.WHATSAPP_PHONE)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(E.WHATSAPP_APIKEY)}`;
  const r = await fetch(u);
  return 'וואטסאפ: ' + (r.ok ? 'נשלח' : 'שגיאה ' + r.status);
}

async function email(text) {
  if (!E.MAIL_USER || !E.MAIL_PASS) return 'מייל: לא הוגדר';
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: E.MAIL_USER, pass: E.MAIL_PASS } });
  const html = `<div dir="rtl" style="font-family:Arial;font-size:16px;white-space:pre-line">${text.replace(/</g, '&lt;')}</div>`;
  await t.sendMail({ from: E.MAIL_USER, to: E.MAIL_TO || E.MAIL_USER, subject: text.split('\n')[0], text, html });
  return 'מייל: נשלח';
}

// אילו ערוצים מחוברים (יש להם סודות ב-GitHub) — מוצג באתר
const configured = () => ({
  telegram: !!E.TELEGRAM_TOKEN,
  whatsapp: !!(E.TEXTMEBOT_APIKEY || (E.WHATSAPP_PHONE && E.WHATSAPP_APIKEY)),
  email: !!(E.MAIL_USER && E.MAIL_PASS),
});

// הערוצים שנבחרו באתר (ברירת מחדל: כולם)
let chosen = { telegram: true, whatsapp: true, email: true };
const setChannels = (c) => { if (c && typeof c === 'object') chosen = { ...chosen, ...c }; };

const status = {}; // תוצאת השליחה האחרונה בכל ערוץ
async function send(text) {
  for (const [k, fn] of [['telegram', telegram], ['whatsapp', whatsapp], ['email', email]]) {
    if (chosen[k] === false) { console.log(k + ': כבוי באתר'); continue; }
    try {
      const r = await fn(text);
      console.log(r);
      if (configured()[k]) status[k] = { ok: /נשלח/.test(r), msg: r, t: new Date().toISOString() };
    } catch (e) {
      console.log(k + ': שגיאה', e.message);
      status[k] = { ok: false, msg: e.message, t: new Date().toISOString() };
    }
  }
}

module.exports = { send, configured, setChannels, status };
