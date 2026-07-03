import { test, expect } from "bun:test";
import { createStubEmbedder } from "../../src/few-shot/embedder";

const stub = createStubEmbedder();

test("stub returns 384-dimensional array", async () => {
  const v = await stub.embed("hello world");
  expect(v.length).toBe(384);
});

test("stub output is L2-normalized (magnitude ≈ 1)", async () => {
  const v = await stub.embed("test text for normalization check");
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  expect(mag).toBeCloseTo(1.0, 5);
});

test("stub is deterministic — same input returns identical output", async () => {
  const a = await stub.embed("deterministic check");
  const b = await stub.embed("deterministic check");
  expect(a).toEqual(b);
});

test("stub returns different embeddings for different inputs", async () => {
  const a = await stub.embed("first input");
  const b = await stub.embed("second input");
  // Not identical
  expect(a).not.toEqual(b);
});

test("stub dimension property is 384", () => {
  expect(stub.dimension).toBe(384);
});

test("custom dimension stub returns correct length", async () => {
  const small = createStubEmbedder(64);
  const v = await small.embed("hi");
  expect(v.length).toBe(64);
  expect(small.dimension).toBe(64);
});
