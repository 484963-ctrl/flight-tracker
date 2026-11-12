// שבת וחג: לא טסים ולא נוחתים מ-3 שעות לפני השקיעה של ערב שבת/חג ועד צאת השבת (50 דקות אחרי השקיעה).
// המראה אחרי צאת השבת — רק אחרי זמן הכנה (ברירת מחדל 3 שעות: להגיע לשדה ולעשות צ׳ק-אין).
// החגים לפי לוח ארץ ישראל (יום אחד, חוץ מראש השנה): ראש השנה א׳-ב׳, יום כיפור, סוכות א׳, שמיני עצרת,
// פסח א׳ ושביעי של פסח, שבועות. לא חול המועד ולא יום טוב שני של גלויות.
// כל בדיקה לפי המקום: ההמראה לפי זמני השבת בשדה שממנו ממריאים, הנחיתה לפי השדה שבו נוחתים.
import { HebrewCalendar, flags, Zmanim, GeoLocation } from '@hebcal/core';

const PLACES = {
  TLV: [32.0, 34.88, 'Asia/Jerusalem'],
  MUC: [48.35, 11.79, 'Europe/Berlin'],
  ZRH: [47.46, 8.55, 'Europe/Zurich'],
  MXP: [45.63, 8.72, 'Europe/Rome'],
  LIN: [45.45, 9.28, 'Europe/Rome'],
  FCO: [41.80, 12.25, 'Europe/Rome'],
  VIE: [48.11, 16.57, 'Europe/Vienna'],
  VCE: [45.505, 12.35, 'Europe/Rome'],
  INN: [47.26, 11.34, 'Europe/Vienna'],
  SZG: [47.79, 13.0, 'Europe/Vienna'],
  BGY: [45.67, 9.70, 'Europe/Rome'],
  CDG: [49.01, 2.55, 'Europe/Paris'],
  LHR: [51.47, -0.45, 'Europe/London'],
  FRA: [50.04, 8.56, 'Europe/Berlin'],
  BER: [52.37, 13.50, 'Europe/Berlin'],
  AMS: [52.31, 4.76, 'Europe/Amsterdam'],
  BUD: [47.44, 19.26, 'Europe/Budapest'],
  PRG: [50.10, 14.26, 'Europe/Prague'],
};

const iso = (d) => d.toISOString().slice(0, 10);
const shift = (s, n) => { const t = new Date(s + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return iso(t); };

// הפרש השעון של אזור זמן ברגע נתון (במילישניות)
function tzOffset(tz, ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms;
}
// שעה מקומית בשדה ← רגע אמיתי (UTC)
function localToMs(dateStr, hours, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0) + hours * 36e5;
  let ms = guess - tzOffset(tz, guess);
  ms = guess - tzOffset(tz, ms); // תיקון סביב מעבר שעון
  return ms;
}
// "4:35 PM" / "3:35 AM+1" ← שעות (ועוד ימים)
function parseTime(s) {
  const m = /(\d{1,2}):(\d\d)\s*([AP])M(\+(\d))?/.exec(s || '');
  if (!m) return null;
  return { h: (+m[1] % 12) + (m[3] === 'P' ? 12 : 0) + +m[2] / 60, plus: +(m[5] || 0) };
}

export function makeChecker({ beforeH = 3, endMin = 50, prepH = 3, places = {} } = {}) {
  for (const [k, v] of Object.entries(places)) if (!PLACES[k] && Array.isArray(v)) PLACES[k] = [v[1], v[2], v[3]];
  // ימי החג בלוח ארץ ישראל, לשנתיים קדימה
  const holy = new Set();
  const now = new Date();
  for (const e of HebrewCalendar.calendar({ start: new Date(now.getFullYear(), 0, 1), end: new Date(now.getFullYear() + 3, 0, 1), il: true }))
    if (e.getFlags() & flags.CHAG) holy.add(iso(e.getDate().greg()));
  const isHoly = (s) => new Date(s + 'T12:00:00Z').getUTCDay() === 6 || holy.has(s);

  const sunCache = {};
  const sunset = (code, s) => {
    const k = code + s;
    if (!(k in sunCache)) {
      const [lat, lon, tz] = PLACES[code] || PLACES.TLV;
      const [y, m, d] = s.split('-').map(Number);
      sunCache[k] = +new Zmanim(new GeoLocation(code, lat, lon, 0, tz), new Date(y, m - 1, d, 12), false).sunset();
    }
    return sunCache[k];
  };
  // חלונות שבת/חג סביב תאריך, במקום מסוים: [התחלה, סוף לנחיתה, סוף להמראה]
  const windows = (code, s) => {
    const out = [];
    for (let i = -3; i <= 3; i++) {
      const d = shift(s, i);
      if (!isHoly(d) || isHoly(shift(d, -1))) continue; // תחילת רצף של ימי שבת/חג
      let last = d;
      while (isHoly(shift(last, 1))) last = shift(last, 1);
      const start = sunset(code, shift(d, -1)) - beforeH * 36e5;
      const endLand = sunset(code, last) + endMin * 6e4;
      out.push([start, endLand, endLand + prepH * 36e5]);
    }
    return out;
  };

  // true = הטיסה בסדר מבחינת שבת וחג
  return function ok(dateStr, dep, arr, from, to) {
    const d = parseTime(dep), a = parseTime(arr);
    if (!d) return false;
    const fromTz = (PLACES[from] || PLACES.TLV)[2], toTz = (PLACES[to] || PLACES.TLV)[2];
    const depMs = localToMs(shift(dateStr, d.plus), d.h, fromTz);
    const arrMs = a ? localToMs(shift(dateStr, a.plus), a.h, toTz) : depMs + 5 * 36e5;
    for (const [s, eLand, eTake] of windows(from, dateStr)) {
      if (depMs >= s && depMs < eTake) return false;   // המראה בשבת/חג או קרוב מדי אליהם
      if (depMs < s && arrMs > eLand) return false;      // טיסה שעוברת על כל השבת
    }
    for (const [s, eLand] of windows(to, shift(dateStr, a ? a.plus : 0))) {
      if (arrMs >= s && arrMs < eLand) return false;     // נחיתה בשבת/חג או 3 שעות לפני
      if (depMs < s && arrMs > eLand) return false;
    }
    return true;
  };
}
