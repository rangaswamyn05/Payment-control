'use strict';
// Reading evaluation. Scores what the app extracts from the text of a screenshot against the answer we expect.
// Run: node eval/run-reader.js            (uses the saved texts in reader-cases.json)
// Real-screenshot run: put the text the app showed under "What the reader saw" into a new case and re-run.
const { parseUpi, parseSchedule } = require('../api/_lib/parse');
const cases = require('./reader-cases.json');
const rows = []; let fieldsOk = 0, fieldsAll = 0, silentWrong = 0;
for (const c of cases) {
  const res = [];
  if (c.kind === 'plan') {
    const got = parseSchedule(c.text).map(r => [r.date, r.amount]);
    const ok = JSON.stringify(got) === JSON.stringify(c.expect.schedule);
    res.push(['schedule', ok]);
  } else {
    const p = parseUpi(c.text), e = c.expect;
    for (const f of ['amount', 'txnId', 'date', 'phone', 'orderHint']) {
      if (!(f in e)) continue;
      let ok;
      if (f === 'amount' && e.amountOptions) ok = e.amountOptions.includes(p.amount) && p.amount !== null && (p.altAmount === e.amount || p.amount === e.amount); // right answer is offered
      else ok = (p[f] === undefined || p[f] === null ? null : p[f]) === e[f];
      res.push([f, ok]);
    }
    if (e.mustNotBeConfident) { const guarded = !!p.amountUnsure; res.push(['confirm asked', guarded]); }
    // a wrong amount is only acceptable if the app asks the uploader to confirm it
    if (e.amount !== undefined && p.amount !== e.amount && !p.amountUnsure && !(e.amountOptions)) silentWrong++;
  }
  for (const [, ok] of res) { fieldsAll++; if (ok) fieldsOk++; }
  rows.push({ id: c.id, app: c.app, note: c.note, res });
}
for (const r of rows) console.log(`${r.res.every(x => x[1]) ? 'PASS' : 'FAIL'}  ${r.id}  ${r.app.padEnd(24)} ${r.res.map(([f, ok]) => f + (ok ? ' ok' : ' WRONG')).join(', ')}  | ${r.note}`);
console.log(`\nFields correct: ${fieldsOk}/${fieldsAll} (${Math.round(100 * fieldsOk / fieldsAll)}%).  Wrong amounts shown without a confirm prompt: ${silentWrong}`);
process.exit(silentWrong || fieldsOk < fieldsAll ? 1 : 0);
