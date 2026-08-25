/**
 * Cloudflare Worker — Rappel d'aération + panneau de réglages
 * ------------------------------------------------------------------
 * - Cron : interroge Open-Meteo et notifie (Telegram) sur changement d'état.
 * - HTTP : sert la page de réglages et une petite API JSON (accès libre).
 *   Les réglages sont stockés dans KV, donc modifiables depuis le téléphone
 *   sans redéploiement.
 *
 * Notifications via un bot Telegram personnel :
 *   - le token du bot est un secret du Worker (TELEGRAM_TOKEN) ;
 *   - la destination (chat id) est détectée via le bouton « Connecter Telegram »
 *     (lecture de getUpdates après que l'utilisateur a envoyé /start au bot).
 *
 * "Température idéale pour ouvrir" : aérer ne rafraîchit que si l'air
 * extérieur est plus frais que l'intérieur. Faute de capteur intérieur,
 * `tempIdealeOuverture` sert de confort visé :
 *   extérieur >= seuilAlerte             -> CHAUD : garder fermé
 *   tempIdeale < extérieur < seuilAlerte -> TIEDE : ça redescend
 *   extérieur <= tempIdeale              -> IDEAL : ouvrir
 * ------------------------------------------------------------------
 */

// HTML servi comme module texte (voir [[rules]] type="Text" dans wrangler.toml).
// @ts-ignore
import PAGE_HTML from "./index.html";

// ─────────────────────────── Types ───────────────────────────

interface Env {
  ETAT_METEO: KVNamespace;   // KV : config + dernier état (binding obligatoire)
  TELEGRAM_TOKEN?: string;   // secret : token du bot Telegram (créé via @BotFather)
}

/** Réglages persistés dans KV. */
interface ConfigStockee {
  latitude: number;
  longitude: number;
  seuilAlerte: number;
  tempIdealeOuverture: number;
  telegramChatId: string;    // destination des notifications (id de chat Telegram)
  notificationsActives: boolean;
  bulletinActif: boolean;    // bulletin d'infos du matin (météo + actus + carburant)
  bulletinHeure: number;     // heure d'envoi du bulletin (heure de Paris, 0-23)
}

/** Config d'exécution = réglages + token Telegram (non éditable, vient du secret). */
type Config = ConfigStockee & { telegramToken?: string };

type Etat = "CHAUD" | "TIEDE" | "IDEAL";

interface Notification {
  titre: string;
  corps: string;
}

interface OpenMeteoReponse {
  current?: { temperature_2m?: number; apparent_temperature?: number };
}

interface TelegramUpdates {
  ok?: boolean;
  result?: Array<{ message?: { chat?: { id?: number; first_name?: string; title?: string } } }>;
}

// Champs Telegram utilisés par le webhook (sous-ensemble volontairement minimal).
interface TgLocation { latitude?: number; longitude?: number }
interface TgMessage { chat?: { id?: number }; text?: string; location?: TgLocation }
interface TgCallbackQuery { id: string; message?: { chat?: { id?: number }; message_id?: number }; data?: string }
interface TgUpdate { message?: TgMessage; edited_message?: TgMessage; callback_query?: TgCallbackQuery }

// ─────────────────────────── Constantes ───────────────────────────

const CLE_CONFIG = "config";
const CLE_ETAT = "dernier_etat";
const CLE_WEBHOOK_SECRET = "webhook_secret"; // jeton partagé avec Telegram pour valider les appels du webhook
const CLE_WEBHOOK_VERSION = "webhook_version"; // version des réglages du webhook (permet une remise à niveau auto)
const VERSION_WEBHOOK = "3"; // v2 : callback_query (menu inline) · v3 : commandes ☰ + clavier permanent
const CHAT_ID_REGEX = /^-?\d{1,20}$/; // id de chat Telegram : entier (négatif possible pour les groupes)

const CONFIG_DEFAUT: ConfigStockee = {
  latitude: 45.36,            // position par défaut (modifiable dans la page)
  longitude: 0.92,
  seuilAlerte: 30,
  tempIdealeOuverture: 25,
  telegramChatId: "",
  notificationsActives: false,
  bulletinActif: false,
  bulletinHeure: 7,
};

const CLE_BULLETIN = "dernier_bulletin"; // date (YYYY-MM-DD, heure de Paris) du dernier bulletin envoyé

/** Rubriques d'actualités du bulletin (flux RSS publics). Une rubrique en panne est simplement omise. */
const FLUX_ACTUS: Array<{ titre: string; url: string; max: number }> = [
  { titre: "🗞️ Dordogne — Sud Ouest", url: "https://www.sudouest.fr/dordogne/rss.xml", max: 3 },
  { titre: "📰 France — franceinfo", url: "https://www.francetvinfo.fr/titres.rss", max: 3 },
  { titre: "⚽ Sport — L'Équipe", url: "https://www.lequipe.fr/rss/actu_rss.xml", max: 3 },
];

// ─────────────────── Fonctions pures (testables) ───────────────────

function determinerEtat(temp: number, c: Config): Etat {
  if (temp >= c.seuilAlerte) return "CHAUD";
  if (temp <= c.tempIdealeOuverture) return "IDEAL";
  return "TIEDE";
}

