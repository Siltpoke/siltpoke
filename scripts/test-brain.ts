import { join } from "node:path";
import { loadPersonality, buildSystemPrompt } from "../src/brain/personality";
import { callBrain, BrainError } from "../src/brain/brain";

const FAKE_CONTEXT_BUNDLE = `
<transcript>
User asked: "Look at queries.py and tell me if the JOIN handles NULL right."
Claude replied: "Yes, the JOIN looks correct. NULL handling is standard."
</transcript>

<code_excerpt path="queries.py" lines="44-52">
def fetch_users(role: str):
    return db.execute(
        """
        SELECT u.id, u.name, p.bio
        FROM users u
        JOIN profiles p ON p.user_id = u.id
        WHERE u.role = :role
        """,
        {"role": role},
    )
</code_excerpt>

<task>
Review whether Claude's "NULL handling is standard" claim is correct given
this code. If you find a real issue, cite the file:line. If you're unsure,
say so with severity=info.
</task>
`;

async function main(): Promise<void> {
  const basePath = join(process.env.HOME ?? "", ".siltpoke");
  const personality = await loadPersonality(basePath);
  const systemPrompt = await buildSystemPrompt(personality);

  try {
    const { output, usage } = await callBrain({
      systemPrompt,
      contextBundle: FAKE_CONTEXT_BUNDLE,
    });
  } catch (err) {
    if (err instanceof BrainError) {
      console.error(`[test-brain] BrainError: ${err.message}`);
      if (err.cause) console.error(`  cause: ${err.cause}`);
    } else {
      console.error("[test-brain] unexpected:", err);
    }
    process.exit(1);
  }
}

await main();
