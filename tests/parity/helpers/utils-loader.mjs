import { loadSourceModule } from "./load-source-module.mjs";
import { FakeImage, installDomStubs } from "./dom-stubs.mjs";
import { openSignSrc } from "./paths.mjs";

export const UTILS_STUBS = {
  axios: { post: async () => ({ data: {} }), get: async () => ({ data: {} }) },
  moment: () => ({ format: () => "", isValid: () => true }),
  "pdf-lib": { PDFDocument: {}, rgb: () => ({}), degrees: () => ({}) },
  parse: {
    User: { current: () => null },
    Object: class {},
    Query: class {},
    Cloud: { run: async () => ({}) }
  },
  "./appinfo": { appInfo: { applogo: "", appId: "opensign" } },
  "file-saver": { saveAs: () => {} },
  "print-js": () => {},
  "@pdf-lib/fontkit": {},
  "./const": { themeColor: "#000" },
  "date-fns-tz": { format: () => "", toZonedTime: (d) => d },
  "../i18n": { t: (k) => k },
  "../utils": {
    applyNumberFormulasToPages: (pages) => pages,
    buildDownloadFilename: () => "file.pdf",
    addPreferenceOpt: () => ({})
  }
};

export function loadUtilsModule({ sourceText } = {}) {
  const dom = installDomStubs();
  const loaded = loadSourceModule(openSignSrc("constant/Utils.js"), {
    stubs: UTILS_STUBS,
    sourceText,
    globals: {
      window: dom.window,
      document: dom.document,
      localStorage: dom.localStorage,
      Image: FakeImage,
      atob: (value) => Buffer.from(value, "base64").toString("binary"),
      btoa: (value) => Buffer.from(value, "binary").toString("base64"),
      fetch: async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8)
      })
    }
  });
  return { ...loaded, canvases: dom.canvases, window: dom.window };
}
