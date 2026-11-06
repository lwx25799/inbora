import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const images = [32, 48, 64].map((size) => {
  const data = Buffer.alloc(
    40 + size * size * 4 + Math.ceil(size / 32) * 4 * size,
  );
  data.writeUInt32LE(40, 0);
  data.writeInt32LE(size, 4);
  data.writeInt32LE(size * 2, 8);
  data.writeUInt16LE(1, 12);
  data.writeUInt16LE(32, 14);
  data.writeUInt32LE(size * size * 4, 20);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = 40 + ((size - 1 - y) * size + x) * 4;
      const white =
        x >= size * 0.42 &&
        x < size * 0.59 &&
        ((y > size * 0.18 && y < size * 0.32) ||
          (y > size * 0.43 && y < size * 0.82));
      data[i] = white ? 255 : 72;
      data[i + 1] = white ? 255 : 98;
      data[i + 2] = white ? 255 : 34;
      data[i + 3] = 255;
    }
  return { size, data };
});
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach(({ size, data }, index) => {
  const i = 6 + 16 * index;
  header[i] = size;
  header[i + 1] = size;
  header.writeUInt16LE(1, i + 4);
  header.writeUInt16LE(32, i + 6);
  header.writeUInt32LE(data.length, i + 8);
  header.writeUInt32LE(offset, i + 12);
  offset += data.length;
});
const folder = fileURLToPath(
  new URL("../desktop/src-tauri/icons/", import.meta.url),
);
await mkdir(folder, { recursive: true });
await writeFile(
  folder + "icon.ico",
  Buffer.concat([header, ...images.map((i) => i.data)]),
);
