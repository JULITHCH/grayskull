// `with { type: "file" }` imports resolve to a path string (embedded in
// compiled binaries); @types/bun has no wildcard for audio assets.
declare module "*.mp3" {
  const path: string;
  export default path;
}
