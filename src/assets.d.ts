// `with { type: "file" }` imports resolve to a path string (embedded in
// compiled binaries); @types/bun has no wildcard for audio assets.
declare module "*.mp3" {
  const path: string;
  export default path;
}

// `with { type: "text" }` imports embed the file content as a string; the
// xterm dist js/css are imported this way to serve them CDN-free.
declare module "*/xterm/lib/xterm.js" {
  const text: string;
  export default text;
}
declare module "*/addon-fit/lib/addon-fit.js" {
  const text: string;
  export default text;
}
declare module "*.css" {
  const text: string;
  export default text;
}
