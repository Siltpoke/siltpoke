import { describe, expect, test } from "bun:test";
import {
  detectRememberIntent,
  looksLikeFactStatement,
} from "../../src/memory/chat-capture";

describe("detectRememberIntent", () => {
  // Each of the 7 markers hits + strips correctly.
  test("各 marker 命中并剥离 trigger", () => {
    const cases: Array<[string, string]> = [
      ["记住 我用 pnpm 不用 npm", "我用 pnpm 不用 npm"],
      ["记一下 周五要发版", "周五要发版"],
      ["记下 测试覆盖率要 80%", "测试覆盖率要 80%"],
      ["帮我记 喜欢粉色", "喜欢粉色"],
      ["别忘了 男朋友叫 Daniel", "男朋友叫 Daniel"],
      ["remember I use pnpm", "I use pnpm"],
      ["note that the daemon runs on 9876", "the daemon runs on 9876"],
    ];
    for (const [input, expected] of cases) {
      const r = detectRememberIntent(input);
      expect(r.hit).toBe(true);
      expect(r.payload).toBe(expected);
    }
  });

  // Case-insensitive English + each separator variant.
  test("英文大小写不敏感", () => {
    expect(detectRememberIntent("REMEMBER buy milk")).toEqual({
      hit: true,
      payload: "buy milk",
    });
    expect(detectRememberIntent("Note That x equals y")).toEqual({
      hit: true,
      payload: "x equals y",
    });
  });

  test("各分隔符 (：:，, 空格) 都被剥离", () => {
    expect(detectRememberIntent("记住：我用 pnpm").payload).toBe("我用 pnpm");
    expect(detectRememberIntent("remember: use pnpm").payload).toBe("use pnpm");
    expect(detectRememberIntent("记住，我用 pnpm").payload).toBe("我用 pnpm");
    expect(detectRememberIntent("remember, use pnpm").payload).toBe("use pnpm");
    expect(detectRememberIntent("记住 我用 pnpm").payload).toBe("我用 pnpm");
  });

  // No marker → miss.
  test("无 marker → miss", () => {
    expect(detectRememberIntent("怎么用 git rebase")).toEqual({
      hit: false,
      payload: "",
    });
    expect(detectRememberIntent("hello there")).toEqual({
      hit: false,
      payload: "",
    });
  });

  // Recall question (ends with question particle) → miss.
  test("召回式提问 → miss (消歧)", () => {
    expect(detectRememberIntent("你还记得 pnpm 吗")).toEqual({
      hit: false,
      payload: "",
    });
    // starts with 'remember' marker BUT ends with '?' → recall, not capture.
    expect(detectRememberIntent("remember when we discussed pnpm?")).toEqual({
      hit: false,
      payload: "",
    });
    expect(detectRememberIntent("记住这个吗？")).toEqual({
      hit: false,
      payload: "",
    });
  });

  // Trigger-only → hit + empty payload.
  test("仅 trigger → hit + 空 payload", () => {
    expect(detectRememberIntent("记住")).toEqual({ hit: true, payload: "" });
    expect(detectRememberIntent("remember")).toEqual({ hit: true, payload: "" });
    expect(detectRememberIntent("  记住  ")).toEqual({ hit: true, payload: "" });
    expect(detectRememberIntent("记住：")).toEqual({ hit: true, payload: "" });
  });

  // Trailing sentence punctuation stripped from stored text.
  test("剥离结尾句号/感叹号", () => {
    expect(detectRememberIntent("记住 我用 pnpm。").payload).toBe("我用 pnpm");
    expect(detectRememberIntent("remember I use pnpm.").payload).toBe(
      "I use pnpm",
    );
    expect(detectRememberIntent("记住 别用 npm！").payload).toBe("别用 npm");
    expect(detectRememberIntent("note that ship it now!").payload).toBe(
      "ship it now",
    );
  });

  test("内部标点不剥离", () => {
    expect(detectRememberIntent("记住 我用 pnpm，不用 npm").payload).toBe(
      "我用 pnpm，不用 npm",
    );
  });

  // Marker mid-sentence (not at start) → miss.
  test("marker 在句中 (非起始) → miss", () => {
    expect(detectRememberIntent("我想记住这个")).toEqual({
      hit: false,
      payload: "",
    });
    expect(detectRememberIntent("please remember this").hit).toBe(false);
  });
});

