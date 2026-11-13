# Takar PRD: Ziggy Lounge pilot, cashless revision (Nov 2026)

> Source: Google Doc 172qjIbFPXQDAG0kMPIylAE-lixoMxjVt2mVHORjAhnw ("TAKAR POC - Ziggy lounge"), read on 2026-11-13.
> Supersedes 2026-11-08-takar-pilot-prd.md for the pilot. Text export, unedited.

Takar PRD: Ziggy Lounge pilot
Nov 7, 2026 · Canoe Project
This is the short version, only for the Ziggy pilot. The full version, for selling Takar to other brands later, is here: Full version (scalable)
In one minute
* What: a cashless POS that also tracks stock, down to the gram.
* Why: ESB has too many steps, stock is never right, and a deleted sale can hide fraud.
* When: Christopher decides on ESB by 15 Nov 2026.
* Success: in 2 weeks, every sale takes its ingredients out of stock, and Christopher stops doing data entry himself.
Problems we fix
Problem today
	What Takar does
	Too many screens and steps
	One screen for each job
	Stock is never right
	Enter a delivery or count stock on a tablet, in minutes
	Small ingredients are not tracked
	Recipes in grams, also for prep made in the kitchen
	Sales can be deleted with no trace
	Void and discount need a manager PIN, and go into a log nobody can change
	Internet or power goes down
	The POS keeps selling, and sends the sales later
	Free drinks and food for staff and family leave no record
	Compliment orders with clear rules and a monthly budget
	Staff can make a drink without entering it
	Stock count before closing shows the gap in red
	Who uses what
Who
	Device
	What they do
	Cashier
	Cashier tablet
	Takes the order and card or QRIS payment on the EDC, and tells the bar and kitchen what to make. Opens and closes the shift. On the Stock tab: sees what is low, records prep and waste, counts stock before closing.
	Bar and kitchen
	No device for now
	Make what the cashier tells them.
	Christopher (manager)
	Laptop. The cashier tablet after closing.
	Menu, prices, deliveries, counts, reports and the compliment budget. Approves with his PIN.
	Two rules:
* The cashier tablet never opens the manager screens while a shift is open.
* After closing, Christopher can sign in on the cashier tablet with his PIN.
One day, end to end
At Ziggy the cashier, bar and kitchen are one step apart. So the cashier just tells them. We don't need order screens in the bar and kitchen for now.
1. Open the shift. The cashier signs in with a PIN and checks that the EDC machines and printers are ready. There is no cash.
2. Take an order and get paid. The guest pays by card or QRIS on the EDC, and the receipt always prints. The cashier tells the bar and kitchen what to make. Stock goes down when the order is paid.
3. Check stock between orders. The Stock tab shows what is low or sold out. A sold-out item turns off on the POS by itself.
4. Close the day. The cashier counts the stock first, then closes the shift by matching each EDC settlement. A gap over Rp10.000 needs Christopher's approval.
5. Christopher reviews the day. On his laptop he approves the count and checks sales, food cost and every approval.
In the full version, orders go to bar and kitchen screens. We can switch that on later, for a bigger outlet.
Payment: cashless
Ziggy takes no cash. Guests pay by card or QRIS, both on an EDC machine.
* The cashier picks the method (card or QRIS) and the machine (EDC BCA, BRI or Mandiri).
* On the EDC the cashier types the amount, then taps Confirm when it prints Approved or Paid. The EDC is not connected to Takar in the pilot.
* Approval code from the EDC slip is optional. It finds a payment the EDC left pending.
* The receipt always prints. There is no on/off switch.
* Closing the shift matches each EDC settlement slip, not cash.
Compliments
Type
	Rule
	Payment
	Staff meal
	Drinks free, food 50% off
	Staff pays the food part
	Owner's family
	Everything free
	None, receipt prints as Compliment
	Compliments still take stock, are not counted as sales, and count against a monthly budget that Christopher sets.
Orders page
The cashier can find any order from today by number, name or approval code, reprint the receipt, chase a payment the EDC left pending, or ask to void an item.
What we build first
* POS: search by any part of the name, Dine in, Take away or Compliment, pager number, options (size, milk, sugar), card or QRIS on the EDC, receipt always prints, open and close shift.
* Stock tab on the cashier tablet: what is low or sold out, record prep and waste, count stock before closing.
* Recipes: each menu item has a recipe in grams.
* Christopher's laptop: Today screen with the compliment budget, deliveries, count approval with items lost, reports and export to Excel.
* Safety: manager PIN for void and discount, a log nobody can change, a PIN for each staff member.
Later: purchase orders, comparing supplier prices, recipe approval, bar and kitchen tablets, accounting and attendance.
Add-on after the pilot (WhatsApp): Christopher approves voids and gaps from WhatsApp, teachers pre-order lunch on WhatsApp and pick it up, and Christopher gets a daily summary. Built with n8n and the WhatsApp Business API, priced separately.
How we know it works (after 2 weeks)
Check
	Target
	Menu items with a full recipe
	100%
	Gap between counted and expected stock (top 20 ingredients)
	Under 5%
	Time to count the top 20 ingredients
	Under 15 minutes
	Voids and discounts with a PIN and a log entry
	100%
	Data entry done by Christopher himself
	Under 10%
	Price
Takar for Ziggy Lounge: Rp20.000.000, one time. Ziggy owns its POS and back office. This is not a yearly fee. Paid in two parts: 50% when the pilot starts, 50% after 2 weeks once the pilot meets its goals.
* Menu, prices and about 60 recipes in grams, including kitchen prep
* Data moved over from ESB
* Cashier tablet and laptop set up, and a PIN for each staff member
* 2 training sessions for the staff
* 2 weeks of support at Ziggy during the pilot
Also included
* 12 months of maintenance and updates, same-day WhatsApp support and a monthly stock review together.
* Built for how Ziggy works: cashless card and QRIS on the EDC, staff and family compliments with a monthly budget, a stock count before closing.
* Not included: tablet, printers, EDC fees, and the WhatsApp add-on (void approval on Toper's phone, teacher pre-orders), which is priced after the pilot.


	ESB
	Takar
	Price per year
	From Rp7 juta a year, plus Rp2,5 juta per extra account, plus VAT
	Rp20 juta once
	Stock to the gram
	No
	Yes, with every sale
	Fraud control
	OTP
	PIN on every void, and a log nobody can change
	Works offline
	No
	Yes
	Support
	About 3 weeks per reply (Play Store reviews)
	Same day, from the people who built it
	Built for Ziggy
	No
	Yes, requests included in year 1
	Over 3 years ESB costs Rp21 juta or more and keeps going; Takar is Rp20 juta once. Takar is shaped around how Ziggy actually runs and changes in days, because the team works with Toper directly. A custom system like this is normally Rp60–80 juta.
Questions for Christopher
1. Is 15 Nov the date for a working pilot, or for the ESB decision?
2. Who will be the admin, and when do they start?
3. Which EDC machines (banks) and printers does Ziggy use?
4. What are the tax and service charge rules (PB1, service %)?
Designs: Ziggy pilot screens and the day, end to end. The full version with bar and kitchen tablets: scalable screens.