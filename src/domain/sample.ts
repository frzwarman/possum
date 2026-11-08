import type { MenuItem,Modifier,OptionGroup,Settings,StockItem,Transfer } from './types'
export const defaultSettings:Settings={id:'settings',appName:'Takar',name:'Ziggy Lounge (demo)',address:'Jl. Sekolah No. 1, Jakarta',phone:'',footer:'Terima kasih. Sampai makan lagi!',timezone:'Asia/Jakarta',cutoff:4,taxBps:0,serviceBps:0,receiptWidth:80,printableWidth:72,goLive:new Date().toISOString().slice(0,10),packaging:[],stations:{kitchen:15,bar:8},varianceLimit:10000,lowAt:5,stationTablets:true}
// The demo has one other outlet and something already on its way, so receiving a transfer can be tried.
export const demoOutlet={id:'demo-dago',name:'Cabang Dago (demo)'}
export const demoTransfer=(to:string,toName:string,sentAt:string):Transfer=>({id:'demo-transfer-1',number:'TR-DEMO0001',from:demoOutlet.id,fromName:demoOutlet.name,to,toName,note:'Contoh kiriman dari cabang lain',status:'sent',sentAt,lines:[{stockId:'rice',name:'Beras',unit:'g',qty:5_000_000,value:75000},{stockId:'egg',name:'Telur',unit:'pcs',qty:30_000,value:60000}]})
// Ingredients are bought in packs and stocked in g, ml or pcs; prep items (ayam ungkep, sambal) are
// made in batches from them and sold by the portion. Areas are where a count walks.
// Demo pictures: Unsplash photos, hotlinked and resized by their CDN (Unsplash licence allows this); the service
// worker caches them so the demo keeps its pictures offline. Keyed by menu or ingredient id.
const PHOTO:Record<string,string>={'nasi-goreng':'1661830948845-1eb54cd9e1fd','ayam-bakar':'1605908580297-f3e1c02e64ff','ayam-penyet':'1645066803665-d16a79a21566','mie-goreng':'1612929633738-8fe44f7ec841','soto':'1737588462384-7bdfb17ddcd2','gado':'1593175217181-eddfe4c48e10','nasi':'1689039234540-d335a43ca28a','tempe':'1707280619402-7ec87ead9841','kentang':'1518013431117-eb1465fa5752','es-teh':'1630248904474-a7927610a5db','jeruk':'1618046364546-81e9d03d39a6','air':'1550505095-81378a674395','americano-hot':'1514432324607-a09d9b4aefdd','americano-iced':'1531835207745-506a1bc035d8','matcha-latte':'1582785513054-8d1bf9d69c1a','ziggy-fried-rice':'1637759079728-3f900db7a782','rice':'1686820740687-426a7b9b2043','chicken':'1694579740719-0e601c5d2437','egg':'1613900050733-09d5dc8b36de','tea':'1766232574096-4c4380105cc7','water':'1616118132534-381148898bb4','box':'1615887087343-6a32f45f27a4','raw-chicken':'1763517174823-61148e142c8e','garlic':'1767978647808-194c1e08c8fa','palm-sugar':'1663101387440-5a42fe9e51a1','salt':'1621315892013-f32af7358947','chili':'1526346698789-22fd84314424','shallot':'1639176267141-2ff48087e1be','sambal-matang':'1689997065743-7585a0a9e2fa','coffee':'1511920170033-f8396924c348','matcha':'1771405317898-26a2e16df5fb','milk':'1553301803-768cd4a59b9c','oat':'1760445528802-3761d3c1b1ae','syrup':'1718210719980-1f159546aeb2','ice':'1758001969632-c67b15c89f1f','cup22':'1521913728990-c534455c5454','cup16':'1769859725562-94ce3321e039'}
export const photo=(id:string)=>PHOTO[id]?`https://images.unsplash.com/photo-${PHOTO[id]}?auto=format&fit=crop&w=480&h=360&q=70`:undefined
const stockRaw:StockItem[]=[
 {id:'rice',name:'Beras',unit:'g',threshold:3000000,area:'Dry store',packs:[{name:'karung',qty:25_000_000}],aliases:['nasi']},
 {id:'chicken',name:'Ayam ungkep (porsi)',unit:'pcs',threshold:10000,area:'Kulkas dapur',station:'kitchen',shelfLife:48,production:{inputs:[{stockId:'raw-chicken',qty:2_000_000},{stockId:'garlic',qty:40_000},{stockId:'palm-sugar',qty:20_000},{stockId:'salt',qty:15_000}],output:20_000}},
 {id:'egg',name:'Telur',unit:'pcs',threshold:10000,area:'Kulkas dapur',packs:[{name:'tray',qty:30_000}]},
 {id:'tea',name:'Teh (porsi)',unit:'pcs',threshold:10000,area:'Rak bar'},
 {id:'water',name:'Air mineral botol',unit:'pcs',threshold:12000,area:'Dry store',packs:[{name:'dus',qty:24_000}]},
 {id:'box',name:'Kotak bungkus',unit:'pcs',threshold:20000,area:'Dry store',packs:[{name:'ikat',qty:50_000}]},
 {id:'raw-chicken',name:'Ayam mentah',unit:'g',threshold:2_000_000,area:'Freezer',packs:[{name:'ekor',qty:1_200_000}]},
 {id:'garlic',name:'Bawang putih',unit:'g',threshold:200_000,area:'Dry store'},
 {id:'palm-sugar',name:'Gula merah',unit:'g',threshold:200_000,area:'Dry store'},
 {id:'salt',name:'Garam',unit:'g',threshold:200_000,area:'Dry store'},
 {id:'chili',name:'Cabai merah',unit:'g',threshold:300_000,area:'Kulkas dapur'},
 {id:'shallot',name:'Bawang merah',unit:'g',threshold:300_000,area:'Dry store'},
 {id:'sambal-matang',name:'Sambal (porsi)',unit:'pcs',threshold:10_000,area:'Kulkas dapur',station:'kitchen',shelfLife:72,production:{inputs:[{stockId:'chili',qty:500_000},{stockId:'shallot',qty:100_000},{stockId:'salt',qty:10_000}],output:20_000}},
 {id:'coffee',name:'Biji kopi',unit:'g',threshold:500_000,area:'Rak bar',packs:[{name:'bungkus',qty:1_000_000}],aliases:['kopi']},
 {id:'matcha',name:'Bubuk matcha',unit:'g',threshold:200_000,area:'Rak bar',packs:[{name:'kaleng',qty:100_000}]},
 {id:'milk',name:'Susu segar',unit:'ml',threshold:4_000_000,area:'Kulkas bar',packs:[{name:'karton',qty:12_000_000}],aliases:['fresh milk']},
 {id:'oat',name:'Susu oat',unit:'ml',threshold:2_000_000,area:'Kulkas bar',packs:[{name:'karton',qty:6_000_000}],aliases:['oat milk']},
 {id:'syrup',name:'Sirup gula',unit:'ml',threshold:1_000_000,area:'Rak bar',packs:[{name:'botol',qty:1_000_000}],aliases:['cane syrup']},
 {id:'ice',name:'Es batu',unit:'g',threshold:2_000_000,area:'Kulkas bar',packs:[{name:'kantong',qty:5_000_000}]},
 {id:'cup22',name:'Gelas 22 oz + tutup + sedotan',unit:'pcs',threshold:50_000,area:'Dry store',packs:[{name:'slop',qty:50_000}]},
 {id:'cup16',name:'Gelas 16 oz + tutup',unit:'pcs',threshold:50_000,area:'Dry store',packs:[{name:'slop',qty:50_000}]},
]
export const stock:StockItem[]=stockRaw.map(s=>({...s,photo:photo(s.id)}))
const egg={id:'extra-egg',name:'Tambah telur',price:5000,recipe:[{stockId:'egg',qty:1000}]}
const raw:Array<[string,string,string,number,boolean,MenuItem['recipe'],MenuItem['modifiers']]>=[
 ['nasi-goreng','Nasi goreng kampung','Makanan',25000,true,[{stockId:'rice',qty:100000}],[egg]],
 ['ayam-bakar','Ayam bakar madu','Makanan',32000,true,[{stockId:'chicken',qty:1000}],[egg]],
 ['ayam-penyet','Ayam penyet sambal ijo','Makanan',30000,true,[{stockId:'chicken',qty:1000}],[egg]],
 ['mie-goreng','Mie goreng Jawa','Makanan',23000,false,[],[egg]],
 ['soto','Soto ayam','Makanan',24000,false,[{stockId:'chicken',qty:1000}],[]],
 ['gado','Gado-gado','Makanan',22000,false,[],[]],
 ['nasi','Nasi putih','Tambahan',6000,true,[{stockId:'rice',qty:80000}],[]],
 ['tempe','Tempe mendoan','Tambahan',12000,false,[],[]],
 ['kentang','Kentang goreng','Tambahan',15000,false,[],[]],
 ['es-teh','Es teh manis','Minuman',6000,true,[{stockId:'tea',qty:1000}],[]],
 ['jeruk','Es jeruk peras','Minuman',10000,true,[],[]],
 ['air','Air mineral','Minuman',5000,false,[{stockId:'water',qty:1000}],[]]
]
// Takar showcase: option groups that move stock. A swap carries a negative delta for what it
// replaces; a level only removes; a size adds the extra amounts and the bigger cup.
const groups:OptionGroup[]=[{id:'size',name:'Ukuran',kind:'size',required:true},{id:'milk',name:'Susu',kind:'swap',required:true},{id:'sugar',name:'Gula',kind:'level',required:true},{id:'extra',name:'Tambahan',kind:'add'}]
const matchaOptions:Modifier[]=[
 {id:'size-regular',name:'Regular',price:0,recipe:[],group:'size',default:true},
 {id:'size-large',name:'Large',price:5000,recipe:[{stockId:'matcha',qty:2000},{stockId:'milk',qty:60000},{stockId:'ice',qty:50000}],group:'size'},
 {id:'milk-fresh',name:'Susu segar',price:0,recipe:[],group:'milk',default:true},
 {id:'milk-oat',name:'Oat milk',price:5000,recipe:[{stockId:'milk',qty:-195000},{stockId:'oat',qty:195000}],group:'milk'},
 {id:'sugar-normal',name:'Normal',price:0,recipe:[],group:'sugar',default:true},
 {id:'sugar-less',name:'Less sugar',price:0,recipe:[{stockId:'syrup',qty:-8000}],group:'sugar'},
 {id:'sugar-none',name:'Tanpa gula',price:0,recipe:[{stockId:'syrup',qty:-16000}],group:'sugar'},
 {id:'extra-shot',name:'Extra matcha',price:7000,recipe:[{stockId:'matcha',qty:3000}],group:'extra'},
]
const takar:MenuItem[]=[
 {id:'americano-hot',name:'Hot Americano',category:'Minuman',type:'beverage',station:'bar',tags:['kopi'],aliases:['americano panas','kopi hitam'],price:22000,favorite:true,active:true,soldOut:false,version:1,recipe:[{stockId:'coffee',qty:18000},{stockId:'cup16',qty:1000}],modifiers:[]},
 {id:'americano-iced',name:'Iced Americano',category:'Minuman',type:'beverage',station:'bar',tags:['kopi','signature'],aliases:['es americano'],price:25000,favorite:true,active:true,soldOut:false,version:1,recipe:[{stockId:'coffee',qty:18000},{stockId:'ice',qty:150000},{stockId:'cup22',qty:1000}],modifiers:[]},
 {id:'matcha-latte',name:'Ice Matcha Latte',category:'Minuman',type:'beverage',station:'bar',tags:['signature'],aliases:['es matcha'],price:32000,favorite:true,active:true,soldOut:false,version:1,recipe:[{stockId:'matcha',qty:5000},{stockId:'milk',qty:195000},{stockId:'syrup',qty:16000},{stockId:'ice',qty:200000},{stockId:'cup22',qty:1000}],groups,modifiers:matchaOptions},
 {id:'ziggy-fried-rice',name:'Ziggy Fried Rice',category:'Makanan',type:'food',station:'kitchen',tags:['signature'],aliases:['nasi goreng ziggy'],price:38000,favorite:true,active:true,soldOut:false,version:1,recipe:[{stockId:'rice',qty:150000},{stockId:'chicken',qty:1000},{stockId:'sambal-matang',qty:1000},{stockId:'egg',qty:1000}],groups:[{id:'heat',name:'Pedas',kind:'level',required:true},{id:'extra',name:'Tambahan',kind:'add'}],modifiers:[{id:'heat-normal',name:'Normal',price:0,recipe:[],group:'heat',default:true},{id:'heat-none',name:'Tanpa sambal',price:0,recipe:[{stockId:'sambal-matang',qty:-1000}],group:'heat'},{id:'heat-extra',name:'Extra pedas',price:2000,recipe:[{stockId:'sambal-matang',qty:1000}],group:'heat'},{...egg,group:'extra'}]},
]
export const sampleMenu:MenuItem[]=[...raw.map(([id,name,category,price,favorite,recipe,modifiers])=>({id,name,category,price,favorite,recipe,modifiers,active:true,soldOut:false,version:1})),...takar].map(m=>({...m,photo:photo(m.id)}))
