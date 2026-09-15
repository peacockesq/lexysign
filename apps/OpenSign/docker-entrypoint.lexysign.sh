#!/bin/sh
set -eu

node <<'NODE'
const fs = require('fs');

const runtimeEnv = {};
for (const key of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']) {
  if (process.env[key]) runtimeEnv[key] = process.env[key];
}

fs.writeFileSync(
  '/app/build/runtime-env.js',
  `window.RUNTIME_ENV = Object.freeze(${JSON.stringify(runtimeEnv)});\n`,
  { mode: 0o644 }
);
NODE

exec "$@"
