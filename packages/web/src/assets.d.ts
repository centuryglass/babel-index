// esbuild's `loader: { '.svg': 'text' }` (packages/server/index.ts) turns an
// `.svg` import into its raw markup as a string - this is that shape stated
// for the typechecker, not a real module on disk.
declare module '*.svg' {
  const svgMarkup: string;
  export default svgMarkup;
}
