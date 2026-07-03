// `~/util` proves a non-`@/` alias; `@app/helper` proves a 2nd, different-target alias.
import { u } from "~/util";
import { h } from "@app/helper";

export const x = u + h;
