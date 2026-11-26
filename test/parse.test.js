'use strict';
const { parseUpi } = require('../api/_lib/parse');
let bad = 0;
function eq(name, got, want) { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want))); }

// Text typed from the 4 real screenshots the user shared (what an OCR reader would return, line by line).
const s1 = `10:09\nBaby's Backyard\n25/11/26, 3:44 AM\n₹5,000\nPaid to\nRACHANA SHIVANNA GOWDA\nPATIL\nKotak Bank • 9731853585@kotak\n25 November 2026, 2:11 pm\nAdvance\nReply\nPOWERED BY\nUPI`;
const s2 = `10:09\n+91 88844 11511\n25/11/26, 4:13 AM\nCredited\n+₹4,000\nStatus\nSUCCESS\nDate\n24 Nov 2026\nRemarks\nUPI/BHARATHI C/ICIC/\n468434730966/Payment\nfrom\nTransaction ID\n468434730966\nTo\nKotak Mahindra Bank\nCurrent XX8960\nReply`;
const s3 = `₹2,000.00\nCompleted\nPayment should now be in RACHANA SHIVANNA GOWDA PATIL's bank account.\n24 Nov 2026 at 10:03 PM\nSent to\nRACHANA SHIVANNA GOWDA PATIL\n24 Nov 2026 at 10:03 PM\nSent from\nINFANT ALEXIOUS CLEMENT P with ICICI Bank ••26\nTransaction ID\n111279719729\nPOWERED BY\nUPI`;
const s4 = `10:09\nBaby's Backyard\n25/11/26, 1:20 AM\n₹5,000\nPaid to\nRACHANA SHIVANNA GOWDA\nPATIL\nKotak Bank • 9731853585@kotak\n25 November 2026, 11:18am\nAdvance\nReply\nPOWERED BY`;

let r = parseUpi(s1);
eq('S1 amount', r.amount, 5000); eq('S1 date', [r.date, r.time], ['2026-11-25', '14:11']); eq('S1 payee', r.payee, 'RACHANA SHIVANNA GOWDA PATIL'); eq('S1 vpa', r.payeeVpa, '9731853585@kotak'); eq('S1 no txn id', r.txnId, null); eq('S1 direction', r.direction, 'debit');
r = parseUpi(s2);
eq('S2 amount', r.amount, 4000); eq('S2 date', [r.date, r.time], ['2026-11-24', null]); eq('S2 txn', r.txnId, '468434730966'); eq('S2 payer', r.payer, 'BHARATHI C'); eq('S2 direction', r.direction, 'credit'); eq('S2 payee not the bank', r.payee, null);
r = parseUpi(s3);
eq('S3 amount', r.amount, 2000); eq('S3 date', [r.date, r.time], ['2026-11-24', '22:03']); eq('S3 txn', r.txnId, '111279719729'); eq('S3 payer', r.payer, 'INFANT ALEXIOUS CLEMENT P'); eq('S3 payee', r.payee, 'RACHANA SHIVANNA GOWDA PATIL');
r = parseUpi(s4);
eq('S4 amount', r.amount, 5000); eq('S4 date', [r.date, r.time], ['2026-11-25', '11:18']); eq('S4 payee', r.payee, 'RACHANA SHIVANNA GOWDA PATIL');
// Robustness
eq('empty text', parseUpi('').amount, null);
eq('rupee sign missing, number alone on a line', parseUpi('Paid\n2,500\nTransaction ID\nT26112500123456').amount, 2500);
eq('UTR style', parseUpi('Rs. 1,200.50 paid\nUTR: 612345678901\n03/11/2026 09:15 AM').txnId, '612345678901');
eq('dd/mm/yyyy', parseUpi('₹100\n03/11/2026 09:15 AM').date, '2026-11-03');
const { parseSchedule } = require('../api/_lib/parse');
eq('schedule rows with dates and amounts', parseSchedule('Sr Due date Amount\n1 05/12/2026 ₹50,000\n2 20 Jan 2027 ₹50,000\n3 2027-03-01 Rs 25,000.00'), [{ date: '2026-12-05', amount: 50000 }, { date: '2027-01-20', amount: 50000 }, { date: '2027-03-01', amount: 25000 }]);
eq('schedule read as separate columns', parseSchedule('Date\n05/12/2026\n20/01/2027\nAmount\n50,000\n60,000'), [{ date: '2026-12-05', amount: 50000 }, { date: '2027-01-20', amount: 60000 }]);
eq('no schedule in plain text', parseSchedule('Thank you 1234'), []);
eq('rupee sign read as a percent sign', parseUpi('Completed\n\n% 30,000\n\nTo: Ramesh Kumar\nNov 25, 2026, 2:11 PM\nUPI transaction ID\n632912345678').amount, 30000);
{ const u = parseUpi('Payment successful\n25,000\nPaid to Ramesh\n25 Nov 2026, 2:11 PM\nUPI Transaction ID\nT2611251411ABCD'); eq('lone number with no rupee sign is flagged and offers the number without a leading 2', [u.amountUnsure, u.amount, u.altAmount], [true, 25000, 5000]); }
{ const u = parseUpi('Paid ₹25,000\nTo Ramesh'); eq('amount with a rupee sign is trusted', [u.amountUnsure, u.altAmount], [undefined, undefined]); }
console.log(bad ? bad + ' FAILED' : 'ALL PARSER TESTS PASSED');
process.exit(bad ? 1 : 0);
