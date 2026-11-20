/**
 * ZIP, bounded both ways. Writing: relative, traversal-free names, deflate on zlib's thread pool. Reading:
 * the central directory only, with limits on entries, expanded bytes and compression ratio checked before
 * anything is inflated; encrypted, absolute, parent-relative and duplicate names are refused. Nothing is
 * ever extracted to disk or executed.
 */
import { crc32, deflateRaw, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const deflate = promisify(deflateRaw), inflate = promisify(inflateRaw);
export const zipLimits = { entries: 2000, members: 20, expandedBytes: 100 * 1024 * 1024, memberBytes: 50 * 1024 * 1024, ratio: 100 };

/** A safe archive member name: relative, forward slashes, no empty, "." or ".." parts, no control characters. */
export function safeMemberName(name: string) {
  if (!name || name.length > 1024 || /[\x00-\x1f\\:]/.test(name) || name.startsWith('/')) return false;
  return name.split('/').every((part, index, parts) => part !== '..' && part !== '.' && (part !== '' || index === parts.length - 1));
}
async function checksum(data: Buffer) {
  let value = 0;
  // Large inputs are checksummed in slices, yielding between them, so the event loop is never held long.
  for (let offset = 0; offset < data.length; offset += 4 * 1024 * 1024) { value = crc32(data.subarray(offset, offset + 4 * 1024 * 1024), value); if (offset) await new Promise(resolve => setImmediate(resolve)); }
  return value >>> 0;
}
export async function zipFilesAsync(entries: { name: string; data: Buffer }[]) {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  const names = new Set<string>();
  for (const entry of entries) {
    if (!safeMemberName(entry.name) || names.has(entry.name)) throw new Error('Invalid or duplicate bundle entry name: ' + entry.name);
    names.add(entry.name);
    const name = Buffer.from(entry.name, 'utf8'), crc = await checksum(entry.data);
    const compressed = entry.data.length > 64 ? await deflate(entry.data) : entry.data;
    const method = compressed.length < entry.data.length ? 8 : 0, body = method ? compressed : entry.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x0800, 8); header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16); header.writeUInt32LE(body.length, 20); header.writeUInt32LE(entry.data.length, 24); header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(0o100644 << 16 >>> 0, 38); header.writeUInt32LE(offset, 42);
    locals.push(local, name, body); central.push(header, name);
    offset += local.length + name.length + body.length;
    if (offset > 0xffffffff) throw new Error('The bundle is larger than a ZIP file can hold without ZIP64');
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
export type ZipEntry = { name: string; method: number; compressedSize: number; size: number; offset: number; crc: number; directory: boolean };
/** Lists an archive from its central directory, refusing anything unsafe before any member is inflated. */
export function listZip(data: Buffer, limits = zipLimits) {
  const search = Math.max(0, data.length - 65557);
  let end = -1;
  for (let at = data.length - 22; at >= search; at--) if (data.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  if (end < 0) throw Object.assign(new Error('This is not a readable ZIP archive'), { code: 'malformed' });
  const count = data.readUInt16LE(end + 10), size = data.readUInt32LE(end + 12), start = data.readUInt32LE(end + 16);
  if (count === 0xffff || start === 0xffffffff) throw Object.assign(new Error('ZIP64 archives are not supported'), { code: 'unsupported' });
  if (count > limits.entries) throw Object.assign(new Error(`The archive has more than ${limits.entries} entries`), { code: 'too_many' });
  if (start + size > data.length) throw Object.assign(new Error('The archive directory is damaged'), { code: 'malformed' });
  const entries: ZipEntry[] = [], names = new Set<string>();
  let at = start, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50) throw Object.assign(new Error('The archive directory is damaged'), { code: 'malformed' });
    const flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10), crc = data.readUInt32LE(at + 16), compressedSize = data.readUInt32LE(at + 20), entrySize = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28), extra = data.readUInt16LE(at + 30), comment = data.readUInt16LE(at + 32), offset = data.readUInt32LE(at + 42);
    const name = data.subarray(at + 46, at + 46 + nameLength).toString(flags & 0x0800 ? 'utf8' : 'latin1');
    at += 46 + nameLength + extra + comment;
    if (flags & 0x0001) throw Object.assign(new Error('The archive is encrypted; Cere does not open encrypted archives'), { code: 'encrypted' });
    if (!safeMemberName(name) || names.has(name)) throw Object.assign(new Error(`The archive contains an unsafe or duplicate name (${name.slice(0, 80)})`), { code: 'unsafe_name' });
    if (![0, 8].includes(method)) throw Object.assign(new Error('The archive uses a compression method Cere does not read'), { code: 'unsupported' });
    names.add(name); expanded += entrySize;
    if (expanded > limits.expandedBytes) throw Object.assign(new Error(`The archive expands to more than ${limits.expandedBytes / 1024 / 1024} MiB`), { code: 'too_large' });
    if (compressedSize && entrySize / compressedSize > limits.ratio && entrySize > 1024 * 1024) throw Object.assign(new Error('The archive’s compression ratio is suspicious (a possible expansion bomb)'), { code: 'bomb' });
    entries.push({ name, method, compressedSize, size: entrySize, offset, crc, directory: name.endsWith('/') });
  }
  return entries;
}
/** Inflates one listed member, bounded by its declared size and checked against its CRC. */
export async function readMember(data: Buffer, entry: ZipEntry, maxBytes = zipLimits.memberBytes) {
  if (entry.size > maxBytes) throw Object.assign(new Error(`${entry.name} is larger than Cere reads`), { code: 'too_large' });
  const at = entry.offset;
  if (at + 30 > data.length || data.readUInt32LE(at) !== 0x04034b50) throw Object.assign(new Error('The archive is damaged'), { code: 'malformed' });
  const start = at + 30 + data.readUInt16LE(at + 26) + data.readUInt16LE(at + 28), body = data.subarray(start, start + entry.compressedSize);
  const out = entry.method === 0 ? Buffer.from(body) : await inflate(body, { maxOutputLength: entry.size + 1 }).catch(() => { throw Object.assign(new Error(`${entry.name} could not be decompressed`), { code: 'malformed' }); });
  if (out.length !== entry.size || (await checksum(out)) !== entry.crc) throw Object.assign(new Error(`${entry.name} is damaged`), { code: 'malformed' });
  return out;
}
