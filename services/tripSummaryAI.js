// Résumé IA du voyage via Claude — nécessite ANTHROPIC_API_KEY + ENABLE_AI_SUMMARY=true

async function generateSummary(voyage, participants, photos, topPhotos) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY non défini');

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();

  const nuits = voyage.date_debut && voyage.date_fin
    ? Math.max(1, Math.round((new Date(voyage.date_fin) - new Date(voyage.date_debut)) / (1000 * 60 * 60 * 24)))
    : '?';
  const prenoms = participants.map(p => p.nom).join(', ') || 'votre crew';
  const nbPhotos = photos.length;
  const dest = voyage.destination || voyage.nom;

  const prompt = process.env.SUMMARY_PROMPT_TEMPLATE ||
    `Tu génères un résumé chaleureux et complice d'un voyage en groupe pour l'app CrewiGo.
Ton : tutoiement, 20-30 ans, bienveillant, fun sans être forcé, 0 cliché de carte postale.
Contraintes : 5-6 phrases max, cite les prénoms si disponibles, inclure au moins 1 donnée chiffrée, terminer sur une note enthousiaste.

Données du voyage :
- Destination : ${dest}
- Participants : ${prenoms}
- Durée : ${nuits} nuit(s)
- Nombre de photos : ${nbPhotos}
- Nombre de top photos sélectionnées : ${topPhotos.length}

Génère uniquement le texte du résumé, sans titre ni markdown.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text.trim();
}

module.exports = { generateSummary };
