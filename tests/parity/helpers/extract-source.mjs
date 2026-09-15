export function sliceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  if (start < 0) {
    throw new Error(`extract: start not found: ${startNeedle.slice(0, 80)}`);
  }
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (end < 0) {
    throw new Error(`extract: end not found after ${startNeedle.slice(0, 80)}`);
  }
  return source.slice(start, end);
}

export function runSourceBlock(block, bindings, returnExpr) {
  const keys = Object.keys(bindings);
  const fn = new Function(...keys, `"use strict";\n${block}\nreturn ${returnExpr};`);
  return fn(...keys.map((key) => bindings[key]));
}
