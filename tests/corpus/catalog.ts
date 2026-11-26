import type { Discount, Ingredient, MenuItem, Modifier, OptionGroup, Role, Settings, StockItem } from '../../src/domain/types'
// Ziggy Lounge, Jakarta: a lounge with a coffee bar and a kitchen. About 250 ingredients (bahan) bought in packs and
// kept in g, ml or pcs across storage areas, a dozen prep items made in-house, and about 100 menu items with option
// groups that move stock (size, milk swap, sugar and ice levels, add-ons, heat). All quantities are thousandths of
// the base unit, all money whole rupiah, as src/domain/types.ts defines them.

// Text a guest, cashier or manager might type, that has broken spreadsheets, receipts and databases elsewhere: CSV
// formula prefixes (OWASP: = + - @ tab CR), quotes, separators, line breaks, emoji, markup and SQL. Each is short
// enough for the tightest field (30 characters) unless it says otherwise.
export const ADVERSARIAL = [
  '=SUM(A1:A9)', '+62 812-3456', '-2+3', '@SUM(1+1)', '\t=1+1', '\r=HYPERLINK("x")',
  'Kopi "susu", gula; aren', "O'Neil; DROP TABLE x;--", 'Baris 1\nBaris 2\r\nBaris 3',
  'Es 🧋☕️ 👨‍👩‍👧 ✨', '<img src=x onerror=alert(1)>', '<b>tebal</b> & "kutip"', '\\u0000 C:\\temp\\', 'ﷺ ‮kanan-kiri‬ ',
] as const
// The longest value a field takes, in characters the server counts (code points) and the client counts (UTF-16).
export const longest = (n: number, unit = 'x') => unit.repeat(n)

