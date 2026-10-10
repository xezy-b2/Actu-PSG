# Actu PSG

Site de suivi non officiel de l'actualité du Paris Saint-Germain : prochain match avec compte à rebours, compo probable, infirmerie, résultats, calendrier, classement de Ligue 1, mercato et fil d'actu.

## Fonctionnement

- `index.html` : la page, sans aucune dépendance. Elle relit `data.json` toutes les minutes et s'actualise sans recharger.
- `data.json` : toutes les données affichées. Il est mis à jour automatiquement chaque heure par une tâche programmée Claude, qui fait un commit dans ce dépôt.

## Mise en ligne avec GitHub Pages

1. Ouvrir **Settings → Pages** dans ce dépôt.
2. Dans **Build and deployment**, choisir **Deploy from a branch**, puis la branche `main` et le dossier `/ (root)`.
3. Enregistrer. Le site est disponible après une minute environ à l'adresse `https://xezy-b2.github.io/actu-psg/`.

## Tester en local

```bash
python3 -m http.server 8000
```

Puis ouvrir http://localhost:8000. Ouvrir `index.html` directement depuis le disque ne fonctionne pas, car le navigateur bloque la lecture de `data.json`.

## Structure de `data.json`

| Champ | Contenu |
|---|---|
| `updatedAt` | Date de la dernière mise à jour (ISO UTC) |
| `nextMatch` | Match en cours ou à venir : équipes, coup d'envoi, statut (`scheduled`, `live`, `final`), score, minute, événements |
| `lineup` | Compo probable ou officielle, lignes du gardien vers l'attaque |
| `absents` | Blessés et incertains (`out` ou `doubt`) |
| `results` / `fixtures` | Derniers résultats et prochains matchs |
| `standings` | Classement de Ligue 1 |
| `transfers` | Arrivées, départs et rumeurs |
| `news` | Fil d'actu avec liens vers les articles d'origine |

Site sans lien avec le Paris Saint-Germain.
