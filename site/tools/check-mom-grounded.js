/** Check "does the minutes invent things": every number and every proper name from the MoM
 *  is looked up in the transcript of the same meeting. This is not an automatic verdict but a list of places
 *  to check by eye: the script prints the transcript lines next to them so you can see where
 *  a number came from.
 *
 *  Why a human is still needed. The transcript is mixed and raw, numbers in it are spoken
 *  as words and on top of that garbled by recognition: "trei sute" = 300, "auzeceșase" =
 *  optzeci și șase = 86, "opt zeci pe … patruzeci" = 80/40, "zero douăci douăi" = 0.22.
 *  The minutes write them as digits — and that is correct work, not invention. So the script
 *  looks for a number both as digits and as words (ro/ru, 0-100 and hundreds), but it cannot catch
 *  garbled forms: whatever stays in the list — go and look.
 *
 *  Run: node tools/check-mom-grounded.js [jobId] [lang]
 *       node tools/check-mom-grounded.js --all [lang]
 *
 *  The Cyrillic transliteration table and character ranges below are intentional: the Russian
 *  minutes and the Russian parts of the transcript are checked too.
 */
const store = require('../db.js');

const ONES = ['zero', 'unu', 'doi', 'trei', 'patru', 'cinci', 'sase', 'sapte', 'opt', 'noua'];
const ONES_RU = ['nol', 'odin', 'dva', 'tri', 'chetyre', 'pyat', 'shest', 'sem', 'vosem', 'devyat'];
const TENS = ['', 'zece', 'douazeci', 'treizeci', 'patruzeci', 'cincizeci', 'saizeci', 'saptezeci', 'optzeci', 'nouazeci'];
const TENS_RU = ['', 'desyat', 'dvadcat', 'tridcat', 'sorok', 'pyatdesyat', 'shestdesyat', 'semdesyat', 'vosemdesyat', 'devyanosto'];

// Cyrillic is transliterated to Latin so that the Russian and the Romanian number words compare the same way.
const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const flat = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/ș/g, 's').replace(/ț/g, 't').replace(/ё/g, 'е')
  .replace(/[а-я]/g, (c) => TRANSLIT[c] ?? c);

/** How this number might have been spoken as words — rough, but enough for a text search. */
function spoken(n) {
  const out = [];
  const v = Number(String(n).replace(',', '.'));
  if (!Number.isFinite(v)) return out;
  const whole = Math.trunc(Math.abs(v));
  if (whole < 10) { out.push(ONES[whole], ONES_RU[whole]); }
  else if (whole < 100) {
    const t = Math.trunc(whole / 10), o = whole % 10;
    // Recognition often splits the tens with a space: "opt zeci pe patruzeci" = 80/40.
    out.push(TENS[t], TENS[t].replace('zeci', ' zeci'), TENS_RU[t]);
    if (o) out.push(`${TENS[t]} si ${ONES[o]}`, ONES[o], ONES_RU[o]);
  } else if (whole % 100 === 0 && whole < 1000) {
    const h = whole / 100;
    out.push(h === 1 ? 'o suta' : `${ONES[h]} sute`, h === 1 ? 'sto' : `${ONES_RU[h]}sot`);
  } else if (whole % 1000 === 0) out.push('mie', 'mii', 'tysyach');
  return out.filter(Boolean).map(flat);
}

function check(id, lang) {
  const parts = store.jobParts(id);
  const text = String(parts.transcript?.text || '');
  const mom = String(parts.mom?.[lang] || '');
  if (!text || !mom) return console.log(`${id}: no transcript or no "${lang}" minutes`);
  const src = flat(text);

  // Meeting dates are inserted by the workflow, list numbering by the markup: neither is speech.
  const momNums = mom.replace(/^\s*\d+\.\s/gm, ' ').replace(/\b\d{1,2}\.\d{2}(\.\d{4})?\b/g, ' ');
  const nums = [...new Set(momNums.match(/\d+(?:[.,]\d+)?/g) || [])]
    .filter((n) => !/^(19|20)\d\d$/.test(n) && n.length <= 6);
  const seen = (n) => src.includes(n) || src.includes(n.replace(',', '.')) || src.includes(n.replace('.', ','))
    || spoken(n).some((w) => src.includes(w));
  const numMiss = nums.filter((n) => !seen(n));

  // A proper name: a capitalised word that is not at the start of a sentence and not in a heading.
  // Compared by the beginning of the stem: the transcript has "Clepsiella", the minutes "Klebsiella".
  const words = [...new Set(mom.replace(/^#{1,6}.*$/gm, '').replace(/\*\*/g, '')
    .match(/(?<![.!?:\n]\s{0,2})\b[A-ZА-ЯĂÂÎȘȚ][a-zа-яăâîșț]{3,}/g) || [])];
  const wordMiss = words.filter((w) => !src.includes(flat(w).slice(0, 5)));

  const ok = !numMiss.length && !wordMiss.length;
  console.log(`${id} "${lang}": ${nums.length} numbers, ${words.length} names — `
    + (ok ? 'everything was found in the transcript' : 'check by eye'));
  if (numMiss.length) console.log('   numbers:', numMiss.join(', '));
  if (wordMiss.length) console.log('   names:', wordMiss.join(', '));
  return ok;
}

const arg = process.argv[2];
const lang = process.argv[3] || 'ru';
if (arg === '--all') {
  for (const r of store.db.all("SELECT id FROM jobs WHERE status = 'done' ORDER BY created_at DESC")) check(r.id, lang);
} else if (arg) {
  check(arg, lang);
} else {
  console.log('Give a meeting id or --all. Latest finished ones:');
  for (const r of store.db.all("SELECT id, title FROM jobs WHERE status = 'done' ORDER BY created_at DESC LIMIT 10")) {
    console.log(' ', r.id, '—', (r.title || '').slice(0, 60));
  }
}