const T = 1000 // thousandths of a base unit
type Unit = StockItem['unit']
// [id, name, unit, area, pack name, pack size in base units, price of one pack, low-stock threshold in base units]
type Row = readonly [string, string, Unit, string, string, number, number, number]
const BAR = 'Rak bar', BARFRIDGE = 'Kulkas bar', DRY = 'Dry store', KITCHEN = 'Kulkas dapur', FREEZER = 'Freezer', PACK = 'Rak kemasan'
const rows: Row[] = [
  // Coffee, tea, powders
  ['kopi-house', 'Biji kopi house blend', 'g', BAR, 'bungkus', 1000, 260000, 2000], ['kopi-gayo', 'Biji kopi Aceh Gayo', 'g', BAR, 'bungkus', 250, 95000, 500],
  ['kopi-toraja', 'Biji kopi Toraja', 'g', BAR, 'bungkus', 250, 98000, 500], ['kopi-kintamani', 'Biji kopi Kintamani', 'g', BAR, 'bungkus', 250, 92000, 500],
  ['kopi-flores', 'Biji kopi Flores Bajawa', 'g', BAR, 'bungkus', 250, 90000, 500], ['kopi-decaf', 'Biji kopi decaf', 'g', BAR, 'bungkus', 500, 160000, 250],
  ['kopi-tubruk', 'Kopi bubuk tubruk', 'g', BAR, 'bungkus', 500, 70000, 250], ['matcha', 'Bubuk matcha', 'g', BAR, 'kaleng', 100, 120000, 200],
  ['cokelat', 'Bubuk cokelat', 'g', BAR, 'bungkus', 1000, 145000, 500], ['taro', 'Bubuk taro', 'g', BAR, 'bungkus', 1000, 110000, 300],
  ['red-velvet', 'Bubuk red velvet', 'g', BAR, 'bungkus', 1000, 115000, 300], ['thai-tea', 'Bubuk thai tea', 'g', BAR, 'bungkus', 400, 65000, 200],
  ['chai', 'Bubuk chai', 'g', BAR, 'bungkus', 500, 98000, 200], ['teh-hitam', 'Teh hitam', 'g', BAR, 'bungkus', 500, 60000, 200],
  ['teh-melati', 'Teh melati', 'g', BAR, 'bungkus', 500, 55000, 200], ['teh-earl', 'Teh earl grey', 'g', BAR, 'kaleng', 250, 85000, 100],
  ['teh-hijau', 'Teh hijau', 'g', BAR, 'bungkus', 250, 50000, 100], ['teh-chamomile', 'Teh chamomile', 'g', BAR, 'kaleng', 100, 75000, 50],
  ['teh-rosella', 'Teh rosella', 'g', BAR, 'bungkus', 200, 45000, 50], ['teh-oolong', 'Teh oolong', 'g', BAR, 'kaleng', 200, 95000, 50],
  // Dairy and milk
  ['susu-segar', 'Susu segar', 'ml', BARFRIDGE, 'karton', 12000, 230000, 6000], ['susu-oat', 'Susu oat', 'ml', BARFRIDGE, 'karton', 6000, 210000, 3000],
  ['susu-almond', 'Susu almond', 'ml', BARFRIDGE, 'karton', 6000, 230000, 2000], ['susu-kedelai', 'Susu kedelai', 'ml', BARFRIDGE, 'karton', 6000, 120000, 2000],
  ['skm', 'Susu kental manis', 'ml', BAR, 'kaleng', 490, 14000, 1000], ['krimer', 'Krimer', 'g', BAR, 'bungkus', 1000, 55000, 500],
  ['whip-cream', 'Whipping cream', 'ml', BARFRIDGE, 'kotak', 1000, 95000, 1000], ['susu-evap', 'Susu evaporasi', 'ml', BAR, 'kaleng', 380, 18000, 760],
  ['es-krim-vanila', 'Es krim vanila', 'ml', FREEZER, 'ember', 8000, 280000, 2000], ['es-krim-cokelat', 'Es krim cokelat', 'ml', FREEZER, 'ember', 8000, 290000, 2000],
  ['mentega', 'Mentega', 'g', KITCHEN, 'blok', 1000, 120000, 500], ['margarin', 'Margarin', 'g', DRY, 'blok', 2000, 60000, 1000],
  ['keju-cheddar', 'Keju cheddar', 'g', KITCHEN, 'blok', 2000, 190000, 1000], ['keju-mozza', 'Keju mozzarella', 'g', KITCHEN, 'blok', 2000, 230000, 1000],
  ['keju-parmesan', 'Keju parmesan', 'g', KITCHEN, 'blok', 500, 210000, 200], ['krim-kental', 'Krim kental (cooking cream)', 'ml', KITCHEN, 'kotak', 1000, 85000, 1000],
  // Syrups and sweeteners
  ['sirup-vanila', 'Sirup vanila', 'ml', BAR, 'botol', 750, 145000, 750], ['sirup-karamel', 'Sirup karamel', 'ml', BAR, 'botol', 750, 145000, 750],
  ['sirup-hazelnut', 'Sirup hazelnut', 'ml', BAR, 'botol', 750, 145000, 750], ['sirup-aren', 'Sirup gula aren', 'ml', BAR, 'botol', 1000, 65000, 2000],
  ['sirup-pandan', 'Sirup pandan', 'ml', BAR, 'botol', 750, 55000, 750], ['sirup-leci', 'Sirup leci', 'ml', BAR, 'botol', 750, 70000, 750],
  ['sirup-stroberi', 'Sirup stroberi', 'ml', BAR, 'botol', 750, 70000, 750], ['sirup-mint', 'Sirup mint', 'ml', BAR, 'botol', 750, 72000, 750],
  ['sirup-markisa', 'Sirup markisa', 'ml', BAR, 'botol', 750, 68000, 750], ['sirup-butterscotch', 'Sirup butterscotch', 'ml', BAR, 'botol', 750, 150000, 750],
  ['sirup-salted', 'Sirup salted caramel', 'ml', BAR, 'botol', 750, 150000, 750], ['sirup-kayumanis', 'Sirup kayu manis', 'ml', BAR, 'botol', 750, 140000, 750],
  ['gula-pasir', 'Gula pasir', 'g', DRY, 'karung', 50000, 850000, 5000], ['gula-aren', 'Gula aren', 'g', DRY, 'bungkus', 1000, 38000, 1000],
  ['madu', 'Madu', 'ml', BAR, 'botol', 650, 95000, 650], ['selai-cokelat', 'Selai cokelat', 'g', DRY, 'toples', 1000, 75000, 500],
  ['selai-stroberi', 'Selai stroberi', 'g', DRY, 'toples', 1000, 55000, 500], ['soda', 'Air soda', 'ml', BARFRIDGE, 'krat', 7200, 108000, 2400],
  ['tonic', 'Tonic water', 'ml', BARFRIDGE, 'krat', 7200, 168000, 2400], ['air-mineral', 'Air mineral botol 600 ml', 'pcs', DRY, 'dus', 24, 72000, 24],
  ['air-galon', 'Air galon', 'ml', DRY, 'galon', 19000, 22000, 19000],
  // Fruit and herbs
  ['lemon', 'Lemon', 'g', BARFRIDGE, 'kg', 1000, 45000, 1000], ['jeruk-nipis', 'Jeruk nipis', 'g', BARFRIDGE, 'kg', 1000, 25000, 500],
  ['jeruk-peras', 'Jeruk peras', 'g', BARFRIDGE, 'kg', 1000, 22000, 3000], ['mangga', 'Mangga harum manis', 'g', BARFRIDGE, 'kg', 1000, 32000, 2000],
  ['stroberi', 'Stroberi', 'g', BARFRIDGE, 'kotak', 500, 40000, 500], ['pisang', 'Pisang cavendish', 'g', BARFRIDGE, 'sisir', 2000, 35000, 1000],
  ['alpukat', 'Alpukat mentega', 'g', BARFRIDGE, 'kg', 1000, 38000, 2000], ['semangka', 'Semangka', 'g', BARFRIDGE, 'buah', 5000, 40000, 3000],
  ['nanas', 'Nanas madu', 'g', BARFRIDGE, 'buah', 1500, 20000, 1500], ['leci', 'Leci kaleng', 'g', BAR, 'kaleng', 565, 32000, 565],
  ['markisa', 'Markisa', 'g', BARFRIDGE, 'kg', 1000, 30000, 500], ['buah-naga', 'Buah naga', 'g', BARFRIDGE, 'kg', 1000, 28000, 500],
  ['apel', 'Apel fuji', 'g', BARFRIDGE, 'kg', 1000, 42000, 500], ['kiwi', 'Kiwi', 'g', BARFRIDGE, 'kotak', 1000, 65000, 300],
  ['blueberry', 'Blueberry', 'g', FREEZER, 'kotak', 500, 85000, 250], ['jahe', 'Jahe', 'g', KITCHEN, 'kg', 1000, 30000, 300],
  ['serai', 'Serai', 'g', KITCHEN, 'ikat', 250, 5000, 100], ['daun-mint', 'Daun mint', 'g', BARFRIDGE, 'ikat', 100, 8000, 50],
  ['kayu-manis', 'Kayu manis batang', 'g', BAR, 'bungkus', 100, 15000, 30], ['pandan', 'Daun pandan', 'g', KITCHEN, 'ikat', 100, 3000, 50],
  // Ice and packaging
  ['es-batu', 'Es batu kristal', 'g', BARFRIDGE, 'kantong', 10000, 15000, 20000], ['es-serut', 'Es serut', 'g', BARFRIDGE, 'kantong', 5000, 10000, 5000],
  ['gelas-12', 'Gelas plastik 12 oz', 'pcs', PACK, 'slop', 50, 32000, 100], ['gelas-16', 'Gelas plastik 16 oz', 'pcs', PACK, 'slop', 50, 38000, 100],
  ['gelas-22', 'Gelas plastik 22 oz', 'pcs', PACK, 'slop', 50, 45000, 100], ['tutup-datar', 'Tutup gelas datar', 'pcs', PACK, 'slop', 100, 25000, 100],
  ['tutup-dome', 'Tutup gelas dome', 'pcs', PACK, 'slop', 100, 30000, 100], ['sedotan', 'Sedotan kertas', 'pcs', PACK, 'pak', 100, 18000, 100],
  ['sedotan-boba', 'Sedotan boba', 'pcs', PACK, 'pak', 100, 20000, 100], ['cup-panas-8', 'Cup kertas panas 8 oz', 'pcs', PACK, 'slop', 50, 40000, 50],
  ['cup-panas-12', 'Cup kertas panas 12 oz', 'pcs', PACK, 'slop', 50, 48000, 50], ['tutup-panas', 'Tutup cup panas', 'pcs', PACK, 'slop', 100, 35000, 100],
  ['kantong-kertas', 'Kantong kertas takeaway', 'pcs', PACK, 'pak', 100, 65000, 100], ['kotak-makan', 'Kotak makan kertas', 'pcs', PACK, 'pak', 50, 60000, 50],
  ['kotak-burger', 'Kotak burger', 'pcs', PACK, 'pak', 50, 55000, 50], ['tisu', 'Tisu makan', 'pcs', PACK, 'pak', 500, 25000, 500],
  ['sendok-plastik', 'Sendok plastik', 'pcs', PACK, 'pak', 100, 15000, 100], ['garpu-plastik', 'Garpu plastik', 'pcs', PACK, 'pak', 100, 15000, 100],
  ['sumpit', 'Sumpit kayu', 'pcs', PACK, 'pak', 100, 20000, 100], ['cup-saus', 'Cup saus kecil', 'pcs', PACK, 'pak', 100, 12000, 100],
  ['plastik-wrap', 'Plastik wrap', 'g', PACK, 'rol', 1000, 45000, 200],
  // Dry goods
  ['beras', 'Beras pandan wangi', 'g', DRY, 'karung', 25000, 375000, 10000], ['mie-telur', 'Mie telur', 'g', DRY, 'bungkus', 1000, 28000, 2000],
  ['spaghetti', 'Spaghetti', 'g', DRY, 'bungkus', 1000, 32000, 2000], ['fettuccine', 'Fettuccine', 'g', DRY, 'bungkus', 500, 25000, 1000],
  ['penne', 'Penne', 'g', DRY, 'bungkus', 500, 22000, 1000], ['terigu', 'Tepung terigu', 'g', DRY, 'bungkus', 1000, 14000, 2000],
  ['maizena', 'Tepung maizena', 'g', DRY, 'bungkus', 500, 12000, 500], ['panir', 'Tepung roti (panir)', 'g', DRY, 'bungkus', 1000, 30000, 1000],
  ['tepung-bumbu', 'Tepung bumbu', 'g', DRY, 'bungkus', 1000, 26000, 1000], ['garam', 'Garam', 'g', DRY, 'bungkus', 500, 6000, 500],
  ['merica', 'Merica bubuk', 'g', DRY, 'bungkus', 100, 15000, 100], ['kaldu-bubuk', 'Kaldu ayam bubuk', 'g', DRY, 'bungkus', 1000, 65000, 300],
  ['kecap-manis', 'Kecap manis', 'ml', DRY, 'jeriken', 5000, 140000, 2000], ['kecap-asin', 'Kecap asin', 'ml', DRY, 'botol', 600, 22000, 600],
  ['saus-tiram', 'Saus tiram', 'ml', DRY, 'botol', 750, 42000, 750], ['saus-sambal', 'Saus sambal botol', 'ml', DRY, 'jeriken', 5000, 110000, 2000],
  ['saus-tomat', 'Saus tomat', 'ml', DRY, 'jeriken', 5000, 95000, 2000], ['mayones', 'Mayones', 'g', KITCHEN, 'bungkus', 1000, 48000, 1000],
  ['saus-teriyaki', 'Saus teriyaki', 'ml', DRY, 'botol', 1000, 55000, 1000], ['saus-bbq', 'Saus barbeque', 'ml', DRY, 'botol', 1000, 52000, 1000],
  ['minyak', 'Minyak goreng', 'ml', DRY, 'jeriken', 18000, 310000, 5000], ['minyak-wijen', 'Minyak wijen', 'ml', DRY, 'botol', 620, 58000, 300],
  ['minyak-zaitun', 'Minyak zaitun', 'ml', DRY, 'botol', 1000, 145000, 500], ['santan', 'Santan', 'ml', DRY, 'kotak', 1000, 32000, 1000],
  ['oat-flakes', 'Oat flakes', 'g', DRY, 'bungkus', 1000, 55000, 500], ['granola', 'Granola', 'g', DRY, 'bungkus', 1000, 95000, 500],
  ['kacang-tanah', 'Kacang tanah sangrai', 'g', DRY, 'bungkus', 1000, 38000, 500], ['wijen', 'Wijen sangrai', 'g', DRY, 'bungkus', 250, 18000, 100],
  ['boba', 'Boba tapioka', 'g', DRY, 'bungkus', 1000, 42000, 1000], ['jelly', 'Jelly kelapa', 'g', BARFRIDGE, 'toples', 1000, 45000, 500],
  ['kopi-instan', 'Kopi instan', 'g', DRY, 'bungkus', 200, 45000, 100], ['bihun', 'Bihun', 'g', DRY, 'bungkus', 500, 15000, 500],
  ['kerupuk', 'Kerupuk udang mentah', 'g', DRY, 'bungkus', 1000, 70000, 500], ['bumbu-kari', 'Bumbu kari', 'g', DRY, 'bungkus', 500, 40000, 200],
  // Protein
  ['ayam-fillet', 'Ayam fillet dada', 'g', FREEZER, 'kg', 1000, 62000, 5000], ['ayam-utuh', 'Ayam utuh potong 8', 'g', FREEZER, 'ekor', 1200, 48000, 6000],
  ['sapi-giling', 'Daging sapi giling', 'g', FREEZER, 'kg', 1000, 135000, 3000], ['sapi-slice', 'Daging sapi slice', 'g', FREEZER, 'kg', 1000, 155000, 3000],
  ['ikan-dori', 'Ikan dori fillet', 'g', FREEZER, 'kg', 1000, 70000, 2000], ['udang', 'Udang kupas', 'g', FREEZER, 'kg', 1000, 140000, 1000],
  ['cumi', 'Cumi ring', 'g', FREEZER, 'kg', 1000, 95000, 1000], ['telur', 'Telur ayam', 'pcs', KITCHEN, 'tray', 30, 58000, 60],
  ['sosis', 'Sosis sapi', 'pcs', FREEZER, 'bungkus', 20, 75000, 20], ['smoked-beef', 'Smoked beef', 'g', FREEZER, 'bungkus', 500, 95000, 500],
  ['beef-bacon', 'Beef bacon', 'g', FREEZER, 'bungkus', 500, 115000, 500], ['tahu', 'Tahu putih', 'pcs', KITCHEN, 'papan', 50, 40000, 50],
  ['tempe', 'Tempe', 'g', KITCHEN, 'papan', 1000, 18000, 1000], ['kornet', 'Kornet sapi', 'g', DRY, 'kaleng', 340, 38000, 340],
  // Vegetables
  ['bawang-merah', 'Bawang merah', 'g', DRY, 'kg', 1000, 42000, 1000], ['bawang-putih', 'Bawang putih', 'g', DRY, 'kg', 1000, 38000, 1000],
  ['bawang-bombay', 'Bawang bombay', 'g', DRY, 'kg', 1000, 28000, 1000], ['cabai-merah', 'Cabai merah keriting', 'g', KITCHEN, 'kg', 1000, 65000, 500],
  ['cabai-rawit', 'Cabai rawit', 'g', KITCHEN, 'kg', 1000, 80000, 300], ['tomat', 'Tomat', 'g', KITCHEN, 'kg', 1000, 18000, 1000],
  ['selada', 'Selada romaine', 'g', KITCHEN, 'kg', 1000, 45000, 500], ['timun', 'Timun', 'g', KITCHEN, 'kg', 1000, 12000, 500],
  ['wortel', 'Wortel', 'g', KITCHEN, 'kg', 1000, 15000, 500], ['kentang', 'Kentang', 'g', KITCHEN, 'kg', 1000, 20000, 2000],
  ['kol', 'Kol', 'g', KITCHEN, 'kg', 1000, 10000, 500], ['sawi', 'Sawi hijau', 'g', KITCHEN, 'kg', 1000, 14000, 500],
  ['daun-bawang', 'Daun bawang', 'g', KITCHEN, 'ikat', 250, 6000, 100], ['seledri', 'Seledri', 'g', KITCHEN, 'ikat', 100, 4000, 50],
  ['jamur', 'Jamur kancing', 'g', KITCHEN, 'kotak', 500, 35000, 250], ['paprika', 'Paprika merah', 'g', KITCHEN, 'kg', 1000, 70000, 250],
  ['brokoli', 'Brokoli', 'g', KITCHEN, 'kg', 1000, 40000, 250], ['jagung', 'Jagung manis pipil', 'g', FREEZER, 'bungkus', 1000, 30000, 500],
  ['kacang-polong', 'Kacang polong beku', 'g', FREEZER, 'bungkus', 1000, 38000, 500], ['terong', 'Terong ungu', 'g', KITCHEN, 'kg', 1000, 14000, 250],
  ['daun-jeruk', 'Daun jeruk', 'g', KITCHEN, 'ikat', 50, 3000, 20], ['lengkuas', 'Lengkuas', 'g', KITCHEN, 'kg', 1000, 20000, 100],
  ['kunyit', 'Kunyit', 'g', KITCHEN, 'kg', 1000, 22000, 100], ['kemiri', 'Kemiri', 'g', DRY, 'bungkus', 250, 18000, 100],
  ['tauge', 'Tauge', 'g', KITCHEN, 'kg', 1000, 12000, 250], ['bayam', 'Bayam', 'g', KITCHEN, 'ikat', 250, 5000, 100],
  // Bread, frozen and bakery
  ['roti-burger', 'Roti burger', 'pcs', DRY, 'pak', 12, 42000, 24], ['roti-tawar', 'Roti tawar', 'pcs', DRY, 'bungkus', 20, 28000, 20],
  ['roti-brioche', 'Roti brioche', 'pcs', DRY, 'pak', 6, 45000, 12], ['croissant', 'Croissant beku', 'pcs', FREEZER, 'dus', 24, 240000, 12],
  ['adonan-croffle', 'Adonan croffle beku', 'pcs', FREEZER, 'dus', 30, 270000, 15], ['tortilla', 'Tortilla', 'pcs', DRY, 'pak', 12, 50000, 12],
  ['donat', 'Donat beku', 'pcs', FREEZER, 'dus', 24, 150000, 12], ['pisang-kepok', 'Pisang kepok', 'g', DRY, 'sisir', 1500, 25000, 1000],
  ['fries', 'Kentang goreng beku', 'g', FREEZER, 'bungkus', 2500, 95000, 5000], ['onion-ring', 'Onion ring beku', 'g', FREEZER, 'bungkus', 1000, 65000, 1000],
  ['nugget', 'Nugget ayam beku', 'g', FREEZER, 'bungkus', 1000, 70000, 1000], ['dimsum', 'Dimsum ayam beku', 'pcs', FREEZER, 'bungkus', 50, 120000, 50],
  ['cireng', 'Cireng beku', 'pcs', FREEZER, 'bungkus', 50, 45000, 50], ['tahu-bakso', 'Tahu bakso beku', 'pcs', FREEZER, 'bungkus', 30, 60000, 30],
  ['singkong', 'Singkong beku', 'g', FREEZER, 'bungkus', 1000, 25000, 1000], ['brownies', 'Brownies loyang', 'pcs', DRY, 'loyang', 16, 160000, 8],
  ['mochi', 'Mochi es krim', 'pcs', FREEZER, 'dus', 20, 140000, 10],
]
// Prep items made in-house: [id, name, unit, area, station, shelf life in hours, yield per batch, inputs per batch]
type Prep = readonly [string, string, Unit, string, 'kitchen' | 'bar', number, number, readonly (readonly [string, number])[]]
const preps: Prep[] = [
  ['cold-brew', 'Cold brew konsentrat', 'ml', BARFRIDGE, 'bar', 72, 2000, [['kopi-house', 200], ['air-galon', 2200]]],
  ['simple-syrup', 'Simple syrup', 'ml', BARFRIDGE, 'bar', 168, 1500, [['gula-pasir', 1000], ['air-galon', 1000]]],
  ['brown-sugar', 'Brown sugar syrup', 'ml', BARFRIDGE, 'bar', 168, 1200, [['gula-aren', 800], ['air-galon', 600], ['pandan', 20]]],
  ['boba-masak', 'Boba masak', 'g', BARFRIDGE, 'bar', 6, 2500, [['boba', 1000], ['gula-aren', 300], ['air-galon', 3000]]],
  ['sambal-matang', 'Sambal matang', 'g', KITCHEN, 'kitchen', 72, 1500, [['cabai-merah', 800], ['cabai-rawit', 100], ['bawang-merah', 300], ['bawang-putih', 100], ['garam', 20], ['minyak', 300]]],
  ['ayam-ungkep', 'Ayam ungkep (porsi)', 'pcs', KITCHEN, 'kitchen', 48, 20, [['ayam-utuh', 2400], ['bawang-putih', 60], ['kunyit', 40], ['garam', 30], ['serai', 30]]],
  ['nasi-masak', 'Nasi putih masak', 'g', KITCHEN, 'kitchen', 8, 5000, [['beras', 2500], ['air-galon', 3500]]],
  ['saus-keju', 'Saus keju', 'ml', KITCHEN, 'kitchen', 48, 1500, [['keju-cheddar', 400], ['susu-segar', 1000], ['mentega', 100], ['terigu', 60]]],
  ['kaldu-ayam', 'Kaldu ayam', 'ml', KITCHEN, 'kitchen', 48, 4000, [['ayam-utuh', 1200], ['bawang-putih', 50], ['seledri', 30], ['air-galon', 5000]]],
  ['bumbu-nasgor', 'Bumbu nasi goreng', 'g', KITCHEN, 'kitchen', 72, 800, [['bawang-merah', 300], ['bawang-putih', 200], ['cabai-merah', 200], ['kemiri', 50], ['minyak', 100]]],
  ['saus-bolognese', 'Saus bolognese', 'g', KITCHEN, 'kitchen', 48, 3000, [['sapi-giling', 1500], ['tomat', 1200], ['bawang-bombay', 300], ['bawang-putih', 60], ['minyak-zaitun', 100]]],
  ['whipped', 'Whipped cream siap', 'g', BARFRIDGE, 'bar', 24, 900, [['whip-cream', 1000], ['gula-pasir', 80]]],
]
// More of what a lounge keeps, to reach a real store's 250 lines: house brands and spares nobody sells from.
const extras: Row[] = [
  ...['Sabun cuci piring', 'Cairan pembersih lantai', 'Spons cuci', 'Lap microfiber', 'Kantong sampah besar', 'Sarung tangan plastik', 'Hairnet', 'Kertas struk 80 mm', 'Kertas struk 58 mm', 'Tinta printer stempel']
    .map((name, i): Row => [`ops-${i}`, name, 'pcs', 'Gudang', 'pak', 10, 25000 + 1000 * i, 5]),
  ...['Sirup vanila (merek B)', 'Sirup karamel (merek B)', 'Susu segar (merek B)', 'Biji kopi espresso cadangan', 'Gula cair cadangan', 'Krimer cadangan', 'Bubuk cokelat premium', 'Matcha ceremonial', 'Teh hitam premium', 'Susu UHT cokelat']
    .map((name, i): Row => [`alt-${i}`, name, i === 2 || i === 9 ? 'ml' : i === 4 ? 'ml' : 'g', BAR, 'bungkus', 1000, 90000 + 5000 * i, 0]),
  ...Array.from({ length: 16 }, (_, i): Row => [`rempah-${i}`, `Rempah ${['jinten', 'ketumbar', 'pala', 'cengkih', 'kapulaga', 'adas', 'bunga lawang', 'oregano', 'basil kering', 'thyme', 'rosemary', 'paprika bubuk', 'cabai bubuk', 'bawang putih bubuk', 'kari India', 'lada hitam utuh'][i]}`, 'g', DRY, 'toples', 100, 18000 + 800 * i, 20]),
  ...Array.from({ length: 12 }, (_, i): Row => [`saus-${i}`, `Saus ${['pesto', 'carbonara', 'alfredo', 'arrabiata', 'blackpepper', 'mentai', 'gochujang', 'sriracha', 'thousand island', 'honey mustard', 'keju nacho', 'sambal matah botol'][i]}`, 'ml', KITCHEN, 'botol', 1000, 60000 + 2500 * i, 250]),
  ...Array.from({ length: 8 }, (_, i): Row => [`buah-beku-${i}`, `${['Mangga', 'Stroberi', 'Nanas', 'Mixed berry', 'Pisang', 'Alpukat', 'Leci', 'Markisa'][i]} beku`, 'g', FREEZER, 'bungkus', 1000, 45000 + 2000 * i, 500]),
]
// Names that break exports and screens, on spare bahan nobody sells from: the catalog must carry them unchanged.
const odd: Row[] = ADVERSARIAL.slice(0, 11).map((name, i): Row => [`aneh-${i}`, name, 'pcs', i % 2 ? 'Gudang' : '=Area "rak"; 2', 'pak', 10, 1000, 0])
odd.push(['aneh-panjang', longest(100, 'é'), 'g', longest(50, 'a'), longest(30, 'p'), 1000, 50000, 0])

