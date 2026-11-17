import { convert } from './calculate'
import type { StockItem } from './types'
// What the counter typed for one item (Figma C10): full packs per pack, plus what is left in the open one.
export type Entry={packs:Record<string,string>;loose:string;big:boolean}
export const blank:Entry={packs:{},loose:'',big:false}
export const BIG:Record<string,string>={g:'kg',ml:'l'}
// A box left empty is not counted; 0 is a count of nothing. Throws the conversion's own message on a bad number.
// Shared with the Takar Stok phone app (mobile/), so a count typed there adds up exactly as it does here.
export function measure(s:Pick<StockItem,'unit'|'packs'>,e:Entry){const parts=[...(s.packs??[]).map(p=>[e.packs[p.name]??'',p.name] as [string,string]),[e.loose,e.big?BIG[s.unit]:s.unit] as [string,string]].map(([a,u])=>[a.trim().replace(/[.,]$/,''),u] as [string,string]).filter(([a])=>a)
 return parts.length?parts.reduce((n,[a,u])=>n+(Number(a.replace(',','.'))===0?0:convert(a,u,s.unit,s.packs)),0):undefined}
