# PSG Live (Actu PSG)

Site de suivi non officiel de l'actualité du Paris Saint-Germain, installable comme une appli : prochain match avec compte à rebours, score en direct, compo, infirmerie, résultats, calendrier, classement de Ligue 1, mercato, fil d'actu et notifications.

## Ce que fait le serveur

Le serveur Node.js (`server/`) tourne sur Railway et :

- sert le site et l'appli installable (`index.html`, `manifest.webmanifest`, `sw.js`, `icons/`) ;
- récupère tout seul, toutes les 10 minutes, les matchs du PSG, les résultats et le classement de Ligue 1 (football-data.org), ainsi que le fil d'actu (flux RSS de Foot Mercato et Google Actualités) ;
- intègre le score en direct relevé par le veilleur, que le site relit toutes les 20 secondes pendant un match ;
- complète avec le contenu rédigé de `data.json` (compo, infirmerie, mercato), relu sur GitHub toutes les 2 minutes ;
- suit le match du PSG en direct et envoie des notifications : buts, coup d'envoi, mi-temps, score final, compo officielle ;
- envoie une notification pour les nouvelles infos du fil d'actu (option désactivée par défaut) ;
- garde les abonnements aux notifications dans MongoDB.

Sans serveur (GitHub Pages), le site fonctionne toujours, mais sans notifications.

## Mise en ligne sur Railway

1. Dans Railway : **New Project → Deploy from GitHub repo**, puis choisir `xezy-b2/actu-psg`.
2. Dans l'onglet **Variables** du service, ajouter :

| Variable | Obligatoire | Rôle |
|---|---|---|
| `MONGODB_URI` | Oui | Chaîne de connexion MongoDB Atlas (`mongodb+srv://…`) |
| `VAPID_SUBJECT` | Oui | Votre adresse de contact, au format `mailto:vous@exemple.fr` |
| `FOOTBALL_DATA_KEY` | Conseillé | Clé gratuite [football-data.org](https://www.football-data.org/client/register), source de secours pour le score et la compo |
| `API_FOOTBALL_KEY` | Non | Clé API-Football (l'offre gratuite ne couvre pas la saison en cours) |
| `MONGODB_DB` | Non | Nom de la base (par défaut `actu_psg`) |
| `POLL_SECONDS` | Non | Intervalle de vérification pendant un match (120 s avec API-Football, 30 s avec Sofascore) |
| `DATA_URL` | Non | Adresse de `data.json` (par défaut le fichier de ce dépôt sur GitHub) |

3. Dans **Settings → Networking**, cliquer sur **Generate Domain** pour obtenir l'adresse publique du site.
4. Dans MongoDB Atlas, menu **Network Access**, autoriser Railway à se connecter (voir plus bas).

Les clés de chiffrement des notifications (VAPID) sont créées automatiquement au premier démarrage et enregistrées dans MongoDB. Ne les changez pas ensuite : tous les abonnements existants deviendraient invalides.

Chaque modification du code redéploie automatiquement. Les mises à jour horaires de `data.json` ne redéploient pas : le serveur relit le fichier tout seul.

### Accès MongoDB Atlas

Railway n'a pas d'adresse IP fixe par défaut. Deux options :

- autoriser toutes les adresses (`0.0.0.0/0`) avec un utilisateur de base dédié au site et un mot de passe long ;
- ou activer les IP fixes de Railway (selon votre offre) et n'autoriser que celles-ci.

## Source du score en direct

Le serveur essaie les sources dans cet ordre et garde la première qui répond :

1. **ESPN** (sans clé) : score et buteurs. Source principale.
2. **football-data.org** (si `FOOTBALL_DATA_KEY` est défini) : score, buteurs et compo.
3. **Sofascore** (sans clé) : bloque en pratique les serveurs (erreur 403).
4. **API-Football** (si `API_FOOTBALL_KEY` est défini) : l'offre gratuite ne couvre pas la saison en cours.

`GET /api/sources/check` teste chaque source sur le dernier match joué, sans envoyer de notification.

## Installer l'appli

- **Android / ordinateur (Chrome, Edge)** : bouton « Installer l'appli » dans le panneau des notifications, ou icône d'installation dans la barre d'adresse.
- **iPhone (iOS 16.4 ou plus)** : dans Safari, **Partager → Sur l'écran d'accueil**, puis ouvrir l'appli depuis son icône pour activer les notifications.

## Vérifier que tout marche

- `GET /healthz` : le serveur répond.
- `GET /api/status` : état des notifications, nombre d'abonnés, données automatiques (matchs, classement, flux RSS), dernière lecture de `data.json` et match suivi.

## Développement

```bash
npm install
npm start      # http://localhost:3000 (abonnements en mémoire sans MONGODB_URI)
npm test       # tests de détection des buts et des temps forts
```

## Structure de `data.json`

| Champ | Contenu |
|---|---|
| `updatedAt` | Date de la dernière mise à jour (ISO UTC) |
| `nextMatch` | Match en cours ou à venir : équipes, coup d'envoi, statut, score, minute, événements, `sofascoreId` pour le widget de score |
| `lineup` | Compo probable ou officielle, lignes du gardien vers l'attaque |
| `absents` | Blessés et incertains (`out` ou `doubt`) |
| `results` / `fixtures` | Derniers résultats et prochains matchs |
| `standings` | Classement de Ligue 1 |
| `transfers` | Arrivées, départs et rumeurs |
| `news` | Fil d'actu avec liens vers les articles d'origine |

Site sans lien avec le Paris Saint-Germain.
