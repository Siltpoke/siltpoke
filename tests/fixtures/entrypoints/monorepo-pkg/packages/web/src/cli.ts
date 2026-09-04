// Fixture: bin entry inside a nested workspace package. Detection is run
// with repoRoot pointed at packages/web (the package manifest owning this
// bin, not the monorepo root), so the manifest read + path resolution both
// stay relative to the package.
export function main() {
  console.log("mytool");
}
