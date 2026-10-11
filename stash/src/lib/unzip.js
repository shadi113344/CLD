// Minimal zip reader for large archives. It reads only the zip's directory and
// the entries you ask for, so a multi-gigabyte export never has to fit in
// memory. Handles stored and deflated entries, and ZIP64 archives.

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

async function view(file, start, end) {
  return new DataView(await file.slice(start, end).arrayBuffer());
}

// want(name) -> true for entries to extract. Returns [{ name, text }].
export async function readZip(file, want) {
  const tailStart = Math.max(0, file.size - (65535 + 22 + 20));
  const tail = await view(file, tailStart, file.size);
  let e = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD) {
      e = i;
      break;
    }
  }
  if (e < 0) throw new Error(`${file.name} isn’t a zip file`);
  let count = tail.getUint16(e + 10, true);
  let size = tail.getUint32(e + 12, true);
  let offset = tail.getUint32(e + 16, true);
  if ((count === 0xffff || size === 0xffffffff || offset === 0xffffffff) && e >= 20 && tail.getUint32(e - 20, true) === EOCD64_LOCATOR) {
    const at = Number(tail.getBigUint64(e - 20 + 8, true));
    const z = await view(file, at, at + 56);
    if (z.getUint32(0, true) !== EOCD64) throw new Error(`${file.name}: damaged zip`);
    count = Number(z.getBigUint64(32, true));
    size = Number(z.getBigUint64(40, true));
    offset = Number(z.getBigUint64(48, true));
  }

  const cd = await view(file, offset, offset + size);
  const names = new TextDecoder();
  const out = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.byteLength && cd.getUint32(p, true) === CENTRAL; i++) {
    const method = cd.getUint16(p + 10, true);
    let csize = cd.getUint32(p + 20, true);
    let usize = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let local = cd.getUint32(p + 42, true);
    const name = names.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    // ZIP64: sizes and offset too big for 32 bits live in extra field 0x0001.
    for (let x = p + 46 + nameLen, end = x + extraLen; x + 4 <= end; ) {
      const id = cd.getUint16(x, true);
      const len = cd.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff) (usize = Number(cd.getBigUint64(q, true))), (q += 8);
        if (csize === 0xffffffff) (csize = Number(cd.getBigUint64(q, true))), (q += 8);
        if (local === 0xffffffff) local = Number(cd.getBigUint64(q, true));
      }
      x += 4 + len;
    }
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || !want(name)) continue;

    const lh = await view(file, local, local + 30);
    if (lh.getUint32(0, true) !== LOCAL) throw new Error(`${file.name}: damaged entry ${name}`);
    const start = local + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const raw = file.slice(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    else throw new Error(`${name} uses a compression Stash can’t read (method ${method})`);
    out.push({ name, text: await data.text() });
  }
  return out;
}
