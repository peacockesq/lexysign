import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(here, "../../..");
export const OPEN_SIGN = path.join(REPO_ROOT, "apps/OpenSign");
export const OPEN_SIGN_SERVER = path.join(REPO_ROOT, "apps/OpenSignServer");

export function openSignSrc(...parts) {
  return path.join(OPEN_SIGN, "src", ...parts);
}

export function serverSrc(...parts) {
  return path.join(OPEN_SIGN_SERVER, ...parts);
}
