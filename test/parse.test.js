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
// Real Kotak "Credited" screenshot (26 Nov 2026), as the OCR engine read it: rupee sign came out as a percent sign after the plus
r = parseUpi('Credited\n\n+%4,500\n\nStatus SUCCESS ©\nDate 26 Nov 2026\nRemarks UPI/HARSH RAJ/HDFC/\n133371160070/UPI\nTransaction ID 133371160070\nTo\n\n@ Kotak Mahindra Bank\nCurrent XX8960');
eq('K1 amount (+%4,500)', r.amount, 4500); eq('K1 flagged unsure', !!r.amountUnsure || r.confidence !== 'high', true); eq('K1 txn', r.txnId, '133371160070'); eq('K1 date', r.date, '2026-11-26'); eq('K1 payer', r.payer, 'HARSH RAJ'); eq('K1 direction', r.direction, 'credit');
// Real PhonePe "Payment Successful" screenshot (26 Nov 2026) as OCR read it
r = parseUpi('1:09 9 ®¢B@68:- ANE ull ull €\n\nPayment Successful\n26 November 2026 at 11:09 AM\n\nRACHANA SHIVANNA\nGOWDA PATIL\nsveees 3585@kotak\n\n%2,000 split Expense\n\n&) View Details Ce Share Receipt\n\nBuilt for big bites!\n\nROLLS STARTING\n\nDone');
eq('P1 amount (%2,000 beside words)', r.amount, 2000); eq('P1 date', [r.date, r.time], ['2026-11-26', '11:09']); eq('P1 payee', r.payee, 'RACHANA SHIVANNA GOWDA PATIL'); eq('P1 direction', r.direction, 'debit'); eq('P1 flagged unsure', r.amountUnsure, true);
// Real GPay screenshot (dark mode) as OCR read it: rupee sign came out as "="
r = parseUpi('=2,000.00\n\nCompleted\n\nve Payment should now be in RACHANA SHIVANNA\nGOWDA PATIL\'s bank account.\n24 Nov 2026 at 10:03 PM\n\nSent to\nRACHANA SHIVANNA GOWDA PATIL\n24 Nov 2026 at 10:03 PM\n\nSent from\n\nINFANT ALEXIOUS CLEMENT P with ICICI Bank «+26\n\nTransaction ID\n\n111279719729');
eq('G1 amount', r.amount, 2000); eq('G1 txn', r.txnId, '111279719729'); eq('G1 date', [r.date, r.time], ['2026-11-24', '22:03']); eq('G1 payee', r.payee, 'RACHANA SHIVANNA GOWDA PATIL'); eq('G1 payer', r.payer, 'INFANT ALEXIOUS CLEMENT P'); eq('G1 flagged unsure', r.amountUnsure, true);
// Real Kotak credited screens where OCR put the word "Remarks" inside the remark text
r = parseUpi('Credited\n+%4,000\nStatus SUCCESS ©\nDate 25 Nov 2026\nUPI/MANISHA PANDA/\nRemarks NESF/632933077307/\nPayment from\nTransaction ID 632933077307\nTo\n() Kotak Mahindra Bank\nCurrent XX8960');
eq('K2 payer across lines', r.payer, 'MANISHA PANDA'); eq('K2 txn', r.txnId, '632933077307'); eq('K2 amount', r.amount, 4000);
r = parseUpi('Credited\n+%4,000\nStatus SUCCESS ©\nDate 24 Nov 2026\nUPI/BHARATHI C/ICIC/\nRemarks 468434730966/Payment\nfrom\nTransaction ID 468434730966\nTo\n() Kotak Mahindra Bank\nCurrent XX8960');
eq('K3 payer is not "Transaction ID"', r.payer, 'BHARATHI C'); eq('K3 date', r.date, '2026-11-24');
// Real GPay dark "details" screen: the payer line carries the bank in brackets
r = parseUpi('To rachana patil\n$91 sores «3585,\n%2,000\nphotoshoot adv\n@ Completed\n23 Nov 2026, 8:01pm\nUPI transaction ID\n632739967036\nTo: RACHANA S PATIL\nla~1@okhdfcbank on Google Pay\nFrom: DINESHWARAN C (ICICI Bank)\n+++sluva@okicici on Google Pay\nGoogle transaction ID\nCICAgPibjNXbUA');
eq('G2 amount', r.amount, 2000); eq('G2 txn is the UPI id', r.txnId, '632739967036'); eq('G2 date', [r.date, r.time], ['2026-11-23', '20:01']); eq('G2 payer', r.payer, 'DINESHWARAN C');
// Real ICICI "Payment successful!" card: time before the date, two-digit year, "Tr. ID"
r = parseUpi('Payment successful!\n25,000\nTo RACHANA SHIVANNA GOWDA PATIL\n9731853585@kotak\nFrom SEENU ANJANAIAH\nseenu.a4455@icici\nPaid at 5:35PM, 23 Nov \'26 IST\nTr. ID: 111267979197');
eq('I1 date and time', [r.date, r.time], ['2026-11-23', '17:35']); eq('I1 txn (Tr. ID)', r.txnId, '111267979197'); eq('I1 payer', r.payer, 'SEENU ANJANAIAH'); eq('I1 payee', r.payee, 'RACHANA SHIVANNA GOWDA PATIL'); eq('I1 amount flagged, 5,000 offered', [r.amountUnsure, r.altAmount], [true, 5000]);
// Real Paytm card: no year, spaced reference number, sender name above the bank
r = parseUpi('Payim\nRachana Shivanna Gow...\n******X 358 5@kotak\n*2,000\nTwo Thousand Rupees\nPaid Successfully @\nShweta Singh\ni= HDFC Bank - 4189\n22 Nov, 12:13 PM | Ref No: 3197 3145 6048');
eq('T1 amount', r.amount, 2000); eq('T1 ref no with spaces', r.txnId, '319731456048'); eq('T1 date has day, month and time', [r.date && r.date.slice(5), r.time], ['11-22', '12:13']); eq('T1 payer', r.payer, 'Shweta Singh');
// Real slice receipt and two PhonePe "Transaction Successful" cards (name shares a line with the amount)
r = parseUpi('Paid 1,000\nTo Rachana Shivanna Gowda\nPatil\n22 Nov \u201826, 09:12 am\nNotes: Payment from slice\nFrom: slice savings\nUPI Ref ID\n632645158678');
eq('SL1 amount', r.amount, 1000); eq('SL1 date', [r.date, r.time], ['2026-11-22', '09:12']); eq('SL1 ref', r.txnId, '632645158678');
r = parseUpi('Transaction Successful\n09:33 am on 21 Nov 2026\nPaid to\nRACHANA SHIVANNA %2,000\nGOWDA PATIL\ne000003585@kotak\nPhonePe Transaction ID\nT2611210932581721202362\nUTR: 544313603237');
eq('PP2 amount', r.amount, 2000); eq('PP2 payee', r.payee, 'RACHANA SHIVANNA GOWDA PATIL'); eq('PP2 txn', r.txnId, 'T2611210932581721202362'); eq('PP2 date', [r.date, r.time], ['2026-11-21', '09:33']);
// Real Paytm / PhonePe crop with a trailing symbol and "Ref, No"
r = parseUpi('Rachana Shivanna Gowda P...\nUPI ID: ******3585@kotak\n~5,000 @\n19 Nov, 04:27PM \u00ab Ref, No: 319528516136 [Q\nCheck Balance Pay Again');
eq('PT2 amount', r.amount, 5000); eq('PT2 ref', r.txnId, '319528516136'); eq('PT2 time', r.time, '16:27');
// Not a payment: a payments-app home screen and a random photo read as nothing
r = parseUpi('Google Pay\nSearch\nPay anyone\nSend money\nPay contacts\nBills & recharges\nBusiness\nSee all\nHome\nPay\nMoney');
eq('N1 home screen: no amount, no id, no date', [r.amount, r.txnId, r.date, r.confidence], [null, null, null, 'low']);
r = parseUpi('IMG_4821\nBeach at sunset');
eq('N2 random photo: nothing found', [r.amount, r.txnId, r.date], [null, null, null]);
const { parseSchedule } = require('../api/_lib/parse');
eq('schedule rows with dates and amounts', parseSchedule('Sr Due date Amount\n1 05/12/2026 ₹50,000\n2 20 Jan 2027 ₹50,000\n3 2027-03-01 Rs 25,000.00'), [{ date: '2026-12-05', amount: 50000 }, { date: '2027-01-20', amount: 50000 }, { date: '2027-03-01', amount: 25000 }]);
eq('schedule read as separate columns', parseSchedule('Date\n05/12/2026\n20/01/2027\nAmount\n50,000\n60,000'), [{ date: '2026-12-05', amount: 50000 }, { date: '2027-01-20', amount: 60000 }]);
eq('no schedule in plain text', parseSchedule('Thank you 1234'), []);
eq('rupee sign read as a percent sign', parseUpi('Completed\n\n% 30,000\n\nTo: Ramesh Kumar\nNov 25, 2026, 2:11 PM\nUPI transaction ID\n632912345678').amount, 30000);
{ const u = parseUpi('Payment successful\n25,000\nPaid to Ramesh\n25 Nov 2026, 2:11 PM\nUPI Transaction ID\nT2611251411ABCD'); eq('lone number with no rupee sign is flagged and offers the number without a leading 2', [u.amountUnsure, u.amount, u.altAmount], [true, 25000, 5000]); }
{ const u = parseUpi('Paid ₹25,000\nTo Ramesh'); eq('amount with a rupee sign is trusted', [u.amountUnsure, u.altAmount], [undefined, undefined]); }
eq('phone number shown on the screenshot is read', [parseUpi('WhatsApp\n+91 98765 43210\nPaid ₹5,000\nUPI transaction ID\n632912345678').phone, parseUpi('Paid ₹5,000\nUPI transaction ID\n632912345678').phone], ['9876543210', undefined]);
console.log(bad ? bad + ' FAILED' : 'ALL PARSER TESTS PASSED');
process.exit(bad ? 1 : 0);
