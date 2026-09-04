// Fixture: minimal bin-declared CLI. The only exported rootable symbol
// in this file, so entrypoint detection roots here via tier-1.
export function main() {
  console.log("mytool");
}
