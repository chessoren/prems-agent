/**
 * Ce que l'agent a fait, tel que le client peut le lire.
 *
 * Le pipeline écrit déjà tout dans `events` : quel match il a retenu, quelle
 * candidature il a envoyée, quels outils il a appelés pour rédiger une réponse,
 * quel créneau il a vérifié dans l'agenda. Rien de tout ça n'était lisible
 * ailleurs que dans les logs Cloud Run — c'est-à-dire nulle part, pour la
 * personne au nom de qui il écrit.
 *
 * Ce module lit deux choses :
 *
 *  - `agent_activity`, une vue sur `events` débarrassée de l'exploitation
 *    (santé des sources, runs de scraping), donc uniquement ce qui concerne une
 *    personne et se raconte ;
 *  - `agent_requests`, ce que l'agent réclame quand il lui manque une pièce.
 *
 * Les deux sont protégées par RLS : un navigateur ne voit que ses lignes.
 */
import { client, ensureSession } from './supabase.js';

/**
 * Chaque type d'événement, traduit en une phrase et un registre.
 *
 * Le registre sépare ce que l'agent *pense* de ce qu'il *fait* — c'est la
 * distinction qui rend un journal d'agent lisible plutôt qu'intimidant. Un
 * type inconnu n'est pas masqué : il apparaît tel quel, parce qu'un journal
 * qui cache ce qu'il ne comprend pas n'est plus un journal.
 */
const KNOWN = {
  'match.created': { kind: 'thought', verb: 'A repéré un logement qui correspond' },
  'match.skipped': { kind: 'thought', verb: 'A écarté un logement' },
  'application.queued': { kind: 'action', verb: 'A préparé une candidature' },
  'application.sent': { kind: 'action', verb: 'A envoyé la candidature' },
  'application.failed': { kind: 'problem', verb: "N'a pas pu envoyer la candidature" },
  'reply.visit_offered': { kind: 'action', verb: 'A reçu une proposition de créneaux' },
  'reply.visit_confirmed': { kind: 'action', verb: 'A obtenu la confirmation de la visite' },
  'visit.confirmed_without_date': {
    kind: 'problem',
    verb: 'Visite confirmée sans date exploitable',
  },
  'calendar.push_failed': { kind: 'problem', verb: 'Google Agenda a refusé la visite' },
  'reply.question': { kind: 'thought', verb: "L'agence pose une question" },
  'reply.refused': { kind: 'thought', verb: 'Candidature écartée par l’agence' },
  'reply.other': { kind: 'thought', verb: 'A lu un message sans suite' },
  'reply.sent_by_agent': { kind: 'action', verb: "A répondu à l'agence" },
  'reply.handed_back': { kind: 'problem', verb: 'A rendu la main' },
  'visit.booked': { kind: 'action', verb: 'A réservé une visite' },
  'calendar.not_connected': { kind: 'problem', verb: "N'a pas pu écrire dans l'agenda" },
};

/** Ce que l'agent a appelé pour décider, en français. */
const TOOL_LABELS = {
  get_client_availability: 'a relu tes disponibilités',
  check_calendar_conflicts: 'a consulté ton agenda Google',
  get_client_facts: 'a relu ton dossier',
  request_document: "t'a demandé une pièce",
  queue_reply: 'a rédigé la réponse',
  stand_down: 'a choisi de ne pas répondre',
};

export function describe(event) {
  const known = KNOWN[event.type];
  return {
    id: event.id,
    at: event.created_at,
    kind: known?.kind ?? 'thought',
    title: known?.verb ?? event.type,
    type: event.type,
    payload: event.payload ?? {},
    tools: (event.payload?.tool_calls ?? []).map((t) => TOOL_LABELS[t] ?? t),
  };
}

/** Le journal, du plus récent au plus ancien. */
export async function timeline({ limit = 60 } = {}) {
  const supabase = client();
  if (!supabase) return [];
  try {
    await ensureSession();
    const { data } = await supabase
      .from('agent_activity')
      .select('id, type, subject_type, subject_id, payload, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    return (data ?? []).map(describe);
  } catch {
    return [];
  }
}

/** Ce que l'agent attend de toi. Les demandes ouvertes d'abord. */
export async function requests() {
  const supabase = client();
  if (!supabase) return [];
  try {
    await ensureSession();
    const { data } = await supabase
      .from('agent_requests')
      .select('id, application_id, kind, doc_kind, label, reason, status, answer, created_at')
      .order('created_at', { ascending: false })
      .limit(40);
    return data ?? [];
  } catch {
    return [];
  }
}

/**
 * Refermer une demande.
 *
 * `answer` pour une phrase, `documentId` quand un fichier vient d'être déposé.
 * Rien n'est supprimé : une demande refermée reste visible, parce que « qu'est-ce
 * qu'il m'avait demandé, déjà ? » est une question qu'on se pose.
 */
export async function resolve(id, { answer = null, documentId = null } = {}) {
  const supabase = client();
  if (!supabase) return false;
  try {
    await ensureSession();
    const { error } = await supabase
      .from('agent_requests')
      .update({
        status: 'resolved',
        answer,
        document_id: documentId,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', id);
    return !error;
  } catch {
    return false;
  }
}

/** Écarter une demande à laquelle on ne veut pas répondre. */
export async function dismiss(id) {
  const supabase = client();
  if (!supabase) return false;
  try {
    await ensureSession();
    const { error } = await supabase
      .from('agent_requests')
      .update({ status: 'dismissed', resolved_at: new Date().toISOString() })
      .eq('id', id);
    return !error;
  } catch {
    return false;
  }
}
