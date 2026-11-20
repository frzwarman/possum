import { describe, expect, it } from 'vitest'
import { crc32 as nodeCrc } from 'node:zlib'
import { crc32, workbook, zip } from '../../src/lib/xlsx'

// Reads the zip back from its end record and directory, the way Excel does.
function unzip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer), text = new TextDecoder(), end = bytes.length - 22, files = new Map<string, string>()
  expect(view.getUint32(end, true)).toBe(0x06054b50)
  let at = view.getUint32(end + 16, true)
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50)
    const size = view.getUint32(at + 24, true), nameLength = view.getUint16(at + 28, true), local = view.getUint32(at + 42, true), name = text.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    expect(view.getUint32(local, true)).toBe(0x04034b50)
    const data = bytes.subarray(local + 30 + nameLength, local + 30 + nameLength + size)
    expect(view.getUint32(at + 16, true)).toBe(nodeCrc(data))
    files.set(name, text.decode(data))
    at += 46 + nameLength
  }
  return files
}

describe('xlsx', () => {
  it('computes the checksum zip readers expect', () => {
    const data = new TextEncoder().encode('Takar · Rp12.000')
    expect(crc32(data)).toBe(nodeCrc(data))
  })
  it('stores files a zip reader finds again, with non-ASCII names and content intact', () => {
    expect([...unzip(zip([['a/é.xml', '<x>Rp1.000 · ✓</x>'], ['b.txt', '']]))]).toEqual([['a/é.xml', '<x>Rp1.000 · ✓</x>'], ['b.txt', '']])
  })
  it('writes one sheet per table with numbers as numbers and text escaped', () => {
    const files = unzip(workbook([
      { name: 'Sif & kas', formats: ['text', 'int', 'dec', 'pct'], bold: [2], rows: [['Pos', 'Jumlah', 'Qty', 'Margin'], ['Bahan <A> & "B"', 12000, 1.5, 0.25], ['Jumlah', -500, '', '']] },
      { name: 'Jurnal: [2026/11]', formats: ['text'], rows: [['Tanggal']] },
      { name: 'sif & kas', formats: ['text'], rows: [['x']] },
    ]))
    expect([...files.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml'])
    expect(files.get('xl/workbook.xml')).toContain('<sheet name="Sif &amp; kas" sheetId="1" r:id="rId1"/><sheet name="Jurnal   2026 11" sheetId="2" r:id="rId2"/><sheet name="sif &amp; kas 3" sheetId="3" r:id="rId3"/>')
    const sheet = files.get('xl/worksheets/sheet1.xml')!
    expect(sheet).toContain('<c r="A1" s="4" t="inlineStr"><is><t xml:space="preserve">Pos</t></is></c>')
    expect(sheet).toContain('<c r="A2" s="0" t="inlineStr"><is><t xml:space="preserve">Bahan &lt;A&gt; &amp; &quot;B&quot;</t></is></c><c r="B2" s="1"><v>12000</v></c><c r="C2" s="2"><v>1.5</v></c><c r="D2" s="3"><v>0.25</v></c>')
    expect(sheet).toContain('<row r="3"><c r="A3" s="4" t="inlineStr"><is><t xml:space="preserve">Jumlah</t></is></c><c r="B3" s="5"><v>-500</v></c></row>')
  })
})
