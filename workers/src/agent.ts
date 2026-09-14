/**
 * The agent runtime: one place where a model is named, authenticated and run.
 *
 * Before this file, three workers each carried their own copy of the same forty
 * lines — sign a request by hand, POST it, dig a string out of the response.
 * Three copies meant three places to change the model, and three places where a
 * retry, a timeout or a tool call would have had to be written again.
 *
 * What replaced it is the Strands Agents SDK. The gain is not that the code is
 * shorter, though it is. It is that an agent can now be given *tools* and left
 * to decide which to call: the negotiator asks for the client's availability
 * rather than being handed it, so a slot it proposes is a slot it went and read.
 * What the model may do is a list of functions, not a paragraph of prose asking
 * it nicely.
 *
 * The model is Claude on Amazon Bedrock. Authentication is the AWS SDK's default
 * credential chain — an IAM role where one is attached, AWS_ACCESS_KEY_ID and
 * AWS_SECRET_ACCESS_KEY otherwise — and none of it is our code.
 */
import { Agent, BedrockModel } from '@strands-agents/sdk';
import type { AgentResult } from '@strands-agents/sdk';
import { GoogleGenAI } from '@google/genai';
import type { z } from 'zod';

/**
 * Claude Sonnet 5, through an EU cross-region inference profile.
 *
 * The `eu.` prefix keeps inference inside European Bedrock regions. These
 * prompts carry a named person's employment, net monthly income, the days they
 * are free and their private correspondence with a letting agency; keeping them
 * in the EU is the default, not an option. `global.anthropic.claude-sonnet-5`
 * trades that for capacity — one variable, no code.
 *
 * `npm run bedrock:models` checks which of these actually answer from the
 * configured account and region.
 */
export const MODEL = process.env.BEDROCK_MODEL_ID ?? 'eu.anthropic.claude-sonnet-5';

/** Paris, like the clients. Where Bedrock is called from. */
export const MODEL_REGION = process.env.AWS_REGION ?? 'eu-west-3';

/**
 * One line in the logs of every run that talks to a model.
 *
 * A residency decision that is only visible in a source file is a residency
 * decision nobody re-examines.
 */
export function modelBanner(): string {
  const residency = MODEL.startsWith('eu.')
    ? 'inférence dans les régions Bedrock européennes'
    : MODEL.startsWith('global.')
      ? 'AUCUNE résidence des données — routage mondial'
      : `inférence en « ${MODEL_REGION} »`;
  return `modèle: ${MODEL} via Amazon Bedrock (${MODEL_REGION}) — ${residency}`;
}

/**
 * The model, bound to Bedrock.
 *
 * No temperature: Claude Sonnet 5 rejects sampling parameters, and adaptive
 * thinking decides how much to reason. `maxTokens` is generous for the same
 * reason — thinking counts against it, and a truncated turn is a failed turn.
 */
export function bedrock(maxTokens = 8_000): BedrockModel {
  return new BedrockModel({ modelId: MODEL, region: MODEL_REGION, maxTokens });
}

/**
 * The embedding model is a separate decision and stays where it was.
 *
 * Embeddings are not agent turns: they are a vector per listing, stored in a
 * `vector(768)` column. `text-multilingual-embedding-002` on Vertex AI produced
 * every vector in the catalogue; changing it means a migration and re-embedding
 * everything, for no gain in what the agents decide.
 */
export const EMBEDDING_MODEL = 'text-multilingual-embedding-002';

/** Where the embedding model is served from. */
export const LOCATION = process.env.GCP_REGION ?? 'europe-west9';

/** The raw Vertex client, for embeddings only. */
export function genai(project: string): GoogleGenAI {
  return new GoogleGenAI({ vertexai: true, project, location: LOCATION });
}

/** What one agent turn produced. */
export interface AgentRun {
  /** The final text, or null if the agent ended on a tool call and said nothing. */
  readonly text: string | null;
  /** Every tool the agent called, in order. Recorded so a decision can be explained. */
  readonly toolCalls: readonly string[];
  /** The validated answer, when the agent was built with a `structuredOutputSchema`. */
  readonly structured?: unknown;
}

/**
 * Run one agent to completion and return what it said and what it did.
 *
 * Ephemeral by design: callers build a fresh `Agent` for every invocation, and
 * the conversation that matters — the one with the agency — already lives in
 * `messages`, which is the copy the client can read. A second, hidden history
 * inside the runtime would be a second source of truth.
 */
export async function runAgent(params: {
  agent: Agent;
  prompt: string;
  timeoutMs?: number;
}): Promise<AgentRun> {
  const { agent, prompt, timeoutMs = 30_000 } = params;

  const result: AgentResult = await agent.invoke(prompt, {
    cancelSignal: AbortSignal.timeout(timeoutMs),
  });
  // A cancelled turn is not an answer. Callers have a fallback for a throw; they
  // have none for half a decision.
  if (result.stopReason === 'cancelled') {
    throw new Error(`agent ${agent.name}: délai de ${timeoutMs} ms dépassé`);
  }

  const toolCalls: string[] = [];
  for (const message of agent.messages) {
    for (const block of message.content) {
      if (block.type === 'toolUseBlock') toolCalls.push(block.name);
    }
  }

  let text = '';
  for (const block of result.lastMessage.content) {
    if (block.type === 'textBlock') text += block.text;
  }

  return { text: text.trim() || null, toolCalls, structured: result.structuredOutput };
}

/**
 * Run an agent whose answer is validated against a schema — or null.
 *
 * Null rather than a throw, because every caller here has a fallback that is
 * better than an exception: a plainly written e-mail, or a message classed as
 * `other`. A malformed answer is an outcome, not an incident.
 */
export async function runAgentStructured<S extends z.ZodType>(params: {
  agent: Agent;
  schema: S;
  prompt: string;
  timeoutMs?: number;
}): Promise<z.infer<S> | null> {
  try {
    const { structured, text } = await runAgent(params);
    if (structured !== undefined) return params.schema.parse(structured);
    if (!text) return null;
    return params.schema.parse(JSON.parse(stripFence(text)));
  } catch {
    return null;
  }
}

/**
 * One real turn against one model ID, for `npm run bedrock:models`.
 *
 * A model ID read from documentation is a guess until the account and region
 * have answered it. This is the same client and credential chain the agents use.
 */
export async function probeModel(modelId: string): Promise<string | null> {
  const agent = new Agent({
    name: 'prems_probe',
    model: new BedrockModel({ modelId, region: MODEL_REGION, maxTokens: 2_000 }),
    printer: false,
  });
  const { text } = await runAgent({ agent, prompt: 'Réponds uniquement : OK', timeoutMs: 60_000 });
  return text;
}

/**
 * Undo a Markdown fence around JSON.
 *
 * Structured output makes this unnecessary almost always. Almost is the
 * operative word, and the cost of being wrong is an application that silently
 * degrades to the flat template.
 */
export function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
}
