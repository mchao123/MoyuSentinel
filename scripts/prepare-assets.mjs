import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";

await mkdir("src-tauri/models", { recursive: true });
const modelPath = "src-tauri/models/yolox_nano.onnx";
const expectedHash =
  "c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
let valid = false;
try {
  valid = sha256(await readFile(modelPath)) === expectedHash;
} catch {}
if (!valid) {
  const url =
    "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx";
  console.log("Downloading the local person-detection model...");
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Model download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expectedHash)
    throw new Error("The model checksum does not match the pinned release");
  await writeFile(modelPath, bytes);
}
await mkdir("src-tauri/icons", { recursive: true });
const size = 128;
const rgba = Buffer.alloc(size * size * 4);
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const edge = x < 13 || x >= size - 13 || y < 13 || y >= size - 13;
    const mark =
      y >= 38 &&
      y < 90 &&
      ((x >= 36 && x < 48) ||
        (x >= 80 && x < 92) ||
        (y < 58 && Math.abs(x - 64) < 12));
    rgba.set(
      edge
        ? [236, 65, 77, 255]
        : mark
          ? [255, 255, 255, 255]
          : [29, 34, 43, 255],
      i,
    );
  }
const png = await sharp(rgba, {
  raw: { width: size, height: size, channels: 4 },
})
  .png()
  .toBuffer();
await writeFile("src-tauri/icons/icon.png", png);
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header[6] = size;
header[7] = size;
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);
await writeFile("src-tauri/icons/icon.ico", Buffer.concat([header, png]));
console.log("Offline ONNX model and application icons are ready.");
