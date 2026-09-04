// Fixture: Next.js App Router route handler — a second framework-convention
// entrypoint, distinct from app/page.tsx (must not collide on one slug).
export function GET() {
  return new Response("ok");
}