describe("looksLikeFactStatement", () => {
  // P1 — each zh durable marker → true (realistic sentences ≥4 chars).
  test("P1 每个中文 marker → true", () => {
    const zh: Array<[string, string]> = [
      ["我喜欢", "我喜欢吃奶油海绵蛋糕"],
      ["我爱", "我爱猫和狗"],
      ["我讨厌", "我讨厌写文档"],
      ["我不喜欢", "我不喜欢用 npm"],
      ["我是", "我是后端工程师"],
      ["我叫", "我叫 Alice"],
      ["我的", "我的男朋友叫 Daniel"],
      ["我在用", "我在用 pnpm"],
      ["我用", "我用 bun 跑测试"],
      ["我不用", "我不用 yarn"],
      ["我在做", "我在做一个宠物项目"],
      ["我住", "我住在上海"],
      ["我会", "我会一点 Rust"],
      ["我习惯", "我习惯早上写代码"],
      ["我通常", "我通常用深色主题"],
      ["记得我", "记得我喜欢粉色"],
    ];
    for (const [marker, msg] of zh) {
      expect([marker, looksLikeFactStatement(msg)]).toEqual([marker, true]);
    }
  });

  // P2 — each en marker → true (case-insensitive + word-boundary).
  test("P2 每个英文 marker → true (大小写不敏感)", () => {
    const en: Array<[string, string]> = [
      ["I like", "I like cream sponge cake"],
      ["I love", "I love cats"],
      ["I hate", "I hate writing docs"],
      ["I prefer", "I prefer dark mode"],
      ["I'm", "I'm a backend engineer"],
      ["I am", "I am based in Shanghai"],
      ["my", "my boyfriend is named Daniel"],
      ["I use", "I use pnpm not npm"],
      ["I don't use", "I don't use yarn"],
      ["I work on", "I work on a pet project"],
      ["I live", "I live in Shanghai"],
      ["I usually", "I usually code in the morning"],
      ["remember I", "remember I like pink"],
    ];
    for (const [marker, msg] of en) {
      expect([marker, looksLikeFactStatement(msg)]).toEqual([marker, true]);
    }
    // Case-insensitive.
    expect(looksLikeFactStatement("I LIKE CREAM CAKE")).toBe(true);
    expect(looksLikeFactStatement("i prefer tabs over spaces")).toBe(true);
  });

  // P2b — word-boundary: substrings inside other words must NOT trigger.
  test("P2b 词边界：myth/army 不触发 'my'", () => {
    expect(looksLikeFactStatement("the myth of sisyphus is long")).toBe(false);
    expect(looksLikeFactStatement("an army marches on its stomach")).toBe(
      false,
    );
    // "iliad" must not trigger "I like"/"I love" etc.
    expect(looksLikeFactStatement("the iliad is an epic poem")).toBe(false);
  });

  // P3 — recall questions → false.
  test("P3 召回式提问 → false", () => {
    expect(looksLikeFactStatement("你记得我什么吗?")).toBe(false);
    expect(looksLikeFactStatement("你记得我什么吗")).toBe(false);
    expect(looksLikeFactStatement("do you like me?")).toBe(false);
    expect(looksLikeFactStatement("我喜欢什么？")).toBe(false);
  });

  // P4 — short / empty → false.
  test("P4 过短/空 → false", () => {
    expect(looksLikeFactStatement("ok")).toBe(false);
    expect(looksLikeFactStatement("嗯")).toBe(false);
    expect(looksLikeFactStatement("")).toBe(false);
    expect(looksLikeFactStatement("   ")).toBe(false);
  });

  // P5 — command / code → false.
  test("P5 命令/代码 → false", () => {
    expect(looksLikeFactStatement("/help")).toBe(false);
    expect(looksLikeFactStatement("/siltpoke-chat hello")).toBe(false);
    expect(looksLikeFactStatement("```\nconst x = 1\n```")).toBe(false);
    expect(looksLikeFactStatement("```js\nI like this\n```")).toBe(false);
    expect(looksLikeFactStatement("`I use this`")).toBe(false);
    // Inline code inside a real fact statement is still a fact.
    expect(looksLikeFactStatement("I use `pnpm` not npm")).toBe(true);
  });

  // P6 — plain chatter (no first-person durable marker) → false.
  test("P6 普通闲聊 → false", () => {
    expect(looksLikeFactStatement("帮我看这个 bug")).toBe(false);
    expect(looksLikeFactStatement("thanks")).toBe(false);
    expect(looksLikeFactStatement("怎么用 git rebase")).toBe(false);
    expect(looksLikeFactStatement("can you help me debug this")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Widened gate — correction-shaped turns.
  // Correction markers ONLY open the gate (recall-oriented); they never
  // classify — that happens downstream (extractor + runner layer-2).
  // ---------------------------------------------------------------------------

  // C1 — zh correction markers open the gate even WITHOUT a first-person
  // durable marker (these were all false before the widening).
  test("C1 中文修正语气 marker → true", () => {
    expect(looksLikeFactStatement("不对，那个项目改名叫 siltpoke 了")).toBe(true);
    expect(looksLikeFactStatement("不是狗派，是猫派")).toBe(true); // 不是…是
    expect(looksLikeFactStatement("其实更喜欢深色主题")).toBe(true);
    expect(looksLikeFactStatement("搞错了，用的是 bun 不是 node")).toBe(true);
    expect(looksLikeFactStatement("记错了，生日是五月")).toBe(true);
  });

  // C1b — the headline correction case also passes (it additionally carries
  // "我是", but must not depend on it).
  test("C1b 故事主路径修正 → true", () => {
    expect(looksLikeFactStatement("不对，我是猫派不是狗派")).toBe(true);
  });

  // C1c — canonical marker-free temporal update. "我现在是" defeats the
  // contiguous "我是" marker (this gap was caught in testing); anchored
  // forms (我现在 / 现在+durable-verb) open the gate.
  test("C1c 无标记时间更新 → true", () => {
    expect(looksLikeFactStatement("我现在是猫派了")).toBe(true);
    expect(looksLikeFactStatement("现在用 pnpm 不用 bun 了")).toBe(true);
  });

  // C1d — the BARE-现在 over-admission previously rejected: casual
  // dev-chat "now" sentences must NOT open the paid-extraction gate.
  test("C1d 日常聊天里的 现在 不放行", () => {
    expect(looksLikeFactStatement("我们现在讨论一下这个方案")).toBe(false);
    expect(looksLikeFactStatement("现在这段代码还有几个坑")).toBe(false);
    expect(looksLikeFactStatement("现在跑起来了，看看结果")).toBe(false);
  });

  // C2 — en correction markers open the gate.
  test("C2 英文修正语气 marker → true", () => {
    expect(looksLikeFactStatement("actually it's cats not dogs")).toBe(true);
    expect(looksLikeFactStatement("no, the daemon port is 9876")).toBe(true);
    expect(looksLikeFactStatement("that's wrong, the repo moved to github")).toBe(true);
    expect(looksLikeFactStatement("I'm not a dog person")).toBe(true);
  });

  // C3 — existing rejects keep precedence over correction markers, BOTH
  // directions thought through: a correction phrased as a question is a
  // recall/challenge, not a statement; commands/code/too-short stay rejected.
  test("C3 修正 marker 不覆盖现有 reject", () => {
    expect(looksLikeFactStatement("不对吗？")).toBe(false); // question particle
    expect(looksLikeFactStatement("actually, do you like cats?")).toBe(false);
    expect(looksLikeFactStatement("/help 不对")).toBe(false); // command
    expect(looksLikeFactStatement("```\n不对 x = 1\n```")).toBe(false); // code
    expect(looksLikeFactStatement("不对")).toBe(false); // too short (<4)
  });

  // C3b — "no," only counts when LEADING; embedded "no," is plain chatter.
  test("C3b 内嵌 'no,' 不开门", () => {
    expect(looksLikeFactStatement("the answer is no, thanks")).toBe(false);
  });

  // C4 — layered responsibility (documented): "不对，13×7=91" is a correction
  // of the PET'S ARITHMETIC, not of a memory about the user. It DOES pass this
  // layer-0 gate (contains 不对 — the gate is recall-oriented and cheap); the
  // EXTRACTOR's contract rejects it (no durable first-person claim about the
  // user → no facts), so nothing is written. See the companion test in
  // extract-facts.test.ts. Byte-identical-store is asserted at the runner
  // layer, not here.
  test("C4 '不对，13×7=91' 过 gate（分层职责，下游拒绝）", () => {
    expect(looksLikeFactStatement("不对，13×7=91")).toBe(true);
  });
});
