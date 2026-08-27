# Rappel d'aération 🌡️

Mini web app **mobile** qui surveille la **température extérieure** (Open-Meteo)
et t'envoie une **notification Telegram** au bon moment pour ouvrir ou fermer
une pièce et la rafraîchir naturellement.

L'app tourne **en arrière-plan côté serveur** (Cloudflare Worker + Cron toutes
les 15 min) : pas besoin que ton téléphone reste allumé ni qu'une app reste
ouverte. Tu reçois juste les notifications dans Telegram.

## Comment ça marche

Aérer ne rafraîchit que si l'air extérieur est plus frais que l'intérieur.
On définit deux seuils réglables depuis la page :

| État | Condition | Notification |
|------|-----------|--------------|
| 🔥 **CHAUD** | extérieur ≥ seuil d'alerte (défaut 30 °C) | « Garde fermé » |
| 🌡️ **TIEDE** | entre les deux seuils | « Ça redescend » |
| ✅ **IDEAL** | extérieur ≤ température idéale (défaut 25 °C) | « Ouvre maintenant » |

Une notification est envoyée **uniquement au changement d'état** (pas de spam).

## Fichiers

```
meteo-web-app/
├── worker.ts       # backend : cron + serveur HTTP (page + API, accès libre)
├── index.html      # page de réglages mobile (importée comme texte par le worker)
├── wrangler.toml   # config Cloudflare (cron, KV, règle Text)
├── tsconfig.json   # type-check strict
└── package.json    # dépendances de dev + scripts
```

## Déploiement (à lancer depuis ta machine)

> Tu as besoin d'un compte Cloudflare (gratuit) et de l'app **Telegram**.

```bash
# 1. Dépendances
npm install

# 2. Connexion à Cloudflare
npx wrangler login

# 3. (déjà fait) Le namespace KV ETAT_METEO existe et son id est déjà
#    renseigné dans wrangler.toml. Rien à faire ici.
#    Pour en recréer un toi-même : npx wrangler kv namespace create ETAT_METEO

# 4. Déploie
npx wrangler deploy

# 5. Ajoute le token de ton bot Telegram (voir « Bot Telegram » ci-dessous)
npx wrangler secret put TELEGRAM_TOKEN
```

Wrangler affiche l'URL publique `https://<nom>.<ton-sous-domaine>.workers.dev`.
Le cron tourne ensuite tout seul côté Cloudflare. URL HTTPS, gratuite, permanente.

## Bot Telegram (gratuit, sans limite de débit)

1. Dans Telegram, ouvre **@BotFather** → `/newbot` → choisis un nom et un
   identifiant. Il te donne un **token** du type `123456789:AAH...`.
2. Ajoute ce token comme **secret** du Worker, nom exact **`TELEGRAM_TOKEN`** :
   - Dashboard Cloudflare → Worker → *Settings → Variables and Secrets → Add →
     Secret*, nom `TELEGRAM_TOKEN`, valeur = le token.
   - ou en CLI : `npx wrangler secret put TELEGRAM_TOKEN`
3. Ouvre **ton bot** dans Telegram et envoie-lui **/start** (indispensable : un
   bot ne peut pas écrire à quelqu'un qui ne l'a pas démarré).

Le token reste un secret côté serveur (jamais renvoyé à la page). La destination
(chat id) est détectée automatiquement par le bouton « Connecter Telegram » de la
page (lecture de `getUpdates`).

## Première utilisation

