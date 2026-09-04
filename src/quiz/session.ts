// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWrite } from "../utils/atomic-write";
import { emptyOverlay } from "./overlay";
import type { Overlay, Scope, QuizTarget } from "./types";
import type { LadderStep } from "./resolution-floor";

export interface QuizSessionState {
  mode: "quiz";
  scope: Scope;
  overlay: Overlay;
  currentTarget: QuizTarget;
  ladderStep: LadderStep | null;
  turnCount: number;
  wrappedUp: boolean;
  /**
   * proj_hash of the project this quiz was opened against. Set once, at
   * opener time (the opener is the only turn that carries `proj_hash` on
   * the wire — see chat-quiz.ts); every continuation turn re-loads the
   * module graph via THIS field rather than the request body. Folded
   * in here (Task 6) rather than kept as a route-local sidecar file —
   * this state IS the durable per-session record, so a field a
   * continuation turn structurally needs belongs on it, not in a second
   * file that can drift out of sync with it.
   */
  projHash: string;
}

interface OverlayWire {
  supported: string[]; contradicted: string[]; unverified: string[];
  userEntities: string[]; hintEntities: string[];
}
interface QuizStateWire {
  mode: "quiz"; scope: Scope; overlay: OverlayWire;
  currentTarget: QuizTarget; ladderStep: LadderStep | null;
  turnCount: number; wrappedUp: boolean; projHash: string;
}

function overlayToWire(o: Overlay): OverlayWire {
  return {
    supported: [...o.supported], contradicted: [...o.contradicted],
    unverified: [...o.unverified], userEntities: [...o.userEntities],
    hintEntities: [...o.hintEntities],
  };
}
function overlayFromWire(w: OverlayWire): Overlay {
  const o = emptyOverlay();
  for (const x of w.supported) o.supported.add(x);
  for (const x of w.contradicted) o.contradicted.add(x);
  for (const x of w.unverified) o.unverified.add(x);
  for (const x of w.userEntities) o.userEntities.add(x);
  for (const x of w.hintEntities) o.hintEntities.add(x);
  return o;
}

export function serializeQuizState(s: QuizSessionState): string {
  const wire: QuizStateWire = { ...s, overlay: overlayToWire(s.overlay) };
  return JSON.stringify(wire);
}
export function deserializeQuizState(json: string): QuizSessionState {
  const w = JSON.parse(json) as QuizStateWire;
  return { ...w, overlay: overlayFromWire(w.overlay) };
}

export function quizSidecarPath(homeBase: string, sessionId: string): string {
  return join(homeBase, "chats", `${sessionId}.quiz.json`);
}
export async function writeQuizState(homeBase: string, sessionId: string, s: QuizSessionState): Promise<void> {
  const path = quizSidecarPath(homeBase, sessionId);
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, serializeQuizState(s));
}
export async function readQuizState(homeBase: string, sessionId: string): Promise<QuizSessionState | null> {
  // Fail-open by design: the sidecar is best-effort session state, not
  // authoritative data. ENOENT (no quiz in progress) AND any other read
  // failure (corrupt/truncated JSON from a torn write, permission error,
  // schema mismatch) all degrade to "no quiz state" rather than a 500 —
  // matching every other pre-flight read on the chat route (budget gate,
  // staleness, page context), which already fail open.
  try {
    return deserializeQuizState(await readFile(quizSidecarPath(homeBase, sessionId), "utf8"));
  } catch {
    return null;
  }
}
export async function deleteQuizState(homeBase: string, sessionId: string): Promise<void> {
  await rm(quizSidecarPath(homeBase, sessionId), { force: true });
}