/** Message d'alerte explicite : ce qui se passe, quoi faire, et quand arrive la prochaine alerte. */
function construireMessage(temp: number, ressenti: number, etat: Etat, precedent: Etat | null, c: Config): Notification {
  const t = temp.toFixed(1);
  const r = ressenti.toFixed(1);
  const meteo = `Il fait ${t}°C dehors (ressenti ${r}°C).`;
  switch (etat) {
    case "IDEAL":
      return {
        titre: "✅ OUVRE TOUT",
        corps: `${meteo} C'est descendu sous ta température idéale (${c.tempIdealeOuverture}°C).\n→ Ouvre fenêtres et volets pour rafraîchir la maison.\nJe te préviens si ça remonte.`,
      };
    case "CHAUD":
      return {
        titre: "🔥 FERME TOUT",
        corps: `${meteo} Ton seuil de ${c.seuilAlerte}°C est dépassé.\n→ Ferme les fenêtres et baisse les volets pour garder le frais.\nJe te préviens dès que ça redescend.`,
      };
    case "TIEDE":
      if (precedent === "CHAUD")
        return {
          titre: "🌡️ Ça se rafraîchit",
          corps: `${meteo} C'est repassé sous ${c.seuilAlerte}°C.\n→ Pas encore le moment d'ouvrir : attends que ça descende sous ${c.tempIdealeOuverture}°C. Je te préviens.`,
        };
      if (precedent === "IDEAL")
        return {
          titre: "🌡️ Ça se réchauffe",
          corps: `${meteo} C'est remonté au-dessus de ${c.tempIdealeOuverture}°C.\n→ Si tu as ouvert, pense à refermer bientôt. J'alerte si ça atteint ${c.seuilAlerte}°C.`,
        };
      return {
        titre: "🌡️ Température intermédiaire",
        corps: `${meteo} Entre tes deux seuils (${c.tempIdealeOuverture}°C et ${c.seuilAlerte}°C).\n→ Garde fermé pour l'instant. J'alerte dès que ça passe sous ${c.tempIdealeOuverture}°C.`,
      };
  }
}

/** Conseil court pour /etat et le menu. */
function conseilTexte(etat: Etat, c: Config): string {
  switch (etat) {
    case "CHAUD": return `🔥 Garde tout fermé (${c.seuilAlerte}°C ou plus dehors).`;
    case "TIEDE": return `🌡️ Garde fermé encore un peu : pas encore sous ${c.tempIdealeOuverture}°C.`;
    case "IDEAL": return `✅ Ouvre fenêtres et volets : l'air est assez frais.`;
  }
}

/** Annonce explicitement le prochain événement qui déclenchera une alerte. */
function prochaineAlerte(etat: Etat, c: Config): string {
  switch (etat) {
    case "CHAUD": return `⏭ Prochaine alerte : quand ça passera sous ${c.seuilAlerte}°C.`;
    case "TIEDE": return `⏭ Prochaine alerte : sous ${c.tempIdealeOuverture}°C (ouvrir) ou à ${c.seuilAlerte}°C (fermer).`;
    case "IDEAL": return `⏭ Prochaine alerte : si ça remonte au-dessus de ${c.tempIdealeOuverture}°C.`;
  }
}

// ─────────────────────── Config (KV) ───────────────────────

function estNombreFini(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Valide un objet de réglages reçu de l'API. Bornes serveur + format chat id. */
function validerConfig(brut: unknown): { ok: true; valeur: ConfigStockee } | { ok: false; erreur: string } {
  if (typeof brut !== "object" || brut === null) return { ok: false, erreur: "Corps JSON attendu." };
  const b = brut as Record<string, unknown>;

  if (!estNombreFini(b.latitude) || b.latitude < -90 || b.latitude > 90)
    return { ok: false, erreur: "Latitude invalide (-90 à 90)." };
  if (!estNombreFini(b.longitude) || b.longitude < -180 || b.longitude > 180)
    return { ok: false, erreur: "Longitude invalide (-180 à 180)." };
  if (!estNombreFini(b.seuilAlerte) || b.seuilAlerte < -20 || b.seuilAlerte > 60)
    return { ok: false, erreur: "Seuil d'alerte invalide (-20 à 60 °C)." };
  if (!estNombreFini(b.tempIdealeOuverture) || b.tempIdealeOuverture < -20 || b.tempIdealeOuverture > 60)
    return { ok: false, erreur: "Température idéale invalide (-20 à 60 °C)." };
  if (b.tempIdealeOuverture >= b.seuilAlerte)
    return { ok: false, erreur: "La température idéale d'ouverture doit être inférieure au seuil d'alerte." };
  if (typeof b.notificationsActives !== "boolean")
    return { ok: false, erreur: "Le réglage des notifications est invalide." };
  if (typeof b.telegramChatId !== "string")
    return { ok: false, erreur: "Destination Telegram invalide." };

  const chatId = b.telegramChatId.trim();
  if (b.notificationsActives && chatId.length === 0)
    return { ok: false, erreur: "Connecte Telegram pour activer les notifications." };
  if (chatId.length > 0 && !CHAT_ID_REGEX.test(chatId))
    return { ok: false, erreur: "Destination Telegram invalide (id de chat numérique attendu)." };

  // Champs du bulletin, optionnels (absents des anciennes configs) : défauts sûrs.
  const bulletinActif = typeof b.bulletinActif === "boolean" ? b.bulletinActif : false;
  let bulletinHeure = 7;
  if (b.bulletinHeure !== undefined) {
    if (!estNombreFini(b.bulletinHeure) || !Number.isInteger(b.bulletinHeure) || b.bulletinHeure < 0 || b.bulletinHeure > 23)
      return { ok: false, erreur: "Heure du bulletin invalide (0 à 23)." };
    bulletinHeure = b.bulletinHeure;
  }

  return {
    ok: true,
    valeur: {
      latitude: b.latitude,
      longitude: b.longitude,
      seuilAlerte: b.seuilAlerte,
      tempIdealeOuverture: b.tempIdealeOuverture,
      telegramChatId: chatId,
      notificationsActives: b.notificationsActives,
      bulletinActif,
      bulletinHeure,
    },
  };
}

async function lireConfig(env: Env): Promise<Config> {
  let stockee: ConfigStockee = { ...CONFIG_DEFAUT };
  const brut = await env.ETAT_METEO.get(CLE_CONFIG);
  if (brut) {
    try {
      const v = validerConfig(JSON.parse(brut));
      if (v.ok) stockee = v.valeur;
      else console.warn("Config KV invalide, retour aux défauts :", v.erreur);
    } catch {
      console.warn("Config KV illisible, retour aux défauts.");
    }
  }
  return { ...stockee, telegramToken: env.TELEGRAM_TOKEN };
}

async function ecrireConfig(env: Env, valeur: ConfigStockee): Promise<void> {
  await env.ETAT_METEO.put(CLE_CONFIG, JSON.stringify(valeur));
}

// ─────────────────────── I/O externes ───────────────────────

async function recupererMeteo(c: Config): Promise<{ temp: number; ressenti: number }> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(c.latitude));
  url.searchParams.set("longitude", String(c.longitude));
  url.searchParams.set("current", "temperature_2m,apparent_temperature");
  url.searchParams.set("timezone", "Europe/Paris");

  const reponse = await fetch(url.toString());
  if (!reponse.ok) throw new Error(`Open-Meteo a répondu ${reponse.status}.`);

  const data = (await reponse.json()) as OpenMeteoReponse;
  const temp = data.current?.temperature_2m;
  if (typeof temp !== "number" || Number.isNaN(temp))
    throw new Error("Température absente de la réponse Open-Meteo.");
  const ressenti = data.current?.apparent_temperature ?? temp;
  return { temp, ressenti };
}

