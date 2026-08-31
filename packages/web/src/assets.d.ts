// esbuild's `loader: { '.svg': 'text' }` (packages/server/index.ts) turns an
// `.svg` import into its raw markup as a string - this is that shape stated
// for the typechecker, not a real module on disk.
declare module '*.svg' {
  const svgMarkup: string;
  export default svgMarkup;
}

// esbuild's `loader: { '.woff2': 'dataurl' }` (packages/server/index.ts) turns a
// `.woff2` import into a `data:font/woff2;base64,...` string - self-hosted, no
// extra static route and no network fetch to a font CDN.
declare module '*.woff2' {
  const dataUri: string;
  export default dataUri;
}
