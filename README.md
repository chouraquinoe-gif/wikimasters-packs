# Ouverture automatique des paquets WikiMasters

Un script qui tourne sur GitHub Actions, même quand ton ordi est éteint :

- il ouvre chaque paquet entre 2 et 60 s (au hasard) après qu'il devient disponible ;
- s'il y a des paquets en stock, il les ouvre un par un avec ce même délai ;
- il t'envoie une notification sur ton téléphone pour chaque carte **R, SR, UR ou L** ;
- si ta session expire, il t'envoie une alerte et s'arrête.

Une exécution dure environ 6 h et une nouvelle démarre toutes les 6 h.

## Installation (une seule fois)

### 1. Notifications (ntfy)
1. Installe l'appli **ntfy** (iOS / Android).
2. Abonne-toi à un sujet au nom long et difficile à deviner, par exemple `wikimasters-` suivi d’une suite de lettres et chiffres au hasard.
   N'importe qui connaissant ce nom pourrait lire tes notifications : garde-le secret.

### 2. Dépôt GitHub
1. Crée un dépôt **public** sur github.com (public = minutes Actions gratuites et illimitées ;
   ton cookie et ton sujet ntfy restent cachés car ce sont des *secrets*).
2. Ajoute-y les fichiers `open-packs.js` et `.github/workflows/open-packs.yml`.

### 3. Récupérer un cookie de session **dédié au script**
Le script renouvelle lui-même sa connexion. Il lui faut donc **sa propre session**, distincte de celle
de ton navigateur habituel (sinon les deux se « volent » le renouvellement et se déconnectent).
1. Ouvre une **fenêtre de navigation privée** dans Chrome (Cmd + Maj + N).
2. Va sur https://www.wiki-masters.com et connecte-toi.
3. Ouvre les outils de développement (Cmd + Option + I) → **>>** → **Network** → recharge la page (Cmd + R).
4. Clique sur la requête `pulls` → **Headers** → **Request Headers** → ligne `cookie` → clic droit → **Copy value**.
5. Ferme la fenêtre privée **sans te déconnecter** (se déconnecter couperait aussi la session du script).

### 4. Secrets GitHub
Dans le dépôt : **Settings → Secrets and variables → Actions → New repository secret** :
- `WM_COOKIE` : la valeur du cookie copiée à l'étape 3
- `NTFY_TOPIC` : le nom de ton sujet ntfy

### 5. Lancer
Onglet **Actions** → « Ouvrir les paquets WikiMasters » → **Run workflow**.
Ensuite ça repart tout seul toutes les 6 h.

## Entretien
- **Connexion perdue** : tu reçois la notification « connexion perdue ». Refais les étapes 3 et 4,
  puis relance (étape 5).
- **Ouverture bloquée** : le site a refusé les ouvertures pendant ~1 h (protection anti-robot, panne).
  Le détail est dans le journal de l'exécution ; relance le workflow plus tard.
- **60 jours sans activité** : GitHub désactive les tâches planifiées des dépôts publics inactifs
  et t'envoie un mail. Il suffit de cliquer sur le lien pour les réactiver.
- **Arrêter** : onglet Actions → le workflow → « … » → **Disable workflow**.
- Les journaux d'exécution (raretés ouvertes, heures) sont visibles publiquement ; ton cookie n'y apparaît jamais.

N'ouvre pas de paquets à la main en même temps que le script tourne : ce n'est pas grave,
mais le script tentera une ouverture pour rien et attendra le paquet suivant.
