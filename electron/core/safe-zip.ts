import { inflateRawSync } from 'node:zlib';

export type ZipLimits = {
  compressed: number;
  expanded: number;
  entries: number;
  entryBytes(name: string): number;
};

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function invalid(detail: string): never {
  throw new Error(`Cannot import this ZIP: ${detail}`);
}

// Apply the same filename rules on every OS, including case-insensitive filesystems.
function filename(raw: Buffer, flags: number) {
  if (!(flags & 0x800) && raw.some((byte) => byte > 127))
    invalid('non-ASCII filenames must use UTF-8. Re-export the archive with UTF-8 filenames.');
  let name: string;
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return invalid('a filename is not valid UTF-8.');
  }
  const relative = name.endsWith('/') ? name.slice(0, -1) : name;
  if (
    !relative ||
    relative.length > 240 ||
    /[\x00-\x1f\x7f\\:<>"|?*]/.test(relative) ||
    relative
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      ) ||
    relative.split('/').length > 9
  )
    invalid('a filename is unsafe or its folders are nested too deeply.');
  return name;
}

/** A deliberately bounded ZIP subset: ordinary stored/deflated files and folders.
 * Parse all headers before inflating; never trust the declared output size as a
 * memory bound. Check the actual length, CRC and deflate consumption as well.
 */
