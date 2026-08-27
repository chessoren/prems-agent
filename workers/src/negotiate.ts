/**
 * Answering the agency, with a date the client can actually keep.
 *
 * This is the part that turns a reply into a viewing. An agent that writes
 * "je suis disponible quand vous voulez" makes the agency do the work and gets
 * answered last; an agent that names three concrete windows gets a slot.
 *
 * It can only do that because availability now lives in the database rather
 * than in the browser. That was the blocking gap: a worker running at eight in
 * the morning cannot read localStorage, so the agent could ask for a visit but
 * never propose a time.
 *
 * Two rules bound what it may do on its own, and both exist because the cost of
 * being wrong is borne by the client, not by us:
 *
 *  - It never invents availability. If the client has saved none, it says so
 *    plainly and asks the agency to propose - which is still better than
 *    silence, and is honest.
 *  - It never argues. A refusal ends the thread. Pushing back on an agency that
 *    has said no is how a client's own address gets marked as spam.
 *
 * This is the one agent here that has tools, and the reason is the first rule.
 * Availability used to be interpolated into the prompt, which meant a model that
 * ignored it produced a plausible sentence naming a day nobody was free — and
 * nothing downstream could tell that apart from a real proposal. Now the slots
 * are behind `get_client_availability`, the facts behind `get_client_facts`, and
 * a reply is a call to `queue_reply`. What the agent may do is a list of four
 * functions, and which ones it actually called is recorded next to the message
 * it produced, so "why did it propose Tuesday?" has an answer that is not a
 * guess about what the model was thinking.
 *
 * The tools read. They do not send: `queue_reply` hands the text back to the
 * caller, which puts it in the same outbox a client's own reply goes through.
 * One path out of this system, one place a send can fail.
 */
import { FunctionTool, LlmAgent } from '@google/adk';
import { z } from 'zod';

import { gemini, runAgent } from './agent.js';

/** The slot vocabulary the interface writes, decoded once here. */
const DAYS: Record<string, string> = {
  lun: 'lundi',
  mar: 'mardi',
  mer: 'mercredi',
  jeu: 'jeudi',
  ven: 'vendredi',
  sam: 'samedi',
  dim: 'dimanche',
};

const WINDOWS: Record<string, string> = {
  matin: 'le matin (9h-12h)',
  midi: 'entre 12h et 14h',
  aprem: "l'après-midi (14h-18h)",
  soir: 'en fin de journée (18h-20h)',
  // The calendar tab also writes bare hours, e.g. `mar-18`.
};

/**
 * Turn saved slots into a sentence a human would write.
 *
 * Grouped by day rather than listed flat: "mardi et jeudi après-midi, samedi
 * matin" is read in one glance, where six bullet points is a form to process.
 */
export function readableAvailability(slots: readonly string[]): string | null {
  if (!slots?.length) return null;

  const byDay = new Map<string, string[]>();
  for (const slot of slots) {
    const [day, rest] = String(slot).split('-');
    if (!day || !rest || !DAYS[day]) continue;
    const label = WINDOWS[rest] ?? (/^\d{1,2}$/.test(rest) ? `à ${rest}h` : null);
    if (!label) continue;
    const list = byDay.get(day) ?? [];
    if (!list.includes(label)) list.push(label);
    byDay.set(day, list);
  }
  if (byDay.size === 0) return null;

  const order = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];
  const parts = order
    .filter((d) => byDay.has(d))
    .map((d) => `${DAYS[d]} ${byDay.get(d)!.join(' ou ')}`);

  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} et ${parts.at(-1)}`;
}

export interface NegotiateInput {
  /** What the agency just wrote. */
  readonly agencyMessage: string;
  /** What has been said so far, oldest first, as "role: text". */
  readonly history: readonly string[];
  readonly availability: readonly string[];
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly city: string | null;
  readonly rooms: number | null;
  readonly rentEur: number | null;
  readonly hasDossier: boolean;
  readonly employment: string | null;
  readonly monthlyIncomeEur: number | null;
  /** 'question' | 'visit_offered' | 'other' - what the classifier decided. */
  readonly kind: string;
}

/**
 * A plain reply, used when Vertex is unavailable.
 *
 * The alternative is not replying, which loses the apartment for a reason the
 * client would never accept.
 */
export function fallbackReply(input: NegotiateInput): string {
  const slots = readableAvailability(input.availability);
  const name = [input.firstName, input.lastName].filter(Boolean).join(' ');
  return (
    'Bonjour,\n\n' +
    'Merci pour votre retour.\n\n' +
    (slots
      ? `Je suis disponible ${slots}. Dites-moi ce qui vous arrange et je m'organise.`
      : 'Je peux me rendre disponible rapidement — proposez-moi un créneau qui vous convient.') +
    `\n\nBien à vous,\n${name}`
  );
}

