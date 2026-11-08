import { describe, expect, it } from 'vitest'
import { search } from '../../src/domain/calculate'
// POS-1: "amer" and "amricano" both find the Americanos; aliases and tags count; no category needed.
const items=[
 {name:'Hot Americano',aliases:['americano panas'],tags:['kopi']},
 {name:'Iced Americano',aliases:[],tags:['kopi','signature']},
 {name:'Ziggy Fried Rice',aliases:['nasi goreng'],tags:['signature']},
 {name:'Es Teh',aliases:[],tags:[]},
]
const names=(q:string)=>search(items,q).map(i=>i.name)
describe('search()',()=>{
 it('matches the start of any word',()=>{expect(names('amer')).toEqual(['Hot Americano','Iced Americano'])})
 it('tolerates a typo',()=>{expect(names('amricano')).toEqual(['Hot Americano','Iced Americano'])})
 it('matches an alias',()=>{expect(names('nasi')).toEqual(['Ziggy Fried Rice'])})
 it('matches a tag',()=>{expect(names('signature')).toEqual(['Iced Americano','Ziggy Fried Rice'])})
 it('returns everything for an empty query',()=>{expect(names('  ')).toHaveLength(4)})
 it('ignores case and accents',()=>{expect(names('ÉS TEH')).toEqual(['Es Teh'])})
 it('needs every word of a two-word query',()=>{expect(names('iced amer')).toEqual(['Iced Americano'])})
})
