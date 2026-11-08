# Takar PRD: Ziggy Lounge pilot (short version), Nov 2026 · Canoe Project

> Source: Google Doc 1IrK_CHzx36nwb2a5aqabMamFFHvJVFsHm7bm2a0xPHo, read on 2026-11-08. This is the pilot-only
> cut of the full PRD (`2026-11-06-takar-prd.md`); where the two differ, this one wins for the pilot.

**TL;DR.** A POS that also tracks stock, down to the gram. ESB has too many steps, stock is never right, a
deleted sale can hide fraud. Christopher decides on ESB by 15 Nov 2026. Success in 2 weeks: every sale takes
its ingredients out of stock, and Christopher stops doing data entry himself.

**Problems we fix:** too many screens → one screen per job; stock never right → enter a delivery or count
stock on a tablet in minutes; small ingredients untracked → recipes in grams, also for prep like ayam ungkep;
sales deleted with no trace → void and discount need a manager PIN and go into a log nobody can change;
internet or power down → the POS keeps selling and sends the sales later.

**Who uses what**
- Cashier · cashier tablet: takes the order and the payment, tells the bar and kitchen what to make, opens
  and closes the shift. On the Stock tab: sees what is low, records batches and waste, counts after closing.
- Bar and kitchen · no device for now: make what the cashier tells them.
- Manager · laptop, and the cashier tablet after closing: menu, prices, deliveries, counts and reports;
  approves with his PIN.

Two rules: the cashier tablet never opens the manager screens while a shift is open; after closing, the
manager can sign in on the cashier tablet with his PIN.

**One day, end to end** (cashier, bar and kitchen are one step apart, so no order screens for them now):
1. Open the shift: count the cash, sign in with a PIN.
2. Take an order and get paid; tell bar and kitchen. **Stock goes down when the order is paid.**
3. Check stock between orders: the Stock tab shows what is low or sold out; a sold-out item turns off on
   the POS by itself.
4. Close the day: count the cash and the bar fridge; a cash gap needs the manager's PIN.
5. The manager reviews the day on his laptop: approves the count, checks sales, food cost and every approval.

In the scalable version orders go to bar and kitchen screens; switch that on later for a bigger outlet.

**What we build first:** POS (search by any part of the name, dine-in default, pager number, options,
cash and QRIS, open and close shift); Stock tab on the cashier tablet (low / sold out, batches, waste, count
after closing); recipes in grams; manager's laptop (Today, deliveries, count approval, reports, Excel
export); safety (manager PIN for void and discount, immutable log, a PIN for each staff member).

**Later:** purchase orders, supplier price comparison, recipe approval, bar and kitchen tablets, accounting,
attendance.

**Targets after 2 weeks:** recipes 100%; gap on top-20 ingredients under 5%; count of top 20 under 15 min;
voids and discounts with PIN and log 100%; manager's own data entry under 10%.

**Questions for the client:** pilot date vs ESB decision; who is the admin; QRIS provider and printers; PB1
and service rules.
