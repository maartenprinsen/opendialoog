# OpenDialoog

**Anonieme, live online dialogen voor groepen van 8 tot enkele duizenden mensen.**
Deelnemers schrijven hun eigen antwoord op een open vraag, beoordelen daarna elkaars berichten en zien gaandeweg wat breed gedragen wordt. De gespreksleider groepeert berichten in thema’s en krijgt na afloop direct een rapport.

Vrije software (MIT-licentie): iedereen mag het gebruiken, aanpassen, verspreiden en zelf hosten, ook commercieel.

---

## Wat het doet

| Voor deelnemers | Voor de gespreksleider |
|---|---|
| Eén link openen: geen account, geen app, geen download | Sessie aanmaken met open vragen en keuzevragen |
| **Eerst zelf schrijven**: je ziet de berichten van anderen pas daarna | Vragen één voor één openen en sluiten |
| Berichten van anderen beoordelen met een schuif (helemaal oneens → helemaal eens) | Live overzicht: aantal deelnemers, berichten, stemmen, steunpercentage |
| Bij je eigen berichten zien hoeveel stemmen en hoeveel procent eens | Thema’s maken en berichten toewijzen (ook in bulk) |
| Tussenstand of thema-overzicht zien (als de gespreksleider dat aanzet) | Automatische **thema-voorstellen** op basis van gedeelde woorden |
| Volledig anoniem | Stelling voorleggen aan álle deelnemers |
| | Mededeling plaatsen bij iedereen |
| | Berichten verbergen of namen eruit halen |
| | **Presentatiescherm** voor de beamer |
| | **Rapport** (afdrukbaar/PDF) en **CSV-export**, met uitsplitsing per groep |

## Zo werkt het verspreidingsmechanisme

Niet iedereen hoeft alle berichten te lezen; dat werkt niet bij honderden deelnemers. In plaats daarvan:

1. Een nieuw bericht gaat eerst naar **4** willekeurige andere deelnemers.
2. Zodra die 4 gestemd hebben en **minstens 60 %** het eens is, wordt het bereik **verdubbeld** (8, 16, 32 …), totdat iedereen het heeft gezien.
3. Berichten met weinig steun blijven bij die eerste kleine groep.
4. Een **stelling van de gespreksleider** gaat altijd naar iedereen.
5. Deelnemers krijgen telkens **3 berichten** tegelijk; berichten die het verst achterlopen op hun doelbereik krijgen voorrang.

Zo worden de berichten van deelnemers zelf de antwoordopties waarop anderen stemmen, en komen de breed gedragen punten vanzelf bovendrijven. Alle getallen zijn per dialoog aan te passen onder *Instellingen*.

**Steunpercentage** = het aandeel “eens” onder iedereen die niet neutraal stemde.

## Anonimiteit en privacy

- Elke deelnemer krijgt een **willekeurige code** in een functionele cookie. Er wordt geen naam, e-mailadres of IP-adres opgeslagen of gelogd.
- Rapporten en exports bevatten **geen** deelnemercodes.
- Uitsplitsingen per groep (bijv. afdeling) worden **nooit getoond voor groepen kleiner dan 8 personen** (instelbaar).
- Geen externe scripts, lettertypen, analytics of CDN’s: de browser van de deelnemer praat alleen met jouw eigen server.
- De gespreksleider kan een bericht aanpassen om herleidbare details (namen) te verwijderen.
- Dialogen kunnen handmatig worden verwijderd, of automatisch na een ingestelde termijn (`RETENTION_DAYS`).
- Draai je het op een server binnen de EU, dan blijft alle data in de EU.

> **Let op:** omdat er geen login is, kan iemand die moeite doet (bijv. met meerdere privévensters) meer dan één keer meedoen. Gebruik bij gevoelige sessies een **toegangscode** en deel de link alleen met de doelgroep. Dat is een bewuste afweging: anonimiteit gaat hier voor identificatie.

## Installeren en starten

Je hebt alleen **Node.js 18 of nieuwer** nodig. Er zijn **geen afhankelijkheden** om te installeren.

```bash
node server.js
```

Open daarna <http://localhost:3000>, maak een dialoog aan en je komt op de beheerpagina. Bewaar de **beheerlink** goed: wie die heeft, kan de dialoog beheren.

### Met Docker

```bash
docker build -t opendialoog .
docker run -d -p 3000:3000 -v opendialoog-data:/app/data --name opendialoog opendialoog
```