1. Ouvre l'URL `workers.dev` → la page de réglages s'affiche directement.
2. Vérifie que le statut sous **Telegram** indique « Bot prêt » (sinon, le secret
   `TELEGRAM_TOKEN` n'est pas en place).
3. Clique **« Connecter Telegram »** → le chat est détecté et enregistré.
4. **« Envoyer un test »** → le message arrive dans Telegram.
5. Active **« Recevoir des alertes »**, règle tes seuils, **Enregistre**.
6. (Optionnel) « Ajouter à l'écran d'accueil » depuis le navigateur.

## Boutons du bot

Trois façons de piloter, sans rien taper :

1. **Clavier permanent** — quatre boutons affichés sous le champ de saisie
   (`🌡️ Météo`, `🗞️ Bulletin`, `⚙️ Réglages`, `⛽ Carburant`). Un appui envoie le
   libellé, que le worker traduit en commande (`BOUTONS_TEXTE` dans `worker.ts`).
   Installé par `/start`, ou automatiquement à la première mise à niveau du webhook.
2. **Bouton ☰** à côté du champ de saisie — liste des commandes avec description,
   déclarée via `setMyCommands` + `setChatMenuButton` dans `configurerWebhook`.
3. **Menu inline** (`/menu` ou `⚙️ Réglages`) — boutons de réglage sous le message,
   qui se met à jour sur place à chaque appui.

## Piloter le bot par message

Une fois « Connecter Telegram » fait (ce qui arme le webhook), tu peux régler
l'app directement depuis Telegram. **Le plus simple : envoie `/menu`** → le bot
répond avec la météo du moment et des **boutons** : alertes ON/OFF, seuils en
+1°/−1°, actualiser. Chaque appui met le menu à jour sur place.

Commandes texte (équivalentes) :

| Message | Effet |
|---------|-------|
| `/menu` (ou n'importe quel message) | menu à boutons |
| `/etat` | météo, conseil et prochaine alerte |
| `/seuil 30` | alerte « fermer » à partir de 30 °C |
| `/ideale 25` | alerte « ouvrir » sous 25 °C |
| `/alertes on` / `/alertes off` | active / coupe les alertes |
| `/matin` | envoie le bulletin d'infos tout de suite |
| `/matin on` / `/matin off` / `/matin 8` | bulletin quotidien automatique (à l'heure choisie) |
| `/carburant` | stations les moins chères à 15 km |
| 📍 **partage de position** | met à jour le lieu suivi |

## Bulletin du matin

Un résumé quotidien envoyé sur Telegram à l'heure choisie (défaut 7 h, heure de
Paris), composé de rubriques **indépendantes** (une source en panne est
simplement omise) :

- **🌦️ Météo du jour** : min/max, pluie, rafales + alertes simples calculées
  (gel, forte chaleur, vent fort, pluie très probable) — Open-Meteo ;
- **🗞️ Dordogne** : les 3 derniers titres de Sud Ouest (flux RSS) ;
- **📰 France** : les 3 derniers titres de franceinfo ;
- **⚽ Sport** : les 3 derniers titres de L'Équipe ;
- **⛽ Carburant** : les prix les moins chers dans un rayon de 15 km (open data
  officiel `data.economie.gouv.fr`).

Les sources se règlent dans la constante `FLUX_ACTUS` de `worker.ts` (ajouter ou
remplacer un flux RSS suffit).

**Suivi de position automatique** : une web app ne peut pas suivre le GPS en
arrière-plan. Pour un suivi « auto », partage ta **position en direct** avec le
bot (Telegram : trombone → Position → *Partager ma position en direct*, 15 min
à 8 h) : chaque mise à jour repositionne le lieu suivi. Un partage de position
ponctuel le fixe une fois.

Le bot confirme **une seule fois**, au partage initial. Les mises à jour
suivantes (`edited_message`, envoyées en continu pendant toute la durée du
partage) sont appliquées **en silence** : sans cela le bot renotifierait sans
fin. Elles ne sont écrites en KV que si la position a bougé de plus de ~500 m,
pour ne pas consommer le quota d'écritures.

Côté technique : `/api/telegram/connect` lit le chat (getUpdates) puis enregistre
un **webhook** (`setWebhook`) protégé par un jeton secret stocké en KV ; le worker
ne traite que les messages venant du chat propriétaire.

## Vérifier le build avant de déployer

```bash
npm run typecheck   # doit renvoyer zéro erreur
```

## Debug de la logique sans attendre la vraie météo

`GET /api/etat?temp=27` renvoie l'état calculé pour une température simulée.
Teste 31 / 27 / 23 pour voir les trois états.

## Sécurité : accès libre

L'app est volontairement **sans mot de passe** : l'URL `workers.dev` est publique,
donc quiconque la connaît peut voir et modifier les réglages (seuils, position,
destination Telegram) et envoyer un test. C'est acceptable pour un usage perso
avec une URL peu devinable. Le token du bot, lui, reste un secret côté serveur.
Pour ré-ajouter une protection, on peut remettre un secret `MOT_DE_PASSE` et une
vérification `Authorization: Bearer` dans le worker.
