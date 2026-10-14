import { crc32, deflateRawSync } from "node:zlib";
export type ZipInput = {
  path: string;
  content?: string | Buffer;
  mode?: number;
  encrypted?: boolean;
  badCRC?: boolean;
  size?: number;
};
/** Small deterministic ZIP fixture builder; no host zip/unzip executable needed. */
export function skillZip(entries: ZipInput[]) {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path),
      data = Buffer.from(entry.content ?? "");
    const compressed = deflateRawSync(data);
    const checksum = entry.badCRC ? (crc32(data) ^ 1) >>> 0 : crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800 | (entry.encrypted ? 1 : 0), 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.size ?? data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800 | (entry.encrypted ? 1 : 0), 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(entry.size ?? data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(
      ((entry.mode ?? (entry.path.endsWith("/") ? 0o40755 : 0o100644)) *
        65536) >>>
        0,
      38,
    );
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export const skillMarkdown =
  "---\nname: review\ndescription: Review code carefully\n---\n\n# Review\n\nRead workspace files and report findings.\n";
