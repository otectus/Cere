/**
 * Document parsing, off the broker's event loop. Plain text, CSV/TSV, JSON, XML, HTML, DOCX, XLSX and ZIP
 * listings become units of text with source locators. Nothing is executed or fetched: no macros, no DTDs
 * or external entities (only the five XML entities and numeric references are decoded), no formulas
 * evaluated, no remote resources, no archive member run. Warnings say what was left out.
 */
import { parentPort } from 'node:worker_threads';
import { listZip, readMember } from './zip.ts';

export type Unit = { locator: Record<string, string | number>; kind: string; text: string };
export type Parsed = { status: 'complete' | 'partial' | 'empty'; units: Unit[]; warnings: string[]; stats: Record<string, unknown> };
const limits = { units: 20_000, chars: 8 * 1024 * 1024, rows: 200_000, linesPerUnit: 60, rowsPerUnit: 50 };

function decode(bytes: Buffer, warnings: string[]) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''); }
  catch { warnings.push('The file is not valid UTF-8; undecodable bytes were replaced'); return new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, ''); }
}
function lines(text: string, kind = 'lines'): Unit[] {
  const all = text.replace(/\r\n?/g, '\n').split('\n'), units: Unit[] = [];
  for (let start = 0; start < all.length; start += limits.linesPerUnit) {
    const slice = all.slice(start, start + limits.linesPerUnit), body = slice.join('\n');
    if (body.trim()) units.push({ locator: { startLine: start + 1, endLine: start + slice.length }, kind, text: body });
  }
  return units;
}
/** RFC 4180 CSV with a detected or chosen delimiter; values are kept exactly as written. */
export function parseCsv(text: string, delimiter?: string) {
  const sample = text.slice(0, 20_000);
  const chosen = delimiter || [',', '\t', ';', '|'].map(d => ({ d, n: sample.split('\n').slice(0, 20).map(line => line.split(d).length - 1) })).filter(c => c.n.length && c.n[0] > 0)
    .sort((a, b) => (b.n.filter(n => n === b.n[0]).length - a.n.filter(n => n === a.n[0]).length) || b.n[0] - a.n[0])[0]?.d || ',';
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false, malformed = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch; continue; }
    if (ch === '"' && field === '') { quoted = true; continue; }
    if (ch === '"') malformed++;
    if (ch === chosen) { row.push(field); field = ''; continue; }
    if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; rows.push(row); row = []; if (rows.length > limits.rows) break; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (quoted) malformed++;
  return { delimiter: chosen, rows, malformed };
}
function csvUnits(text: string, warnings: string[], delimiter?: string) {
  const { delimiter: used, rows, malformed } = parseCsv(text, delimiter);
  if (rows.length > limits.rows) warnings.push(`Only the first ${limits.rows.toLocaleString('en-US')} rows were read`);
  if (malformed) warnings.push(`${malformed} malformed quote(s); values near them may be split differently than intended`);
  const widths = new Set(rows.map(r => r.length));
  if (widths.size > 1) warnings.push('Rows have different numbers of columns');
  const header = rows[0] || [], units: Unit[] = [];
  for (let start = 1; start < rows.length; start += limits.rowsPerUnit) {
    const slice = rows.slice(start, start + limits.rowsPerUnit);
    units.push({ locator: { rows: `${start + 1}-${start + slice.length}`, columns: header.length }, kind: 'rows', text: [header.join(used), ...slice.map(r => r.join(used))].join('\n') });
  }
  return { units, stats: { delimiter: used === '\t' ? 'tab' : used, rows: Math.max(0, rows.length - 1), columns: header.length, header: header.slice(0, 50) } };
}
/** A small XML reader for Office parts: elements, attributes and text. DTDs and entities beyond the five built-ins are never processed. */
type XmlNode = { name: string; attributes: Record<string, string>; children: XmlNode[]; text: string };
export function parseXml(source: string): XmlNode {
  if (/<!DOCTYPE/i.test(source)) throw Object.assign(new Error('Document type declarations are not processed'), { code: 'dtd' });
  const root: XmlNode = { name: '#root', attributes: {}, children: [], text: '' }, stack = [root];
  const entity = (value: string) => value.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, name: string) => name === 'lt' ? '<' : name === 'gt' ? '>' : name === 'amp' ? '&' : name === 'quot' ? '"' : name === 'apos' ? "'" : String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)));
  const pattern = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null, count = 0;
  while ((match = pattern.exec(source))) {
    if (++count > 2_000_000) throw new Error('The document has too many XML parts');
    const top = stack[stack.length - 1];
    if (match[1] !== undefined) top.text += match[1];
    else if (match[3]) {
      if (match[2]) { if (stack.length > 1) stack.pop(); continue; }
      const attributes: Record<string, string> = {};
      for (const attr of match[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[attr[1]] = entity(attr[2] ?? attr[3] ?? '');
      const node: XmlNode = { name: match[3], attributes, children: [], text: '' };
      top.children.push(node);
      if (!match[5]) stack.push(node);
    } else if (match[6]) top.text += entity(match[6]);
  }
  return root;
}
const local = (name: string) => name.includes(':') ? name.split(':')[1] : name;
function* walk(node: XmlNode): Generator<XmlNode> { yield node; for (const child of node.children) yield* walk(child); }
function textOf(node: XmlNode): string {
  let out = '';
  for (const part of walk(node)) { const name = local(part.name); if (name === 't') out += part.text; else if (name === 'tab') out += '\t'; else if (name === 'br' || name === 'cr') out += '\n'; }
  return out;
}
async function docx(bytes: Buffer, warnings: string[]) {
  const entries = listZip(bytes), find = (name: string) => entries.find(entry => entry.name === name);
  const document = find('word/document.xml');
  if (!document) throw Object.assign(new Error('This is not a Word document (word/document.xml is missing)'), { code: 'malformed' });
  if (entries.some(entry => /vbaProject\.bin$/i.test(entry.name))) warnings.push('The document contains macros; they were not run');
  if (entries.some(entry => entry.name.startsWith('word/embeddings/'))) warnings.push('Embedded objects (such as spreadsheets) were not opened');
  const rels = find('word/_rels/document.xml.rels');
  if (rels && /TargetMode\s*=\s*"External"/i.test((await readMember(bytes, rels)).toString('utf8'))) warnings.push('The document links to external content, which was not fetched');
  const xml = parseXml((await readMember(bytes, document)).toString('utf8'));
  const body = [...walk(xml)].find(node => local(node.name) === 'body');
  const units: Unit[] = []; let paragraph = 0, table = 0;
  for (const block of body?.children || []) {
    const name = local(block.name);
    if (name === 'p') { paragraph++; const text = textOf(block).trim(); if (text) units.push({ locator: { paragraph }, kind: 'paragraph', text }); }
    else if (name === 'tbl') {
      table++;
      const rows = block.children.filter(child => local(child.name) === 'tr').map(tr => tr.children.filter(child => local(child.name) === 'tc').map(tc => textOf(tc).replace(/\s+/g, ' ').trim()));
      units.push({ locator: { table, rows: rows.length }, kind: 'table', text: rows.map(cells => cells.join(' | ')).join('\n') });
    }
  }
  return { units, stats: { paragraphs: paragraph, tables: table } };
}
const columnName = (ref: string) => ref.replace(/\d+$/, '');
async function xlsx(bytes: Buffer, warnings: string[], includeHidden: boolean) {
  const entries = listZip(bytes), find = (name: string) => entries.find(entry => entry.name === name);
  const workbook = find('xl/workbook.xml');
  if (!workbook) throw Object.assign(new Error('This is not an Excel workbook (xl/workbook.xml is missing)'), { code: 'malformed' });
  if (entries.some(entry => entry.name.startsWith('xl/externalLinks/'))) warnings.push('The workbook links to other files; those links were not followed');
  if (entries.some(entry => /vbaProject\.bin$/i.test(entry.name))) warnings.push('The workbook contains macros; they were not run');
  const shared: string[] = [];
  const strings = find('xl/sharedStrings.xml');
  if (strings) for (const item of parseXml((await readMember(bytes, strings)).toString('utf8')).children.flatMap(node => node.children)) if (local(item.name) === 'si') shared.push(textOf(item));
  const relations = new Map<string, string>();
  const rels = find('xl/_rels/workbook.xml.rels');
  if (rels) for (const node of walk(parseXml((await readMember(bytes, rels)).toString('utf8')))) if (local(node.name) === 'Relationship') relations.set(node.attributes.Id, node.attributes.Target);
  const sheets = [...walk(parseXml((await readMember(bytes, workbook)).toString('utf8')))].filter(node => local(node.name) === 'sheet');
  const units: Unit[] = [], names: string[] = [], hidden: string[] = [];
  let formulas = 0, cells = 0;
  for (const sheet of sheets) {
    const name = sheet.attributes.name || 'Sheet', state = sheet.attributes.state || 'visible';
    if (state !== 'visible' && !includeHidden) { hidden.push(name); continue; }
    const target = relations.get(sheet.attributes['r:id']) || '';
    const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    const entry = find(path); if (!entry) { warnings.push(`Sheet ${name} could not be found in the file`); continue; }
    names.push(name);
    const rows = [...walk(parseXml((await readMember(bytes, entry)).toString('utf8')))].filter(node => local(node.name) === 'row');
    const rendered: { row: number; text: string }[] = [];
    for (const row of rows) {
      const parts: string[] = [];
      for (const cell of row.children.filter(child => local(child.name) === 'c')) {
        const ref = cell.attributes.r || '', type = cell.attributes.t || 'n';
        const formula = cell.children.find(child => local(child.name) === 'f'), value = cell.children.find(child => local(child.name) === 'v');
        const inline = cell.children.find(child => local(child.name) === 'is');
        let shown = type === 's' ? shared[Number(value?.text)] ?? '' : type === 'inlineStr' ? (inline ? textOf(inline) : '') : type === 'b' ? (value?.text === '1' ? 'TRUE' : 'FALSE') : value?.text ?? '';
        if (formula) { formulas++; shown = `=${formula.text}${value ? ` (cached: ${shown})` : ' (no cached value)'}`; }
        if (shown === '') continue;
        cells++; parts.push(`${ref}: ${shown}`);
      }
      if (parts.length) rendered.push({ row: Number(row.attributes.r) || rendered.length + 1, text: parts.join(' | ') });
    }
    for (let start = 0; start < rendered.length; start += limits.rowsPerUnit) {
      const slice = rendered.slice(start, start + limits.rowsPerUnit);
      units.push({ locator: { sheet: name, rows: `${slice[0].row}-${slice[slice.length - 1].row}` }, kind: 'cells', text: slice.map(row => row.text).join('\n') });
    }
  }
  if (hidden.length) warnings.push(`Hidden sheets were left out: ${hidden.join(', ')}`);
  if (formulas) warnings.push('Formulas are shown as written; their cached values come from the last time the file was saved and may be stale. Nothing was recalculated.');
  void columnName;
  return { units, stats: { sheets: names, hiddenSheets: hidden, cells, formulas } };
}
async function html(text: string, warnings: string[]) {
  const { parseHTML } = await import('linkedom');
  const { document } = parseHTML(text);
  let removed = 0;
  for (const element of document.querySelectorAll('script,style,noscript,iframe,object,embed,template,link,meta,svg,canvas,form')) { element.remove(); removed++; }
  if (removed) warnings.push('Scripts, styles, frames and embedded objects were removed; nothing was loaded or run');
  const units: Unit[] = []; let heading = 'Start', index = 0, buffer: string[] = [];
  const flush = () => { const body = buffer.join('\n').replace(/\n{3,}/g, '\n\n').trim(); if (body) units.push({ locator: { section: heading.slice(0, 120), index: index++ }, kind: 'section', text: body }); buffer = []; };
  const visit = (node: any) => {
    for (const child of node.childNodes || []) {
      if (child.nodeType === 3) { const value = String(child.textContent || '').replace(/\s+/g, ' '); if (value.trim()) buffer.push(value.trim()); continue; }
      if (child.nodeType !== 1) continue;
      const tag = String(child.tagName || '').toLowerCase();
      if (/^h[1-6]$/.test(tag)) { flush(); heading = String(child.textContent || '').replace(/\s+/g, ' ').trim() || heading; continue; }
      visit(child);
      if (['p', 'div', 'li', 'tr', 'br', 'section', 'article', 'blockquote', 'pre', 'table'].includes(tag)) buffer.push('');
    }
  };
  visit(document.body || document.documentElement);
  flush();
  return { units, stats: { sections: units.length, title: String(document.title || '').slice(0, 200) } };
}
async function parse(p: { bytes: Uint8Array; mime: string; name: string; options: Record<string, unknown> }): Promise<Parsed> {
  const bytes = Buffer.from(p.bytes), warnings: string[] = [], lower = p.name.toLowerCase();
  let result: { units: Unit[]; stats: Record<string, unknown> };
  if (/wordprocessingml/.test(p.mime) || lower.endsWith('.docx')) result = await docx(bytes, warnings);
  else if (/spreadsheetml/.test(p.mime) || lower.endsWith('.xlsx')) result = await xlsx(bytes, warnings, p.options.includeHidden === true);
  else if (p.mime === 'application/zip' || lower.endsWith('.zip')) {
    const entries = listZip(bytes);
    result = { units: [{ locator: { listing: 1 }, kind: 'listing', text: entries.map(entry => `${entry.directory ? 'folder' : `${entry.size} bytes`}  ${entry.name}`).join('\n') }], stats: { members: entries.length, expanded: entries.reduce((sum, entry) => sum + entry.size, 0) } };
    warnings.push('Only the list of members was read; choose a member to extract it');
  } else {
    const text = decode(bytes, warnings);
    if (/csv|tab-separated/.test(p.mime) || /\.(csv|tsv)$/.test(lower)) result = csvUnits(text, warnings, typeof p.options.delimiter === 'string' ? p.options.delimiter : lower.endsWith('.tsv') ? '\t' : undefined);
    else if (p.mime === 'text/html' || /\.html?$/.test(lower)) result = await html(text, warnings);
    else {
      if (p.mime === 'application/json' || lower.endsWith('.json')) { try { JSON.parse(text); } catch { warnings.push('The JSON is not valid; it is shown as text'); } }
      if (p.mime === 'application/xml' || lower.endsWith('.xml')) { if (/<!DOCTYPE|<!ENTITY/i.test(text)) warnings.push('The XML declares a document type or entities; they were not processed'); }
      result = { units: lines(text), stats: { lines: text.split('\n').length } };
    }
  }
  let units = result.units, chars = 0;
  const kept: Unit[] = [];
  for (const unit of units) { if (kept.length >= limits.units || chars + unit.text.length > limits.chars) { warnings.push('The document is larger than one extraction holds; the rest was left out'); break; } kept.push(unit); chars += unit.text.length; }
  units = kept;
  return { status: !units.length ? 'empty' : warnings.some(w => /left out|Only the first/.test(w)) ? 'partial' : 'complete', units, warnings, stats: { ...result.stats, units: units.length, chars } };
}
parentPort?.on('message', async (message: any) => {
  try { parentPort!.postMessage({ id: message.id, ok: true, value: await parse(message) }); }
  catch (error: any) { parentPort!.postMessage({ id: message.id, ok: false, code: error?.code || 'failed', message: String(error?.message || error).slice(0, 500) }); }
});
