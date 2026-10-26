# Le 3000 — version Vercel + Firebase

Site statique (aucun build) : `index.html`, `firebase-config.js`, `vercel.json`.
Le moteur de jeu et la comptabilité sont identiques à la version claude.ai ; les tests sont dans `tests/` (`node tests/test.js`).

## Mise en ligne sur Vercel (sans rien installer)
1. https://github.com/new → nom `le3000` → **Create repository**.
2. Sur la page du dépôt : **uploading an existing file** → glisser **tout le contenu** du dossier dézippé (pas le dossier lui-même) → **Commit changes**.
3. https://vercel.com/new → **Import** le dépôt `le3000` → Framework : *Other* → **Deploy**.
4. Chaque modification déposée sur GitHub (ex. `firebase-config.js`) redéploie le site automatiquement.

## Sans Firebase
Le jeu sur un seul appareil fonctionne tout de suite (sauvegarde dans le navigateur).

## Activer le jeu sur plusieurs téléphones (gratuit, ~5 min)
1. https://console.firebase.google.com → **Créer un projet** (nom : `le3000`, Google Analytics désactivé). Offre Spark gratuite, pas de carte bancaire.
2. **Créer → Authentication → Commencer → Méthode de connexion → Anonyme → Activer.**
3. **Créer → Firestore Database → Créer une base de données** → emplacement `eur3 (Europe)` → **mode production**.
4. Onglet **Règles** de Firestore → remplacer tout par le contenu de `firestore.rules` → **Publier**.
5. Roue dentée → **Paramètres du projet → Vos applications → icône Web `</>`** → nom `le3000` (sans Firebase Hosting) → copier l'objet `firebaseConfig`.
6. Coller ces valeurs dans `firebase-config.js` (ou les envoyer à Claude pour qu'il redéploie).
7. **Authentication → Paramètres → Domaines autorisés** → ajouter le domaine Vercel (ex. `le3000.vercel.app`).

## Jouer à plusieurs
- L'hôte ouvre le site → **Créer une table en ligne** → un code à 6 caractères s'affiche.
- Chaque joueur ouvre le même lien → **Rejoindre une table** → code + prénom.
- Les dés sont tirés sur l'appareil de l'hôte ; les téléphones envoient « lancer / bloquer ».
- Une table ne peut être modifiée que par l'appareil qui l'a créée (règles Firestore). Pour changer d'appareil hôte : Comptes → Exporter → Sauvegarde, puis Restaurer sur le nouvel appareil.

## Points de règle à confirmer
Isolés dans `CONFIG` en tête du script : 432 sous le seuil des 300, victoire immédiate à 3000 pile, dépassement vérifié dès le lancer, au moins un lancer marquant pour bloquer.
