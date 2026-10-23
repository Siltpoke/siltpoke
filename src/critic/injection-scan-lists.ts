// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Word and category lists for the injection rule scanner (`injection-scan.ts`, the only importer).
 * Data only, no logic: each list is separate so it can be tuned alone. Patterns are bounded (no
 * nested quantifiers).
 */

/** Words that name the reader (ASCII ones are whole-word). */
export const READER_WORDS: RegExp[] = [
  /\breviewers?\b/i,
  /\bAI\b/i,
  /\bassistants?\b/i,
  /\b(?:large\s+)?(?:language|reviewing|reviewer|ai|llm)\s+models?\b/i,
  // an AI judging the code, named by its job ("the review model", "evaluation system", "code-review engine")
  /\b(?:review|code[- ]review|audit|auditing|evaluation|evaluator|grading|scoring|judge)\s+(?:models?|systems?|engines?)\b/i,
  /\bevaluators?\b/i,
  // bare model/agent/bot are ordinary nouns; they name the reader only after an address word
  /\b(?:note|message|notice|instructions?|dear|hey|hi|attention|for|to)\s+(?:the\s+|any\s+|all\s+)?(?:[\w-]+\s+){0,2}(?:models?|agents?|bots?|checkers?)\b/i,
  /\b(?:[\w-]+\s+)?bots?(?=\s*[:：,])/i,
  /\b(?:an?|any|the)\s+(?:[\w-]+\s+){0,2}(?:auditors?|reviewers?|checkers?|scanners?|analy[sz]ers?|bots?|agents?|models?)\s+(?:reads|reading|reviews|reviewing|analy[sz]es|analy[sz]ing|scans|scanning)\s+this\b/i,
  /\b(?:review|reviewer|code|coding|automated|automation|lint|linter|ci|security|audit)\s+(?:bots?|agents?|checkers?)\b/i,
  /\b(?:model|llm|ai|agent|bot)\s+(?:instructions|note|notice)\s*[:：]/i,
  /\bLLMs?\b/i,
  // not CLAUDE.md / CLAUDE.local.md / ~/.claude/ / claude-code
  /\bClaude\b(?![-/_.]\w)/,
  /\b(?:GPT(?:-[\w.]+)?|ChatGPT)\b/,
  // capitalised: an addressee; lowercase claude/codex/gemini are CLI and provider names in code
  /\b(?:Codex|Gemini|Copilot)\b(?![-/_.]\w)/,
  /(?:^|\s)@(?:ai[\w-]*|claude|codex|gemini|copilot)\b/i,
  /\b(?:whoever|anyone|anything)\s+(?:reads|reading|reviewing|analy[sz]ing)\s+this\b/i,
  // 审查/评审/审核 alone is the activity ("代码审查时..."); it names the reader only as a person/bot or "…的AI".
  /(?:审查|评审|审核)(?:者|员|机器人|模型|助手|AI|系统)|代码审核/i,
  /(?:审查|评审|审核)[^，。！？；\n]{0,12}的\s*(?:AI|模型|助手)/i,
  /(?:致|给)\s*(?:AI|模型|助手|机器人|大模型)|各位[^，。！？；\n]{0,10}(?:机器人|模型|助手|AI)|如果你是[^，。！？；\n]{0,6}(?:AI|模型|助手)/i,
  /读到这/,
  // 助手函数/类 is a helper in code
  /(?:大|语言)模型|评估系统|助手(?!函数|类|方法|脚本|工具)/,
];

/** Chinese reader words count as an address wherever they sit. */
export const ZH_READER = /(?:审查|评审|审核|致|给|各位|如果你是|读到这|模型|评估系统|助手)/;

/**
 * Pseudo-authority labels: text posing as a system/operator/policy message. Each pattern is
 * address-shaped (a bracket, a colon label, ALL CAPS, or a "<role> directive" phrase), so the match
 * itself addresses whoever reads it, like a reader word.
 */