### Instellingen (omgevingsvariabelen)

| Variabele | Standaard | Betekenis |
|---|---|---|
| `PORT` | `3000` | Poort |
| `HOST` | `0.0.0.0` | Adres om op te luisteren |
| `DATA_DIR` | `./data` | Map waarin dialogen als JSON worden bewaard |
| `CREATE_PASSWORD` | *(leeg)* | Als ingesteld: wachtwoord nodig om nieuwe dialogen te maken |
| `RETENTION_DAYS` | `0` | Verwijder dialogen automatisch na zoveel dagen zonder activiteit (0 = nooit) |

### Online zetten

Zet OpenDialoog achter een reverse proxy met HTTPS (bijv. Caddy, nginx of Traefik). Met Caddy is dat één regel:

```
dialoog.jouwschool.nl {
    reverse_proxy localhost:3000
}
```

Zet in je proxy het loggen van IP-adressen uit of anonimiseer het, anders bewaart de proxy wat OpenDialoog zelf juist niet bewaart.

## Testen

```bash
npm test            # simuleert 60 deelnemers en controleert de regels
node test/simulate.js 300
```

De simulatie controleert onder meer: eerst schrijven voor je leest, niet stemmen op je eigen bericht, alleen stemmen op berichten die aan jou zijn voorgelegd, populaire berichten verspreiden zich verder dan impopulaire, stellingen bereiken iedereen, groepen < 8 worden niet uitgesplitst en er staan geen deelnemercodes in het rapport.

## Pagina’s

| Adres | Voor wie |
|---|---|
| `/` | Nieuwe dialoog aanmaken |
| `/d/<id>` | Deelnemers |
| `/beheer/<id>#k=<sleutel>` | Gespreksleider |
| `/scherm/<id>#k=<sleutel>` | Presentatiescherm (beamer) |
| `/rapport/<id>#k=<sleutel>` | Rapport en CSV-export |

## Een goede dialoog opzetten

- **Stel open vragen die uitleg vragen**: “Wat zou je werk merkbaar beter maken, en waarom juist dat?” werkt beter dan “Hoe tevreden ben je?”.
- Plan **45–75 minuten** met 2 à 4 vragen; reken per open vraag 10–15 minuten.
- Begin eventueel met een **keuzevraag** (afdeling, rol, leerjaar) als je uitkomsten per groep wilt zien.
- Zet halverwege een vraag de **tussenstand** aan en groepeer tegen het einde in **thema’s**. Leg het sterkste idee als **stelling** voor aan iedereen.

## Opbouw van de code

```
server.js          Hele server: opslag, verspreiding, thema-voorstellen, rapport, API
public/            Statische pagina's (HTML/CSS/JS, geen bouwstap)
  deelnemer.*      Deelnemersscherm (mobiel eerst)
  beheer.*         Beheerscherm
  rapport.*        Rapport
  scherm.*         Presentatiescherm
test/simulate.js   Simulatie met nep-deelnemers
```

Data staat in het geheugen en wordt elke 2 seconden naar `data/<id>.json` geschreven. Dat volstaat voor honderden tot enkele duizenden gelijktijdige deelnemers op één server. Voor nog grotere aantallen is opslag in een database (bijv. PostgreSQL of Redis) de logische volgende stap.

## Wat (nog) niet zit erin

- Realtime vertaling tussen talen (dit kan met een eigen vertaaldienst, zoals LibreTranslate, worden toegevoegd).
- Inloggen via de organisatie (SSO).
- Thema-voorstellen met taalmodellen. De ingebouwde voorstellen werken met gedeelde woorden en moeten altijd door een mens worden gecontroleerd.

## Achtergrond

OpenDialoog is een onafhankelijke, from-scratch implementatie van het algemene idee van een *anonieme, gewogen online groepsdialoog*, zoals dat ook bij commerciële diensten (bijv. Synthetron) wordt toegepast. Er is geen code, ontwerp of tekst van zo’n dienst overgenomen. OpenDialoog is niet aan Synthetron of een andere partij verbonden.

Wie deze software commercieel inzet in landen waar softwarepatenten gelden, doet er goed aan na te gaan of er nog lopende patenten zijn op vergelijkbare werkwijzen.

Verwant open-sourceproject met een andere aanpak: [Pol.is](https://github.com/compdemocracy/polis) (stemmen op korte stellingen, clustering van meningsgroepen).

## Licentie

MIT, zie [LICENSE](LICENSE).
