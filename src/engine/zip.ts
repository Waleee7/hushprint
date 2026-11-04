// Minimal ZIP writer (STORE method) for "download all". Images are already compressed, so no deflate needed.
import { concat, crc32 } from './bytes.ts';

const le16 = (n: number) => Uint8Array.of(n & 255, (n >> 8) & 255);
const le32 = (n: number) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);

export const makeZip = (files: { name: string; data: Uint8Array }[], when = new Date()): Uint8Array => {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const date = ((Math.max(1980, when.getFullYear()) - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data);
    const local = concat([le32(0x04034b50), le16(20), le16(0x0800), le16(0), le16(time), le16(date), le32(crc), le32(f.data.length), le32(f.data.length), le16(name.length), le16(0), name]);
    central.push(concat([le32(0x02014b50), le16(20), le16(20), le16(0x0800), le16(0), le16(time), le16(date), le32(crc), le32(f.data.length), le32(f.data.length), le16(name.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(offset), name]));
    parts.push(local, f.data);
    offset += local.length + f.data.length;
  }
  const cd = concat(central);
  return concat([...parts, cd, le32(0x06054b50), le16(0), le16(0), le16(files.length), le16(files.length), le32(cd.length), le32(offset), le16(0)]);
};
