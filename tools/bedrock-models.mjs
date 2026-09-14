/**
 * Which Claude model IDs actually answer on Amazon Bedrock, from this account
 * and this region — measured, not read.
 *
 * Runs one real Strands agent turn per candidate, through the exact client and
 * credential chain the workers use (`workers/dist/agent.js`).
 *
 *   npm run bedrock:models
 *   npm run bedrock:models -- --strict   # exit 1 unless BEDROCK_MODEL_ID answers
 *
 * Needs AWS credentials (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or a profile)
 * with bedrock:InvokeModel and model access granted for Anthropic models.
 */
const { MODEL, MODEL_REGION, probeModel } = await import('../workers/dist/agent.js');

const candidates = [
  ...new Set([
    MODEL,
    'eu.anthropic.claude-sonnet-5',
    'global.anthropic.claude-sonnet-5',
    'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
  ]),
];

console.log(`\nBedrock · région ${MODEL_REGION} · configuré : ${MODEL}\n`);

let configuredOk = false;
for (const id of candidates) {
  const started = Date.now();
  try {
    const text = await probeModel(id);
    console.log(`✓  ${id.padEnd(34)} ${Date.now() - started} ms · « ${String(text).slice(0, 20)} »`);
    if (id === MODEL) configuredOk = true;
  } catch (error) {
    const reason = String(error?.message ?? error).split('\n')[0].slice(0, 110);
    console.log(`✗  ${id.padEnd(34)} ${reason}`);
  }
}

if (!configuredOk) {
  console.log(`\nLe modèle configuré ne répond pas. Choisissez un ID marqué ✓ : BEDROCK_MODEL_ID=…`);
  if (process.argv.includes('--strict')) process.exit(1);
}
