const { getSession } = require('../sessions');

/**
 * Middleware Express : vérifie le session token participant.
 * Token attendu dans le header X-Participant-Token ou req.body.sessionToken.
 * En cas de succès, injecte req.participantSession = { participantId, voyageId, nom, couleur, role }.
 */
module.exports = function verifyParticipantSession(req, res, next) {
  const token =
    req.headers['x-participant-token'] ||
    req.body?.sessionToken;

  if (!token) {
    return res.status(401).json({ error: 'Session token requis — identifie-toi d\'abord' });
  }

  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Session invalide ou expirée — identifie-toi à nouveau' });
  }

  req.participantSession = session;
  next();
};
