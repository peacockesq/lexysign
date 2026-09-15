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

export const imageNaturalSize = { width: 800, height: 200 };

export class FakeImage {
  constructor() {
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.width = 0;
    this.height = 0;
    this.onload = null;
    this.onerror = null;
    this._src = "";
  }
  set src(value) {
    this._src = value;
    this.naturalWidth = imageNaturalSize.width;
    this.naturalHeight = imageNaturalSize.height;
    this.width = imageNaturalSize.width;
    this.height = imageNaturalSize.height;
    queueMicrotask(() => {
      if (typeof this.onload === "function") this.onload();
    });
  }
  get src() {
    return this._src;
  }
}

export class FakeCanvas {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.ops = [];
  }
  getContext() {
    const canvas = this;
    return {
      canvas,
      scale(...args) {
        canvas.ops.push(["scale", args]);
      },
      clearRect(...args) {
        canvas.ops.push(["clearRect", args]);
      },
      drawImage(...args) {
        canvas.ops.push(["drawImage", args]);
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

export function installDomStubs(target = globalThis) {
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
        const canvas = new FakeCanvas();
        canvases.push(canvas);
        return canvas;
      }
      return { style: {}, setAttribute() {} };
    }
  };
  target.window = windowObj;
  target.document = documentObj;
  target.localStorage = localStorage;
  target.Image = FakeImage;
  target.atob = (value) => Buffer.from(value, "base64").toString("binary");
  target.btoa = (value) => Buffer.from(value, "binary").toString("base64");
  target.__canvases = canvases;
  return { window: windowObj, document: documentObj, localStorage, canvases };
}
