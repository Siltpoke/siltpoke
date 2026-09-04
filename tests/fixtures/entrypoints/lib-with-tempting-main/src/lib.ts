// Fixture: a library exporting a helper NAMED `main` — a tempting name for
// any naive "look for a function called main" heuristic — but it is not
// declared in package.json#bin or #scripts, and this file is not a
// framework-convention path (src/index.ts / src/main.ts / app|pages route).
// No strategy reaches it: detection must return [] here.
export function main() {
  return 1;
}
