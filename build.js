const esbuild = require('esbuild');

Promise.all([
  esbuild.build({
    entryPoints: ['src/content.js'],
    bundle: true,
    outfile: 'dist/content.bundle.js',
    target: 'chrome110',
    format: 'iife',
    minify: false,
    sourcemap: true,
  }),
  esbuild.build({
    entryPoints: ['popup.js'],
    bundle: true,
    outfile: 'dist/popup.bundle.js',
    target: 'chrome110',
    format: 'iife',
    minify: false,
    sourcemap: true,
  }),
])
  .then(() => console.log('Build succeeded: dist/content.bundle.js, dist/popup.bundle.js'))
  .catch((err) => {
    console.error('Build failed:', err);
    process.exit(1);
  });
