import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

// The server takes a delivery-note photo only as a WebP data URL of at most 70 000 characters (about 52 KB),
// the same ceiling the web app's "Foto nota" has.
const LIMIT = 70_000;

// Shrinks a photo until it fits: narrower first, then stronger compression. The first size that fits is the
// sharpest one the server accepts.
export async function shrinkNote(uri: string): Promise<string> {
  for (const width of [900, 720, 560]) {
    for (const compress of [0.5, 0.35, 0.25]) {
      const context = ImageManipulator.manipulate(uri);
      try {
        context.resize({ width });
        const image = await context.renderAsync();
        try {
          const out = await image.saveAsync({ format: SaveFormat.WEBP, compress, base64: true });
          const data = `data:image/webp;base64,${out.base64 ?? ''}`;
          if (out.base64 && data.length <= LIMIT) return data;
        } finally {
          image.release();
        }
      } finally {
        context.release();
      }
    }
  }
  throw new Error('Foto masih terlalu besar. Coba ambil lebih dekat.');
}