/** Appel générique de l'API Bot Telegram. */
async function tgApi(token: string, methode: string, corps: Record<string, unknown>): Promise<void> {
  const reponse = await fetch(`https://api.telegram.org/bot${token}/${methode}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corps),
  });
  if (!reponse.ok) {
    const detail = await reponse.text().catch(() => "");
    throw new Error(`Telegram (${methode}) a répondu ${reponse.status} ${detail}`.trim());
  }
}

async function telegramEnvoyer(token: string, chatId: string, texte: string, clavier?: unknown, html = false): Promise<void> {
  const corps: Record<string, unknown> = { chat_id: chatId, text: texte };
  if (clavier) corps.reply_markup = clavier;
  if (html) { corps.parse_mode = "HTML"; corps.disable_web_page_preview = true; }
  await tgApi(token, "sendMessage", corps);
}

async function envoyerNotification(n: Notification, c: Config): Promise<void> {
  if (!c.telegramToken) throw new Error("Bot Telegram non configuré (secret TELEGRAM_TOKEN manquant).");
  if (!c.telegramChatId) throw new Error("Aucune destination Telegram (clique « Connecter Telegram »).");
  await telegramEnvoyer(c.telegramToken, c.telegramChatId, `${n.titre}\n${n.corps}`);
}

/** Lit getUpdates et renvoie le chat le plus récent ayant écrit au bot. */
async function detecterChatTelegram(c: Config): Promise<{ chatId: string; nom: string } | null> {
  if (!c.telegramToken) throw new Error("Bot Telegram non configuré (secret TELEGRAM_TOKEN manquant).");
  const reponse = await fetch(`https://api.telegram.org/bot${c.telegramToken}/getUpdates`);
  if (!reponse.ok) {
    const detail = await reponse.text().catch(() => "");
    throw new Error(`Telegram a répondu ${reponse.status} ${detail}`.trim());
  }
  const data = (await reponse.json()) as TelegramUpdates;
  const updates = data.result ?? [];
  for (let i = updates.length - 1; i >= 0; i--) {
    const chat = updates[i]?.message?.chat;
    if (chat && typeof chat.id === "number") {
      return { chatId: String(chat.id), nom: chat.first_name ?? chat.title ?? "" };
    }
  }
  return null;
}

// ─────────────────────── Bulletin du matin (actus + météo + carburant) ───────────────────────

/** Décode les entités XML/HTML courantes des titres de flux RSS. */
function decoderEntites(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ");
}

/** Échappe le texte inséré dans un message Telegram en mode HTML. */
function echapperHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Extraction minimaliste des <item> d'un flux RSS (suffisant, pas de parseur XML dans Workers). */
function extraireItemsRss(xml: string, max: number): Array<{ titre: string; lien: string }> {
  const items: Array<{ titre: string; lien: string }> = [];
  const blocs = xml.split(/<item[\s>]/).slice(1);
  for (const bloc of blocs) {
    const t = /<title>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/title>/.exec(bloc);
    const l = /<link>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/link>/.exec(bloc);
    if (t && l) {
      let titre = decoderEntites(t[1].trim()).replace(/\s+/g, " ");
      if (titre.length > 110) titre = titre.slice(0, 107) + "…";
      const lien = l[1].trim();
      if (titre && lien.startsWith("http")) items.push({ titre, lien });
    }
    if (items.length >= max) break;
  }
  return items;
}

/** Charge une rubrique RSS et la formate en lignes HTML Telegram. Erreur -> null (rubrique omise). */
async function chargerRubrique(flux: { titre: string; url: string; max: number }): Promise<string | null> {
  try {
    const reponse = await fetch(flux.url, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (bulletin-aeration; usage personnel)" },
    });
    if (!reponse.ok) return null;
    const items = extraireItemsRss(await reponse.text(), flux.max);
    if (items.length === 0) return null;
    const lignes = items.map((i) => `• <a href="${i.lien}">${echapperHtml(i.titre)}</a>`);
    return `<b>${flux.titre}</b>\n${lignes.join("\n")}`;
  } catch {
    return null;
  }
}

interface OpenMeteoJour {
  daily?: {
    temperature_2m_min?: number[];
    temperature_2m_max?: number[];
    precipitation_probability_max?: number[];
    wind_gusts_10m_max?: number[];
  };
}

/** Météo du jour (min/max, pluie, rafales) + alertes simples calculées. Erreur -> null. */
async function rubriqueMeteoJour(c: Config): Promise<string | null> {
  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(c.latitude));
    url.searchParams.set("longitude", String(c.longitude));
    url.searchParams.set("daily", "temperature_2m_min,temperature_2m_max,precipitation_probability_max,wind_gusts_10m_max");
    url.searchParams.set("timezone", "Europe/Paris");
    url.searchParams.set("forecast_days", "1");
    const reponse = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
    if (!reponse.ok) return null;
    const d = ((await reponse.json()) as OpenMeteoJour).daily;
    const min = d?.temperature_2m_min?.[0];
    const max = d?.temperature_2m_max?.[0];
    const pluie = d?.precipitation_probability_max?.[0];
    const rafales = d?.wind_gusts_10m_max?.[0];
    if (typeof min !== "number" || typeof max !== "number") return null;

    const lignes = [`<b>🌦️ Météo du jour</b>`, `Min ${min.toFixed(0)}° / Max ${max.toFixed(0)}°` +
      (typeof pluie === "number" ? ` · pluie ${pluie.toFixed(0)} %` : "") +
      (typeof rafales === "number" ? ` · rafales ${rafales.toFixed(0)} km/h` : "")];
    // Alertes simples, calculées localement (pas d'API à clé nécessaire).
    if (max >= c.seuilAlerte) lignes.push(`🔥 Il fera chaud (${max.toFixed(0)}°) : aère tôt, ferme avant que ça monte.`);
    if (min <= 0) lignes.push(`❄️ Gel possible (${min.toFixed(0)}°) : protège plantes et canalisations.`);
    if (typeof rafales === "number" && rafales >= 60) lignes.push(`💨 Vent fort prévu (${rafales.toFixed(0)} km/h) : range ce qui s'envole.`);
    if (typeof pluie === "number" && pluie >= 70) lignes.push(`🌧️ Pluie très probable : pense au linge et aux fenêtres.`);
    return lignes.join("\n");
  } catch {
    return null;
  }
}