export function stock(): StockItem[] {
  const base: StockItem[] = [...rows, ...extras, ...odd].map(([id, name, unit, area, pack, size, , threshold]) => ({
    id, name, unit, threshold: threshold * T, area, packs: [{ name: pack, qty: size * T }],
    ...(id === 'kopi-house' && { aliases: ['house blend', 'espresso beans'] }), ...(id === 'susu-segar' && { aliases: ['fresh milk', '=susu'] }),
  }))
  const made: StockItem[] = preps.map(([id, name, unit, area, station, shelfLife, output, inputs]) => ({
    id, name, unit, threshold: Math.round(output / 2) * T, area, station, shelfLife,
    production: { inputs: inputs.map(([stockId, qty]) => ({ stockId, qty: qty * T })), output: output * T },
  }))
  return [...base, ...made]
}
// What one pack costs, by stock id, and the pack size in thousandths: purchases buy whole packs.
export const packs = new Map([...rows, ...extras, ...odd].map(([id, , , , name, size, price]) => [id, { name, qty: size * T, price }]))

type Recipe = readonly (readonly [string, number])[]
const r = (recipe: Recipe): Ingredient[] => recipe.map(([stockId, qty]) => ({ stockId, qty: Math.round(qty * T) }))
const has = (recipe: Recipe, id: string) => recipe.find(([s]) => s === id)?.[1] ?? 0
// Option groups built from the drink's own recipe, so a swap or a level removes what the base actually uses.
function drinkOptions(recipe: Recipe, iced: boolean): { groups: OptionGroup[]; modifiers: Modifier[] } {
  const groups: OptionGroup[] = [{ id: 'size', name: 'Ukuran', kind: 'size', required: true }], modifiers: Modifier[] = [
    { id: 'size-reg', name: 'Regular', price: 0, recipe: [], group: 'size', default: true },
    { id: 'size-large', name: 'Large', price: 6000, recipe: r([...recipe.filter(([s]) => s.startsWith('kopi-') || s === 'matcha').map(([s, q]) => [s, q / 2] as const), ...(has(recipe, 'susu-segar') ? [['susu-segar', 60] as const] : []), ...(iced ? [['es-batu', 50] as const, ['gelas-16', -1] as const, ['gelas-22', 1] as const] : [['cup-panas-8', -1] as const, ['cup-panas-12', 1] as const])].filter(([, q]) => q !== 0)), group: 'size' },
  ]
  if (has(recipe, 'susu-segar')) {
    const milk = has(recipe, 'susu-segar')
    groups.push({ id: 'milk', name: 'Susu', kind: 'swap', required: true })
    modifiers.push({ id: 'milk-fresh', name: 'Susu segar', price: 0, recipe: [], group: 'milk', default: true },
      { id: 'milk-oat', name: 'Oat milk', price: 8000, recipe: r([['susu-segar', -milk], ['susu-oat', milk]]), group: 'milk' },
      { id: 'milk-almond', name: 'Almond milk', price: 8000, recipe: r([['susu-segar', -milk], ['susu-almond', milk]]), group: 'milk' })
  }
  const syrup = recipe.find(([s]) => s.startsWith('sirup-') || s === 'simple-syrup' || s === 'brown-sugar')
  if (syrup) {
    groups.push({ id: 'sugar', name: 'Gula', kind: 'level', required: true })
    modifiers.push({ id: 'sugar-normal', name: 'Normal', price: 0, recipe: [], group: 'sugar', default: true },
      { id: 'sugar-less', name: 'Less sugar', price: 0, recipe: r([[syrup[0], -syrup[1] / 2]]), group: 'sugar' },
      { id: 'sugar-none', name: 'Tanpa gula', price: 0, recipe: r([[syrup[0], -syrup[1]]]), group: 'sugar' })
  }
  if (iced) {
    groups.push({ id: 'ice', name: 'Es', kind: 'level' })
    modifiers.push({ id: 'ice-less', name: 'Less ice', price: 0, recipe: r([['es-batu', -has(recipe, 'es-batu') / 2]]), group: 'ice' })
  }
  groups.push({ id: 'extra', name: 'Tambahan', kind: 'add' })
  modifiers.push({ id: 'extra-shot', name: 'Extra shot', price: 6000, recipe: r([['kopi-house', 9]]), group: 'extra' },
    { id: 'extra-vanila', name: 'Sirup vanila', price: 5000, recipe: r([['sirup-vanila', 15]]), group: 'extra' },
    { id: 'extra-boba', name: 'Boba', price: 6000, recipe: r([['boba-masak', 40], ['sedotan-boba', 1]]), group: 'extra' })
  return { groups, modifiers }
}
function foodOptions(recipe: Recipe): { groups: OptionGroup[]; modifiers: Modifier[] } {
  const sambal = has(recipe, 'sambal-matang'), groups: OptionGroup[] = [], modifiers: Modifier[] = []
  if (sambal) {
    groups.push({ id: 'heat', name: 'Pedas', kind: 'level', required: true })
    modifiers.push({ id: 'heat-normal', name: 'Normal', price: 0, recipe: [], group: 'heat', default: true },
      { id: 'heat-none', name: 'Tanpa sambal', price: 0, recipe: r([['sambal-matang', -sambal]]), group: 'heat' },
      { id: 'heat-extra', name: 'Extra pedas', price: 2000, recipe: r([['sambal-matang', sambal], ['cabai-rawit', 5]]), group: 'heat' })
  }
  groups.push({ id: 'extra', name: 'Tambahan', kind: 'add' })
  modifiers.push({ id: 'extra-egg', name: 'Telur ceplok', price: 6000, recipe: r([['telur', 1], ['minyak', 10]]), group: 'extra' },
    { id: 'extra-cheese', name: 'Keju', price: 8000, recipe: r([['keju-mozza', 25]]), group: 'extra' },
    // An add-on with no group and no recipe, as older catalogs have.
    { id: 'extra-kerupuk', name: 'Kerupuk', price: 3000, recipe: [] })
  return { groups, modifiers }
}
// [id, name, category, type (undefined = an older catalog row, typed by its category), price, recipe]
type Dish = readonly [string, string, string, MenuItem['type'] | undefined, number, Recipe]
const ICED = [['es-batu', 150], ['gelas-16', 1], ['tutup-dome', 1], ['sedotan', 1]] as const, HOT = [['cup-panas-8', 1], ['tutup-panas', 1]] as const
const coffee: Dish[] = [
  ['espresso', 'Espresso', 'Kopi', 'beverage', 18000, [['kopi-house', 18], ['cup-panas-8', 1]]],
  ['americano', 'Hot Americano', 'Kopi', 'beverage', 25000, [['kopi-house', 18], ['air-galon', 180], ...HOT]],
  ['americano-iced', 'Iced Americano', 'Kopi', 'beverage', 27000, [['kopi-house', 18], ['air-galon', 120], ...ICED]],
  ['latte', 'Cafe Latte', 'Kopi', 'beverage', 32000, [['kopi-house', 18], ['susu-segar', 180], ...HOT]],
  ['latte-iced', 'Iced Latte', 'Kopi', 'beverage', 34000, [['kopi-house', 18], ['susu-segar', 150], ...ICED]],
  ['cappuccino', 'Cappuccino', 'Kopi', 'beverage', 32000, [['kopi-house', 18], ['susu-segar', 150], ...HOT]],
  ['flat-white', 'Flat White', 'Kopi', 'beverage', 33000, [['kopi-house', 27], ['susu-segar', 120], ...HOT]],
  ['kopsu-aren', 'Kopi Susu Gula Aren', 'Kopi', 'beverage', 28000, [['kopi-house', 18], ['susu-segar', 150], ['sirup-aren', 25], ...ICED]],
  ['kopsu-pandan', 'Kopi Susu Pandan', 'Kopi', 'beverage', 30000, [['kopi-house', 18], ['susu-segar', 150], ['sirup-pandan', 20], ...ICED]],
  ['mocha', 'Iced Mocha', 'Kopi', 'beverage', 36000, [['kopi-house', 18], ['susu-segar', 150], ['cokelat', 20], ['simple-syrup', 10], ...ICED]],
  ['caramel-macchiato', 'Caramel Macchiato', 'Kopi', 'beverage', 38000, [['kopi-house', 18], ['susu-segar', 160], ['sirup-karamel', 20], ...ICED]],
  ['vanilla-latte', 'Vanilla Latte', 'Kopi', 'beverage', 36000, [['kopi-house', 18], ['susu-segar', 150], ['sirup-vanila', 20], ...ICED]],
  ['hazelnut-latte', 'Hazelnut Latte', 'Kopi', 'beverage', 36000, [['kopi-house', 18], ['susu-segar', 150], ['sirup-hazelnut', 20], ...ICED]],
  ['butterscotch-latte', 'Butterscotch Latte', 'Kopi', 'beverage', 38000, [['kopi-house', 18], ['susu-segar', 150], ['sirup-butterscotch', 20], ...ICED]],
  ['salted-latte', 'Salted Caramel Latte', 'Kopi', 'beverage', 38000, [['kopi-house', 18], ['susu-segar', 150], ['sirup-salted', 20], ...ICED]],
  ['affogato', 'Affogato', 'Kopi', 'beverage', 35000, [['kopi-house', 18], ['es-krim-vanila', 100], ['cup-panas-8', 1]]],
  ['cold-brew-black', 'Cold Brew', 'Kopi', 'beverage', 30000, [['cold-brew', 150], ...ICED]],
  ['cold-brew-tonic', 'Cold Brew Tonic', 'Kopi', 'beverage', 35000, [['cold-brew', 90], ['tonic', 120], ['lemon', 10], ...ICED]],
  ['v60-gayo', 'V60 Aceh Gayo', 'Manual brew', 'beverage', 35000, [['kopi-gayo', 15], ['air-galon', 250], ...HOT]],
  ['v60-toraja', 'V60 Toraja', 'Manual brew', 'beverage', 36000, [['kopi-toraja', 15], ['air-galon', 250], ...HOT]],
  ['v60-kintamani', 'V60 Kintamani', 'Manual brew', 'beverage', 35000, [['kopi-kintamani', 15], ['air-galon', 250], ...HOT]],
  ['japanese-iced', 'Japanese Iced Coffee Flores', 'Manual brew', 'beverage', 37000, [['kopi-flores', 18], ['air-galon', 150], ...ICED]],
  ['kopi-tubruk', 'Kopi Tubruk', 'Kopi', 'beverage', 18000, [['kopi-tubruk', 15], ['gula-pasir', 10], ...HOT]],
  ['piccolo', 'Piccolo', 'Kopi', 'beverage', 28000, [['kopi-house', 18], ['susu-segar', 60], ['cup-panas-8', 1]]],
  ['long-black', 'Long Black', 'Kopi', 'beverage', 26000, [['kopi-house', 27], ['air-galon', 120], ...HOT]],
  ['decaf-latte', 'Decaf Latte', 'Kopi', 'beverage', 36000, [['kopi-decaf', 18], ['susu-segar', 150], ...ICED]],
  ['dirty-matcha', 'Dirty Matcha', 'Kopi', 'beverage', 40000, [['matcha', 4], ['kopi-house', 18], ['susu-segar', 150], ['simple-syrup', 15], ...ICED]],
  ['avocado-coffee', 'Avocado Coffee', 'Kopi', 'beverage', 42000, [['alpukat', 120], ['kopi-house', 18], ['skm', 30], ...ICED]],
]
const nonCoffee: Dish[] = [
  ['matcha-latte', 'Matcha Latte', 'Non-kopi', 'beverage', 36000, [['matcha', 5], ['susu-segar', 180], ['simple-syrup', 15], ...ICED]],
  ['chocolate', 'Iced Chocolate', 'Non-kopi', 'beverage', 32000, [['cokelat', 30], ['susu-segar', 180], ['simple-syrup', 10], ...ICED]],
  ['chocolate-hot', 'Hot Chocolate', 'Non-kopi', 'beverage', 30000, [['cokelat', 30], ['susu-segar', 200], ...HOT]],
  ['taro-latte', 'Taro Latte', 'Non-kopi', 'beverage', 32000, [['taro', 30], ['susu-segar', 180], ['simple-syrup', 10], ...ICED]],
  ['red-velvet', 'Red Velvet Latte', 'Non-kopi', 'beverage', 32000, [['red-velvet', 30], ['susu-segar', 180], ['simple-syrup', 10], ...ICED]],
  ['thai-tea', 'Thai Tea', 'Non-kopi', 'beverage', 28000, [['thai-tea', 12], ['skm', 30], ['susu-evap', 30], ...ICED]],
  ['chai-latte', 'Chai Latte', 'Non-kopi', 'beverage', 34000, [['chai', 20], ['susu-segar', 180], ['madu', 10], ...HOT]],
  ['brown-sugar-boba', 'Brown Sugar Boba Milk', 'Non-kopi', 'beverage', 35000, [['brown-sugar', 30], ['boba-masak', 60], ['susu-segar', 200], ['es-batu', 100], ['gelas-22', 1], ['sedotan-boba', 1]]],
]
// The tea and juice rows carry no type: an older catalog, typed by category (Teh → beverage) on both sides.
const tea: Dish[] = [
  ['es-teh', 'Es Teh Manis', 'Teh', undefined, 15000, [['teh-melati', 4], ['simple-syrup', 25], ...ICED]],
  ['teh-panas', 'Teh Panas', 'Teh', undefined, 12000, [['teh-hitam', 4], ['gula-pasir', 10], ...HOT]],
  ['lemon-tea', 'Lemon Tea', 'Teh', undefined, 22000, [['teh-hitam', 4], ['lemon', 20], ['simple-syrup', 20], ...ICED]],
  ['lychee-tea', 'Lychee Tea', 'Teh', undefined, 26000, [['teh-hitam', 4], ['leci', 40], ['sirup-leci', 20], ...ICED]],
  ['earl-grey', 'Earl Grey', 'Teh', undefined, 22000, [['teh-earl', 3], ...HOT]],
  ['jasmine-tea', 'Jasmine Tea', 'Teh', undefined, 20000, [['teh-melati', 3], ...HOT]],
  ['chamomile', 'Chamomile Honey', 'Teh', undefined, 25000, [['teh-chamomile', 2], ['madu', 15], ...HOT]],
  ['teh-tarik', 'Teh Tarik', 'Teh', undefined, 22000, [['teh-hitam', 6], ['skm', 30], ...ICED]],
  ['rosella', 'Rosella Iced Tea', 'Teh', undefined, 22000, [['teh-rosella', 4], ['simple-syrup', 20], ...ICED]],
  ['oolong', 'Oolong Tea', 'Teh', undefined, 24000, [['teh-oolong', 3], ...HOT]],
]
const mocktail: Dish[] = [
  ['mojito', 'Virgin Mojito', 'Mocktail', 'beverage', 30000, [['daun-mint', 5], ['jeruk-nipis', 30], ['sirup-mint', 20], ['soda', 150], ...ICED]],
  ['passion-soda', 'Passion Fruit Soda', 'Mocktail', 'beverage', 30000, [['markisa', 40], ['sirup-markisa', 20], ['soda', 150], ...ICED]],
  ['strawberry-squash', 'Strawberry Squash', 'Mocktail', 'beverage', 30000, [['stroberi', 50], ['sirup-stroberi', 20], ['soda', 150], ...ICED]],
  ['mango-smoothie', 'Mango Smoothie', 'Jus', 'beverage', 32000, [['mangga', 150], ['susu-segar', 80], ['simple-syrup', 15], ['es-batu', 100], ['gelas-22', 1], ['sedotan', 1]]],
  ['jus-jeruk', 'Jus Jeruk', 'Jus', undefined, 25000, [['jeruk-peras', 300], ...ICED]],
  ['jus-semangka', 'Jus Semangka', 'Jus', undefined, 22000, [['semangka', 300], ['simple-syrup', 10], ...ICED]],
  ['lemonade', 'Lemonade', 'Mocktail', 'beverage', 24000, [['lemon', 40], ['simple-syrup', 30], ['air-galon', 150], ...ICED]],
  ['air-mineral', 'Air Mineral', 'Minuman', undefined, 10000, [['air-mineral', 1]]],
]
const SAMBAL = ['sambal-matang', 30] as const, RICE = ['nasi-masak', 200] as const
const food: Dish[] = [
  ['nasgor-ziggy', 'Nasi Goreng Ziggy', 'Makanan', 'food', 55000, [RICE, ['bumbu-nasgor', 40], ['ayam-ungkep', 1], ['telur', 1], ['kecap-manis', 15], SAMBAL, ['kerupuk', 10]]],
  ['nasgor-kampung', 'Nasi Goreng Kampung', 'Makanan', 'food', 42000, [RICE, ['bumbu-nasgor', 40], ['telur', 1], ['kecap-manis', 15], SAMBAL]],
  ['mie-goreng', 'Mie Goreng Jawa', 'Makanan', 'food', 40000, [['mie-telur', 120], ['bumbu-nasgor', 30], ['telur', 1], ['sawi', 30], ['kecap-manis', 20], SAMBAL]],
  ['mie-rebus', 'Mie Rebus', 'Makanan', 'food', 40000, [['mie-telur', 120], ['kaldu-ayam', 300], ['telur', 1], ['sawi', 30]]],
  ['ayam-geprek', 'Nasi Ayam Geprek', 'Makanan', 'food', 45000, [RICE, ['ayam-ungkep', 1], ['tepung-bumbu', 50], ['minyak', 60], SAMBAL, ['timun', 30]]],
  ['ayam-bakar', 'Nasi Ayam Bakar', 'Makanan', 'food', 48000, [RICE, ['ayam-ungkep', 1], ['kecap-manis', 20], SAMBAL, ['selada', 20]]],
  ['teriyaki-bowl', 'Rice Bowl Teriyaki', 'Makanan', 'food', 52000, [RICE, ['ayam-fillet', 150], ['saus-teriyaki', 40], ['wijen', 2], ['brokoli', 40]]],
  ['matah-bowl', 'Rice Bowl Sambal Matah', 'Makanan', 'food', 50000, [RICE, ['ayam-fillet', 150], ['saus-11', 30], ['bawang-merah', 20], ['serai', 5]]],
  ['beef-slice-rice', 'Beef Slice Rice', 'Makanan', 'food', 62000, [RICE, ['sapi-slice', 130], ['bawang-bombay', 30], ['saus-teriyaki', 30], ['telur', 1]]],
  ['katsu', 'Chicken Katsu', 'Makanan', 'food', 55000, [RICE, ['ayam-fillet', 160], ['panir', 40], ['telur', 1], ['minyak', 80], ['kol', 40], ['mayones', 20]]],
  ['spag-bolognese', 'Spaghetti Bolognese', 'Pasta', 'food', 58000, [['spaghetti', 130], ['saus-bolognese', 180], ['keju-parmesan', 10]]],
  ['spag-carbonara', 'Spaghetti Carbonara', 'Pasta', 'food', 60000, [['spaghetti', 130], ['krim-kental', 120], ['beef-bacon', 50], ['telur', 1], ['keju-parmesan', 15]]],
  ['fettuccine-alfredo', 'Fettuccine Alfredo', 'Pasta', 'food', 60000, [['fettuccine', 130], ['krim-kental', 120], ['jamur', 40], ['keju-parmesan', 15], ['mentega', 15]]],
  ['penne-arrabiata', 'Penne Arrabiata', 'Pasta', 'food', 55000, [['penne', 130], ['tomat', 150], ['cabai-rawit', 5], ['bawang-putih', 10], ['minyak-zaitun', 15]]],
  ['aglio-olio', 'Spaghetti Aglio Olio', 'Pasta', 'food', 50000, [['spaghetti', 130], ['bawang-putih', 20], ['cabai-rawit', 5], ['minyak-zaitun', 30], ['udang', 60]]],
  ['beef-burger', 'Beef Burger', 'Makanan', 'food', 68000, [['roti-burger', 1], ['sapi-giling', 150], ['keju-cheddar', 20], ['selada', 15], ['tomat', 30], ['fries', 120], ['kotak-burger', 1]]],
  ['chicken-burger', 'Crispy Chicken Burger', 'Makanan', 'food', 60000, [['roti-burger', 1], ['ayam-fillet', 140], ['tepung-bumbu', 40], ['minyak', 60], ['selada', 15], ['mayones', 20], ['fries', 120], ['kotak-burger', 1]]],
  ['club-sandwich', 'Club Sandwich', 'Makanan', 'food', 55000, [['roti-tawar', 3], ['smoked-beef', 40], ['telur', 1], ['keju-cheddar', 20], ['selada', 15], ['tomat', 30], ['fries', 100]]],
  ['quesadilla', 'Chicken Quesadilla', 'Makanan', 'food', 52000, [['tortilla', 2], ['ayam-fillet', 100], ['keju-mozza', 50], ['paprika', 30], ['saus-10', 20]]],
  ['caesar-salad', 'Caesar Salad', 'Makanan', 'food', 48000, [['selada', 150], ['ayam-fillet', 80], ['keju-parmesan', 15], ['roti-tawar', 1], ['mayones', 30]]],
  ['soto-ayam', 'Soto Ayam', 'Makanan', 'food', 42000, [RICE, ['kaldu-ayam', 350], ['ayam-ungkep', 1], ['bihun', 30], ['tauge', 30], ['telur', 1], SAMBAL]],
  ['fish-chips', 'Fish and Chips', 'Makanan', 'food', 65000, [['ikan-dori', 180], ['terigu', 50], ['minyak', 100], ['fries', 150], ['mayones', 30]]],
  ['big-breakfast', 'Ziggy Big Breakfast', 'Makanan', 'food', 72000, [['telur', 2], ['sosis', 2], ['beef-bacon', 40], ['roti-brioche', 1], ['jamur', 40], ['tomat', 50], ['mentega', 15]]],
  ['omelette', 'Omelette Keju', 'Makanan', 'food', 38000, [['telur', 3], ['keju-cheddar', 25], ['susu-segar', 30], ['mentega', 10], ['roti-tawar', 2]]],
  ['pancake', 'Pancake Madu', 'Dessert', undefined, 40000, [['terigu', 80], ['telur', 1], ['susu-segar', 100], ['mentega', 15], ['madu', 20]]],
  ['french-toast', 'French Toast', 'Dessert', undefined, 42000, [['roti-brioche', 1], ['telur', 1], ['susu-segar', 60], ['mentega', 15], ['es-krim-vanila', 60]]],
  ['udang-tepung', 'Udang Goreng Tepung', 'Makanan', 'food', 58000, [RICE, ['udang', 120], ['tepung-bumbu', 50], ['minyak', 80], SAMBAL]],
  ['cumi-goreng', 'Cumi Goreng Mentega', 'Makanan', 'food', 56000, [RICE, ['cumi', 140], ['mentega', 25], ['bawang-bombay', 30], ['kecap-manis', 15]]],
  ['nasi-putih', 'Nasi Putih', 'Tambahan', undefined, 8000, [RICE]],
  ['telur-ceplok', 'Telur Ceplok', 'Tambahan', undefined, 6000, [['telur', 1], ['minyak', 10]]],
]
const snacks: Dish[] = [
  ['fries', 'French Fries', 'Camilan', undefined, 28000, [['fries', 180], ['minyak', 40], ['saus-tomat', 30], ['cup-saus', 1]]],
  ['cheese-fries', 'Cheese Fries', 'Camilan', 'snack', 35000, [['fries', 180], ['minyak', 40], ['saus-keju', 60]]],
  ['onion-rings', 'Onion Rings', 'Camilan', 'snack', 30000, [['onion-ring', 150], ['minyak', 40], ['saus-tomat', 30]]],
  ['mendoan', 'Tempe Mendoan', 'Camilan', 'snack', 25000, [['tempe', 150], ['tepung-bumbu', 50], ['minyak', 50], ['kecap-manis', 15], ['cabai-rawit', 3]]],
  ['tahu-crispy', 'Tahu Crispy', 'Camilan', 'snack', 25000, [['tahu', 4], ['tepung-bumbu', 40], ['minyak', 50]]],
  ['cireng', 'Cireng Rujak', 'Camilan', 'snack', 25000, [['cireng', 6], ['minyak', 40], ['gula-aren', 20], ['cabai-rawit', 3]]],
  ['dimsum', 'Dimsum Ayam', 'Camilan', 'snack', 32000, [['dimsum', 4], ['saus-6', 15]]],
  ['nugget', 'Chicken Nugget', 'Camilan', 'snack', 30000, [['nugget', 150], ['minyak', 40], ['saus-tomat', 30]]],
  ['pisgor', 'Pisang Goreng Keju', 'Camilan', 'snack', 28000, [['pisang-kepok', 200], ['terigu', 40], ['minyak', 50], ['keju-cheddar', 20], ['skm', 20]]],
  ['roti-bakar', 'Roti Bakar Cokelat', 'Camilan', 'snack', 26000, [['roti-tawar', 2], ['mentega', 15], ['selai-cokelat', 30], ['skm', 15]]],
  ['croffle', 'Croffle Original', 'Camilan', 'snack', 30000, [['adonan-croffle', 1], ['gula-pasir', 10], ['whipped', 20]]],
  ['croffle-choco', 'Croffle Cokelat', 'Camilan', 'snack', 35000, [['adonan-croffle', 1], ['selai-cokelat', 30], ['whipped', 20]]],
  ['donat', 'Donat Gula', 'Camilan', 'snack', 15000, [['donat', 1], ['gula-pasir', 10]]],
  ['singkong', 'Singkong Goreng', 'Camilan', 'snack', 22000, [['singkong', 200], ['minyak', 40], ['garam', 2]]],
  ['tahu-bakso', 'Tahu Bakso', 'Camilan', 'snack', 26000, [['tahu-bakso', 4], ['minyak', 40], ['saus-sambal', 20]]],
  ['platter', 'Ziggy Mix Platter', 'Camilan', 'snack', 65000, [['fries', 120], ['onion-ring', 80], ['nugget', 80], ['cireng', 3], ['minyak', 80], ['saus-tomat', 40]]],
  ['sosis-bakar', 'Sosis Bakar', 'Camilan', 'snack', 28000, [['sosis', 2], ['saus-bbq', 20]]],
  ['es-krim', 'Es Krim Dua Rasa', 'Dessert', 'snack', 25000, [['es-krim-vanila', 80], ['es-krim-cokelat', 80]]],
  ['brownies', 'Brownies Ice Cream', 'Dessert', 'snack', 35000, [['brownies', 1], ['es-krim-vanila', 70]]],
  ['mochi', 'Mochi Es Krim', 'Dessert', 'snack', 25000, [['mochi', 2]]],
]
// Items made for the adversarial pass: names, tags and options that read as formulas, markup and line breaks, and one
// at every limit the server sets. One never sells, so the manager can remove it.
const oddMenu: Dish[] = [
  ['aneh-formula', '=HYPERLINK("http://x";"klik")', '+Kategori;"aneh"', 'snack', 1000, [['tisu', 1]]],
  ['aneh-html', '<script>alert("x")</script> & co', '<b>Camilan</b>', 'snack', 2000, [['tisu', 1]]],
  ['aneh-baris', 'Menu\nberbaris\r\ndua', '@Kategori', 'beverage', 3000, [['air-mineral', 1]]],
  ['aneh-panjang', longest(100, 'ü'), longest(50, 'k'), 'food', 4000, [['telur', 1]]],
  ['aneh-emoji', 'Es 🍹 spesial 👨‍🍳', 'Minuman 🍸', undefined, 5000, [['es-batu', 100], ['gelas-12', 1]]],
  ['aneh-belum-laku', 'Menu uji (hapus)', 'Uji', 'food', 7000, [['telur', 1]]],
]
export function menu(): MenuItem[] {
  const items: MenuItem[] = []
  for (const [list, drink] of [[coffee, true], [nonCoffee, true], [tea, true], [mocktail, true], [food, false], [snacks, false], [oddMenu, false]] as const) {
    for (const [id, name, category, type, price, recipe] of list) {
      const iced = recipe.some(([s]) => s === 'es-batu'), options = drink && type !== 'snack' && id !== 'espresso' && id !== 'air-mineral' ? drinkOptions(recipe, iced) : !drink && list !== oddMenu && type !== 'snack' && category !== 'Tambahan' ? foodOptions(recipe) : { groups: [], modifiers: [] }
      items.push({
        id, name, category, price, active: true, soldOut: false, favorite: items.length % 9 === 0, version: 1, recipe: r(recipe), ...options,
        ...(type && { type }), ...(type === 'beverage' && list !== oddMenu && { station: 'bar' as const }),
        ...(id === 'americano-iced' && { tags: ['kopi', 'signature', '=tag'], aliases: ['es americano', 'iced amer'] }),
        ...(id === 'aneh-formula' && { tags: ['-1+1', '@tag', '"kutip"'], aliases: ['=alias', 'baris\nbaru'] }),
        ...(id === 'aneh-panjang' && { tags: Array.from({ length: 20 }, (_, i) => longest(50, String.fromCharCode(97 + i))) }),
      })
    }
  }
  // Group and option names at their limits, on an item that also sells.
  const odd = items.find((m) => m.id === 'aneh-emoji')!
  odd.groups = [{ id: 'g-' + longest(10, 'z'), name: longest(50, 'g'), kind: 'add' }]
  odd.modifiers = [{ id: 'm-1', name: longest(100, 'm'), price: 1000, recipe: r([['es-batu', 10]]), group: odd.groups[0].id }, { id: 'm-2', name: '=1+1 "opsi"; baru\nbaris', price: 0, recipe: [], group: odd.groups[0].id }]
  return items
}