/**
 * The instruction: what the negotiator is, minus anything case-specific.
 *
 * Everything it is allowed to assert about the client now comes from a tool
 * call, so the instruction can say the one thing that matters — go and look —
 * instead of carrying facts that may not apply to this thread.
 */
const NEGOTIATOR_INSTRUCTION = `Tu écris la réponse d'un particulier à une agence immobilière, dans une conversation en cours au sujet d'un logement qu'il veut visiter. Le message part de sa boîte mail et porte son nom.

Ton objectif unique : obtenir une date de visite. Rien d'autre.

Procédure, dans cet ordre :
1. Appelle get_client_availability pour savoir quand le candidat peut visiter.
2. Appelle get_client_facts si l'agence pose une question sur le candidat.
3. Rédige, puis appelle queue_reply avec le message — ou stand_down si aucune réponse n'est utile.

Règles de rédaction :
- 70 mots maximum. Une agence lit trois lignes.
- Réponds précisément à ce qu'elle vient d'écrire. Si elle pose une question, réponds-y d'abord, en une phrase.
- Ne propose que des créneaux rendus par get_client_availability. N'en invente aucun autre, ne donne pas de date calendaire précise (pas de "le 14"), reste sur les jours et les moments. Si l'outil ne rend aucune disponibilité, ne prétends pas en avoir : demande à l'agence de proposer un créneau, en te disant assez souple.
- N'écris sur le candidat que ce que get_client_facts a rendu. Si l'agence demande autre chose — garant, date d'entrée, animal, composition du foyer — ne le fabrique pas : écris que tu le transmets dans la journée. Un mail envoyé au nom de quelqu'un ne peut pas contenir un fait inventé à son sujet.
- Ton neutre, poli, direct. Aucun superlatif, aucune relance insistante.
- Ne mentionne ni Prems, ni outil, ni automatisation, ni IA.
- Termine par une formule courte et la signature du candidat.

N'appelle queue_reply ou stand_down qu'une seule fois : c'est la fin de ton tour.`;

/**
 * The agent, its tools bound to one thread.
 *
 * Rebuilt per call rather than cached, because the tools close over *this*
 * client and *this* listing. A cached agent would be one bug away from
 * proposing one client's availability to another client's agency.
 */
