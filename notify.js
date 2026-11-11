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

async function send(text) {
  for (const fn of [telegram, whatsapp, email]) {
    try { console.log(await fn(text)); } catch (e) { console.log(fn.name + ': שגיאה', e.message); }
  }
}

module.exports = { send };