export const EDCS = ['BCA', 'BRI', 'Mandiri']
// Ziggy: PB1 10% and a 5% service charge, cash and three EDC machines, the pilot's settings otherwise. The business day
// turns at 04:00 in Jakarta. Saved discounts: a happy hour on drinks, a voucher that needs a manager's PIN, a promo on
// chosen items, one that has ended and one that has not started.
export function settings(name: string, goLive: string, days: string[]): Settings {
  const first = days[0], last = days[days.length - 1]
  const discounts: Discount[] = [
    { id: 'happy-hour', name: 'Happy hour minuman 20%', note: '15.00–17.00', kind: 'percent', value: 20, scope: 'beverage', from: first, to: last },
    { id: 'voucher-25', name: 'Voucher Rp25.000', note: 'min. Rp100.000', kind: 'amount', value: 25000, scope: 'order', from: first, to: last, minSpend: 100000, approval: true },
    { id: 'croffle-promo', name: 'Promo croffle 50%', note: '=promo; "croffle"', kind: 'percent', value: 50, scope: 'items', items: ['croffle', 'croffle-choco'], from: first, to: last },
    { id: 'makan-10', name: 'Diskon makanan 10%', note: '', kind: 'percent', value: 10, scope: 'food', from: first, to: last },
    { id: 'camilan-5k', name: 'Camilan hemat Rp5.000', note: '@camilan', kind: 'amount', value: 5000, scope: 'snack', from: first, to: last },
    { id: 'ended', name: 'Promo lama (berhenti)', note: '', kind: 'percent', value: 30, scope: 'order', from: first, to: last, ended: true },
    { id: 'future', name: 'Promo tahun baru', note: '', kind: 'percent', value: 15, scope: 'order', from: '2027-01-01', to: '2027-01-07' },
  ]
  return {
    id: 'settings', appName: 'Takar', name, address: 'Jl. Kemang Raya No. 8, Jakarta Selatan', phone: '+62 21 555 0101', footer: 'Terima kasih, sampai jumpa lagi!\n=Instagram @ziggy', timezone: 'Asia/Jakarta', cutoff: 4,
    taxBps: 1000, serviceBps: 500, receiptWidth: 80, printableWidth: 72, goLive, packaging: [{ stockId: 'kantong-kertas', qty: 1000 }],
    stations: { kitchen: 15, bar: 8 }, varianceLimit: 10000, lowAt: 5, stationTablets: false, cashless: false, edcs: EDCS, lockMinutes: 2,
    complimentBudget: 3_000_000, family: ['Ibu Linda', 'Kevin'], discounts, tagline: 'Kemang',
  }
}

