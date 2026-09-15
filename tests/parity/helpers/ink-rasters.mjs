/** Image-only rasters for signature ink-fit tests. Not a DOM stub. */

export function createRaster({ width, height, background = null, ink = null, extraPixels = [] }) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  if (background) {
    const [r, g, b, a] = background;
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = a;
    }
  }
  if (ink) {
    const { x, y, w, h, rgba = [0, 0, 0, 255] } = ink;
    const x1 = x + w;
    const y1 = y + h;
    for (let py = y; py < y1; py += 1) {
      if (py < 0 || py >= height) continue;
      for (let px = x; px < x1; px += 1) {
        if (px < 0 || px >= width) continue;
        const i = (py * width + px) * 4;
        pixels[i] = rgba[0];
        pixels[i + 1] = rgba[1];
        pixels[i + 2] = rgba[2];
        pixels[i + 3] = rgba[3];
      }
    }
  }
  for (const p of extraPixels) {
    if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) continue;
    const i = (p.y * width + p.x) * 4;
    const [r, g, b, a] = p.rgba;
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = a;
  }
  return { width, height, pixels };
}

export function createTransparentLeftoverRgb({ width, height, ink }) {
  return createRaster({
    width,
    height,
    background: [255, 0, 0, 0],
    ink
  });
}

export function createWhiteBackgroundInk({ width, height, ink }) {
  return createRaster({
    width,
    height,
    background: [255, 255, 255, 255],
    ink
  });
}

export function createEdgeStrokeRaster({ width, height, rgba = [0, 0, 0, 255] }) {
  const extraPixels = [];
  for (let x = 0; x < width; x += 1) {
    extraPixels.push({ x, y: 0, rgba });
    extraPixels.push({ x, y: height - 1, rgba });
  }
  for (let y = 0; y < height; y += 1) {
    extraPixels.push({ x: 0, y, rgba });
    extraPixels.push({ x: width - 1, y, rgba });
  }
  return createRaster({ width, height, extraPixels });
}
