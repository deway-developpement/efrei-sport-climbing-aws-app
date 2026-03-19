import { getSecret } from '../../../layers/commons/aws.secret';
import { putAssociationAnnouncement } from '../../../layers/commons/dynamodb.association_announcements';
import { buildAssociationAnnouncementFromDiscordMessage, parseAnnouncementRetentionDays } from '../src/association.announcements';
import { compactAnnouncementWithFallback } from '../src/association.announcements.compactor';

const DISCORD_BOT_TOKEN_SECRET_PATH =
    process.env.DISCORD_BOT_TOKEN_SECRET_PATH || 'Efrei-Sport-Climbing-App/secrets/discord_bot_token';
const ACTIVE_DAYS = 7;
const RETENTION_DAYS = parseAnnouncementRetentionDays(process.env.DM_ANNOUNCEMENT_RETENTION_DAYS);
const POST_DELAY_MS = parseInt(process.env.DISCORD_IMPORT_POST_DELAY_MS || '750', 10);
const DRY_RUN = process.env.DRY_RUN === 'true';

type DiscordSecret = {
    DISCORD_BOT_TOKEN?: string;
};

type BackfillAnnouncement = {
    postedAtIso: string;
    author: string;
    content: string;
};

const ANNOUNCEMENTS: BackfillAnnouncement[] = [
    {
        postedAtIso: '2026-01-12T12:11:00+01:00',
        author: 'Paul Mairesse [CODE]',
        content:
            "Hello @Membres,\n\nLa séance hebdomadaire de cette semaine, c'est de nouveau vendredi soir à partir de 18h30 à Antrebloc !\n\nOn continue l'initiation voie de la semaine dernière. C'est toujours possible de vous prêter des baudriers si vous me prévenez à l'avance par mp.\n\nOn vous attend nombreux ! 🧗",
    },
    {
        postedAtIso: '2026-01-19T15:18:00+01:00',
        author: 'Corentin - VP',
        content:
            "Hello @Membres\n\nLa séance hebdomadaire de cette semaine, c'est vendredi aprèm à partir de 15h00 à Antrebloc !\n\nOn vous attend nombreux ! 🧗",
    },
    {
        postedAtIso: '2026-01-26T08:13:00+01:00',
        author: 'Enora - Présidente',
        content:
            "Hello @Membres !\nLes photos de la compétition duo sont dispo sur EPS !\nMerci à Eva pour ces superbes photos ! ✨\nEt encore merci à tous ceux qui ont participé à la compétition !\nA très vite sur les murs 🧗\n\n[Efrei Picture Studio]\n[Compétition Duo à Antrebloc]",
    },
    {
        postedAtIso: '2026-01-26T13:20:00+01:00',
        author: 'Enora - Présidente',
        content:
            "RECRUTEMENTS ESC – Mandat 2026-2027 🧗‍♀️🎉\nHello tout le monde !\n\nLa passation de la meilleure asso de l'Efrei approche à grands pas ! C'est pourquoi, nous recherchons des membres motivés pour rejoindre nos bureaux restreint et étendu.\n\nRejoindre le bureau d’ESC, c’est l’occasion de s’investir dans la vie associative de l’Efrei et de faire vivre l’asso tout au long de l’année.\n\n📌 Postes à pourvoir pour le mandat 2026-2027 :\nTrésorier\nSecrétaire\nRespo Séances\nRespo Event\nRespo Compétitions\n\n👉 Tu as aimé nos événements et un poste t’intéresse ?\nAlors, n'hésite pas à rejoindre l'aventure en remplissant le formulaire ! 🗺️\nTu seras ensuite contacté pour passer un entretien :)\n\n⏰ Fin des candidatures : dimanche 15 février\n\nA très vite sur les murs @everyone ! 🧗 :ESC:",
    },
    {
        postedAtIso: '2026-01-28T11:34:00+01:00',
        author: 'Corentin - VP',
        content:
            "Hello @Membres\n\nLa séance hebdomadaire de cette semaine, c'est jeudi aprèm à partir de 14h00 à Antrebloc !\n\nOn vous attend nombreux ! 🧗",
    },
    {
        postedAtIso: '2026-02-01T14:58:00+01:00',
        author: 'Enora - Présidente',
        content:
            'Le Kilter Board Challenge fait son grand retour ! 🔥 🎉\n📅 Dates : du 1er au 28 février 2026\n\nVous l’aviez sûrement deviné avec notre teaser posté il y a quelques jours sur Instagram. Et ça y est, le Kilter Board Challenge est de retour !\n\n🏆 Le concept\nVous avez 1 mois pour tenter de réussir un maximum de blocs parmi les 40 que nous avons ouverts pour vous. Peu importe votre niveau, tous les @Membres de l\'asso peuvent participer !\n\n🎥 Comment valider vos blocs ?\nFilmez-vous en réussissant le bloc\nNommez vos vidéos Bloc_XX\nMettez-les dans un dossier OneDrive unique\nRemplissez ce formulaire en vérifiant que le dossier est bien accessible\n\n🎟️ Vous gagnez :\n1 ticket de tombola par bloc validé\n2 tickets si vous acceptez que vos vidéos soient postées en story Insta\n\n📌 Où retrouver les blocs ?\nIci : Lien blocs\nSur le compte Kilter "corentin_joly" -> ESC_kilter_2026\nSur le PDF associé à ce message\n\n⚠️ Précisions\nPas de vidéo = pas de points\nVidéo mal cadrée où on ne voit pas le bloc = pas de points\nVidéo floue = pas de points\nMauvaise inclinaison = pas de points\n\nRègles Kilter Board 🧗\n🔵 : mains + pieds\n🟠 : pieds\n🟢 : start\n🟣 : end\n\nNous organiserons une finale le mercredi 4 mars, ainsi qu’un tirage au sort sous forme de tombola à la fin de l’événement.\nCe mois-ci, ce n’est pas le niveau qui compte, mais le nombre de blocs validés.\nVous l\'aurez compris, plus vous validez de blocs, plus vous avez de chances de gagner !\nPlusieurs lots sont à gagner ! 🎉\n\nN\'hésitez pas à nous contacter si vous avez des questions :)\n\nÀ très vite sur la Kilter ! 🧗‍♀️ :ESC:\n\nPS : si vous voulez organiser les prochains événements d\'ESC, pensez à postuler pour rejoindre le bureau 😉',
    },
    {
        postedAtIso: '2026-02-04T00:15:00+01:00',
        author: 'Enora - Présidente',
        content:
            "Hello !\n\nVous êtes plusieurs à avoir rempli le formulaire de la Kilter, mais à avoir indiqué un lien auquel nous n'avons pas accès... Alors svp assurez-vous bien que n'importe qui avec le lien peut ouvrir votre dossier, sinon nous ne pourrons pas valider vos blocs et vous serez bêtement pénalisés 🥲\n\nA très vite sur les murs ! 🧗‍♀️ :ESC:",
    },
    {
        postedAtIso: '2026-02-04T11:30:00+01:00',
        author: 'Valentin Gourjon - VP [SPZ2]',
        content:
            "Pour compléter le message d'Enora, j'aimerai faire quelques précisions sur la Kilter Board et sur vos séances en général.\n\nJe vois de plus en plus de personnes perdre en vigilance dans la salle. Faites attention aux règles de sécurité. On ne cours pas sur les tapis. On marche au milieu, et on ne passe pas sous les angles. On ne discute pas juste en dessous des blocs. Ce sont des règles de sécurité importantes, aussi bien pour vous que pour les autres, merci de les respecter.\n\nLa kilter board est un style assez différent de l'escalade habituelle. Alors, et particulièrement si vous n'avez pas l'habitude, pensez à vous échauffer bien les doigts afin de limiter un maximum le risque de blessures.\n\nLa kilter n'est pas réservée à votre usage. On sait que la compet vous inscite fortement à grimper dessus, et que tout le monde n'a pas le même niveau, mais soyez vigilant à ne pas empêcher d'autres grimpeurs (de l'asso ou non) à profiter aussi de la board. Partagez l'espace !\n\nBonne grimpette à tous ! 🧗 :ESC:",
    },
    {
        postedAtIso: '2026-02-04T21:20:00+01:00',
        author: 'Corentin - VP',
        content:
            "Hello @Membres\n\nLa séance hebdomadaire de cette semaine, c'est jeudi aprèm à partir de 14h00 à Antrebloc !\n\nOn vous attend nombreux ! 🧗",
    },
    {
        postedAtIso: '2026-02-06T16:16:00+01:00',
        author: 'Enora - Présidente',
        content:
            "RAPPEL RECRUTEMENTS ESC – Mandat 2026-2027 🧗‍♀️🎉\nHello tout le monde !\n\nPour rappel, la passation de la meilleure asso de l'Efrei approche à grands pas ! C'est pourquoi, nous recherchons des membres motivés pour rejoindre nos bureaux restreint et étendu.\n\nRejoindre le bureau d’ESC, c’est l’occasion de s’investir dans la vie associative de l’Efrei et de faire vivre l’asso tout au long de l’année.\n\n📌 Postes à pourvoir pour le mandat 2026-2027 :\nTrésorier\nSecrétaire\nRespo Séances\nRespo Event\nRespo Compétitions\n\n👉 Tu as aimé nos événements et un poste t’intéresse ?\nAlors, n'hésite pas à rejoindre l'aventure en remplissant le formulaire ! 🗺️\nTu seras ensuite contacté pour passer un entretien :)\n\n⏰ Fin des candidatures : dimanche 15 février\n\nA très vite sur les murs @Membres ! 🧗 :ESC:",
    },
    {
        postedAtIso: '2026-02-10T08:20:00+01:00',
        author: 'Corentin - VP',
        content:
            "Hello @Membres\n\nLa séance hebdomadaire de cette semaine, c'est mardi aprèm à partir de 15h00 à Antrebloc !\n\nPetit rappel n'oubliez pas de vous signaler au près du responsable de la séance pour avoir vos points lxp.\n\nOn vous attend nombreux ! 🧗",
    },
    {
        postedAtIso: '2026-02-16T21:26:00+01:00',
        author: 'Elias - Respo Séances',
        content:
            "Hello @Membres\n\nLa séance hebdomadaire de cette semaine, c'est jeudi à 18h00 à Climb up Antrebloc !\n\nOn vous attend nombreux ! 🧗",
    },
    {
        postedAtIso: '2026-02-18T10:34:00+01:00',
        author: 'Enora - Présidente',
        content:
            "Assemblée Générale Ordinaire 2026 - Efrei Sport Climbing 🧗 🔥\nHello @Membres,\nVous avez normalement tous reçu un mail vous invitant à l'Assemblée Générale Ordinaire d'ESC qui se tiendra le mardi 3 mars 2026 à 18h45 en Amphi C001.\n\n📌 Ordre du jour :\nBilan moral et financier\nVote du Bureau pour le mandat 2026-2027\nQuestions diverses\n\nL'AGO se fera uniquement en présentiel.\n\nRappel Kilter Board Challenge 🏆\nL’événement Kilter est en cours jusqu’au 28 février à 13h !\n\nPensez à remplir le formulaire de participation dès maintenant, même si vous n'avez pas encore validé tous les blocs. Vous pourrez les rajouter au fur et à mesure.\n\nCela vous permettra d’obtenir vos 2 points si vous acceptez d’être reposté en story 🎉\nEt de notre côté, ça nous évitera de tout traiter à la dernière minute.\n\nN'hésitez pas à nous contacter si vous avez des questions :)\n\nA très vite sur les murs 🧗‍♀️ :ESC:",
    },
    {
        postedAtIso: '2026-02-25T00:14:00+01:00',
        author: 'Enora - Présidente',
        content:
            "Retour des places CU et séance hebdo 🧗 🎉\nHello @Membres !\n\nBonne nouvelle !\nLes places Climb Up à prix réduit sont de retour sur notre boutique Helloasso ! 👀\n\nPour fêter ça, rendez-vous à la séance hebdo de cette semaine à Climb Up Porte d'Italie avec @Elias - Respo Séances, ce jeudi à 18h.\n\nVous le remarquerez peut-être, nous avons dû augmenter le tarif à 8€ après l’augmentation des prix de notre prestataire.\n\nA très vite sur les murs ! 🧗‍♀️ :ESC:",
    },
    {
        postedAtIso: '2026-03-02T13:09:00+01:00',
        author: 'Enora - Présidente',
        content:
            "Finale Kilter Board & Passa ESC 👀 🧗‍♀️ 🏆\nHello @Membres !\n\nC'est enfin l'heure de la finale du Kilter Board Challenge qui vous a occupé durant tout le mois de février.\n📌 Rendez-vous ce mercredi 4 mars à 19h00 à Antrebloc pour découvrir des blocs inédits (pas que sur la Kilter 👀) et gagner vos derniers tickets !\n\nN'oubliez pas non plus la passation de l'asso demain soir à 18h45 en Amphi C001 à République !\n\nPardon pour les rappels tardifs, on était occupés à former le meilleur bureau possible pour assurer pendant le prochain mandat ! 🎉\n\nA très vite à la passa et sur les murs ! 🧗‍♀️ :ESC:",
    },
    {
        postedAtIso: '2026-03-08T23:37:00+01:00',
        author: 'Elias - Respo Séances',
        content:
            "Hello @Membres\n\nDurant ce nouveau mandat, on va essayer de faire davantage de séances hebdomadaires avec notre nouvelle super équipe de respos séances.\n\nAu programme cette semaine :\n- Mardi à 17h30 : séance à Climb Up Aubervilliers avec Elias, Jérôme et Alexandre\n- Mercredi à 14h : séance à Climb Up Porte d'Italie avec Alexis\n- Jeudi à 18h : séance à Antrebloc avec Elias et Alexandre\n\nOn vous attend nombreux ! 🧗",
    },
    {
        postedAtIso: '2026-03-10T13:56:00+01:00',
        author: 'Enora - Présidente',
        content:
            'Hello hello, on a un petit souci avec les places CU, mais on remet la billeterie très vite en place :) :ESC:',
    },
    {
        postedAtIso: '2026-03-14T13:09:00+01:00',
        author: 'Enora - Présidente',
        content:
            "Hello @Membres !\nLes photos de la passa sont dispo sur EPS !\nMerci à Adam pour ces superbes photos ! ✨\nEt encore merci à tous ceux qui sont venus !\nA très vite sur les murs 🧗",
    },
];

