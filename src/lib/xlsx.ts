// An Excel workbook written by hand: an .xlsx file is a zip of a few small XML files, so the accounting export needs
// no library. One sheet per table, the first row a frozen bold header, numbers as numbers so Excel can add them up.
// ponytail: the zip is stored without compression; switch to CompressionStream('deflate-raw') if a year of journal
// lines makes the file heavy.
export type Format = "text" | "int" | "dec" | "pct";
export interface XSheet { name: string; rows: (string | number)[][]; formats: Format[]; bold?: number[] }
const FORMATS: Format[] = ["text", "int", "dec", "pct"];
const esc = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const column = (i: number): string => (i < 26 ? "" : column(Math.floor(i / 26) - 1)) + String.fromCharCode(65 + (i % 26));
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n', MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main", REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships", PKG = "http://schemas.openxmlformats.org/package/2006";
const TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml";

function sheetXml(s: XSheet) {
  const bold = new Set([0, ...(s.bold ?? [])]), widths = s.rows[0]?.map((_, c) => Math.min(60, Math.max(8, ...s.rows.slice(0, 200).map((r) => String(r[c] ?? "").length + 2)))) ?? [];
  const rows = s.rows.map((r, n) => `<row r="${n + 1}">${r.map((v, c) => {
    if (v === "") return "";
    const at = `${column(c)}${n + 1}`, style = (typeof v === "number" ? Math.max(1, FORMATS.indexOf(s.formats[c] ?? "int")) : 0) + (bold.has(n) ? 4 : 0);
    return typeof v === "number" ? `<c r="${at}" s="${style}"><v>${Number.isFinite(v) ? v : 0}</v></c>` : `<c r="${at}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  }).join("")}</row>`).join("");
  return `${HEAD}<worksheet xmlns="${MAIN}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${rows}</sheetData></worksheet>`;
}
// Excel allows a sheet name 31 characters and none of []:*?/\; two sheets may not share a name.
const names = (sheets: XSheet[]) => { const used = new Set<string>(); return sheets.map((s, i) => { let n = s.name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || `Sheet${i + 1}`; if (used.has(n.toLowerCase())) n = `${n.slice(0, 28)} ${i + 1}`; used.add(n.toLowerCase()); return n; }); };

export function workbook(sheets: XSheet[]): Uint8Array {
  const xf = (font: number) => [0, 3, 164, 165].map((f) => `<xf numFmtId="${f}" fontId="${font}" fillId="0" borderId="0" xfId="0"${f ? ' applyNumberFormat="1"' : ""}${font ? ' applyFont="1"' : ""}/>`).join("");
  const title = names(sheets);
  return zip([
    ["[Content_Types].xml", `${HEAD}<Types xmlns="${PKG}/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${TYPE}.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="${TYPE}.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${TYPE}.worksheet+xml"/>`).join("")}</Types>`],
    ["_rels/.rels", `${HEAD}<Relationships xmlns="${PKG}/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `${HEAD}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><bookViews><workbookView/></bookViews><sheets>${title.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `${HEAD}<Relationships xmlns="${PKG}/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", `${HEAD}<styleSheet xmlns="${MAIN}"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.###"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8">${xf(0)}${xf(1)}</cellXfs></styleSheet>`],
    ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ]);
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export const crc32 = (data: Uint8Array) => { let c = 0xffffffff; for (const b of data) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
// A zip with every file stored as it is: a local header and the bytes per file, then the directory, then its end record.
export function zip(files: [string, string][]): Uint8Array {
  const text = new TextEncoder(), parts: Uint8Array[] = [], directory: Uint8Array[] = [];
  const record = (fields: [number, number][], tail: Uint8Array[]) => { const head = new DataView(new ArrayBuffer(fields.reduce((n, [size]) => n + size, 0))); let at = 0; for (const [size, v] of fields) { if (size === 2) head.setUint16(at, v, true); else head.setUint32(at, v, true); at += size; } return [new Uint8Array(head.buffer), ...tail]; };
  let offset = 0;
  for (const [path, content] of files) {
    const name = text.encode(path), data = text.encode(content), crc = crc32(data);
    // version 2.0, UTF-8 names, stored, 1 January 2026.
    const common: [number, number][] = [[2, 20], [2, 0x0800], [2, 0], [2, 0], [2, 0x5c21], [4, crc], [4, data.length], [4, data.length], [2, name.length], [2, 0]];
    const local = record([[4, 0x04034b50], ...common], [name, data]);
    directory.push(...record([[4, 0x02014b50], [2, 20], ...common, [2, 0], [2, 0], [2, 0], [4, 0], [4, offset]], [name]));
    parts.push(...local);
    offset += local.reduce((n, p) => n + p.length, 0);
  }
  const size = directory.reduce((n, p) => n + p.length, 0);
  parts.push(...directory, ...record([[4, 0x06054b50], [2, 0], [2, 0], [2, files.length], [2, files.length], [4, size], [4, offset], [2, 0]], []));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
