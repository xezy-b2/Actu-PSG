// Repère quand deux titres parlent de la même info (même si les médias la formulent autrement).
const STOP = new Set(("psg paris saint germain football foot ligue club parisien parisiens officiel officielle " +
  "pour dans avec sans contre face avant apres après entre vers chez plus moins tout tous toute toutes cette celui " +
  "leur leurs sont sera était fait faire peut doit veut encore deja déjà enfin aussi mais donc comme quand alors " +
  "selon voici pourquoi comment info infos video vidéo direct live photo photos l'equipe lequipe mercato " +
  "nouvelle nouveau nouveaux grosse gros grande grand énorme enorme incroyable etre avoir jusqu").split(" "));

function keywords(title) {
  return new Set(String(title || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, " ").split(/[^a-z0-9]+/)
    .filter(w => w.length >= 4 && !STOP.has(w))
    // Racine sur 6 lettres : "sanction" et "sanctionné", "prolonge" et "prolongation" se rejoignent.
    .map(w => w.replace(/(s|x)$/, "").slice(0, 6)));
}

// Même info si au moins 2 mots-clés en commun et au moins la moitié des mots-clés du titre le plus court.
function sameStory(a, b) {
  const A = a instanceof Set ? a : keywords(a), B = b instanceof Set ? b : keywords(b);
  if (!A.size || !B.size) return false;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common >= 2 && common / Math.min(A.size, B.size) >= 0.5;
}

module.exports = { keywords, sameStory };