async function getDiscordBotToken(): Promise<string> {
    if (process.env.DISCORD_BOT_TOKEN) {
        return process.env.DISCORD_BOT_TOKEN;
    }
    const secret = (await getSecret(DISCORD_BOT_TOKEN_SECRET_PATH)) as DiscordSecret | undefined;
    if (!secret?.DISCORD_BOT_TOKEN) {
        throw new Error('Missing DISCORD_BOT_TOKEN in Secrets Manager or environment');
    }
    return secret.DISCORD_BOT_TOKEN;
}

function resolveTargetChannelId(): string {
    const direct = process.env.DISCORD_ANNOUNCEMENT_BACKFILL_CHANNEL_ID?.trim();
    if (direct) {
        return direct;
    }
    const fromList = process.env.DISCORD_ANNOUNCEMENTS_CHANNEL_IDS?.split(',')
        .map((value) => value.trim())
        .find((value) => value.length > 0);
    if (fromList) {
        return fromList;
    }
    throw new Error('Missing DISCORD_ANNOUNCEMENT_BACKFILL_CHANNEL_ID or DISCORD_ANNOUNCEMENTS_CHANNEL_IDS');
}

async function postMessage(token: string, channelId: string, content: string): Promise<{
    id: string;
    channelId: string;
    url: string;
}> {
    if (DRY_RUN) {
        const syntheticId = `dry-run-${Math.random().toString(36).slice(2, 10)}`;
        return {
            id: syntheticId,
            channelId,
            url: `https://discord.com/channels/@me/${channelId}/${syntheticId}`,
        };
    }

    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bot ${token}`,
        },
        body: JSON.stringify({ content }),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Discord post failed: ${response.status} ${response.statusText} - ${body}`);
    }

    const payload = (await response.json()) as { id: string; channel_id: string };
    return {
        id: payload.id,
        channelId: payload.channel_id,
        url: `https://discord.com/channels/@me/${payload.channel_id}/${payload.id}`,
    };
}

