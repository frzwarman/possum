const INPUT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_DATA_URL_LENGTH = 70_000;

export function validateMenuPhotoData(value: string | undefined): boolean {
  if (value === undefined || value === "") return true;
  // A compressed WebP taken on the device, or a hotlinked Unsplash photo (demo catalogue, stock pictures).
  return (
    value.length <= MAX_DATA_URL_LENGTH &&
    (/^data:image\/webp;base64,[A-Za-z0-9+/=]+$/.test(value) || /^https:\/\/images\.unsplash\.com\/[\w\-./?=&%]+$/.test(value))
  );
}

function canvasToDataUrl(canvas: HTMLCanvasElement, quality: number): string {
  return canvas.toDataURL("image/webp", quality);
}

// Menu photos: 420 px on a filled background. Logos: 256 px, transparency kept so the receipt stays white.
export const compressMenuPhoto = (file: File) => compressImage(file, 420, "#f2f1e9");
export const compressLogo = (file: File) => compressImage(file, 256);

async function compressImage(file: File, maxSide: number, background?: string): Promise<string> {
  if (!INPUT_TYPES.has(file.type)) {
    throw new Error(
      "Gunakan foto JPG, PNG, atau WebP. Ubah foto HEIC di galeri terlebih dahulu.",
    );
  }
  if (file.size > MAX_SOURCE_BYTES)
    throw new Error("Foto maksimal 10 MB sebelum diperkecil.");

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(
      "Foto tidak dapat dibaca oleh browser ini. Coba JPG, PNG, atau WebP lain.",
    );
  }

  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: !background });
  if (!context) {
    bitmap.close();
    throw new Error("Perangkat tidak dapat memproses foto.");
  }
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  for (const quality of [0.72, 0.62, 0.52, 0.42]) {
    const output = canvasToDataUrl(canvas, quality);
    if (validateMenuPhotoData(output)) return output;
  }
  throw new Error(
    "Foto masih terlalu besar setelah diperkecil. Pilih foto dengan detail lebih sederhana.",
  );
}
