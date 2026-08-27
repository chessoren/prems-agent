/**
 * Writing the application.
 *
 * The message goes out from the client's own mailbox with their name on it, so
 * it has to read like something they wrote. Three rules shape the prompt, and
 * each exists because its opposite is what makes automated mail obvious:
 *
 *  - Short. An agent triaging forty replies reads the first three lines.
 *  - Specific. Naming the actual apartment proves it was not a blast.
 *  - No superlatives. "Je serais ravi de découvrir ce bien d'exception" is how
 *    a template announces itself.
 *
 * The model is Gemini 3.5 Flash, on Vertex AI, reached through the Agent
 * Development Kit rather than by hand (see `agent.ts`). The writer is a plain
 * agent with no tools: everything it may say is in the prompt, and giving it a
 * way to go and read more would only widen what it can get wrong.
 */
import { LlmAgent } from '@google/adk';
import { z } from 'zod';

import { gemini, runAgentJson } from './agent.js';

export interface DraftInput {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly employment: string | null;
  readonly monthlyIncomeEur: number | null;
  readonly hasGuarantor: boolean;
  readonly city: string | null;
  readonly rooms: number | null;
  readonly surfaceM2: number | null;
  readonly rentEur: number;
  readonly title: string | null;
  readonly agencyName: string | null;
  readonly hasDossier: boolean;
}

export interface Draft {
  readonly subject: string;
  readonly body: string;
}

/**
 * A message that does not depend on the model being available.
 *
 * If Vertex is down, an application still goes out - a plain, correct, slightly
 * flatter one. Refusing to write to the agency because the copywriter was
 * unavailable would cost the client the apartment for no reason.
 */
export function fallbackDraft(input: DraftInput): Draft {
  const name = [input.firstName, input.lastName].filter(Boolean).join(' ') || 'Un candidat';
  const what = [
    input.rooms ? `${input.rooms} pièces` : null,
    input.surfaceM2 ? `${Math.round(input.surfaceM2)} m²` : null,
    input.city,
  ]
    .filter(Boolean)
    .join(', ');

  return {
    subject: `Demande de visite — ${what || input.title || 'votre annonce'}`,
    body:
      `Bonjour,\n\n` +
      `Je suis intéressé${input.firstName ? '' : '(e)'} par votre annonce${what ? ` (${what})` : ''} ` +
      `à ${input.rentEur} € par mois, et je souhaiterais organiser une visite.\n\n` +
      (input.monthlyIncomeEur
        ? `Je suis ${input.employment ?? 'en activité'}, avec un revenu net mensuel de ` +
          `${input.monthlyIncomeEur} €${input.hasGuarantor ? ', et je dispose d’un garant' : ''}.\n\n`
        : '') +
      `Mon dossier est complet et disponible immédiatement.\n\n` +
      `Merci d’avance,\n${name}`,
  };
}

/**
 * The rules, which do not change from one application to the next.
 *
 * They belong in the agent's instruction rather than in the message: the
 * instruction is what the agent *is*, the message is the case in front of it.
 * Keeping that split honest is what makes the prompt reviewable — every line
 * below is here because its opposite was observed in a real draft.
 */
