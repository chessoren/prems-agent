/**
 * Dossier completeness, against the décret n° 2015-1437.
 *
 * That decree fixes an exhaustive list of what a landlord may ask a candidate
 * tenant for. It cuts both ways, and the second half is the part worth
 * honouring: asking for anything outside the list is unlawful. So this checks
 * that the file is complete, and nothing here ever asks for more.
 *
 * The celebration screen claims the dossier is "conforme loi ALUR". This is the
 * function that has to make that claim true.
 */
import { admin } from './storage.js';

/** Which supporting documents each situation actually requires. */
const INCOME_EVIDENCE = {
  cdi: 'Trois derniers bulletins de salaire',
  independant: 'Dernier avis d’imposition',
  etudiant: 'Avis d’attribution de bourse ou justificatif de garant',
  retraite: 'Bulletin de pension ou dernier avis d’imposition',
  sans_emploi: 'Avis d’imposition ou justificatif de ressources',
};

export async function verify(userId) {
  const [{ data: profile }, { data: documents }] = await Promise.all([
    admin.from('profiles').select('*').eq('id', userId).maybeSingle(),
    admin.from('documents').select('kind, doc_subtype').eq('user_id', userId),
  ]);

  if (!profile) return { complete: false, checks: [], missing: ['Profil introuvable'] };

  const kinds = new Set((documents || []).map((document) => document.kind));

  const checks = [
    {
      id: 'identite',
      label: 'Pièce d’identité en cours de validité',
      ok: Boolean(profile.first_name && profile.last_name && profile.id_document_type && profile.id_document_number),
    },
    {
      id: 'domicile',
      label: 'Justificatif de domicile actuel',
      ok: kinds.has('domicile'),
    },
    {
      id: 'situation',
      label: 'Justificatif de situation professionnelle',
      ok: Boolean(profile.employment_status),
    },
    {
      id: 'ressources',
      label: INCOME_EVIDENCE[profile.employment_status] || 'Justificatif de ressources',
      ok: Number(profile.monthly_income_cents) > 0,
    },
  ];

  // Only demanded when the income alone does not clear the usual 3x threshold.
  if (profile.needs_guarantor) {
    checks.push({
      id: 'garant',
      label: 'Garant ou garantie Visale',
      ok: Boolean(profile.guarantor_name || profile.guarantor_relation === 'visale'),
    });
  }

  return {
    complete: checks.every((check) => check.ok),
    checks,
    missing: checks.filter((check) => !check.ok).map((check) => check.label),
  };
}
