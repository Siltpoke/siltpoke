// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Opt-in client startup tracing for the ⚡ dashboard-load-performance track.
 *
 * Why this is committed rather than a throwaway edit: the numbers this track
 * produces keep needing a re-run (the gzip arm claimed 78% of bytes and zero
 * milliseconds; the bundle A/B was too noisy at n=7 to establish its effect).
 * A measurement that can only be reproduced by re-applying a hand edit is a
 * measurement nobody re-checks. This ships as a documented, default-OFF probe
 * so any later claim about where the page's startup time goes can be re-run
 * with one env var.
 *
 * OFF unless `SILTPOKE_PERF_TRACE=1` is set in the daemon's environment, in
 * which case two tiny inline scripts are emitted by `Layout`:
 *   - `PERF_TRACE_HEAD_SCRIPT` — FIRST script in <head>, before the theme
 *     bootstrap and before any external <script>/<link>. It stamps `headStart`,
 *     starts a buffered longtask observer, and subscribes to the Alpine
 *     lifecycle events so `Alpine.start()`'s DOM walk is timed from outside
 *     the bundle (the bundle cannot time its own start).
 *   - `PERF_TRACE_BODY_SCRIPT` — LAST element in <body>. `bodyEnd - headStart`
 *     is the main-thread cost of parsing the document itself.
 *
 * Read the result from a browser (or a driver) with:
 *   JSON.stringify(window.__siltpokePerf.summary())
 *
 * `summary()` is deliberately a snapshot function, not a stored object: it is
 * read AFTER the load event, so it can fold in navigation + resource timings
 * that do not exist yet at head-parse time.
 */

/** True when the daemon was started with `SILTPOKE_PERF_TRACE=1`. */
export function isPerfTraceEnabled(): boolean {
  return process.env.SILTPOKE_PERF_TRACE === "1";
}

/**
 * Emitted as the first <script> in <head>. Plain ES5, no bundler involvement —
 * it must run before anything else, including the theme bootstrap.
 *
 * Everything is wrapped so a browser without `longtask` support (or with the
 * entry type disabled) still yields marks rather than throwing in <head> and
 * taking the theme bootstrap down with it.
 */