const WRITER_INSTRUCTION = `Tu écris, à la première personne, l'e-mail par lequel un particulier demande à visiter un logement. Il part de sa propre boîte mail et porte son nom : il doit se lire comme un message écrit à la main, un soir, par quelqu'un qui veut cet appartement.

Ce qui fait qu'une agence répond :
- Elle reçoit quarante messages par jour et lit les trois premières lignes. 80 mots maximum.
- Elle doit reconnaître SON annonce en une seconde : cite le type de bien, la ville et le loyer. Jamais le titre brut de l'annonce, surtout s'il est en majuscules — le recopier est la signature d'un envoi automatique.
- Elle cherche un dossier solide. Donne la situation professionnelle et le revenu en une phrase de français normal, pas en liste.
- Elle veut une date. Termine par une demande de visite, en te disant disponible en semaine comme le week-end.

Interdits, chacun pour une raison :
- Ne JAMAIS mentionner ce que le candidat n'a pas. Pas de garant, pas de CDI, revenu modeste : on ne le signale pas. Personne n'annonce sa propre faiblesse dans une candidature, et l'agence le demandera si elle veut le savoir.
- Aucun superlatif, aucune formule commerciale ("bien d'exception", "je serais ravi"), aucune flatterie.
- N'invente rien : pas de date précise, pas de profession, pas de détail absent des données.
- Ne mentionne ni Prems, ni outil, ni automatisation, ni IA.
- Ne mets aucun lien : le dossier et l'annonce sont ajoutés automatiquement sous ta signature.
- Pas de "Madame, Monsieur," suivi d'un saut : commence par "Bonjour," — c'est ce qu'écrit un particulier.

Tout champ absent ou nul dans les données n'existe pas et ne doit pas être évoqué.

L'objet doit permettre de retrouver l'annonce sans ouvrir le message : type de bien, ville, et rien d'autre. Pas de nom de candidat dans l'objet.`;

/**
 * What the agent must return, declared rather than described.
 *
 * The schema goes to the model as a response schema, so "réponds en JSON
 * strict" — an instruction that was occasionally ignored — becomes a constraint
 * the API enforces.
 */
const DraftSchema = z.object({
  subject: z.string().describe("L'objet : type de bien et ville, rien d'autre."),
  body: z.string().describe("Le corps du message, signature du candidat comprise."),
});

/** Built once per process: an agent is a description, and this one never varies. */
let writer: { project: string; agent: LlmAgent } | null = null;

function applicationWriter(project: string): LlmAgent {
  if (writer?.project === project) return writer.agent;
  const agent = new LlmAgent({
    name: 'prems_application_writer',
    model: gemini(project),
    description: "Écrit la candidature d'un particulier à une agence immobilière.",
    instruction: WRITER_INSTRUCTION,
    generateContentConfig: { temperature: 0.4, maxOutputTokens: 600 },
    outputSchema: DraftSchema,
  });
  writer = { project, agent };
  return agent;
}

export async function writeDraft(input: DraftInput, project: string): Promise<Draft> {
  // Whether the income comfortably clears the bar agencies actually apply.
  // Stated as a fact when it is true, never computed for the model to guess at.
  const ratio =
    input.monthlyIncomeEur && input.rentEur
      ? Math.round((input.monthlyIncomeEur / input.rentEur) * 10) / 10
      : null;

  const message = `${
    input.hasDossier
      ? "Le candidat a un dossier DossierFacile vérifié, dont le lien est ajouté automatiquement après sa signature. Tu peux dire en une demi-phrase que le dossier complet est disponible, sans le décrire ni donner d'URL.\n"
      : ''
  }${
    ratio && ratio >= 3
      ? `Le revenu représente ${ratio} fois le loyer, ce qui est au-dessus du seuil habituel : c'est un argument, formule-le simplement.\n`
      : ''
  }
Données disponibles :
${JSON.stringify(
  {
    prenom: input.firstName,
    nom: input.lastName,
    situation: input.employment,
    revenu_mensuel_eur: input.monthlyIncomeEur,
    // Présent uniquement s'il existe : son absence ne doit jamais atteindre le modèle.
    ...(input.hasGuarantor ? { garant: true } : {}),
    bien: {
      ville: input.city,
      pieces: input.rooms,
      surface_m2: input.surfaceM2 ? Math.round(input.surfaceM2) : null,
      loyer_mensuel_eur: input.rentEur,
    },
    agence: input.agencyName,
  },
  null,
  1,
)}`;

  const parsed = await runAgentJson<{ subject?: string; body?: string }>({
    agent: applicationWriter(project),
    prompt: message,
    timeoutMs: 20_000,
  });

  if (!parsed?.subject || !parsed.body) return fallbackDraft(input);

  // A model that ignores the word limit produces something that reads as
  // generated. Better a plain message that reads as human.
  if (parsed.body.split(/\s+/).length > 180) return fallbackDraft(input);

  return { subject: parsed.subject.slice(0, 180), body: parsed.body };
}
