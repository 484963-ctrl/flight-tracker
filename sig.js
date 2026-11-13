// "חתימה" של כל מה שהוגדר באתר — אם השתנתה, בודקים מיד את הטיולים החדשים
const c = require('./config.json').supabase;
const KEY = process.env.TEXTMEBOT_APIKEY ? 'flights-scan:' + process.env.TEXTMEBOT_APIKEY : '';
const call = (f, b) => fetch(c.url + '/rest/v1/rpc/' + f, { method: 'POST', headers: { apikey: c.key, 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.text());
Promise.all([KEY ? call('ft_scan_sig', { key: KEY }) : '', call('flight_get_watches'), call('flight_get_settings')])
  .then((a) => console.log(require('crypto').createHash('sha1').update(a.join('|')).digest('hex')))
  .catch(() => console.log('x'));
