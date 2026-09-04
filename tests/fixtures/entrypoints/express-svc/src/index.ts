// Fixture: an Express service whose module scope calls an exported
// `startApp` — the tier-1 root must resolve to `startApp` itself (a
// convention-named export: matches the "start" prefix), never to the
// internal `app.listen` call (an external method, not an in-repo symbol).
// NOTE: deliberately NOT named `startServer` — that literal name collides
// with siltpoke's own authored preset role (id "daemon") and would get
// deduped into a `source: "preset"` entry instead of the generic
// `source: "framework"` entry this fixture means to exercise.
import express from "express";

const app = express();

export function startApp() {
  app.listen(3000);
}

startApp();