export function readSafeZip(input: Uint8Array, limits: ZipLimits): Map<string, Buffer> {
  const zip = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (zip.length > limits.compressed) invalid('the compressed archive exceeds the size limit.');
  let end = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65557); offset--) {
    if (
      zip.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + zip.readUInt16LE(offset + 20) === zip.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0) invalid('the archive is incomplete or its directory is missing.');
  const count = zip.readUInt16LE(end + 10),
    centralSize = zip.readUInt32LE(end + 12),
    centralOffset = zip.readUInt32LE(end + 16);
  if (
    zip.readUInt16LE(end + 4) ||
    zip.readUInt16LE(end + 6) ||
    zip.readUInt16LE(end + 8) !== count ||
    count === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  )
    invalid('split archives and ZIP64 archives are not supported.');
  if (!count || count > limits.entries)
    invalid('the archive exceeds the file-count limit or is empty.');
  if (centralOffset + centralSize !== end) invalid('the archive directory is inconsistent.');

  const records: {
    name: string;
    start: number;
    end: number;
    dataStart: number;
    compressed: number;
    size: number;
    crc: number;
    method: number;
    directory: boolean;
  }[] = [];
  const names = new Set<string>();
  const nodes = new Map<string, { spelling: string; directory: boolean }>();
  let offset = centralOffset,
    expanded = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || zip.readUInt32LE(offset) !== 0x02014b50)
      invalid('an archive directory entry is damaged.');
    const flags = zip.readUInt16LE(offset + 8),
      method = zip.readUInt16LE(offset + 10),
      crc = zip.readUInt32LE(offset + 16),
      compressed = zip.readUInt32LE(offset + 20),
      size = zip.readUInt32LE(offset + 24),
      nameLength = zip.readUInt16LE(offset + 28),
      extraLength = zip.readUInt16LE(offset + 30),
      commentLength = zip.readUInt16LE(offset + 32),
      start = zip.readUInt32LE(offset + 42),
      attributes = zip.readUInt32LE(offset + 38);
    if (offset + 46 + nameLength + extraLength + commentLength > end)
      invalid('an archive directory entry is truncated.');
    if (
      flags & ~(0x800 | 8 | 6) ||
      ![0, 8].includes(method) ||
      zip.readUInt16LE(offset + 6) > 20 ||
      zip.readUInt16LE(offset + 34)
    )
      invalid('encrypted files, links and unsupported compression formats are not allowed.');
    const rawName = zip.subarray(offset + 46, offset + 46 + nameLength);
    const name = filename(rawName, flags),
      directory = name.endsWith('/');
    const mode = attributes >>> 16,
      kind = mode & 0xf000;
    if (kind && kind !== (directory ? 0x4000 : 0x8000))
      invalid('symbolic links and special files are not allowed.');
    if (attributes & 0x10 && !directory) invalid('a folder has a conflicting filename.');
    if (directory && size) invalid('a folder contains unexpected data.');
    const key = name.replace(/\/$/, '').normalize('NFC').toLowerCase();
    if (names.has(key)) invalid('duplicate or ambiguous filenames are not allowed.');
    names.add(key);
    const parts = name.replace(/\/$/, '').split('/');
    for (let part = 1; part <= parts.length; part++) {
      const spelling = parts.slice(0, part).join('/'),
        folded = spelling.normalize('NFC').toLowerCase();
      const isDirectory = part < parts.length || directory,
        previous = nodes.get(folded);
      if (previous && (previous.spelling !== spelling || previous.directory !== isDirectory))
        invalid('file and folder names conflict.');
      nodes.set(folded, { spelling, directory: isDirectory });
    }
    expanded += size;
    if (size > limits.entryBytes(name) || expanded > limits.expanded)
      invalid('the expanded archive exceeds the size limit.');
    const checkExtras = (begin: number, length: number) => {
      let cursor = begin;
      while (cursor < begin + length) {
        if (cursor + 4 > begin + length) invalid('an extra field is truncated.');
        const type = zip.readUInt16LE(cursor),
          bytes = zip.readUInt16LE(cursor + 2);
        if (type === 1) invalid('ZIP64 archives are not supported.');
        cursor += 4 + bytes;
        if (cursor > begin + length) invalid('an extra field is truncated.');
      }
    };
    checkExtras(offset + 46 + nameLength, extraLength);
    if (start + 30 > centralOffset || zip.readUInt32LE(start) !== 0x04034b50)
      invalid('a local file header is missing.');
    const localNameLength = zip.readUInt16LE(start + 26),
      localExtraLength = zip.readUInt16LE(start + 28);
    const dataStart = start + 30 + localNameLength + localExtraLength;
    if (
      dataStart + compressed > centralOffset ||
      zip.readUInt16LE(start + 4) > 20 ||
      zip.readUInt16LE(start + 6) !== flags ||
      zip.readUInt16LE(start + 8) !== method ||
      !rawName.equals(zip.subarray(start + 30, start + 30 + localNameLength))
    )
      invalid('local and directory file headers disagree.');
    checkExtras(start + 30 + localNameLength, localExtraLength);
    let recordEnd = dataStart + compressed;
    if (flags & 8) {
      if (recordEnd + 12 > centralOffset) invalid('a data descriptor is missing.');
      if (zip.readUInt32LE(recordEnd) === 0x08074b50) recordEnd += 4;
      if (
        recordEnd + 12 > centralOffset ||
        zip.readUInt32LE(recordEnd) !== crc ||
        zip.readUInt32LE(recordEnd + 4) !== compressed ||
        zip.readUInt32LE(recordEnd + 8) !== size
      )
        invalid('a data descriptor is inconsistent.');
      recordEnd += 12;
    } else if (
      zip.readUInt32LE(start + 14) !== crc ||
      zip.readUInt32LE(start + 18) !== compressed ||
      zip.readUInt32LE(start + 22) !== size
    )
      invalid('local and directory file sizes disagree.');
    records.push({
      name,
      start,
      end: recordEnd,
      dataStart,
      compressed,
      size,
      crc,
      method,
      directory,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== end) invalid('the archive directory length is inconsistent.');
  let position = 0;
  for (const record of [...records].sort((a, b) => a.start - b.start)) {
    if (record.start !== position) invalid('file records overlap or contain unexpected data.');
    position = record.end;
  }
  if (position !== centralOffset) invalid('the archive contains unexpected data.');
  const entries = new Map<string, Buffer>();
  for (const record of records) {
    const compressed = zip.subarray(record.dataStart, record.dataStart + record.compressed);
    let data: Buffer;
    try {
      if (record.method === 0) data = compressed;
      else {
        const inflated = inflateRawSync(compressed, {
          maxOutputLength: Math.max(1, record.size),
          info: true,
        }) as unknown as {
          buffer: Buffer;
          engine: { bytesWritten: number };
        };
        if (inflated.engine.bytesWritten !== compressed.length)
          invalid('a compressed stream contains extra data.');
        data = inflated.buffer;
      }
    } catch {
      return invalid(`the data in ${record.name} is damaged or exceeds its declared size.`);
    }
    if (data.length !== record.size || crc32(data) !== record.crc)
      invalid(`the size or checksum of ${record.name} does not match.`);
    if (!record.directory) entries.set(record.name, data);
  }
  return entries;
}
