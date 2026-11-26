import { describe, expect, it } from "vitest";
import { validateMenuPhotoData } from "../../src/lib/menu-photo";

describe("optional menu photos", () => {
  it("allows the field to be omitted or cleared", () => {
    expect(validateMenuPhotoData(undefined)).toBe(true);
    expect(validateMenuPhotoData("")).toBe(true);
  });

  it("accepts the compressed WebP data format used offline", () => {
    expect(validateMenuPhotoData("data:image/webp;base64,UklGRg==")).toBe(true);
  });

  it("rejects remote URLs, SVG markup, other data types and oversized payloads", () => {
    expect(validateMenuPhotoData("https://example.com/menu.jpg")).toBe(false);
    expect(validateMenuPhotoData("data:image/svg+xml,<svg/>")).toBe(false);
    // menu/F7: WebKit cannot encode WebP from a canvas, so a JPEG is taken too; a PNG (its fallback) is not.
    expect(validateMenuPhotoData("data:image/jpeg;base64,/9j/4AAQ")).toBe(true);
    expect(validateMenuPhotoData("data:image/png;base64,iVBORw0KGgo=")).toBe(false);
    expect(
      validateMenuPhotoData(`data:image/webp;base64,${"A".repeat(70_000)}`),
    ).toBe(false);
  });
});
