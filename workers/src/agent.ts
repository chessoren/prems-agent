/**
 * The agent runtime: one place where a model is named, authenticated and run.
 *
 * Before this file, three workers each carried their own copy of the same forty
 * lines — sign a JWT by hand, exchange it for a token, POST to the Vertex REST
 * endpoint, dig a string out of `candidates[0].content.parts[0].text`. Three
 * copies meant three places to change the model, and three places where a
 * retry, a timeout or a tool call would have had to be written again.
 *
 * What replaced it is the Agent Development Kit. The gain is not that the code
 * is shorter, though it is. It is that an agent can now be given *tools* and
 * left to decide which to call: the negotiator asks for the client's
 * availability rather than being handed it, so a slot it proposes is a slot it
 * went and read. What the model may do is a list of functions, not a paragraph
 * of prose asking it nicely.
 *
 * Authentication is Application Default Credentials, which is what Cloud Run
 * already gives the container. The signed-JWT path is gone: locally,
 * `gcloud auth application-default login` or GOOGLE_APPLICATION_CREDENTIALS
 * covers the same ground, and neither one is our code.
 */
import { Gemini, InMemoryRunner, isFinalResponse } from '@google/adk';
import type { Event, LlmAgent } from '@google/adk';
import { GoogleGenAI } from '@google/genai';

/**
 * Paris, like the jobs themselves and everything else that holds client data.
 *
 * Overridable because a region that runs out of a model's capacity is a real
 * failure mode, and moving the workers is a deployment, not a code change.
 */
export const LOCATION = process.env.GCP_REGION ?? 'europe-west9';

/**
 * The Gemini calls go to the European multi-region, not to Paris.
 *
 * This is the same split already made for Document AI, and for the same reason:
 * `europe-west9` is not offered as a location for the thing being called. The
 * Gemini 3.x family is served from `eu`, the European multi-region, and is not
 * documented as available from the Paris single region. `eu` keeps the request
 * inside the European Union, which is the constraint that actually applies —
 * unlike `global`, which would not.
 *
 * Read from the environment so a deploy can move it without a build. **Confirm
 * against the live endpoint before deploying** (`docs/RUNBOOK.md`, §4): this
 * value comes from Google's documentation, and the last time a model name in
 * this repository was taken from documentation alone it was wrong.
 */
export const MODEL_LOCATION = process.env.GCP_MODEL_LOCATION ?? 'eu';

/**
 * Gemini 3.5 Flash, on Vertex AI.
 *
 * It replaces `gemini-2.5-flash-lite`, which was chosen when Flash-Lite was the
 * cheapest model that wrote idiomatic French and the work was pure writing. Two
 * things changed. The agent now calls tools and has to choose between them,
 * which is where the smaller model was weakest; and 3.5 Flash is the first
 * Flash-tier model with parallel agentic execution, so the negotiator can read
 * availability and the client's file in one turn instead of three.
 *
 * The per-token price is higher. The volume is not per run: one call per
 * application written and one per reply received, against a scrape that runs
 * every minute and never touches a model at all.
 */
export const MODEL = 'gemini-3.5-flash';

/**
 * The embedding model is a separate decision and stays where it was.
 *
 * 768 dimensions, multilingual, verified against the live endpoint. The corpus
 * is French; a newer English-first model would be the wrong tool sold as an
 * upgrade, and changing it means re-embedding the whole catalogue.
 */
export const EMBEDDING_MODEL = 'text-multilingual-embedding-002';

/** The model, bound to Vertex in our project, in the region that serves it. */
export function gemini(project: string): Gemini {
  return new Gemini({
    model: MODEL,
    vertexai: true,
    project,
    location: MODEL_LOCATION,
  });
}

/**
 * The raw SDK client, for the calls that are not agent turns — embeddings.
 *
 * Paris, not `eu`: the embedding model is served from the single region and has
 * been running there since the first backfill. Moving it would mean re-embedding
 * the catalogue to no purpose.
 */
export function genai(project: string): GoogleGenAI {
  return new GoogleGenAI({ vertexai: true, project, location: LOCATION });
}

/** What one agent turn produced. */
export interface AgentRun {
  /** The final text, or null if the agent ended on a tool call and said nothing. */
  readonly text: string | null;
  /** Every tool the agent called, in order. Recorded so a decision can be explained. */
  readonly toolCalls: readonly string[];
}

/**
 * Run one agent to completion and return what it said and what it did.
 *
 * Ephemeral by design: each application and each reply is its own invocation,
 * and the conversation that matters — the one with the agency — already lives in
 * `messages`, which is the copy the client can read. A second, hidden history
 * inside the runtime would be a second source of truth.
 */
export async function runAgent(params: {
  agent: LlmAgent;
  prompt: string;
  /** Whose behalf this runs on. Ends up in the trace; never in a prompt. */
  userId?: string;
  timeoutMs?: number;
}): Promise<AgentRun> {
  const { agent, prompt, userId = 'prems', timeoutMs = 30_000 } = params;

  const runner = new InMemoryRunner({ agent, appName: agent.name });
  const session = await runner.sessionService.createSession({
    appName: runner.appName,
    userId,
  });

  const toolCalls: string[] = [];
  let text = '';

  const events: AsyncGenerator<Event> = runner.runAsync({
    userId,
    sessionId: session.id,
    newMessage: { role: 'user', parts: [{ text: prompt }] },
    abortSignal: AbortSignal.timeout(timeoutMs),
  });

  for await (const event of events) {
    for (const part of event.content?.parts ?? []) {
      if (part.functionCall?.name) toolCalls.push(part.functionCall.name);
    }
    if (isFinalResponse(event)) {
      for (const part of event.content?.parts ?? []) if (part.text) text += part.text;
    }
  }

  return { text: text.trim() || null, toolCalls };
}

/**
 * Run an agent whose answer is JSON, and return it parsed — or null.
 *
 * Null rather than a throw, because every caller here has a fallback that is
 * better than an exception: a plainly written e-mail, or a message classed as
 * `other`. A malformed answer is an outcome, not an incident.
 */
export async function runAgentJson<T>(params: {
  agent: LlmAgent;
  prompt: string;
  userId?: string;
  timeoutMs?: number;
}): Promise<T | null> {
  try {
    const { text } = await runAgent(params);
    if (!text) return null;
    return JSON.parse(stripFence(text)) as T;
  } catch {
    return null;
  }
}

/**
 * Undo a Markdown fence around JSON.
 *
 * `responseMimeType: application/json` makes this unnecessary almost always.
 * Almost is the operative word, and the cost of being wrong is an application
 * that silently degrades to the flat template.
 */
export function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
}
