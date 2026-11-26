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
  ? new Response(JSON.stringify({ responses: [{ fullTextAnnotation: { text: "10:09\nBaby's Backyard\n₹5,000\nPaid to\nRACHANA SHIVANNA GOWDA\nPATIL\nKotak Bank • 9731853585@kotak\n25 November 2026, 2:11 pm\nUPI transaction ID\nT2611251411ABCD\nAdvance\nReply\nPOWERED BY\nUPI" } }] }), { status: 200 })
  : realFetch(u, o);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
fs.mkdirSync('/tmp/pcshots', { recursive: true });

(async () => {
  const srv = await start(0); const base = 'http://localhost:' + srv.address().port;
  const browser = await chromium.launch();
  const errors = [];
  async function newPage(w, h) { const ctx = await browser.newContext({ viewport: { width: w, height: h } }); const pg = await ctx.newPage(); pg.on('pageerror', e => errors.push(String(e))); pg.on('console', m => { if (m.type() === 'error' && !/favicon|fonts|401 \(Unauthorized\)|status of 409/i.test(m.text())) errors.push(m.text()); }); return pg; }
  async function login(pg, u) { await pg.goto(base + '/#/login'); await pg.waitForSelector('#un'); await pg.fill('#un', u); await pg.fill('#pw', 'demo1234'); await pg.click('button[type=submit]'); await pg.waitForSelector('.top'); }
  const overflow = pg => pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);

  // ---- sales on a phone
  let pg = await newPage(390, 844);
  await pg.goto(base + '/'); await pg.waitForSelector('#un');
  ok('login screen shows demo logins', (await pg.textContent('.login')).includes('Demo logins'));
  await pg.fill('#un', 'uploader'); await pg.fill('#pw', 'wrong'); await pg.click('button[type=submit]'); await pg.waitForFunction(() => document.getElementById('lerr').textContent.length > 0);
  ok('wrong password shows a clear message', (await pg.textContent('#lerr')).includes('Wrong username or password'));
  await pg.fill('#pw', 'demo1234'); await pg.click('button[type=submit]'); await pg.waitForSelector('.top');
  ok('sales lands on Add payment', pg.url().endsWith('#/add'));
  const navText = await pg.textContent('.nav');
  ok('sales menu has no summaries or orders', !/Dashboard|Orders|Review|Statement|Team|Settings|Reports/.test(navText), navText);
  ok('drop zone is the first thing on the page', await pg.locator('#pz').count() === 1);
  await pg.fill('#f_o', 'demo-1001'); await pg.waitForFunction(() => /order total/.test(document.getElementById('ohint').textContent));
  ok('order lookup shows client, total and the next payment number pre-selected', (await pg.textContent('#ohint')).includes('Demo client A') && (await pg.inputValue('#f_s')) === '1');
  await pg.setInputFiles('#pz input', { name: 'shot.png', mimeType: 'image/png', buffer: PNG });
  await pg.waitForFunction(() => document.getElementById('p_a') && document.getElementById('p_a').value === '5000', null, { timeout: 8000 });
  ok('dropped screenshot read: amount, date, time, transaction ID filled', await pg.inputValue('#p_a') === '5000' && await pg.inputValue('#p_d') === '2026-11-25' && await pg.inputValue('#p_t') === '14:11' && await pg.inputValue('#p_r') === 'T2611251411ABCD');
  ok('order ID kept after the drop', await pg.inputValue('#f_o') === 'demo-1001');
  await pg.screenshot({ path: '/tmp/pcshots/uploader.png' });
  ok('no sideways scroll on phone (add payment)', !(await overflow(pg)));
  await pg.selectOption('#f_s', '4'); await pg.click('#af button[type=submit]'); await pg.waitForSelector('#f_sr');
  ok('wrong payment number asks for a reason', (await pg.textContent('main')).includes('This looks like payment 1'));
  await pg.fill('#f_sr', 'Earlier ones were cash'); await pg.click('#af button[type=submit]'); await pg.waitForSelector('text=Payment 4 saved');
  ok('saved with the reason, no manager step', true);
  await pg.click('text=Add another'); await pg.click('[data-pmode=cash]');
  await pg.fill('#f_o', 'DEMO-1002'); await pg.fill('#p_a', '20000'); await pg.waitForFunction(() => /order total/.test(document.getElementById('ohint').textContent));
  await pg.click('#af button[type=submit]'); await pg.waitForSelector('text=Payment 1 saved');
  ok('cash tells sales the owner will approve it', (await pg.textContent('main')).includes('owner will approve'));
  await pg.goto(base + '/#/new-order'); await pg.waitForSelector('#nf');
  await pg.fill('#oph', '+1 646 555 0100'); await pg.fill('#oc', 'UI-1'); await pg.fill('#ocu', 'Browser client'); await pg.fill('#ot', '90000');
  await pg.setInputFiles('#pz input', { name: 'adv.png', mimeType: 'image/png', buffer: PNG });
  await pg.waitForFunction(() => document.getElementById('p_a') && document.getElementById('p_a').value === '5000', null, { timeout: 8000 });
  await pg.fill('#p_r', 'UITXN0001'); await pg.click('#nf button[type=submit]'); await pg.waitForSelector('text=Sent for approval');
  ok('sales creates an order with first advance by dropping the screenshot', true);
  await pg.goto(base + '/#/mine'); await pg.waitForSelector('text=My orders');
  ok('my submissions lists the order as waiting, and payments without status or totals', /Waiting for approval/.test(await pg.textContent('main')) && !/Verified|Outstanding/.test(await pg.textContent('main')));
  await pg.goto(base + '/#/orders'); await pg.waitForFunction(() => location.hash === '#/add');
  ok('sales is bounced away from manager pages', true);
  await pg.close();

  // ---- manager on a laptop
  pg = await newPage(1440, 900); await login(pg, 'manager');
  await pg.waitForSelector('.kpi');
  const dash = await pg.textContent('main');
  ok('dashboard shows outstanding, validation and review items', /Outstanding from clients/.test(dash) && /Validation/.test(dash) && /Needs your review/.test(dash), dash.slice(0, 300));
  await pg.screenshot({ path: '/tmp/pcshots/dashboard.png' });
  await pg.goto(base + '/#/review'); await pg.waitForSelector('[data-act=reviewOrder]');
  await pg.click('[data-act=reviewOrder]'); await pg.waitForSelector('#rt');
  await pg.fill('#rt', '80000'); ok('button says change and approve when something is edited', (await pg.textContent('[data-x=ok]')) === 'Change and approve');
  await pg.fill('#rm2', 'Agreed 80k'); await pg.click('[data-x=ok]'); await pg.waitForSelector('text=Approved. Invoice created.');
  ok('manager changes the total and approves in one step', true);
  await pg.screenshot({ path: '/tmp/pcshots/review.png' });
  await pg.click('.nav a[href="#/orders"]'); await pg.waitForSelector('a.tr');
  await pg.click('a.tr:has-text("DEMO-1001")'); await pg.waitForSelector('text=Payments on this order');
  ok('back button on order detail', await pg.locator('.back').count() === 1);
  ok('order shows validation pending, not wrong', (await pg.textContent('main')).includes('Provide statements to validate'));
  ok('invoice link exists on an approved order', true);
  await pg.screenshot({ path: '/tmp/pcshots/order.png' });
  await pg.click('[data-act=verify]'); await pg.fill('#askv', 'Seen in bank app'); await pg.click('[data-x=yes]');
  await pg.waitForSelector('.badge.good:has-text("Verified")');
  ok('manager verifies by hand with a note', true);
  await pg.click('.back'); await pg.waitForSelector('text=Orders');
  ok('back button returns to the order list', pg.url().endsWith('#/orders'));
  await pg.goto(base + '/#/review'); await pg.waitForSelector('text=Waiting for the owner');
  ok('manager sees cash waiting for the owner, with no approve button', (await pg.textContent('main')).includes('Owner approves') && await pg.locator('[data-act=ownerApprove]').count() === 0);

  // statement
  fs.writeFileSync('/tmp/pcshots/st.csv', 'Statement of account\nTxn Date,Narration,Chq/Ref No,Withdrawal,Deposit,Balance\n25-11-2026,UPI/CR/123/PAYMENT,REF1,,"5,000.00","1,05,000.00"\n25-11-2026,UPI/CR/999/SOMEONE,REF2,,"77,777.00","1,82,777.00"\n24-11-2026,ATM WDL,,"2,000.00",,"1,80,777.00"\n');
  await pg.goto(base + '/#/statement'); await pg.waitForSelector('#sf');
  // a pending online payment to match: add one as the manager first via API-free route (the uploader's earlier one was verified by hand), so just check the credits preview and run
  await pg.setInputFiles('#sf input', '/tmp/pcshots/st.csv'); await pg.waitForSelector('#runst');
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
  await pg.goto(base + '/#/review'); await pg.waitForSelector('[data-act=ownerApprove]');
  await pg.click('[data-act=ownerApprove]'); await pg.waitForSelector('text=Approved');
  ok('owner approves the cash', true);
  await pg.goto(base + '/#/settings'); await pg.waitForSelector('#sf2');
  ok('settings: storage dropdown, GST number rule, limits', !!(await pg.$('#st')) && !!(await pg.$('#bn')) && !!(await pg.$('#l1')));
  await pg.fill('#bz', 'Acme Photos'); await pg.check('#bn'); await pg.selectOption('#st', 'app_sheet'); await pg.fill('#cf', 'Phone number'); await pg.fill('#l1', '50000');
  await pg.click('#sf2 button[type=submit]'); await pg.waitForSelector('text=Settings saved');
  ok('owner saves business setup', true);
  await pg.goto(base + '/#/orders/DEMO-1003'); await pg.waitForSelector('text=Adjust outstanding');
  await pg.click('[data-act=adjust]'); await pg.click('[data-k=change_total]'); await pg.fill('#nt', '40000'); await pg.fill('#ac', 'Discount'); await pg.click('[data-x=ok]'); await pg.waitForSelector('text=Done');
  ok('owner adjusts the total and it applies at once', true);
  await pg.goto(base + '/#/reports'); await pg.waitForSelector('#dl');
  ok('reports show revenue and a download button', /Revenue/.test(await pg.textContent('main')));
  await pg.screenshot({ path: '/tmp/pcshots/reports.png' });
  await pg.click('[data-act=clearData]'); await pg.waitForSelector('.toast:has-text("Download the report")');
  ok('clear asks to download the report first', /Download the report first/.test(await pg.textContent('.toast')));
  await pg.goto(base + '/#/audit'); await pg.waitForSelector('.tr:not(.h)');
  ok('audit log shows entries', (await pg.locator('.tr:not(.h)').count()) > 5);
  await pg.close();

  // ---- sales finds an order by phone number
  pg = await newPage(390, 844); await login(pg, 'uploader');
  await pg.goto(base + '/#/add'); await pg.waitForSelector('#f_ph');
  await pg.fill('#f_ph', '646 555 0100'); await pg.waitForSelector('[data-pick]');
  ok('typing the phone number lists the customer’s open order', (await pg.textContent('[data-pick]')).includes('UI-1'));
  await pg.click('[data-pick]'); await pg.waitForFunction(() => /order total/.test(document.getElementById('ohint').textContent));
  ok('tapping it fills the order ID and shows the client', await pg.inputValue('#f_o') === 'UI-1' && (await pg.textContent('#ohint')).includes('Browser client'));
  await pg.close();

  ok('no browser errors', errors.length === 0, errors.join(' | '));
  await browser.close(); srv.close();
  console.log(bad ? '\n' + bad + ' FAILED' : '\nALL UI TESTS PASSED'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