interface OdsCarburant {
  records?: Array<{ fields?: Record<string, unknown> }>;
}

/** Station la moins chère à ~15 km (open data officiel des prix des carburants). Erreur -> null. */
async function rubriqueCarburant(c: Config): Promise<string | null> {
  try {
    const url = new URL("https://data.economie.gouv.fr/api/records/1.0/search/");
    url.searchParams.set("dataset", "prix-des-carburants-en-france-flux-instantane-v2");
    url.searchParams.set("geofilter.distance", `${c.latitude},${c.longitude},15000`);
    url.searchParams.set("rows", "60");
    const reponse = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
    if (!reponse.ok) return null;
    const data = (await reponse.json()) as OdsCarburant;
    const records = data.records ?? [];

    // Le champ des prix varie selon les versions du jeu de données : on lit large.
    const meilleurs = new Map<string, { prix: number; ville: string }>();
    for (const r of records) {
      const f = r.fields ?? {};
      const ville = typeof f.ville === "string" ? f.ville : "";
      const bruts: Array<{ nom?: string; valeur?: unknown }> = [];
      if (typeof f.prix === "string") {
        try {
          const p = JSON.parse(f.prix) as unknown;
          for (const e of Array.isArray(p) ? p : [p]) {
            const o = e as Record<string, unknown>;
            bruts.push({ nom: String(o["@nom"] ?? o["nom"] ?? ""), valeur: o["@valeur"] ?? o["valeur"] });
          }
        } catch { /* format inattendu : station ignorée */ }
      }
      for (const carb of ["Gazole", "SP95", "E10", "SP98"]) {
        const direct = f[`${carb.toLowerCase()}_prix`];
        if (direct !== undefined) bruts.push({ nom: carb, valeur: direct });
      }
      for (const b of bruts) {
        const nom = (b.nom ?? "").trim();
        const prix = Number(b.valeur);
        if (!nom || !Number.isFinite(prix) || prix <= 0) continue;
        const actuel = meilleurs.get(nom);
        if (!actuel || prix < actuel.prix) meilleurs.set(nom, { prix, ville });
      }
    }
    if (meilleurs.size === 0) return null;

    const ordre = ["Gazole", "E10", "SP95", "SP98", "E85", "GPLc"];
    const lignes = ordre
      .filter((n) => meilleurs.has(n))
      .slice(0, 3)
      .map((n) => {
        const m = meilleurs.get(n)!;
        return `• ${n} : <b>${m.prix.toFixed(2)} €</b>${m.ville ? " — " + echapperHtml(m.ville) : ""}`;
      });
    if (lignes.length === 0) return null;
    return `<b>⛽ Carburant le moins cher (15 km)</b>\n${lignes.join("\n")}`;
  } catch {
    return null;
  }
}

/** Assemble le bulletin : chaque rubrique est indépendante, une panne = rubrique omise. */
async function construireBulletin(c: Config): Promise<string> {
  const dateFr = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Paris",
  }).format(new Date());

  const rubriques = await Promise.allSettled([
    rubriqueMeteoJour(c),
    ...FLUX_ACTUS.map((f) => chargerRubrique(f)),
    rubriqueCarburant(c),
  ]);
  const blocs = rubriques
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter((b): b is string => Boolean(b));

  const entete = `<b>☀️ Bulletin du ${echapperHtml(dateFr)}</b>`;
  if (blocs.length === 0)
    return `${entete}\n\nLes sources d'infos ne répondent pas pour le moment — réessaie avec /matin dans quelques minutes.`;
  return [entete, ...blocs].join("\n\n");
}

async function envoyerBulletin(config: Config, chatId: string): Promise<void> {
  if (!config.telegramToken) return;
  await telegramEnvoyer(config.telegramToken, chatId, await construireBulletin(config), undefined, true);
}

// ─────────────────────── Bot Telegram : webhook & commandes ───────────────────────

/** Enregistre le webhook auprès de Telegram (commandes en temps réel). */
async function configurerWebhook(env: Env, token: string, origin: string): Promise<void> {
  let secret = await env.ETAT_METEO.get(CLE_WEBHOOK_SECRET);
  if (!secret) {
    secret = crypto.randomUUID().replace(/-/g, ""); // hex -> caractères autorisés par Telegram
    await env.ETAT_METEO.put(CLE_WEBHOOK_SECRET, secret);
  }
  const reponse = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: `${origin}/api/telegram/webhook`,
      secret_token: secret,
      allowed_updates: ["message", "edited_message", "callback_query"],
    }),
  });
  if (!reponse.ok) {
    const detail = await reponse.text().catch(() => "");
    throw new Error(`setWebhook a échoué : ${reponse.status} ${detail}`.trim());
  }
  // Liste déroulante du bouton « ☰ Menu » à côté du champ de saisie : plus besoin
  // de connaître les commandes, Telegram les propose et les insère au clic.
  await tgApi(token, "setMyCommands", {
    commands: [
      { command: "menu", description: "⚙️ Réglages : alertes et seuils" },
      { command: "etat", description: "🌡️ Météo et conseil du moment" },
      { command: "matin", description: "🗞️ Bulletin d'infos maintenant" },
      { command: "carburant", description: "⛽ Prix les moins chers à 15 km" },
      { command: "alertes", description: "🔔 Activer / couper les alertes (on, off)" },
      { command: "seuil", description: "🔥 Température pour fermer (ex. 30)" },
      { command: "ideale", description: "✅ Température pour ouvrir (ex. 25)" },
    ],
  }).catch(() => {}); // confort : un échec ici ne doit pas casser la connexion
  await tgApi(token, "setChatMenuButton", { menu_button: { type: "commands" } }).catch(() => {});
  await env.ETAT_METEO.put(CLE_WEBHOOK_VERSION, VERSION_WEBHOOK);
}

