const esbuild = require('esbuild');

esbuild
  .build({
    entryPoints: ['src/content.js'],
    bundle: true,
    outfile: 'dist/content.bundle.js',
    target: 'chrome110',
    format: 'iife',
    minify: false,
    sourcemap: true,
  })
  .then(() => console.log('Build succeeded: dist/content.bundle.js'))
  .catch((err) => {
    console.error('Build failed:', err);
    process.exit(1);
  });
