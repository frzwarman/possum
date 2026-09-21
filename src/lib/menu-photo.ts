const INPUT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_DATA_URL_LENGTH = 70_000;

export function validateMenuPhotoData(value: string | undefined): boolean {
  if (value === undefined || value === "") return true;
  return (
    value.length <= MAX_DATA_URL_LENGTH &&
    /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/.test(value)
  );
}

function canvasToDataUrl(canvas: HTMLCanvasElement, quality: number): string {
  return canvas.toDataURL("image/webp", quality);
}

export async function compressMenuPhoto(file: File): Promise<string> {
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

  const maxSide = 420;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    bitmap.close();
    throw new Error("Perangkat tidak dapat memproses foto.");
  }
  context.fillStyle = "#f2f1e9";
  context.fillRect(0, 0, width, height);
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
