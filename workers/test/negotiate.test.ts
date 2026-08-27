/**
 * The guardrails around the one agent that has tools.
 *
 * What is pinned here is not the writing - that is the model's job and it
 * changes - but the four cases where the system must override the agent. Each
 * one is a message that would otherwise go out from a client's own mailbox,
 * with their name on it, saying something they cannot honour.
 *
 * The model is replaced by a script: a list of tool calls, in order, exactly as
 * a real turn would produce them. That is enough, because every rule under test
 * is a rule about what the agent *did*, not about what it wrote.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FunctionTool, LlmAgent } from '@google/adk';

/** What the scripted agent will do on the next call, set per test. */
let script: Array<{ tool: string; args?: Record<string, unknown> }> = [];

vi.mock('../src/agent.js', () => ({
  MODEL: 'test-model',
  EMBEDDING_MODEL: 'test-embedding-model',
  LOCATION: 'europe-west9',
  gemini: () => 'test-model',
  genai: () => {
    throw new Error('unused');
  },
  // Plays the script against the agent's real tools, so the sink, the argument
  // validation and the idempotence of `queue_reply` are the production ones.
  runAgent: async ({ agent }: { agent: LlmAgent }) => {
    const byName = new Map((agent.tools as FunctionTool[]).map((t) => [t.name, t] as const));
    const toolCalls: string[] = [];
    for (const step of script) {
      const tool = byName.get(step.tool);
      if (!tool) throw new Error(`l'agent n'a pas d'outil ${step.tool}`);
      await tool.runAsync({ args: step.args ?? {}, toolContext: undefined as never });
      toolCalls.push(step.tool);
    }
    return { text: null, toolCalls };
  },
}));

const { fallbackReply, readableAvailability, writeReply } = await import('../src/negotiate.js');

const input = (over: Partial<Parameters<typeof writeReply>[0]> = {}) => ({
  agencyMessage: 'Bonjour, souhaitez-vous visiter ?',
  history: [],
  availability: ['mar-aprem', 'jeu-aprem'],
  firstName: 'Camille',
  lastName: 'Roux',
  city: 'Montreuil',
  rooms: 2,
  rentEur: 1100,
  hasDossier: true,
  employment: 'CDI',
  monthlyIncomeEur: 3600,
  kind: 'question',
  ...over,
});

beforeEach(() => {
  script = [];
});

describe('readableAvailability', () => {
  it('groups windows by day, in the order of the week', () => {
    expect(readableAvailability(['jeu-aprem', 'mar-matin', 'mar-aprem'])).toBe(
      "mardi le matin (9h-12h) ou l'après-midi (14h-18h) et jeudi l'après-midi (14h-18h)",
    );
  });

  it('is null when nothing usable was saved', () => {
    expect(readableAvailability([])).toBeNull();
    expect(readableAvailability(['n’importe quoi'])).toBeNull();
  });
});

describe('writeReply', () => {
  it('never answers a refusal, and never even builds an agent for one', async () => {
    script = [{ tool: 'queue_reply', args: { body: 'et pourtant' } }];
    const decision = await writeReply(input({ kind: 'refused' }), 'p');

    expect(decision.body).toBeNull();
    // The gate is in code, before the model: nothing ran.
    expect(decision.toolCalls).toEqual([]);
  });

  it('returns what the agent queued, once it has read the availability', async () => {
    script = [
      { tool: 'get_client_availability' },
      { tool: 'queue_reply', args: { body: 'Bonjour,\n\nMardi après-midi me convient.' } },
    ];
    const decision = await writeReply(input(), 'p');

    expect(decision.body).toContain('Mardi après-midi');
    expect(decision.toolCalls).toEqual(['get_client_availability', 'queue_reply']);
  });

  it('falls back when the client had slots and the agent never looked at them', async () => {
    script = [{ tool: 'queue_reply', args: { body: 'Je suis libre lundi matin.' } }];
    const decision = await writeReply(input(), 'p');

    // A day nobody is free, written confidently, is the failure the tool exists
    // to expose. The flat reply proposes the real slots instead.
    expect(decision.body).toBe(fallbackReply(input()));
    expect(decision.body).toContain("mardi l'après-midi");
  });

  it('keeps a deliberate stand-down, and only a deliberate one', async () => {
    script = [{ tool: 'stand_down', args: { raison: 'accusé de réception automatique' } }];
    expect((await writeReply(input(), 'p')).body).toBeNull();

    // An empty turn is not a decision: the agent said nothing and called
    // nothing, which must not read as "it chose silence".
    script = [];
    expect((await writeReply(input(), 'p')).body).toBe(fallbackReply(input()));
  });

  it('refuses a calendar date invented for a client with no availability', async () => {
    const noSlots = input({ availability: [] });
    script = [
      { tool: 'get_client_availability' },
      { tool: 'queue_reply', args: { body: 'Je peux passer le 14 septembre à 15h.' } },
    ];

    expect((await writeReply(noSlots, 'p')).body).toBe(fallbackReply(noSlots));
  });

  it('sends once when the agent calls the terminal action twice', async () => {
    script = [
      { tool: 'get_client_availability' },
      { tool: 'queue_reply', args: { body: 'Le premier message.' } },
      { tool: 'queue_reply', args: { body: 'Le second, qui ne doit pas gagner.' } },
    ];

    expect((await writeReply(input(), 'p')).body).toBe('Le premier message.');
  });
});
