// Entry of the standalone bundle inlined into the HTML export
// (`public/static/export-standalone.js`, built by scripts/build-client.ts as its
// own non-splitting IIFE). Everything it needs is imported below; it never pulls
// in the dashboard or the privacy modules.
import { mountHtmlPanel } from "./export/html-panel";

(window as unknown as { __codeMapExport: { mount: typeof mountHtmlPanel } }).__codeMapExport = { mount: mountHtmlPanel };
mountHtmlPanel(document);
