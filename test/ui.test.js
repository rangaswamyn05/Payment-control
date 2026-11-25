'use strict';
process.env.GOOGLE_VISION_KEY = 'test-key';
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const { start } = require('./serve');
const fs = require('fs');
let bad = 0;
const ok = (n, c, x) => { if (!c) bad++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  ' + (x || ''))); };

// canned reading of the 1st real screenshot, returned when the app calls Google Vision
const realFetch = global.fetch;
global.fetch = async (u, o) => String(u).includes('vision.googleapis.com')
  ? new Response(JSON.stringify({ responses: [{ fullTextAnnotation: { text: "10:09\nBaby's Backyard\n₹5,000\nPaid to\nRACHANA SHIVANNA GOWDA\nPATIL\nKotak Bank • 9731853585@kotak\n25 November 2026, 2:11 pm\nAdvance\nReply\nPOWERED BY\nUPI" } }] }), { status: 200 })
  : realFetch(u, o);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
fs.mkdirSync('/tmp/pcshots', { recursive: true });

(async () => {
  const srv = await start(0); const base = 'http://localhost:' + srv.address().port;
  const browser = await chromium.launch();
  const errors = [];
  async function newPage(w, h) { const ctx = await browser.newContext({ viewport: { width: w, height: h } }); const pg = await ctx.newPage(); pg.on('pageerror', e => errors.push(String(e))); pg.on('console', m => { if (m.type() === 'error' && !/favicon|fonts|401 \(Unauthorized\)/i.test(m.text())) errors.push(m.text()); }); return pg; }
  async function login(pg, u) { await pg.goto(base + '/#/login'); await pg.waitForSelector('#un'); await pg.fill('#un', u); await pg.fill('#pw', 'demo1234'); await pg.click('button[type=submit]'); await pg.waitForSelector('.top'); }
  const overflow = pg => pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);

  // ---- uploader on a phone
  let pg = await newPage(390, 844);
  await pg.goto(base + '/'); await pg.waitForSelector('#un');
  ok('login screen shows demo logins', (await pg.textContent('.login')).includes('Demo logins'));
  await pg.fill('#un', 'uploader'); await pg.fill('#pw', 'wrong'); await pg.click('button[type=submit]'); await pg.waitForFunction(() => document.getElementById('lerr').textContent.length > 0);
  ok('wrong password shows a clear message', (await pg.textContent('#lerr')).includes('Wrong username or password'));
  await pg.fill('#pw', 'demo1234'); await pg.click('button[type=submit]'); await pg.waitForSelector('.top');
  ok('uploader lands on Add payment', pg.url().endsWith('#/add'));
  const navText = await pg.textContent('.nav');
  ok('uploader menu has no summaries or orders', !/Dashboard|Orders|Review|Statement|Team|Settings/.test(navText), navText);
  await pg.setInputFiles('#fi', { name: 'shot.png', mimeType: 'image/png', buffer: PNG });
  await pg.waitForFunction(() => document.getElementById('f_a') && document.getElementById('f_a').value === '5000', null, { timeout: 8000 });
  ok('screenshot read: amount, date, time, payee filled', await pg.inputValue('#f_a') === '5000' && await pg.inputValue('#f_d') === '2026-11-25' && await pg.inputValue('#f_t') === '14:11');
  await pg.fill('#f_o', 'demo-1001'); await pg.waitForFunction(() => /Found/.test(document.getElementById('ohint').textContent));
  ok('order lookup shows client name only', (await pg.textContent('#ohint')).includes('Demo client A'));
  await pg.screenshot({ path: '/tmp/pcshots/uploader.png' });
  ok('no sideways scroll on phone (add payment)', !(await overflow(pg)));
  await pg.click('#af button[type=submit]'); await pg.waitForSelector('text=Payment saved');
  ok('payment saved confirmation', true);
  await pg.click('text=Add another'); await pg.click('[data-m=cash]');
  await pg.fill('#f_o', 'DEMO-1002'); await pg.fill('#f_a', '20000'); await pg.waitForFunction(() => /Found/.test(document.getElementById('ohint').textContent));
  await pg.click('#af button[type=submit]'); await pg.waitForSelector('text=Payment saved');
  await pg.goto(base + '/#/mine'); await pg.waitForSelector('.tr:not(.h)');
  ok('my submissions lists both, with no status or totals', (await pg.locator('.tr:not(.h)').count()) === 2 && !/Verified|Awaiting|Outstanding/.test(await pg.textContent('main')));
  await pg.goto(base + '/#/orders'); await pg.waitForFunction(() => location.hash === '#/add');
  ok('uploader is bounced away from manager pages', true);
  await pg.close();

  // ---- manager on a laptop
  pg = await newPage(1440, 900); await login(pg, 'manager');
  await pg.waitForSelector('.kpi');
  const dash = await pg.textContent('main');
  ok('dashboard shows outstanding and cash to confirm', /Outstanding from clients/.test(dash) && /1 cash to confirm/.test(dash), dash.slice(0, 300));
  await pg.screenshot({ path: '/tmp/pcshots/dashboard.png' });
  await pg.click('.nav a[href="#/orders"]'); await pg.waitForSelector('a.tr');
  await pg.click('a.tr:has-text("DEMO-1001")'); await pg.waitForSelector('text=Payments on this order');
  ok('back button on order detail', await pg.locator('.back').count() === 1);
  ok('payment shows awaiting verification', (await pg.textContent('main')).includes('Awaiting verification'));
  ok('close is blocked and says why', (await pg.textContent('main')).includes('Cannot close'));
  await pg.screenshot({ path: '/tmp/pcshots/order.png' });
  await pg.click('[data-act=verify]'); await pg.fill('#askv', 'Seen in bank app'); await pg.click('[data-x=yes]');
  await pg.waitForSelector('.badge.good:has-text("Verified")');
  ok('manager verifies by hand with a note', true);
  await pg.click('.back'); await pg.waitForSelector('text=Orders');
  ok('back button returns to the order list', pg.url().endsWith('#/orders'));
  await pg.goto(base + '/#/review'); await pg.waitForSelector('text=Cash to confirm');
  await pg.click('[data-act=confirmCash]'); await pg.click('[data-x=yes]'); await pg.waitForSelector('text=Nothing waiting');
  ok('manager confirms the uploader\'s cash', true);
  await pg.screenshot({ path: '/tmp/pcshots/review.png' });

  // statement
  fs.writeFileSync('/tmp/pcshots/st.csv', 'Statement of account\nTxn Date,Narration,Chq/Ref No,Withdrawal,Deposit,Balance\n25-11-2026,UPI/CR/123/PAYMENT,REF1,,"5,000.00","1,05,000.00"\n25-11-2026,UPI/CR/999/SOMEONE,REF2,,"77,777.00","1,82,777.00"\n24-11-2026,ATM WDL,,"2,000.00",,"1,80,777.00"\n');
  await pg.goto(base + '/#/statement'); await pg.waitForSelector('#sf');
  // a pending online payment to match: add one as the manager first via API-free route (the uploader's earlier one was verified by hand), so just check the credits preview and run
  await pg.setInputFiles('#sf', '/tmp/pcshots/st.csv'); await pg.waitForSelector('#runst');
  ok('statement: finds 2 credits (the withdrawal is ignored)', (await pg.textContent('#stprev')).includes('Found 2 credits'), await pg.textContent('#stprev'));
  await pg.click('#runst'); await pg.waitForSelector('#stres h2');
  ok('statement result lists the credit nobody logged', (await pg.textContent('#stres')).includes('77,777'));
  await pg.screenshot({ path: '/tmp/pcshots/statement.png' });

  // mobile layout for manager
  await pg.setViewportSize({ width: 390, height: 844 }); await pg.goto(base + '/#/'); await pg.waitForSelector('.kpi');
  ok('no sideways page scroll on phone (dashboard)', !(await overflow(pg)));
  await pg.goto(base + '/#/orders/DEMO-1001'); await pg.waitForSelector('text=Payments on this order');
  ok('no sideways page scroll on phone (order detail)', !(await overflow(pg)));
  await pg.close();

  // ---- owner
  pg = await newPage(1280, 900); await login(pg, 'owner');
  await pg.goto(base + '/#/team'); await pg.waitForSelector('#uf');
  await pg.fill('#un1', 'Asha'); await pg.fill('#uu', 'asha'); await pg.fill('#up', 'password123'); await pg.selectOption('#ur', 'uploader'); await pg.click('#uf button[type=submit]');
  await pg.waitForSelector('text=asha');
  ok('owner adds a person', true);
  await pg.goto(base + '/#/settings'); await pg.waitForSelector('#sf2');
  ok('settings shows connector form', !!(await pg.$('#au')));
  await pg.goto(base + '/#/orders/DEMO-1003'); await pg.waitForSelector('text=Change total');
  ok('owner sees change-total', true);
  await pg.goto(base + '/#/audit'); await pg.waitForSelector('.tr:not(.h)');
  ok('audit log shows entries', (await pg.locator('.tr:not(.h)').count()) > 5);
  await pg.close();

  ok('no browser errors', errors.length === 0, errors.join(' | '));
  await browser.close(); srv.close();
  console.log(bad ? '\n' + bad + ' FAILED' : '\nALL UI TESTS PASSED'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