export const AUTHORITY_LABELS: RegExp[] = [
  /^[\s*/#>"'-]*[[<【]\s*\/?\s*(?:system|admin(?:istrator)?|operator|developer(?:\s+message)?|root|policy|directive|override|priority|compliance|audit|test\s+mode|debug(?:\s+mode)?|maintenance\s+mode|sudo)\b[^\]>】\n]{0,30}[\]>】]/i,
  /\b(?:system|admin(?:istrator)?|operator|developer\s+(?:message|note|instructions?)|policy|directive|override|priority|compliance|audit\s+(?:notice|mode)|test\s+mode|debug\s+mode|maintenance\s+mode)(?:\s+[\w-]+){0,2}\s*[:：]/i,
  /\b(?:SYSTEM|ADMIN|OPERATOR|OVERRIDE|PRIORITY|POLICY|DIRECTIVE|COMPLIANCE|DEVELOPER|DEBUG\s+MODE|TEST\s+MODE|MAINTENANCE\s+MODE)\b(?:\s+[A-Z]+\b){0,2}/,
  /\b(?:system|admin(?:istrator)?|operator|developer|security|compliance|policy|priority|audit)\s+(?:directive|override|instructions?|message|notice|update|announcement|exemption|exception)\b/i,
  /【[^】\n]{0,6}(?:系统|管理员|开发者|指令|规则|策略|模式|测试|合规|豁免|优先|覆盖)[^】\n]{0,6}】/,
  /系统(?:指令|提示|通知|消息|公告|设定|级|管理员)|(?:管理员|开发者|运营)(?:指令|通知|消息)|最高优先级|(?:测试|调试|维护|开发者)模式|合规(?:豁免|声明|要求)|豁免|系统[^，。：:\n]{0,4}[：:]/,
];

/** Claims to outrank earlier instructions or the reader's task; marks the sentence as pseudo-authority. */
export const OUTRANK: RegExp[] = [
  /\b(?:overrides?|overriding|supersedes?|superseding|outranks?|replaces?)\s+(?:all\s+|any\s+)?(?:the\s+|your\s+|my\s+|these\s+)?(?:previous\s+|prior\s+|earlier\s+|other\s+|original\s+|existing\s+|system\s+|above\s+|preceding\s+)?(?:instructions?|rules|guidance|guidelines|directives?|prompts?|polic(?:y|ies)|tasks?)\b/i,
  /\btakes?\s+(?:precedence|priority)\s+over\b|\bhigher\s+priority\s+than\b/i,
  /\bregardless\s+of\s+(?:any\s+|all\s+|the\s+|your\s+)?(?:previous\s+|prior\s+|earlier\s+|other\s+|original\s+|above\s+)?(?:instructions?|rules|guidance|guidelines|tasks?|prompts?|requests?)\b/i,
  /\binstead\s+of\s+(?:your|the)\s+(?:original\s+|assigned\s+|actual\s+|review(?:ing)?\s+)?task\b/i,
  /优先于|优先级(?:最高|高于)|无论(?:原本|原来|之前|你的|原有)|覆盖(?:之前|先前|以上|原有|原来)|取代(?:之前|原有)|凌驾于/,
];

/** Second person: the sentence speaks to whoever reads it. */
export const SECOND_PERSON = /\b(?:you|your|you're|yourself)\b|你|您/i;

/** A sentence is a directive when it holds one of these (or an imperative opens it, see isImperative). */
export const DIRECTIVE_WORDS: RegExp[] = [
  /\b(?:please|kindly|must|should|shall|need\s+to|needs\s+to|have\s+to|has\s+to|make\s+sure|be\s+sure\s+to|remember\s+to|do\s+not|don't|dont|never|always)\b/i,
  /(?:^|[,;:—–]\s*)(?:only|just)\s+\w/i, // only when opening a clause ("…: only reply OK"), not "summarized only back"
  /请|务必|必须|一定要|一律|不要|别|勿|无需|不用|不必|不需要|只(?:需|要)|直接|应(?:该|当)/,
  /把[^，。！？；\n]{1,20}(?:设为|改为|写成|标为|标记为|评为|当作|视为)/, // 把…设为/标为… (disposal construction) is an order
];

/** First words after an address that open a statement, not an order ("AI reviewer tool: shows ..."). */
export const NON_IMPERATIVE = new Set(
  "the a an this that these those it its it's there here we i you your our they he she his her their is are was were be been being has have had will would can could may might all any some each every no not none one two of in on at by from with as so and or but if then also see".split(" "),
);

export interface Target {
  name: string;
  patterns: RegExp[];
  negatable?: boolean; // a prohibition ("never commit secrets") is a normal rule: a negated match does not count
  requires?: RegExp; // the match's clause must also match this
  selfDirective?: boolean; // the match is itself an order ("you are now a … bot"): no directive word needed
}

/** Asks for FEWER findings: a normal review rule asks for more ("report security issues"). */
export const FEWER = /\b(?:nothing|none|ignore|ignoring|skip|omit|overlook|suppress|leave\s+out|downplay|downgrade|dismiss|gloss\s+over|hide|conceal|exclude|withhold)\b|忽略|跳过|没|无需|不用|不必|不需要|(?:不要|别|勿)(?:报|提|指出|标记|评论|管)/i;
/** …or a negation right before the noun ("no findings", "not raise any issue"); "never edit a test to … a bug" is not one. */
export const NO_BEFORE = /\b(?:no|zero|without|not\s+\w+(?:\s+any)?|never\s+\w+(?:\s+any)?)\s+(?:\w+\s+)?$/i;
/** Sets a graded verdict's value. */
const SOFTEN = /\b(?:low|lower|lowest|downgrade|reduce|minimal|minimum|zero|info|informational|pass|passing|perfect|max|maximum|full|top|highest|as)\b|低|降|最低|通过|满分|五星|高分|无/i;
/** Reads or ships a file out: what makes a path outside the project an exfiltration target. */
const EXFIL = /\b(?:read|cat|open|include|quote|print|send|upload|post|copy|paste|show|attach|output|contents?|append)\b|读取|内容|发送|上传|贴|放进|附上/i;
/** Shows a secret to someone: "flag hardcoded secrets" asks for more review, "print the API key" leaks one. */
const DISCLOSE = /\b(?:reveal|print|show|output|include|send|share|tell|repeat|quote|dump|echo|paste|expose|read|cat|list|leak|post|upload|write|copy|display|return|give|append|attach|disclose|recite|summari[sz]e|contents?)\b|泄露|输出|打印|显示|发送|贴|告诉|复述|写出|读取|附上|列出|给出|内容/i;
/** Controls WHAT the reader's own output says (not its style: "keep your answers short" is a normal rule). */
const CONTENT = /\b(?:begin|start|end|finish|prefix|conclude|include|append|say|says|state|claim|mention|tell|declare|omit|leave\s+out|skip|exclude|remove|drop|hide|only|nothing|exactly|the\s+(?:word|phrase|sentence|string)|approved?|LGTM|pass(?:ed|ing)?|no\s+(?:issues|findings|defects|problems|bugs|risks?))\b|["“'‘「][^"”'’」]{1,60}["”'’」]|写|加上|包含|只|不要提|省略|开头|结尾|最后|末尾|批准|通过|没有问题|无风险/i;

/** What the directive is about. Mostly nouns: they generalise across verbs. */
export const TARGETS: Target[] = [
  { name: "findings", requires: FEWER, patterns: [
      /\b(?:findings?|issues?|problems?|warnings?|alerts?|vulnerabilit(?:y|ies)|bugs?|flaws?|defects?|concerns?|nits?|objections?|criticism|remarks?)\b/i,
      /\b(?:failing\s+(?:tests?|checks?|builds?)|security\s+(?:checks?|checklist|review|scan))\b/i,
      /\b(?:review|any)\s+(?:comments?|feedback)\b/i,
      /问题|漏洞|警告|告警|报警|缺陷|隐患|后门|意见|风险|毛病/,
  ] },
  { name: "findings", patterns: [
      /\b(?:report|flag|mention|raise|find|found)\s+(?:no|nothing|anything|zero)\b/i,
      /\b(?:no|zero)\s+(?:comments?|feedback|findings?|issues?|problems?|warnings?|alerts?|concerns?)\b/i,
      /\bempty\s+(?:list|set|array|report)\s+of\s+(?:findings|issues|problems|warnings)\b|\bempty\s+(?:findings|issues|problems|warnings)\s+(?:list|array|section)\b/i,
      // suppressing the reader's own report: negated reporting verbs (suppression verbs count via FEWER + a noun)
      /\b(?:not|never|don't|dont|no\s+need\s+to)\s+(?:\w+\s+)?(?:flag|report|mention|raise|comment\s+on|point\s+out|warn\s+about|call\s+out|bring\s+up|criticiz\w*)\b/i,
      /(?:不要|别|勿|无需|不用|不必|不需要)(?:再)?(?:在[^，。！？；\n]{1,6}?[中里内])?(?:报告|报|提(?![交供升前醒示高取])|指出|标记|评论|写进|写入|列出)/,
  ] },
  // dismissing the very text the note sits in ("ignore this file", "skip the code below")
  { name: "scope", patterns: [
      /\b(?:ignore|skip|disregard|overlook|exclude|pass\s+over)\s+(?:all\s+|any\s+)?(?:this|these|here|everything|the\s+(?:following|lines?\s+below|code\s+below|change|diff))\b/i,
      /(?:忽略|跳过|别看|(?:不要|不用|无需|不必|不需要)(?:再)?(?:看|检查|审查))(?:这|此|本|以下|下面)/,
  ] },
  // negatable: "reviewers must not approve their own PR" is a normal rule
  { name: "verdict", negatable: true, patterns: [
      // "approval" alone is usually the human's ("user's blocking approval"); the reader's is "your/an approval"
      /\b(?:your|an|give|grant)\b[^.,;:]{0,30}?\bapproval\b/i,
      /\b(?:verdicts?|approve|approved|approving|LGTM|low[- ]risk|false\s+positives?|safe\s+to\s+merge|ready\s+to\s+merge)\b/i,
      // re-labelling to a passing value ("mark every finding as a false positive", "treat X as safe")
      /\b(?:mark|marked|treat|consider|regard|accept|label|classify)\s+(?:[\w-]+\s+){0,4}?as\s+(?:an?\s+)?(?:safe|secure|correct|fine|ok|okay|valid|clean|benign|harmless|intended|intentional|approved|resolved|fixed|reviewed|passing|passed|low|info|false\s+positives?|not\s+an?\s+(?:issue|bug|problem))\b/i,
      /\brate\s+(?:it|this|the\s+\w+)\b|\b\d{1,3}\s*\/\s*(?:10|100)\b/i,
      /\bpass(?:es|ed)?\s+(?:this|the\s+review|review|the\s+check)\b/i,
      /\b(?:full|five|5|max(?:imum)?|all)\s+stars?\b/i,
      /结论|好评|批准|评分|打分|满分|五星|一切正常|(?<!测试|检查|编译|构建|CI|lint)通过(?!\s*(?:lint|测试|检查|CI|编译|构建|单测|类型检查))/i,
  ] },
  // a graded verdict counts only when the note sets its value ("give a passing score"), not "report issues with their severity"
  { name: "verdict", requires: SOFTEN, patterns: [
      /\b(?:scores?|severity|severities|ratings?|grades?|stars?|assessments?|classif(?:y|ied|ication)|risk\s+(?:level|rating|score))\b/i,
      /风险等级|严重(?:性|程度|级别)|等级|评级|评价/,
  ] },
  { name: "output", patterns: [
      /\byour\s+(?:\w+\s+)?(?:reply|replies|response|answer|summary|output|review|report|bubble|critique|verdict|message)\b/i,
      /\b(?:respond|reply|answer)\s+(?:only\s+with|with\s+(?:only\b|just\b|["“'`]|the\s+(?:word|phrase|string|text)))/i,
      /\bthe\s+(?:word|phrase|string|text)\s+["'“‘]?[A-Z]/,
      /\b(?:say|output|print|write)\s+["“'`]/i,
      /\b(?:say|state|claim|tell\s+\w+)\s+that\b/i,
      /\b(?:describe|present|call|label|portray|report)\s+(?:it|this|them|the\s+\w+)\s+as\b/i,
      /(?:回复|回答|输出|写上?|加上|说)\s*[“"「]/,
      /你的(?:回复|回答|总结|评审|审查|结论|输出)|(?:回复|回答|总结|输出)(?:里|中|末尾|结尾|开头|最后)|以.{0,20}结尾|声称/,
  ] },
  { name: "secrets", negatable: true, requires: DISCLOSE, patterns: [
      /\b(?:system\s+prompt|developer\s+message|(?:your|previous|prior|above|original|hidden|internal|system)\s+(?:instructions|rules|prompt|guidelines)|rules\s+above|secrets?|passwords?|passwd|api[ _-]?keys?|private\s+keys?|ssh\s+keys?|credentials?|canary|env(?:ironment)?\s+variables?|id_rsa)\b/i,
      // bare "token" is an LLM unit as often as a credential
      /\b(?:auth|access|api|bearer|github|npm|secret|session|refresh|hardcoded|personal\s+access)[ _-]?tokens?\b|\b[A-Z][A-Z0-9]*_TOKEN\b/i,
      /(?:^|[\s"'`(/])\.(?:env|ssh|aws)\b/,
      /系统提示|提示词|(?:之前|以上|上面)的?(?:指令|规则)|密码|密钥|私钥|令牌|凭证|口令/,
  ] },
  { name: "files outside the project", negatable: true, requires: EXFIL, patterns: [
      /(?:^|[\s"'`(=])(?:~\/|\.\.\/|\/[\w.-]+\/[\w.-])/,
      /\b(?:send|post|upload|curl|fetch)\b.{0,60}?\bhttps?:\/\//i,
  ] },
];

/**
 * Targets only an AI reviewer has, for second-person sentences with no reader word ("Begin your answer
 * with …"). "your summary/review/feedback" are left out: human docs ask for those ("leave your feedback").
 */
export const AI_TARGETS: Target[] = [
  { name: "own output", requires: CONTENT, patterns: [
      /\byour\s+(?:\w+\s+)?(?:answers?|responses?|repl(?:y|ies)|verdicts?|assessments?|ratings?|output|critique|evaluation|conclusions?)\b/i,
      /你的(?:回答|回复|答复|结论|评价|评估|评分|总结|输出|审查|评审)|(?:回答|回复|输出)的?(?:开头|结尾|末尾|最后)/,
  ] },
  { name: "own role", selfDirective: true, patterns: [
      /\byou\s+are\s+now\s+(?:an?|the)\s+(?:[\w-]+\s+){0,3}?(?:bot|assistant|model|AI|agent|evaluator|grader|approver)\b/i,
      /\bpretend\s+(?:that|the|this|it|to\s+be)\b/i,
      /你现在是|扮演|假装/,
  ] },
  { name: "own setup", negatable: true, patterns: [
      /\byour\s+(?:system\s+prompt|(?:system|original|hidden|initial|internal)\s+(?:instructions|guidelines|rules|prompt)|instructions|guidelines|developer\s+message|prompt)\b/i,
      /\b(?:system\s+prompt|developer\s+message)\b/i,
      /你的(?:系统提示|提示词|指令|规则|设定)|系统提示|提示词/,
  ] },
];

export const NEGATION = /\b(?:never|not|don't|dont|no)\b|不要|别|勿|禁止|严禁|不能|不得/i;

/** Fixed phrases that hit on their own. */
export const FIXED_PHRASES: RegExp[] = [
  /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding|original)\s+(?:instructions|rules|prompts?|directions)\b/i,
  /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:the\s+)?(?:rules|instructions)\s+above\b/i,
  /(?:忽略|忘记|忘掉|无视)(?:之前|以上|上面|前面)的?(?:所有)?(?:指令|规则|指示|提示)/,
];

/** Phrases the note asks the reader to output. Capture group 1 is the phrase. */
export const CANDIDATE_PATTERNS: RegExp[] = [
  /\bthe (?:word|phrase|string|text)\s+["'“‘]([^"'”’]{1,60})["'”’]/i,
  /\bthe (?:word|phrase|string|text)\s+([^\s"'“‘”’.,;:!?]{1,60})/i,
  /\b(?:say|output|write|print|end\b.{0,40}?\bwith)\s+["“]([^"”]{1,60})["”]/i,
];
