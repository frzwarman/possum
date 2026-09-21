# Implementation checkpoints

Repository inspected: empty, no existing package manager or configuration. One Vite application, strict TypeScript, pnpm lockfile. No production credentials supplied.

1. Foundation: types and integer calculation rules; transactional Dexie command/outbox; isolated demo; login and primary device authorization; order/payment/receipt.
2. Service: drafts and saved orders, explicit preparation, printable kitchen changes, shift cash and close, dated reports.
3. Stock: immutable movements, versioned recipes, purchases and counts; menu/settings onboarding and CSV preview.
4. Reliability: idempotent SQL RPC, RLS tests, retry/recovery, PWA update controls, accessibility/browser tests, deployment and recovery runbooks.

Design: background #f6f5f0, surface #ffffff, ink #222c27, green #205c45, muted #647168, warning #925e16. System sans-serif, tabular money. Desktop left navigation / menu / receipt cart; phone bottom navigation and full-height cart dialog. Compact menu tiles with optional 420 px WebP photos and visible prices. Actions stay near the current order. Blank photos use the bundled food illustration, so images never become a setup dependency.

Defaults: IDR integer rupiah, quantities in thousandths of a base unit; 04:00 business-day cutoff; Asia/Jakarta; tax/service off; 12-hour shift authorization; single full-bill payment; full refunds only, online manager only. Refund never restores stock. Preparation consumes versioned recipe/add-ons/packaging once per line batch. Prepared lines are locked; additions get new line IDs; prepared cancellations leave consumption intact. Operational reporting starts at configured go-live date. Physical printing and Android hardware require external acceptance.