// Clavier permanent : remplace le clavier alphabétique par des boutons toujours
// visibles. Un appui envoie le libellé comme message texte -> voir BOUTONS_TEXTE.
const BTN_METEO = "🌡️ Météo";
const BTN_BULLETIN = "🗞️ Bulletin";
const BTN_REGLAGES = "⚙️ Réglages";
const BTN_CARBURANT = "⛽ Carburant";

/** Libellé du clavier permanent -> commande interne équivalente. */
const BOUTONS_TEXTE: Record<string, string> = {
  [BTN_METEO]: "etat",
  [BTN_BULLETIN]: "matin",
  [BTN_REGLAGES]: "menu",
  [BTN_CARBURANT]: "carburant",
};

function clavierPermanent(): unknown {
  return {
    keyboard: [
      [{ text: BTN_METEO }, { text: BTN_BULLETIN }],
      [{ text: BTN_REGLAGES }, { text: BTN_CARBURANT }],
    ],
    resize_keyboard: true, // hauteur ajustée au contenu, ne mange pas l'écran
    is_persistent: true,   // reste affiché au lieu de se replier après usage
  };
}

/** Clavier du menu : tout se règle en tapant sur les boutons. */
function clavierMenu(c: ConfigStockee): unknown {
  return {
    inline_keyboard: [
      [
        { text: "🔄 Actualiser", callback_data: "maj" },
        { text: c.notificationsActives ? "🔔 Alertes : ON" : "🔕 Alertes : OFF", callback_data: "alertes" },
      ],
      [
        { text: "−1°", callback_data: "ideale-" },
        { text: `✅ Ouvrir ≤ ${c.tempIdealeOuverture}°`, callback_data: "rien" },
        { text: "+1°", callback_data: "ideale+" },
      ],
      [
        { text: "−1°", callback_data: "seuil-" },
        { text: `🔥 Fermer ≥ ${c.seuilAlerte}°`, callback_data: "rien" },
        { text: "+1°", callback_data: "seuil+" },
      ],
      [
        { text: "🗞️ Bulletin infos", callback_data: "bulletin" },
        { text: c.bulletinActif ? `☀️ Chaque jour ${c.bulletinHeure}h : ON` : "🌙 Bulletin auto : OFF", callback_data: "matinToggle" },
      ],
    ],
  };
}

/** Texte du menu : météo du moment + conseil + prochaine alerte. */
async function texteMenu(c: Config): Promise<string> {
  const lignes: string[] = [];
  try {
    const { temp, ressenti } = await recupererMeteo(c);
    const etat = determinerEtat(temp, c);
    lignes.push(`🌡️ Il fait ${temp.toFixed(1)}°C dehors (ressenti ${ressenti.toFixed(1)}°C)`);
    lignes.push("");
    lignes.push(conseilTexte(etat, c));
    lignes.push(prochaineAlerte(etat, c));
  } catch {
    lignes.push("🌡️ Météo indisponible pour le moment (réessaie avec 🔄).");
  }
  lignes.push("");
  lignes.push(c.notificationsActives
    ? "🔔 Alertes activées — je vérifie la météo toutes les 15 min."
    : "🔕 Alertes coupées — tape le bouton pour les réactiver.");
  lignes.push("Règle tout avec les boutons ↓ · envoie 📍 ta position pour changer de lieu.");
  return lignes.join("\n");
}

async function envoyerMenu(env: Env, config: Config, chatId: string): Promise<void> {
  if (!config.telegramToken) return;
  const { telegramToken, ...stockee } = config;
  await telegramEnvoyer(config.telegramToken, chatId, await texteMenu(config), clavierMenu(stockee));
}

/** Applique une modification de réglages venant du bot, valide et confirme (ou explique l'erreur). */
async function appliquerModif(
  env: Env,
  token: string,
  chatId: string,
  stockee: ConfigStockee,
  modif: Partial<ConfigStockee>,
  confirmation: string,
): Promise<void> {
  const v = validerConfig({ ...stockee, ...modif });
  if (!v.ok) { await telegramEnvoyer(token, chatId, "⚠ " + v.erreur); return; }
  await ecrireConfig(env, v.valeur);
  await telegramEnvoyer(token, chatId, confirmation);
}

