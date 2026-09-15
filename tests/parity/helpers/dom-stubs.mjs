export function createMemoryStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    }
  };
}

export const imageRasters = new Map();

export function createInkRaster({ width, height, ink }) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const x0 = ink.x;
  const y0 = ink.y;
  const x1 = ink.x + ink.w;
  const y1 = ink.y + ink.h;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + x) * 4;
      pixels[i] = 0;
      pixels[i + 1] = 0;
      pixels[i + 2] = 0;
      pixels[i + 3] = 255;
    }
  }
  return { width, height, pixels };
}

export function registerRaster(src, raster) {
  imageRasters.set(src, raster);
}

export function inkStats(canvas) {
  const { width, height, pixels } = canvas;
  if (!pixels || !width || !height) {
    return { count: 0, minX: 0, minY: 0, maxX: -1, maxY: -1, bboxW: 0, bboxH: 0 };
  }
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = pixels[(y * width + x) * 4 + 3];
      if (a > 0) {
        count += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const bboxW = maxX >= minX ? maxX - minX + 1 : 0;
  const bboxH = maxY >= minY ? maxY - minY + 1 : 0;
  return { count, minX, minY, maxX, maxY, bboxW, bboxH, width, height };
}

export class FakeImage {
  constructor() {
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.width = 0;
    this.height = 0;
    this.pixels = null;
    this.onload = null;
    this.onerror = null;
    this._src = "";
  }
  set src(value) {
    this._src = value;
    const raster = imageRasters.get(value);
    if (!raster) {
      this.onerror?.(new Error(`no raster registered for ${value}`));
      return;
    }
    this.naturalWidth = raster.width;
    this.naturalHeight = raster.height;
    this.width = raster.width;
    this.height = raster.height;
    this.pixels = raster.pixels;
    queueMicrotask(() => {
      if (typeof this.onload === "function") this.onload();
    });
  }
  get src() {
    return this._src;
  }
}

export class RasterCanvas {
  constructor() {
    this._width = 0;
    this._height = 0;
    this.pixels = new Uint8ClampedArray(0);
    this.ops = [];
    this._scaleX = 1;
    this._scaleY = 1;
  }
  get width() {
    return this._width;
  }
  set width(value) {
    this._width = Math.max(0, Math.floor(value));
    this.pixels = new Uint8ClampedArray(this._width * this._height * 4);
    this._scaleX = 1;
    this._scaleY = 1;
  }
  get height() {
    return this._height;
  }
  set height(value) {
    this._height = Math.max(0, Math.floor(value));
    this.pixels = new Uint8ClampedArray(this._width * this._height * 4);
    this._scaleX = 1;
    this._scaleY = 1;
  }
  getContext() {
    const canvas = this;
    return {
      canvas,
      scale(x, y = x) {
        canvas._scaleX *= x;
        canvas._scaleY *= y;
        canvas.ops.push(["scale", [x, y]]);
      },
      clearRect(x, y, w, h) {
        canvas.ops.push(["clearRect", [x, y, w, h]]);
        fillRect(canvas, x, y, w, h, [0, 0, 0, 0]);
      },
      drawImage(...args) {
        canvas.ops.push(["drawImage", args]);
        blit(canvas, args);
      },
      fillText(...args) {
        canvas.ops.push(["fillText", args]);
      },
      measureText(text) {
        const width = String(text || "").length * 10;
        return {
          width,
          actualBoundingBoxAscent: 8,
          actualBoundingBoxDescent: 2
        };
      },
      getImageData(x, y, w, h) {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let row = 0; row < h; row += 1) {
          for (let col = 0; col < w; col += 1) {
            const sx = x + col;
            const sy = y + row;
            const di = (row * w + col) * 4;
            if (sx < 0 || sy < 0 || sx >= canvas._width || sy >= canvas._height) continue;
            const si = (sy * canvas._width + sx) * 4;
            data[di] = canvas.pixels[si];
            data[di + 1] = canvas.pixels[si + 1];
            data[di + 2] = canvas.pixels[si + 2];
            data[di + 3] = canvas.pixels[si + 3];
          }
        }
        return { width: w, height: h, data };
      },
      set font(value) {
        canvas.ops.push(["font", [value]]);
      },
      set fillStyle(value) {
        canvas.ops.push(["fillStyle", [value]]);
      },
      set textAlign(value) {
        canvas.ops.push(["textAlign", [value]]);
      },
      set textBaseline(value) {
        canvas.ops.push(["textBaseline", [value]]);
      }
    };
  }
  toDataURL() {
    return "data:image/png;base64,ZmFrZQ==";
  }
}

function fillRect(canvas, x, y, w, h, rgba) {
  const x0 = Math.round(x * canvas._scaleX);
  const y0 = Math.round(y * canvas._scaleY);
  const x1 = Math.round((x + w) * canvas._scaleX);
  const y1 = Math.round((y + h) * canvas._scaleY);
  for (let py = y0; py < y1; py += 1) {
    if (py < 0 || py >= canvas._height) continue;
    for (let px = x0; px < x1; px += 1) {
      if (px < 0 || px >= canvas._width) continue;
      const i = (py * canvas._width + px) * 4;
      canvas.pixels[i] = rgba[0];
      canvas.pixels[i + 1] = rgba[1];
      canvas.pixels[i + 2] = rgba[2];
      canvas.pixels[i + 3] = rgba[3];
    }
  }
}

function blit(canvas, args) {
  const img = args[0];
  let sx = 0;
  let sy = 0;
  let sw = img?.naturalWidth || 0;
  let sh = img?.naturalHeight || 0;
  let dx;
  let dy;
  let dw;
  let dh;
  if (args.length === 5) {
    [, dx, dy, dw, dh] = args;
  } else if (args.length === 9) {
    [, sx, sy, sw, sh, dx, dy, dw, dh] = args;
  } else {
    return;
  }
  const x0 = Math.round(dx * canvas._scaleX);
  const y0 = Math.round(dy * canvas._scaleY);
  const destW = Math.max(1, Math.round(dw * canvas._scaleX));
  const destH = Math.max(1, Math.round(dh * canvas._scaleY));
  const src = img.pixels;
  if (!src) return;
  for (let y = 0; y < destH; y += 1) {
    const py = y0 + y;
    if (py < 0 || py >= canvas._height) continue;
    const srcY = sy + Math.min(sh - 1, Math.floor((y + 0.5) * sh / destH));
    for (let x = 0; x < destW; x += 1) {
      const px = x0 + x;
      if (px < 0 || px >= canvas._width) continue;
      const srcX = sx + Math.min(sw - 1, Math.floor((x + 0.5) * sw / destW));
      const di = (py * canvas._width + px) * 4;
      const si = (srcY * img.naturalWidth + srcX) * 4;
      canvas.pixels[di] = src[si];
      canvas.pixels[di + 1] = src[si + 1];
      canvas.pixels[di + 2] = src[si + 2];
      canvas.pixels[di + 3] = src[si + 3];
    }
  }
}

export function installDomStubs() {
  const canvases = [];
  const localStorage = createMemoryStorage();
  const windowObj = {
    innerWidth: 1280,
    devicePixelRatio: 1,
    location: { origin: "https://sign.lexyalgo.com" },
    RUNTIME_ENV: {},
    localStorage
  };
  const documentObj = {
    createElement(tag) {
      if (tag === "canvas") {
        const canvas = new RasterCanvas();
        canvases.push(canvas);
        return canvas;
      }
      return { style: {}, setAttribute() {} };
    }
  };
  return { window: windowObj, document: documentObj, localStorage, canvases };
}