async function delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    const token = await getDiscordBotToken();
    const channelId = resolveTargetChannelId();

    console.log(
        `[backfill-announcements] starting count=${ANNOUNCEMENTS.length} channelId=${channelId} dryRun=${DRY_RUN} retentionDays=${RETENTION_DAYS}`,
    );

    for (const [index, entry] of ANNOUNCEMENTS.entries()) {
        const publishedAt = new Date(entry.postedAtIso);
        const post = await postMessage(token, channelId, entry.content);
        const baseAnnouncement = buildAssociationAnnouncementFromDiscordMessage(
            {
                id: post.id,
                channelId: post.channelId,
                content: entry.content,
                url: post.url,
                createdAt: publishedAt,
                attachments: [],
            },
            {
                activeDays: ACTIVE_DAYS,
                retentionDays: RETENTION_DAYS,
                source: 'discord_channel_backfill',
                publishedAtOverride: publishedAt,
            },
        );

        if (!baseAnnouncement) {
            console.log(`[backfill-announcements] skipped_empty index=${index + 1}`);
            continue;
        }

        const compacted = await compactAnnouncementWithFallback(baseAnnouncement);
        await putAssociationAnnouncement(compacted);

        console.log(
            `[backfill-announcements] imported index=${index + 1}/${ANNOUNCEMENTS.length} messageId=${post.id} originalDate=${entry.postedAtIso} author="${entry.author}" status=${compacted.compactionStatus}`,
        );

        if (POST_DELAY_MS > 0 && index < ANNOUNCEMENTS.length - 1) {
            await delay(POST_DELAY_MS);
        }
    }

    console.log('[backfill-announcements] completed');
}

void main().catch((error) => {
    console.error('[backfill-announcements] failed', error);
    process.exit(1);
});