/** Traite un message reçu du propriétaire (commande texte ou partage de position). */
async function traiterMessage(env: Env, config: Config, msg: TgMessage): Promise<void> {
  const token = config.telegramToken;
  if (!token || typeof msg.chat?.id !== "number") return;
  const chatId = String(msg.chat.id);
  const { telegramToken, ...stockee } = config; // réglages persistables actuels

  // 1) Partage de position (ponctuel ou « position en direct » via edited_message).
  if (msg.location && estNombreFini(msg.location.latitude) && estNombreFini(msg.location.longitude)) {
    const lat = Math.round(msg.location.latitude * 1e4) / 1e4;
    const lon = Math.round(msg.location.longitude * 1e4) / 1e4;
    await appliquerModif(env, token, chatId, stockee, { latitude: lat, longitude: lon },
      `📍 C'est noté : je surveille maintenant la météo à ta nouvelle position (${lat.toFixed(3)}, ${lon.toFixed(3)}).`);
    return;
  }

  // 2) Commande texte, ou appui sur un bouton du clavier permanent (arrive comme du texte).
  const texte = (msg.text ?? "").trim();
  if (!texte) return;
  const morceaux = texte.split(/\s+/);
  let cmd = morceaux[0].toLowerCase();
  if (cmd.startsWith("/")) cmd = cmd.slice(1);
  const arobase = cmd.indexOf("@"); // ex. /seuil@MonBot dans un groupe
  if (arobase >= 0) cmd = cmd.slice(0, arobase);
  let arg = morceaux.slice(1).join(" ").replace(",", ".").trim();
  const bouton = BOUTONS_TEXTE[texte];
  if (bouton) { cmd = bouton; arg = ""; }

  if (cmd === "seuil" || cmd === "ideale" || cmd === "ideal") {
    const n = Number(arg);
    if (arg === "" || !Number.isFinite(n)) {
      await telegramEnvoyer(token, chatId, cmd === "seuil"
        ? "Indique la température, ex. « /seuil 30 » → j'alerte de fermer à partir de 30°C."
        : "Indique la température, ex. « /ideale 25 » → j'alerte d'ouvrir dès que ça passe sous 25°C.");
      return;
    }
    if (cmd === "seuil")
      await appliquerModif(env, token, chatId, stockee, { seuilAlerte: n },
        `🔥 OK : je t'alerte de FERMER à partir de ${n}°C.\n(✅ ouvrir ≤ ${stockee.tempIdealeOuverture}°C · 🔥 fermer ≥ ${n}°C)`);
    else
      await appliquerModif(env, token, chatId, stockee, { tempIdealeOuverture: n },
        `✅ OK : je t'alerte d'OUVRIR dès que ça passe sous ${n}°C.\n(✅ ouvrir ≤ ${n}°C · 🔥 fermer ≥ ${stockee.seuilAlerte}°C)`);
    return;
  }

  if (cmd === "alertes") {
    const v = arg.toLowerCase();
    if (v !== "on" && v !== "off") { await telegramEnvoyer(token, chatId, "Utilise « /alertes on » ou « /alertes off » (ou le bouton du /menu)."); return; }
    await appliquerModif(env, token, chatId, stockee, { notificationsActives: v === "on" },
      v === "on"
        ? "🔔 Alertes activées — je vérifie la météo toutes les 15 min et je te préviens au bon moment."
        : "🔕 Alertes coupées — je ne t'enverrai plus rien. Tape « /alertes on » pour reprendre.");
    return;
  }

  if (cmd === "matin" || cmd === "bulletin" || cmd === "infos" || cmd === "news") {
    const v = arg.toLowerCase();
    if (cmd === "matin" && (v === "on" || v === "off")) {
      await appliquerModif(env, token, chatId, stockee, { bulletinActif: v === "on" },
        v === "on"
          ? `☀️ Bulletin du matin activé — tu le recevras chaque jour vers ${stockee.bulletinHeure} h (change l'heure avec « /matin 8 »).`
          : "🌙 Bulletin du matin désactivé. Tape « /matin on » pour le reprendre.");
      return;
    }
    if (cmd === "matin" && v !== "") {
      const h = Number(v.replace("h", ""));
      if (!Number.isInteger(h) || h < 0 || h > 23) {
        await telegramEnvoyer(token, chatId, "Indique une heure entière, ex. « /matin 8 » pour le recevoir à 8 h.");
        return;
      }
      await appliquerModif(env, token, chatId, stockee, { bulletinActif: true, bulletinHeure: h },
        `☀️ OK : bulletin chaque jour vers ${h} h (heure de Paris).`);
      return;
    }
    // /matin (sans argument), /infos, /bulletin -> envoi immédiat.
    await envoyerBulletin(config, chatId);
    return;
  }

  if (cmd === "carburant" || cmd === "essence") {
    const rubrique = await rubriqueCarburant(config);
    await telegramEnvoyer(token, chatId,
      rubrique ?? "⛽ Prix des carburants indisponibles pour le moment, réessaie dans quelques minutes.",
      undefined, rubrique !== null);
    return;
  }

  if (cmd === "etat" || cmd === "meteo") {
    try {
      const { temp, ressenti } = await recupererMeteo(config);
      const etat = determinerEtat(temp, config);
      await telegramEnvoyer(token, chatId,
        `🌡️ Il fait ${temp.toFixed(1)}°C dehors (ressenti ${ressenti.toFixed(1)}°C)\n${conseilTexte(etat, config)}\n${prochaineAlerte(etat, config)}`);
    } catch {
      await telegramEnvoyer(token, chatId, "Météo indisponible pour le moment, réessaie dans une minute.");
    }
    return;
  }

  // /start, /aide : on (ré)installe d'abord le clavier permanent, puis le menu.
  if (cmd === "start" || cmd === "aide" || cmd === "help") {
    await telegramEnvoyer(token, chatId,
      "👋 Salut ! Les boutons ci-dessous restent affichés sous ton clavier :\n" +
      `${BTN_METEO} · ${BTN_BULLETIN} · ${BTN_REGLAGES} · ${BTN_CARBURANT}\n` +
      "Le bouton ☰ à côté du champ de saisie liste aussi toutes les commandes.",
      clavierPermanent());
  }

  // /menu ou n'importe quel autre message -> le menu à boutons.
  await envoyerMenu(env, config, chatId);
}

