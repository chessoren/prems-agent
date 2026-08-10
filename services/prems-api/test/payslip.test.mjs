/**
 * Reading the net salary off a payslip.
 *
 * These cases exist because a synthetic payslip reading 2 450 € net came back
 * as the 3 150 € gross: the amount regex matched a prefix of a longer digit
 * run, and "the text after the label" landed in the wrong column once the OCR
 * serialised the table column by column.
 *
 *   node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// config.js fails fast on missing values, so give it the shape it wants before
// the module under test pulls it in.
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';
process.env.GCP_PROJECT_ID ||= 'test';

const { parseAmount, netFromRow } = await import('../src/documentai.js');

test('un montant n’est jamais lu partiellement', () => {
  assert.equal(parseAmount('3150,00'), 3150);
  assert.equal(parseAmount('2 450,00'), 2450);
  assert.equal(parseAmount('2.450,00'), 2450);
  assert.equal(parseAmount('1234'), 1234);
});

test('ce qui n’est pas un salaire est rejeté', () => {
  assert.equal(parseAmount('Page 3'), null, 'trop petit');
  assert.equal(parseAmount('SIRET 40483304800022'), null, 'trop grand');
  assert.equal(parseAmount('aucun chiffre'), null);
});

/** Build a document whose tokens carry the geometry of a real page. */
function documentFrom(rows) {
  let text = '';
  const tokens = [];

  rows.forEach((row, index) => {
    const y = 0.1 + index * 0.05;
    for (const [column, word] of row.entries()) {
      const start = text.length;
      text += word;
      tokens.push({
        layout: {
          textAnchor: { textSegments: [{ startIndex: start, endIndex: text.length }] },
          boundingPoly: {
            normalizedVertices: [
              { x: 0.1 + column * 0.3, y: y - 0.012 },
              { x: 0.3 + column * 0.3, y: y - 0.012 },
              { x: 0.3 + column * 0.3, y: y + 0.012 },
              { x: 0.1 + column * 0.3, y: y + 0.012 },
            ],
          },
        },
      });
      text += ' ';
    }
    text += '\n';
  });

  return { text, pages: [{ tokens }] };
}

test('mise en page sur une ligne : le montant de la ligne du libellé', () => {
  const document = documentFrom([
    ['Salaire', 'brut', '3150,00'],
    ['NET', 'A', 'PAYER', '2450,00'],
  ]);
  assert.deepEqual(netFromRow(document), { value: 2450, priority: 1 });
});

test('montant scindé en deux jetons', () => {
  const document = documentFrom([['NET', 'A', 'PAYER', '2', '450,00']]);
  assert.equal(netFromRow(document).value, 2450);
});

/**
 * The case that actually failed: the OCR emits every label, then every figure.
 * Text order puts the gross right after the net label; only the row geometry
 * tells them apart.
 */
test('mise en page en colonnes : la géométrie départage', () => {
  const text =
    'Salaire brut\nTotal cotisations\nNET A PAYER\n3150,00\n700,00\n2450,00\n';
  const spans = [
    ['Salaire brut', 0.1, 0.2],
    ['Total cotisations', 0.15, 0.2],
    ['NET A PAYER', 0.2, 0.2],
    ['3150,00', 0.1, 0.7],
    ['700,00', 0.15, 0.7],
    ['2450,00', 0.2, 0.7],
  ];

  let cursor = 0;
  const tokens = spans.map(([word, y, x]) => {
    const start = text.indexOf(word, cursor);
    cursor = start + word.length;
    return {
      layout: {
        textAnchor: { textSegments: [{ startIndex: start, endIndex: cursor }] },
        boundingPoly: {
          normalizedVertices: [
            { x, y: y - 0.012 },
            { x: x + 0.2, y: y - 0.012 },
            { x: x + 0.2, y: y + 0.012 },
            { x, y: y + 0.012 },
          ],
        },
      },
    };
  });

  assert.equal(netFromRow({ text, pages: [{ tokens }] }).value, 2450);
});

test('le libellé le plus spécifique gagne', () => {
  const document = documentFrom([
    ['Salaire', 'net', '2800,00'],
    ['NET', 'A', 'PAYER', '2450,00'],
  ]);
  assert.equal(netFromRow(document).value, 2450, 'net à payer prime sur salaire net');
});

test('aucune géométrie exploitable : rien plutôt qu’un chiffre inventé', () => {
  assert.equal(netFromRow({ text: 'NET A PAYER 2450,00', pages: [] }), null);
});
