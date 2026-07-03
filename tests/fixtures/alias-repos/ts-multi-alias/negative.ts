// NEGATIVE cases — both must resolve to null:
//  - `@dup/dupName` is AMBIGUOUS: maps to both src/dupName.ts AND lib/dupName.ts.
//  - `@app/missing` is UNRESOLVABLE: no lib/missing.ts exists.
import { d } from "@dup/dupName";
import { z } from "@app/missing";

export const n = d;
export type Z = typeof z;