export const PERF_TRACE_HEAD_SCRIPT = `(function(){
  var P = {marks:{}, longtasks:[]};
  P.mark = function(n){ if(P.marks[n] === undefined) P.marks[n] = performance.now(); };
  window.__siltpokePerf = P;
  P.mark("headStart");
  try {
    new PerformanceObserver(function(list){
      var es = list.getEntries();
      for (var i=0;i<es.length;i++){
        var e = es[i];
        var attr = [];
        var a = e.attribution || [];
        for (var j=0;j<a.length;j++) attr.push(a[j].containerType + ":" + (a[j].containerSrc || a[j].containerName || ""));
        P.longtasks.push({start: Math.round(e.startTime), dur: Math.round(e.duration), attr: attr});
      }
    }).observe({type:"longtask", buffered:true});
  } catch(_){}
  document.addEventListener("alpine:init", function(){ P.mark("alpineInit"); });
  document.addEventListener("alpine:initialized", function(){ P.mark("alpineInitialized"); });
  document.addEventListener("DOMContentLoaded", function(){ P.mark("dcl"); });
  window.addEventListener("load", function(){ P.mark("load"); });
  // Self-driving sample collection. Armed by the driver with
  //   localStorage["siltpoke-perf-run"] = "<remaining sample count>"
  // Each load appends its own summary to sessionStorage and reloads until the
  // counter runs out. Why the page drives itself instead of a parent frame
  // polling it: a driver loop lives in another document, and if THAT document
  // is ever backgrounded its timers clamp to ~1s, which lands in the numbers as
  // if the page under test were slow. Measured: the same page, same machine,
  // reported a 1907ms and a 649ms load in consecutive parent-driven runs. A
  // page that records its own timeline has no such coupling.
  window.addEventListener("load", function(){
    var left = parseInt(localStorage.getItem("siltpoke-perf-run") || "0", 10);
    if (!(left > 0)) return;
    // A sample taken while the tab is backgrounded is thrown away later, so
    // taking one is pure waste — and worse, a run that spends itself while the
    // operator is looking elsewhere reports "done" having collected almost
    // nothing usable (measured: 23 of 26 samples discarded that way). So a
    // hidden load does not consume a sample at all: it parks until the tab is
    // looked at, then reloads so the NEXT navigation is the one measured. The
    // counter therefore counts FOREGROUND samples, which is the only kind that
    // means anything.
    if (document.visibilityState !== "visible") {
      document.addEventListener("visibilitychange", function once(){
        if (document.visibilityState !== "visible") return;
        document.removeEventListener("visibilitychange", once);
        setTimeout(function(){ location.reload(); }, 400);
      });
      return;
    }
    setTimeout(function(){
      var acc = [];
      try { acc = JSON.parse(sessionStorage.getItem("siltpoke-perf-samples") || "[]"); } catch(_){}
      acc.push(P.summary());
      sessionStorage.setItem("siltpoke-perf-samples", JSON.stringify(acc));
      localStorage.setItem("siltpoke-perf-run", String(left - 1));
      // Single-variable control for the pre-script window. Every navigation
      // here spends ~150ms of main-thread time between responseEnd and the
      // first inline script — before the parser reaches any markup. The two
      // candidates are "tearing down the previous heavy document" and
      // "intrinsic to loading this page". Emptying the OUTGOING document
      // changes only the weight of what is torn down, and nothing about the
      // page being measured.
      //
      // Alternating mode flips the arm after every sample so ONE armed run
      // collects both arms interleaved. That is not tidiness: a human
      // switching to the terminal to start a second arm puts the browser
      // window behind it, and a backgrounded tab is throttled — so any
      // protocol needing a keystroke BETWEEN arms silently makes the second
      // arm worthless. Interleaving also splits machine noise across both arms
      // rather than handing one arm the quieter half of the run.
      var doStrip = localStorage.getItem("siltpoke-perf-strip") === "1";
      if (doStrip) document.body.innerHTML = "";
      // Written AFTER the decision, read by the NEXT load's summary(). The
      // arm a sample belongs to is a property of the navigation that produced
      // it — the teardown it just paid for — so it cannot be read off the
      // flag as it stands during that load: alternating mode has already
      // flipped that flag for the following navigation. Recording the acted-on
      // value is what keeps the label attached to what actually happened.
      localStorage.setItem("siltpoke-perf-prev-strip", doStrip ? "1" : "0");
      if (localStorage.getItem("siltpoke-perf-alternate") === "1") {
        localStorage.setItem("siltpoke-perf-strip", doStrip ? "0" : "1");
      }
      if (left - 1 > 0) location.reload();
    }, 250);
  });
  P.summary = function(){
    var nav = performance.getEntriesByType("navigation")[0] || {};
    var res = performance.getEntriesByType("resource").map(function(r){
      return {
        name: r.name.replace(/^https?:\\/\\//, ""),
        start: Math.round(r.startTime),
        dur: Math.round(r.duration),
        end: Math.round(r.responseEnd),
        transfer: r.transferSize,
        decoded: r.decodedBodySize,
        blocking: r.renderBlockingStatus || ""
      };
    });
    var lt = 0;
    for (var i=0;i<P.longtasks.length;i++) lt += P.longtasks[i].dur;
    return {
      // Recorded per sample, not once per run: a backgrounded tab is throttled,
      // and a sample taken while hidden must be discarded rather than averaged
      // in. This field is what makes that rejection possible after the fact.
      vis: document.visibilityState,
      // Whether the document THIS navigation tore down had been emptied first
      // (see the strip control below). Written by the previous load, so it
      // names the condition this sample actually experienced rather than the
      // arm the next one will run.
      prevStripped: localStorage.getItem("siltpoke-perf-prev-strip") === "1",
      nav: {
        ttfb: Math.round(nav.responseStart || 0),
        responseEnd: Math.round(nav.responseEnd || 0),
        domInteractive: Math.round(nav.domInteractive || 0),
        dclStart: Math.round(nav.domContentLoadedEventStart || 0),
        dclEnd: Math.round(nav.domContentLoadedEventEnd || 0),
        domComplete: Math.round(nav.domComplete || 0),
        loadEnd: Math.round(nav.loadEventEnd || 0),
        htmlDecoded: nav.decodedBodySize || 0
      },
      marks: P.marks,
      derived: {
        htmlParse: (P.marks.bodyEnd !== undefined && P.marks.headStart !== undefined)
          ? Math.round(P.marks.bodyEnd - P.marks.headStart) : null,
        alpineWalk: (P.marks.alpineInitialized !== undefined && P.marks.alpineInit !== undefined)
          ? Math.round(P.marks.alpineInitialized - P.marks.alpineInit) : null
      },
      longtaskTotal: Math.round(lt),
      longtasks: P.longtasks,
      resources: res,
      paint: performance.getEntriesByType("paint").map(function(p){
        return {name: p.name, at: Math.round(p.startTime)};
      })
    };
  };
})();`;

/**
 * Emitted as the last element inside <body>. Pairs with `headStart` to give the
 * document's own parse cost, with every external <link>/<script> in <head>
 * already discovered (and, for render-blocking stylesheets, already waited on).
 */
export const PERF_TRACE_BODY_SCRIPT = `window.__siltpokePerf && window.__siltpokePerf.mark("bodyEnd");`;
