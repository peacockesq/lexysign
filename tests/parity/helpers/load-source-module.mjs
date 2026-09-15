import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

function convertNamedImportBlock(named) {
  const inner = named.trim().replace(/^\{/, "").replace(/\}$/, "");
  const mapped = inner
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const aliased = part.match(/^(\S+)\s+as\s+(\S+)$/);
      if (aliased) return `${aliased[1]}: ${aliased[2]}`;
      return part;
    });
  return `{ ${mapped.join(", ")} }`;
}

function rewriteImports(source) {
  return source.replace(
    /^[ \t]*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"][ \t]*;?[ \t]*$/gm,
    (_match, bindings, spec) => {
      const stubExpr = `globalThis.__requireStub(${JSON.stringify(spec)})`;
      const trimmed = bindings.trim();
      if (trimmed.startsWith("* as ")) {
        const name = trimmed.slice(5).trim();
        return `const ${name} = ${stubExpr};`;
      }
      if (trimmed.startsWith("{")) {
        return `const ${convertNamedImportBlock(trimmed)} = ${stubExpr};`;
      }
      const defaultAndNamed = trimmed.match(/^([A-Za-z_$][\w$]*)\s*,\s*(\{[\s\S]*\})$/);
      if (defaultAndNamed) {
        return `const ${defaultAndNamed[1]} = ${stubExpr};\nconst ${convertNamedImportBlock(defaultAndNamed[2])} = ${stubExpr};`;
      }
      return `const ${trimmed} = ${stubExpr};`;
    }
  );
}

function rewriteExports(source) {
  const exported = [];
  let next = source.replace(
    /export\s+default\s+async\s+function\s+([A-Za-z_$][\w$]*)/g,
    (_m, name) => {
      exported.push(["default", name]);
      return `async function ${name}`;
    }
  );
  next = next.replace(
    /export\s+default\s+function\s+([A-Za-z_$][\w$]*)/g,
    (_m, name) => {
      exported.push(["default", name]);
      return `function ${name}`;
    }
  );
  next = next.replace(/export\s+default\s+/g, "exports.default = ");
  next = next.replace(
    /export\s+async\s+function\s+([A-Za-z_$][\w$]*)/g,
    (_m, name) => {
      exported.push([name, name]);
      return `async function ${name}`;
    }
  );
  next = next.replace(
    /export\s+function\s+([A-Za-z_$][\w$]*)/g,
    (_m, name) => {
      exported.push([name, name]);
      return `function ${name}`;
    }
  );
  next = next.replace(
    /export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    (_m, kind, name) => {
      exported.push([name, name]);
      return `${kind} ${name}`;
    }
  );
  next = next.replace(/export\s+\{([^}]+)\}/g, (_m, list) => {
    list
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => {
        const [local, alias] = item.split(/\s+as\s+/).map((s) => s.trim());
        exported.push([alias || local, local]);
      });
    return "";
  });
  const trailer = exported
    .map(([key, value]) => `exports[${JSON.stringify(key)}] = ${value};`)
    .join("\n");
  return `${next}\n${trailer}\n`;
}

export function loadSourceModule(
  filePath,
  { stubs = {}, globals = {}, sourceText } = {}
) {
  const original = sourceText ?? fs.readFileSync(filePath, "utf8");
  let source = original.replace(/^\uFEFF/, "");
  source = source.replace(/\bimport\.meta\.env\b/g, "globalThis.__importMetaEnv");
  source = source.replace(/\bimport\.meta\b/g, "globalThis.__importMeta");
  source = rewriteImports(source);
  source = rewriteExports(source);

  const exports = {};
  const sandbox = {
    module: { exports },
    exports,
    console,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    ...globals
  };
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window = globals.window || sandbox.window || sandbox;
  sandbox.document = globals.document || sandbox.document;
  sandbox.__moduleStubs = stubs;
  sandbox.__requireStub = (spec) => {
    if (!Object.prototype.hasOwnProperty.call(stubs, spec)) {
      throw new Error(
        `Missing module stub for ${JSON.stringify(spec)} while loading ${filePath}`
      );
    }
    return stubs[spec];
  };
  sandbox.__importMetaEnv = globals.importMetaEnv || {};
  sandbox.__importMeta = { env: sandbox.__importMetaEnv };

  vm.createContext(sandbox);
  const script = new vm.Script(source, {
    filename: path.basename(filePath)
  });
  script.runInContext(sandbox);
  return { exports, sandbox, source: original };
}

export function readRepoFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}
