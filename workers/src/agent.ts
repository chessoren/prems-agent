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
 * Gemini 3.7 Flash, on Vertex AI.
 *
 * The path here was two wrong turns. `gemini-2.5-flash-lite` was chosen when
 * the work was pure writing and Flash-Lite was the cheapest model that wrote
 * idiomatic French; the note that came with it — "Gemini 3.5 Flash-Lite does
 * not exist, checked against the live endpoint" — was true of the *Flash-Lite*
 * variant and said nothing about the family, which is how this repository spent
 * a while two generations behind. 3.5 Flash was the correction. 3.7 Flash is
 * the current one, and the reason to take it is the same reason 2.5 Flash-Lite
 * had to go: the negotiator now chooses between four tools, and tool selection
 * is exactly where the smaller and older models are weakest.
 *
 * @see MODEL_LOCATION — the region is not a separate decision from the model.
 */
export const MODEL = process.env.GCP_MODEL ?? 'gemini-3.7-flash';

/**
 * Where each model is actually served from. Measured, not read.
 *
 * A model and its region are one decision, and this table is the only place
 * that pairing exists. Every line below was established by calling the live
 * endpoint on 2026-08-27 — `npm run gcp:models` — after two rounds of getting
 * it wrong from documentation:
 *
 *   gemini-3.7-flash   global only. 404 in every European region tried.
 *   gemini-3.5-flash   global, and europe-west3 (Frankfurt). Nowhere else in
 *                      Europe — not west9, west4, west1, north1, southwest1.
 *   gemini-2.5-flash   every European region tried, europe-west9 included.
 *
 * And the correction that matters most: **there is no `eu` endpoint.**
 * `eu-aiplatform.googleapis.com` answers 400 "Invalid hostname". The European
 * multi-region exists for Document AI, which is where the idea came from; it
 * does not exist for Vertex AI. A fallback documented here for two commits
 * would have failed on its first call.
 *
 * **The trade, in one line.** `gemini-3.7-flash` runs on the global endpoint,
 * which routes and processes anywhere in the world: no EU data residency, no
 * in-region ML processing. These prompts carry a named person's employment,
 * net monthly income, the days they are free, and their private correspondence
 * with a letting agency. Two ways back, both two variables and no code:
 *
 *   GCP_MODEL=gemini-3.5-flash GCP_MODEL_LOCATION=europe-west3   # EU, newest
 *   GCP_MODEL=gemini-2.5-flash GCP_MODEL_LOCATION=europe-west9   # Paris, with the jobs
 */
const SERVED_FROM: Record<string, string> = {
  'gemini-3.7-flash': 'global',
  'gemini-3.5-flash': 'europe-west3',
  'gemini-2.5-flash': 'europe-west9',
};

export const MODEL_LOCATION = process.env.GCP_MODEL_LOCATION ?? SERVED_FROM[MODEL] ?? 'global';

/**
 * One line in the logs of every run that talks to a model.
 *
 * A residency decision that is only visible in a source file is a residency
 * decision nobody re-examines. This puts it in Cloud Logging, on every run,
 * where an operator sees it without being asked to go and look.
 */
export function modelBanner(): string {
  const residency =
    MODEL_LOCATION === 'global'
      ? 'AUCUNE résidence des données — traitement mondial'
      : `données traitées en « ${MODEL_LOCATION} »`;
  return `modèle: ${MODEL} @ ${MODEL_LOCATION} — ${residency}`;
}

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
