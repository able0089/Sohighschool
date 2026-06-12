import { Jimp } from "jimp";

const HASH_SIZE = 8;

export async function computeDHash(imageBuffer: Buffer): Promise<string> {
  const img = await Jimp.fromBuffer(imageBuffer);

  img.resize({ w: HASH_SIZE + 1, h: HASH_SIZE });

  const bits: number[] = [];
  for (let y = 0; y < HASH_SIZE; y++) {
    for (let x = 0; x < HASH_SIZE; x++) {
      const left = img.getPixelColor(x, y);
      const right = img.getPixelColor(x + 1, y);
      const leftGray = grayValue(left);
      const rightGray = grayValue(right);
      bits.push(leftGray < rightGray ? 1 : 0);
    }
  }

  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    const nibble =
      (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3];
    hex += nibble.toString(16);
  }
  return hex;
}

function grayValue(rgba: number): number {
  const r = (rgba >>> 24) & 0xff;
  const g = (rgba >>> 16) & 0xff;
  const b = (rgba >>> 8) & 0xff;
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Infinity;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    dist += xor.toString(2).split("").filter((c) => c === "1").length;
  }
  return dist;
}
