import type { MenuItem, Settings, StockItem } from './types'
export const defaultSettings:Settings={id:'settings',appName:'Meja',name:'Warung Daun',address:'Jl. Melati No. 12, Bandung',phone:'',footer:'Terima kasih. Sampai makan lagi!',timezone:'Asia/Jakarta',cutoff:4,taxBps:0,serviceBps:0,receiptWidth:80,printableWidth:72,goLive:new Date().toISOString().slice(0,10),packaging:[]}
export const stock:StockItem[]=[{id:'rice',name:'Beras',unit:'g',threshold:3000000},{id:'chicken',name:'Ayam ungkep (porsi)',unit:'pcs',threshold:10000},{id:'egg',name:'Telur',unit:'pcs',threshold:10000},{id:'tea',name:'Teh (porsi)',unit:'pcs',threshold:10000},{id:'water',name:'Air mineral botol',unit:'pcs',threshold:12000},{id:'box',name:'Kotak bungkus',unit:'pcs',threshold:20000}]
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
export const sampleMenu:MenuItem[]=raw.map(([id,name,category,price,favorite,recipe,modifiers])=>({id,name,category,price,favorite,recipe,modifiers,active:true,soldOut:false,version:1}))
