const db = require('../database');
const run = db.isAsync
  ? (fn) => fn()
  : (fn) => Promise.resolve(fn());

async function toggleLike(photoId, voyageId, auteur) {
  const liked = await run(() => db.photo_likes.toggle(photoId, voyageId, auteur));
  const allLikes = await run(() => db.photo_likes.getByVoyage(voyageId));
  const count = allLikes.filter(l => l.photo_id === +photoId).length;
  return { liked, count };
}

async function getLikesForVoyage(voyageId) {
  const likes = await run(() => db.photo_likes.getByVoyage(voyageId));
  const map = {};
  for (const l of likes) {
    if (!map[l.photo_id]) map[l.photo_id] = { count: 0, auteurs: [] };
    map[l.photo_id].count++;
    map[l.photo_id].auteurs.push(l.auteur);
  }
  return map;
}

async function scorePhotos(voyageId) {
  const likes = await run(() => db.photo_likes.getByVoyage(voyageId));
  const scoreMap = {};
  for (const l of likes) {
    if (!scoreMap[l.photo_id]) scoreMap[l.photo_id] = { count: 0, auteurs: new Set(), days: new Set() };
    scoreMap[l.photo_id].count++;
    scoreMap[l.photo_id].auteurs.add(l.auteur);
    scoreMap[l.photo_id].days.add(l.created_at.slice(0, 10));
  }
  const scores = Object.entries(scoreMap).map(([pid, s]) => ({
    photo_id: +pid,
    score: s.count * 3 + s.auteurs.size * 2 + s.days.size
  }));
  scores.sort((a, b) => b.score - a.score);
  return scores.map(s => s.photo_id);
}

module.exports = { toggleLike, getLikesForVoyage, scorePhotos };