export type Person = { key: string; name: string; role: Role }
// Everyone a lounge needs, every role once at least. Names a spreadsheet would run, and the longest one the server takes.
export const ZIGGY_STAFF: Person[] = [
  { key: 'owner', name: 'Christopher (Pemilik)', role: 'owner' }, { key: 'manager', name: 'Toper', role: 'manager' },
  { key: 'admin', name: 'Rina Admin', role: 'admin' }, { key: 'chef', name: 'Chef Bayu', role: 'chef' },
  { key: 'siti', name: 'Siti', role: 'cashier' }, { key: 'dewi', name: '=Dewi "kasir"; 2', role: 'cashier' },
  { key: 'raka', name: 'Raka Barista', role: 'barista' }, { key: 'joko', name: 'Joko Dapur', role: 'kitchen' },
  { key: 'maya', name: 'Maya Akuntan', role: 'accountant' },
]
export const DAGO_STAFF: Person[] = [
  { key: 'owner2', name: 'Pemilik Dago', role: 'owner' }, { key: 'manager2', name: 'Manajer Dago', role: 'manager' },
  { key: 'kasir2', name: longest(100, 'k'), role: 'cashier' }, { key: 'barista2', name: 'Barista Dago', role: 'barista' },
  { key: 'dapur2', name: 'Dapur Dago', role: 'kitchen' },
]
export const PIN = { owner: '271828', manager: '314159', admin: '161803', owner2: '141421', manager2: '173205' } as Record<string, string>