function negotiator(
  input: NegotiateInput,
  project: string,
  sink: { reply: string | null },
): LlmAgent {
  const slots = readableAvailability(input.availability);

  const getAvailability = new FunctionTool({
    name: 'get_client_availability',
    description:
      "Les créneaux où le candidat peut visiter, tels qu'il les a enregistrés. À appeler avant toute proposition de date.",
    execute: () =>
      slots
        ? { available: true, creneaux: slots }
        : {
            available: false,
            consigne:
              "Le candidat n'a enregistré aucune disponibilité. Demande à l'agence de proposer un créneau.",
          },
  });

  const getFacts = new FunctionTool({
    name: 'get_client_facts',
    description:
      'Les faits connus sur le candidat. Un champ absent est une information dont nous ne disposons pas et qui ne doit pas être écrite.',
    execute: () => ({
      nom: [input.firstName, input.lastName].filter(Boolean).join(' ') || null,
      situation_professionnelle: input.employment,
      revenu_mensuel_net_eur: input.monthlyIncomeEur,
      dossier_complet_disponible: input.hasDossier,
      bien: {
        ville: input.city,
        pieces: input.rooms,
        loyer_mensuel_eur: input.rentEur,
      },
    }),
  });

  const queueReply = new FunctionTool({
    name: 'queue_reply',
    description:
      "Met le message en file d'envoi vers l'agence. C'est l'action finale : ne l'appelle qu'une fois, avec le message complet.",
    parameters: z.object({
      body: z.string().describe('Le message, signature comprise.'),
    }),
    // Idempotent on purpose. A model that calls the terminal action twice must
    // not be able to send twice; the second call is told so rather than
    // silently overwriting the first.
    execute: ({ body }) => {
      if (sink.reply !== null)
        return { queued: false, raison: 'un message a déjà été mis en file' };
      sink.reply = body.trim();
      return { queued: true };
    },
  });

  const standDown = new FunctionTool({
    name: 'stand_down',
    description:
      "N'envoie rien. À utiliser quand aucune réponse n'est utile : un refus, un accusé de réception automatique, un message hors sujet.",
    parameters: z.object({
      raison: z.string().describe('Pourquoi il ne faut rien envoyer.'),
    }),
    execute: ({ raison }) => ({ acknowledged: true, raison }),
  });

  return new LlmAgent({
    name: 'prems_negotiator',
    model: gemini(project),
    description: 'Répond à une agence immobilière au nom du candidat, pour obtenir une visite.',
    instruction: NEGOTIATOR_INSTRUCTION,
    generateContentConfig: { temperature: 0.3, maxOutputTokens: 500 },
    tools: [getAvailability, getFacts, queueReply, standDown],
  });
}

/**
 * What the agent decided, and how it got there.
 *
 * `toolCalls` is not decoration: it is the difference between a slot the agent
 * read and a slot it produced, and it is what gets written next to the message
 * in the event log. A decision nobody can reconstruct is a decision nobody can
 * defend to the client whose name is on the mail.
 */
export interface ReplyDecision {
  /** The message to queue, or null when nothing should be sent. */
  readonly body: string | null;
  /** Every tool the agent called, in order. Empty when it never ran. */
  readonly toolCalls: readonly string[];
}

/** Nothing to send, and no agent involved in deciding that. */
const SILENCE: ReplyDecision = { body: null, toolCalls: [] };

/**
 * Write the next message in the thread.
 *
 * The body is null when nothing should be sent — a refusal, a stand-down, or a
 * turn the agent ended without deciding. Silence is a valid move; a reply that
 * says nothing is not.
 */
export async function writeReply(input: NegotiateInput, project: string): Promise<ReplyDecision> {
  // Not a prompt instruction. A refusal ends the thread before the agent is
  // built, because a rule the model could talk itself out of is not a rule.
  if (input.kind === 'refused') return SILENCE;

  const slots = readableAvailability(input.availability);
  const sink: { reply: string | null } = { reply: null };

  const message = `Historique de la conversation (du plus ancien au plus récent) :
${input.history.slice(-6).join('\n---\n').slice(0, 4000)}

Dernier message de l'agence, auquel tu réponds :
${input.agencyMessage.slice(0, 3000)}`;

  let toolCalls: readonly string[] = [];
  try {
    ({ toolCalls } = await runAgent({
      agent: negotiator(input, project, sink),
      prompt: message,
      timeoutMs: 30_000,
    }));
  } catch {
    return { body: fallbackReply(input), toolCalls: [] };
  }

  // An explicit stand-down is a decision, and it is kept. An empty turn is not:
  // the agent said nothing and called nothing, which is a failure wearing the
  // costume of a choice.
  if (sink.reply === null) {
    return {
      body: toolCalls.includes('stand_down') ? null : fallbackReply(input),
      toolCalls,
    };
  }

  // The client had availability and the agent never went to read it. Whatever
  // it wrote about dates, it did not get them from here — which is exactly the
  // failure the tools exist to make visible.
  if (slots && !toolCalls.includes('get_client_availability')) {
    return { body: fallbackReply(input), toolCalls };
  }

  // A model that starts inventing calendar dates has stopped using the
  // availability it was given, and a date the client cannot keep is worse than
  // no date at all.
  if (!slots && MONTH.test(sink.reply)) return { body: fallbackReply(input), toolCalls };

  return { body: sink.reply, toolCalls };
}

/** A calendar date in French. Written out once, because it is used as a guard. */
const MONTH =
  /\b\d{1,2}\s?(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)/i;