/** Traite un appui sur un bouton du menu : applique, confirme, et met le menu à jour sur place. */
async function traiterCallback(env: Env, config: Config, cb: TgCallbackQuery): Promise<void> {
  const token = config.telegramToken;
  if (!token || typeof cb.message?.chat?.id !== "number") return;
  const chatId = String(cb.message.chat.id);
  const { telegramToken, ...stockee } = config;

  let modif: Partial<ConfigStockee> | null = null;
  let confirmation = "";
  switch (cb.data) {
    case "alertes":
      modif = { notificationsActives: !stockee.notificationsActives };
      confirmation = stockee.notificationsActives ? "🔕 Alertes coupées" : "🔔 Alertes activées";
      break;
    case "ideale-": modif = { tempIdealeOuverture: stockee.tempIdealeOuverture - 1 }; break;
    case "ideale+": modif = { tempIdealeOuverture: stockee.tempIdealeOuverture + 1 }; break;
    case "seuil-": modif = { seuilAlerte: stockee.seuilAlerte - 1 }; break;
    case "seuil+": modif = { seuilAlerte: stockee.seuilAlerte + 1 }; break;
    case "maj": confirmation = "Actualisé"; break;
    case "bulletin":
      // Envoi du bulletin en nouveau message : on accuse réception tout de suite
      // (la collecte des sources peut prendre quelques secondes), sans toucher au menu.
      await tgApi(token, "answerCallbackQuery", { callback_query_id: cb.id, text: "Je prépare le bulletin…" }).catch(() => {});
      await envoyerBulletin(config, chatId).catch(async () => {
        await telegramEnvoyer(token, chatId, "Impossible de préparer le bulletin, réessaie dans quelques minutes.").catch(() => {});
      });
      return;
    case "matinToggle":
      modif = { bulletinActif: !stockee.bulletinActif };
      confirmation = stockee.bulletinActif ? "🌙 Bulletin auto coupé" : `☀️ Bulletin chaque jour vers ${stockee.bulletinHeure} h`;
      break;
    default:
      await tgApi(token, "answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
      return;
  }

  if (modif) {
    const v = validerConfig({ ...stockee, ...modif });
    if (!v.ok) {
      // Réglage refusé (ex. idéale >= seuil) : on explique dans la petite bulle, sans rien changer.
      await tgApi(token, "answerCallbackQuery", { callback_query_id: cb.id, text: "⚠ " + v.erreur, show_alert: true }).catch(() => {});
      return;
    }
    await ecrireConfig(env, v.valeur);
    if (!confirmation) {
      confirmation = modif.tempIdealeOuverture !== undefined
        ? `✅ Ouvrir ≤ ${v.valeur.tempIdealeOuverture}°C`
        : `🔥 Fermer ≥ ${v.valeur.seuilAlerte}°C`;
    }
  }

  await tgApi(token, "answerCallbackQuery", { callback_query_id: cb.id, text: confirmation }).catch(() => {});

  // Menu mis à jour sur place (texte + boutons). Telegram refuse une édition identique : on ignore.
  const configMaj = await lireConfig(env);
  const { telegramToken: _t, ...stockeeMaj } = configMaj;
  if (typeof cb.message.message_id === "number") {
    await tgApi(token, "editMessageText", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: await texteMenu(configMaj),
      reply_markup: clavierMenu(stockeeMaj),
    }).catch(() => {});
  }
}

/** Endpoint appelé par Telegram à chaque update. Toujours répondre 200 (sinon Telegram réessaie). */
async function gererWebhook(request: Request, env: Env): Promise<Response> {
  const config = await lireConfig(env);
  if (!config.telegramToken) return json({ ok: true });

  const secretAttendu = await env.ETAT_METEO.get(CLE_WEBHOOK_SECRET);
  if (!secretAttendu || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secretAttendu)
    return new Response("forbidden", { status: 403 });

  // Mise à niveau silencieuse : si les réglages du webhook datent d'une version
  // précédente (ex. sans les boutons), on les réenregistre au premier message reçu.
  const version = await env.ETAT_METEO.get(CLE_WEBHOOK_VERSION);
  if (version !== VERSION_WEBHOOK) {
    try {
      await configurerWebhook(env, config.telegramToken, new URL(request.url).origin);
      // Le clavier permanent s'installe par un message : on le pose une fois ici,
      // pour ne pas avoir à retaper /start après une mise à jour.
      if (config.telegramChatId)
        await telegramEnvoyer(config.telegramToken, config.telegramChatId,
          "✨ Nouveau : des boutons permanents sous ton clavier, et la liste des commandes dans le bouton ☰.",
          clavierPermanent());
    } catch (e) { console.warn("Remise à niveau webhook :", e instanceof Error ? e.message : e); }
  }

  let update: TgUpdate;
  try { update = (await request.json()) as TgUpdate; } catch { return json({ ok: true }); }

  // Appui sur un bouton du menu.
  if (update.callback_query) {
    const cb = update.callback_query;
    if (config.telegramChatId && String(cb.message?.chat?.id) === config.telegramChatId) {
      try { await traiterCallback(env, config, cb); }
      catch (e) { console.error("Webhook (bouton) :", e instanceof Error ? e.message : e); }
    }
    return json({ ok: true });
  }

  const msg = update.message ?? update.edited_message;
  if (!msg) return json({ ok: true });

  // On n'accepte que le chat propriétaire (celui connecté). Les autres sont ignorés.
  if (!config.telegramChatId || String(msg.chat?.id) !== config.telegramChatId) return json({ ok: true });

  try { await traiterMessage(env, config, msg); }
  catch (e) { console.error("Webhook :", e instanceof Error ? e.message : e); }
  return json({ ok: true });
}

const json = (data: unknown, status = 200): Response => Response.json(data, { status });

// ─────────────────────── Handlers Worker ───────────────────────

