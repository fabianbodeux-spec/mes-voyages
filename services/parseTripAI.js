// Parse une phrase en langage naturel → trip structuré, via l'API Claude (tool use).
// Appel REST direct (fetch global, Node >=18) → aucune dépendance SDK.
// Nécessite ANTHROPIC_API_KEY (clé serveur, jamais exposée au client).

const TRIP_TYPES = ['ski', 'city', 'plage', 'ile', 'road', 'evg', 'evf', 'camping', 'rando', 'plongee', 'potes', 'autre'];

async function parseTrip(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY non défini');

  const today = new Date().toISOString().slice(0, 10);

  // Tool use → force une sortie JSON structurée et validée par le schéma
  const tool = {
    name: 'creer_trip',
    description: "Structure les informations d'un voyage de groupe à partir de la description en langage naturel de l'utilisateur.",
    input_schema: {
      type: 'object',
      properties: {
        nom:        { type: 'string', description: 'Nom court et stylé du trip (max 40 caractères), en français, ton jeune et fun. Ex: "EVG de Tom · Barcelone 2026".' },
        ville:      { type: 'string', description: 'Ville de destination, ou chaîne vide si non précisée.' },
        pays:       { type: 'string', description: 'Pays de destination, déduit de la ville si évident, sinon chaîne vide.' },
        type:       { type: 'string', enum: TRIP_TYPES, description: 'Type de trip le plus pertinent.' },
        emoji:      { type: 'string', description: 'Un seul emoji représentant le trip.' },
        date_debut: { type: ['string', 'null'], description: "Date de début au format YYYY-MM-DD, ou null si non déduite. Résoudre les expressions relatives (ex: 'premier week-end de juillet') par rapport à aujourd'hui." },
        date_fin:   { type: ['string', 'null'], description: 'Date de fin au format YYYY-MM-DD, ou null.' },
        nb_participants: { type: ['integer', 'null'], description: 'Nombre total de voyageurs si mentionné, sinon null.' },
      },
      required: ['nom', 'type', 'emoji'],
    },
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'creer_trip' },
      messages: [{
        role: 'user',
        content: `Aujourd'hui nous sommes le ${today}. Voici la description d'un voyage de groupe par l'utilisateur, structure-la via l'outil.\n\n"${text}"`,
      }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`API Claude ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  const block = Array.isArray(data.content) && data.content.find(c => c.type === 'tool_use');
  if (!block || !block.input) throw new Error('Réponse IA invalide');

  const out = block.input;
  // Garde-fous : normaliser/valider avant de renvoyer au client
  if (!TRIP_TYPES.includes(out.type)) out.type = 'autre';
  out.nom   = (out.nom   || '').toString().slice(0, 60);
  out.ville = (out.ville || '').toString().slice(0, 80);
  out.pays  = (out.pays  || '').toString().slice(0, 80);
  out.emoji = (out.emoji || '✈️').toString().slice(0, 4);
  const validDate = d => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? d : null;
  out.date_debut = validDate(out.date_debut);
  out.date_fin   = validDate(out.date_fin);
  out.nb_participants = Number.isInteger(out.nb_participants) && out.nb_participants > 0
    ? Math.min(out.nb_participants, 50) : null;

  return out;
}

module.exports = { parseTrip, TRIP_TYPES };
