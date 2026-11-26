-- QA fixes, 2026-11-25, cluster catalog (menu/F7). Safari and every iPhone or iPad browser cannot encode WebP from a
-- canvas, so the app saves a photo as JPEG there (src/lib/menu-photo.ts). The logo takes both, under the same size cap
-- and the same strict base64 shape; catalog.publish does the same for menu photos (202611250001_qa_fixes.sql).
-- Older apps only show the logo (an <img>), so a JPEG one is safe for them.
alter table public.restaurants drop constraint restaurants_logo_check,
 add constraint restaurants_logo_check check (logo is null or (length(logo) <= 70000 and logo ~ '^data:image/(webp|jpeg);base64,[A-Za-z0-9+/=]+$'));