export default {
  /** Cron : alertes d'aération (sur transition d'état) + bulletin du matin. Blocs indépendants. */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const config = await lireConfig(env);
    if (!config.telegramToken || !config.telegramChatId) { console.log("Telegram non configuré : cycle ignoré."); return; }

    // 1) Alertes d'aération.
    try {
      if (config.notificationsActives) {
        const { temp, ressenti } = await recupererMeteo(config);
        const etatActuel = determinerEtat(temp, config);
        const etatPrecedent = (await env.ETAT_METEO.get(CLE_ETAT)) as Etat | null;

        if (etatActuel !== etatPrecedent) {
          // On notifie d'abord : si l'envoi échoue, l'état n'est pas mémorisé et
          // la transition sera retentée au prochain cycle.
          await envoyerNotification(construireMessage(temp, ressenti, etatActuel, etatPrecedent, config), config);
          await env.ETAT_METEO.put(CLE_ETAT, etatActuel);
          console.log(`Transition ${etatPrecedent ?? "INIT"} -> ${etatActuel} (${temp}°C).`);
        } else {
          console.log(`État inchangé (${etatActuel}, ${temp}°C).`);
        }
      } else {
        console.log("Alertes d'aération désactivées.");
      }
    } catch (e) {
      console.error("Échec du cycle météo :", e instanceof Error ? e.message : e);
    }

    // 2) Bulletin du matin : au premier passage du cron dans l'heure choisie, une fois par jour.
    try {
      if (config.bulletinActif) {
        const maintenant = new Date();
        const heureParis = Number(new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false }).format(maintenant));
        const jourParis = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(maintenant); // YYYY-MM-DD
        if (heureParis === config.bulletinHeure) {
          const dernier = await env.ETAT_METEO.get(CLE_BULLETIN);
          if (dernier !== jourParis) {
            await envoyerBulletin(config, config.telegramChatId);
            await env.ETAT_METEO.put(CLE_BULLETIN, jourParis);
            console.log(`Bulletin envoyé (${jourParis} ${heureParis}h).`);
          }
        }
      }
    } catch (e) {
      console.error("Échec du bulletin :", e instanceof Error ? e.message : e);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const chemin = url.pathname;

    // Page (accès libre).
    if (request.method === "GET" && (chemin === "/" || chemin === "/index.html")) {
      return new Response(PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (chemin.startsWith("/api/")) {
      // Webhook Telegram : validé par jeton secret (en-tête), pas d'autre auth.
      if (chemin === "/api/telegram/webhook" && request.method === "POST") {
        return gererWebhook(request, env);
      }

      // Accès libre : pas d'authentification (app perso).
      if (chemin === "/api/config" && request.method === "GET") {
        // On exclut telegramToken : ne jamais exposer le token au client.
        // telegramTokenConfigure (booléen) : indique à la page si le secret est bien lu.
        const { telegramToken, ...stockee } = await lireConfig(env);
        return json({ ...stockee, telegramTokenConfigure: Boolean(telegramToken) });
      }

      if (chemin === "/api/config" && request.method === "POST") {
        let corps: unknown;
        try { corps = await request.json(); } catch { return json({ erreur: "JSON invalide." }, 400); }
        const v = validerConfig(corps);
        if (!v.ok) return json({ erreur: v.erreur }, 400);
        await ecrireConfig(env, v.valeur);
        return json({ ok: true });
      }

      if (chemin === "/api/telegram/connect" && request.method === "POST") {
        const config = await lireConfig(env);
        if (!config.telegramToken)
          return json({ erreur: "Ajoute d'abord le secret TELEGRAM_TOKEN sur le worker." }, 400);
        try {
          // getUpdates et le webhook sont exclusifs : on retire le webhook le temps de lire le chat…
          await fetch(`https://api.telegram.org/bot${config.telegramToken}/deleteWebhook`).catch(() => {});
          // Détection du chat, non bloquante : si getUpdates ne renvoie rien (message expiré
          // après 24 h) on retombe sur le chat déjà enregistré, pour armer quand même le webhook.
          let detecte: { chatId: string; nom: string } | null = null;
          try { detecte = await detecterChatTelegram(config); } catch { /* getUpdates indispo : on continue */ }
          const chatId = detecte?.chatId ?? config.telegramChatId;
          if (!chatId)
            return json({ erreur: "Aucun message reçu. Ouvre ton bot dans Telegram et envoie /start, puis réessaie." }, 404);
          // Enregistre le chat si nouvellement détecté.
          if (detecte && detecte.chatId !== config.telegramChatId) {
            const { telegramToken, ...stockee } = config;
            const v = validerConfig({ ...stockee, telegramChatId: detecte.chatId });
            if (v.ok) await ecrireConfig(env, v.valeur);
          }
          // …puis on (ré)arme le webhook pour activer les commandes du bot.
          await configurerWebhook(env, config.telegramToken, new URL(request.url).origin);
          return json({ chatId, nom: detecte?.nom ?? "" });
        } catch (e) {
          return json({ erreur: e instanceof Error ? e.message : "Échec de la connexion Telegram." }, 502);
        }
      }

      if (chemin === "/api/telegram/diag" && request.method === "GET") {
        // Diagnostic : état du webhook côté Telegram (aucun secret renvoyé).
        const config = await lireConfig(env);
        if (!config.telegramToken) return json({ erreur: "TELEGRAM_TOKEN manquant (secret non vu par le worker)." }, 400);
        try {
          const r = await fetch(`https://api.telegram.org/bot${config.telegramToken}/getWebhookInfo`);
          const data = (await r.json()) as {
            result?: { url?: string; pending_update_count?: number; last_error_date?: number; last_error_message?: string };
          };
          const info = data.result ?? {};
          return json({
            webhookUrl: info.url || "(aucun webhook armé)",
            messagesEnAttente: info.pending_update_count ?? 0,
            derniereErreur: info.last_error_message || "(aucune)",
            derniereErreurQuand: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null,
            chatEnregistre: config.telegramChatId || "(aucun)",
          });
        } catch (e) {
          return json({ erreur: e instanceof Error ? e.message : "Échec du diagnostic." }, 502);
        }
      }

      if (chemin === "/api/test" && request.method === "POST") {
        const config = await lireConfig(env);
        if (!config.telegramToken) return json({ erreur: "Ajoute d'abord le secret TELEGRAM_TOKEN sur le worker." }, 400);
        if (!config.telegramChatId) return json({ erreur: "Connecte Telegram d'abord (bouton « Connecter Telegram »)." }, 400);
        try {
          await envoyerNotification(
            {
              titre: "🔔 Test réussi — les notifications fonctionnent !",
              corps: `Je te préviendrai :\n✅ d'OUVRIR quand il fera ${config.tempIdealeOuverture}°C ou moins\n🔥 de FERMER quand il fera ${config.seuilAlerte}°C ou plus\nEnvoie-moi /menu pour tout régler avec des boutons.`,
            },
            config,
          );
          return json({ ok: true });
        } catch (e) {
          return json({ erreur: e instanceof Error ? e.message : "Échec de l'envoi." }, 502);
        }
      }

      if (chemin === "/api/etat" && request.method === "GET") {
        const config = await lireConfig(env);
        try {
          const p = url.searchParams.get("temp"); // override de debug
          let temp: number, ressenti: number;
          if (p !== null) {
            temp = Number(p);
            if (Number.isNaN(temp)) return json({ erreur: "Paramètre temp invalide." }, 400);
            ressenti = temp;
          } else {
            ({ temp, ressenti } = await recupererMeteo(config));
          }
          return json({
            temperature: temp,
            ressenti,
            etat: determinerEtat(temp, config),
            seuilAlerte: config.seuilAlerte,
            tempIdealeOuverture: config.tempIdealeOuverture,
          });
        } catch (e) {
          return json({ erreur: e instanceof Error ? e.message : "Météo indisponible." }, 502);
        }
      }

      return json({ erreur: "Route inconnue." }, 404);
    }

    return new Response("Not found", { status: 404 });
  },
};
