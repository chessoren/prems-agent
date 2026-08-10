/**
 * Configuration, read once at boot so a missing value fails the container
 * rather than the first user request.
 *
 * Nothing here has a secret default. On Cloud Run the two secrets arrive as
 * environment variables mounted from Secret Manager; locally they come from a
 * gitignored .env the developer exports by hand.
 */

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Variable d'environnement manquante : ${name}`);
  return value;
};

const optional = (name, fallback = '') => process.env[name] || fallback;

export const config = {
  port: Number(optional('PORT', '8080')),

  supabase: {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    // Tokens are ES256-signed and verified against the project's JWKS, so the
    // service never needs to hold a shared signing secret.
    issuer: optional('SUPABASE_JWT_ISSUER', `${required('SUPABASE_URL')}/auth/v1`),
  },

  documentAi: {
    projectId: required('GCP_PROJECT_ID'),
    // Document AI has no europe-west9 processor location. `eu` is the European
    // multi-region: data stays in the EU, which is the constraint that matters.
    location: optional('DOCAI_LOCATION', 'eu'),
    identityProcessorId: optional('DOCAI_IDENTITY_PROCESSOR_ID'),
    payslipProcessorId: optional('DOCAI_PAYSLIP_PROCESSOR_ID'),
  },

  /**
   * Exact origins allowed to call this service. No wildcards.
   *
   * Separated by semicolons, commas or whitespace - all three are accepted
   * because `gcloud` parses --substitutions as a dict and splits it on commas,
   * so a comma-separated value needs shell-dependent escaping to survive. A
   * semicolon needs none.
   */
  allowedOrigins: optional('ALLOWED_ORIGINS', 'http://localhost:4321')
    .split(/[;,\s]+/)
    .map((origin) => origin.trim())
    .filter(Boolean),

  /** Documents above this never reach Document AI. */
  maxBytes: Number(optional('MAX_DOCUMENT_BYTES', String(10 * 1024 * 1024))),
};
