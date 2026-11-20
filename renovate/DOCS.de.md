# Renovate (Deutsch)

Renovate hält die Abhängigkeiten deiner Repositories aktuell: Es öffnet einen Pull Request, wenn ein Docker-Image, eine GitHub Action, ein npm- oder Python-Paket oder [vieles andere](https://docs.renovatebot.com/modules/manager/) eine neue Version hat. Diese App betreibt es auf deinem Home Assistant, mit Weboberfläche und Zeitplan.

**Diese App ist experimentell.** Melde Probleme bitte mit angehängtem Lauf-Protokoll (vorher Geheimnisse entfernen).

Inhalt: [Funktionsweise](#funktionsweise) · [Schnellstart](#schnellstart) · [Anmeldung](#anmeldung) · [Repositories](#repositories) · [Zeitplan und Läufe](#zeitplan-und-läufe) · [Webhooks](#webhooks) · [Home Assistant](#home-assistant) · [Ressourcen](#ressourcen) · [Konfiguration](#konfiguration) · [Optionen](#optionen) · [Fehlersuche](#fehlersuche) · [Sicherheit](#sicherheit)

## Funktionsweise

Die Weboberfläche ist die Seite dieser App (**Web-UI öffnen** oder *Renovate* in der Seitenleiste). Home Assistant leitet sie per *Ingress* weiter, es muss also kein Port geöffnet werden, und dein Home-Assistant-Login schützt sie. Standardmäßig sehen sie nur Administratoren.

Dahinter hält ein kleiner Server deine Verbindungen und Einstellungen in einer SQLite-Datenbank, startet Renovate nach Zeitplan (oder wenn ein Webhook eintrifft) und zeichnet jeden Lauf auf: ein Ergebnis pro Repository und ein Protokoll. Renovate bearbeitet eine Verbindung nach der anderen in kleinen Durchgängen, damit auch ein Raspberry Pi mitkommt.

## Schnellstart

1. Starte die App und öffne die Weboberfläche.
2. **Git-Server verbinden**: Servertyp wählen, anmelden, Repositories wählen.
3. Starte zuerst eine **Vorschau**. Sie sucht nach Updates und zeigt, was passieren würde, ohne etwas zu ändern.
4. Führe es dann echt aus. In jedem Repository ohne Renovate-Konfiguration öffnet Renovate einen Pull Request namens **Configure Renovate**. Übernimm ihn, um Renovate dort einzuschalten.
5. Prüfe die Update-Pull-Requests, sobald sie eintreffen. Du entscheidest, was übernommen wird.

## Anmeldung

### Mit Code anmelden (GitHub)

Du erhältst einen kurzen Code, gibst ihn auf github.com ein und bestätigst. Kein Token, das du erstellen oder kopieren musst. Dafür braucht es eine OAuth-App mit aktiviertem *Device Flow*:

1. Öffne bei GitHub **Settings → Developer settings → OAuth Apps → New OAuth App**. Beliebiger Name, beliebige URL.
2. Setze den Haken bei **Enable Device Flow** und registriere die App.
3. Trage die **Client ID** unter **Erweitert → GitHub-OAuth-Client-ID** ein und starte die App neu.

Ohne Client-ID bietet der Assistent für GitHub stattdessen die Token-Methode an.

### Token

Für GitHub und GitLab öffnet der Assistent die Token-Seite mit bereits ausgefülltem Namen und Berechtigungen. Erstelle das Token, kopiere es und füge es im Assistenten ein.

| Server | Berechtigungen des Tokens |
| --- | --- |
| GitHub | `repo` und `workflow` (klassisch) oder Contents, Pull requests, Issues und Workflows mit Schreibzugriff (feingranular) |
| GitLab | `api` und `write_repository` |
| Gitea, Forgejo | `write:repository`, `write:issue`, `read:user`, `read:organization`, `read:misc` (`read:misc` brauchen nur Gitea 1.20.0 und 1.20.1). Ergänze `read:packages`, wenn du Gitea-Pakete nutzt. |

Bei Gitea und Forgejo sollte das Konto **Vollname und E-Mail-Adresse** eingetragen haben; Renovate nutzt sie für seine Commits, und der Assistent warnt, wenn sie fehlen. Renovate überspringt Spiegel-Repositories und Repositories mit abgeschalteten Pull Requests. Wähle für Forgejo und Codeberg den Servertyp *Forgejo*: Renovate entfernt die Forgejo-Unterstützung aus seiner Gitea-Plattform.

Die Pull Requests öffnet das Konto, zu dem das Token gehört. Lege für einen sauberen Verlauf ein eigenes Konto wie `renovate` an.

### Passwort (Gitea und Forgejo)

Gib deine Zugangsdaten einmal ein. Die App fordert beim Server ein Token mit genau den obigen Berechtigungen an und speichert dieses Token verschlüsselt. **Dein Passwort wird nicht gespeichert** und nur für diese eine Anfrage verwendet. Bei Zwei-Faktor-Authentifizierung fragt der Assistent nach dem aktuellen Code. Entfernst du die Verbindung später, lösche das Token (Name `renovate-home-assistant-…`) in den Einstellungen deines Servers; ohne dein Passwort kann die App das nicht.

### Browser-Anmeldung (Passkey, YubiKey, SSO)

Für **Gitea, Forgejo und GitLab**. Du meldest dich auf der Seite deines Servers selbst an, also funktioniert alles, was diese Seite akzeptiert: Passwort, ein **Passkey**, ein **Sicherheitsschlüssel wie der YubiKey 5 NFC**, Single Sign-on. Die App sieht dein Passwort nie. Das ist der Weg für Konten mit eingerichtetem Sicherheitsschlüssel, denn diese können mit ihrem Passwort kein Token erstellen.

Es funktioniert von jedem Gerät und braucht keine öffentliche Adresse. Einmal pro Server:

1. Wähle im Assistenten *Passkey, Sicherheitsschlüssel oder SSO*. Er zeigt, was einzutragen ist, und verlinkt auf die Anwendungseinstellungen deines Servers (Gitea: *Einstellungen → Anwendungen*, GitLab: *Einstellungen → Anwendungen*).
2. Erstelle eine **OAuth2-Anwendung** namens `Renovate` mit der Weiterleitungs-URI `http://127.0.0.1:5594/callback` und **ausgeschaltetem „Vertraulicher Client“** (öffentlicher Client, ohne Geheimnis). GitLab braucht zusätzlich die Berechtigungen `api` und `write_repository`. Kopiere die **Client-ID**, die der Server anzeigt.
3. Füge die Client-ID ein, klicke auf *Anmeldung vorbereiten* und öffne die Anmeldeseite. Melde dich wie immer an (Passkey, YubiKey an die Handy-Rückseite halten, ...) und stimme zu.
4. Der Browser zeigt danach eine Fehlerseite, weil er `127.0.0.1` öffnen will. Das ist normal. Kopiere die **Adresse dieser Seite** aus der Adressleiste und füge sie im Assistenten ein.

Die Tokens einer solchen Anmeldung laufen nach einer Stunde (Gitea) oder zwei (GitLab) ab. Die App erneuert sie mit dem Refresh-Token **vor jedem Lauf und jedem Durchgang**, ein Lauf startet also nie mit einem sterbenden Token. Widerruft der Server die Anmeldung oder läuft das Refresh-Token ab (Gitea: 30 Tage ohne Lauf), schlägt der Lauf mit einem Hinweis fehl, und die Verbindung muss neu hinzugefügt werden.

### Die Gitea-App von Home Assistant

Der Assistent sucht die Gitea-App aus [alexbelgium/hassio-addons](https://github.com/alexbelgium/hassio-addons) unter `http://db21ed7f-gitea:3000` und bietet ihre Adresse an. Andere Adressen funktionieren ebenso; nimm die, unter der dein Server aus Home Assistant heraus antwortet.

### Weitere Server

| Server | Was der Assistent verlangt |
| --- | --- |
| Bitbucket Cloud | Dein **Benutzername** und ein **API-Token** mit den Berechtigungen für Repositories, Pull Requests, Benutzer und Workspace (lesen und schreiben). Renovate möchte außerdem eine Workspace-Gruppe mit der Berechtigung *Create repositories*, die das Konto enthält. |
| Bitbucket Server / Data Center | Die Adresse deines Servers und ein **HTTP-Zugriffstoken** des Kontos |
| Azure DevOps | Die Adresse deiner Organisation (`https://dev.azure.com/meine-organisation`, oder deine Server-Collection) und ein **persönliches Zugriffstoken** mit Lese- und Schreibrecht für *Code* und *Work Items* |
| Gerrit | Die Adresse des Servers, dein **Benutzername** und das **HTTP-Passwort** des Kontos. Für Automerge muss das Konto Code-Review +2 geben dürfen. |
| SCM-Manager 3 | Die Adresse samt `/scm` und ein **API-Schlüssel** des Kontos; das Review-Plugin ab Version 3.11 muss installiert sein |

Diese Server sind **Beta**: nach der Dokumentation von Renovate gebaut und gegen aufgezeichnete API-Antworten getestet, nicht gegen echte Installationen. Sie haben keine Webhooks. Repository-Namen folgen dem Format von Renovate (`workspace/repo`, `PROJEKT/repo`, `Projekt/Repo`).

## Repositories

Jede Verbindung hat einen **Modus**:

- **Von Hand** (Standard): Es werden nur Repositories verarbeitet, die du einschaltest. Neue Repositories bleiben aus.
- **Automatisch**: Jedes Repository, auf das das Konto pushen darf, wird verarbeitet, auch neue. Mit *Einschluss-* und *Ausschluss-Mustern* (`my-org/*`, `**/archive-*`) grenzt du das ein. Forks und archivierte Repositories werden übersprungen, solange du das nicht änderst.

Ein Schalter in der Repository-Liste gewinnt immer gegen die Regeln. Die Liste wird vor jedem automatischen Lauf und mit **Liste aktualisieren** erneuert.

## Zeitplan und Läufe

Standardmäßig läuft Renovate alle sechs Stunden (`0 */6 * * *`). Wähle einen Cron-Zeitplan, ein festes Intervall oder nur manuelle Läufe. Läufe verschiedener Verbindungen überlappen nur, wenn das Ressourcenprofil parallele Läufe erlaubt; zwei Läufe derselben Verbindung nie.

Ein Lauf startet durch den Zeitplan, durch dich (**Jetzt ausführen**, **Vorschau-Lauf** oder ein einzelnes Repository) oder durch einen Webhook. Anfragen für dieselbe Verbindung, die eintreffen, während ein Lauf wartet, werden zu einem zusammengefasst. Ein Lauf, der länger als das Zeitlimit dauert, wird gestoppt, und **Lauf abbrechen** stoppt einen jederzeit.

## Webhooks

Mit Webhooks (GitHub, GitLab, Gitea und Forgejo) meldet der Git-Server der App, wenn etwas passiert, sodass Renovate innerhalb etwa einer Minute reagiert: nach dem Merge eines Pull Requests, einem Push auf den Standard-Branch oder dem Abhaken einer Box im *Dependency Dashboard*. Ereignisse, die Renovate selbst auslöst, werden ignoriert.

1. Schalte **Webhooks → Webhooks empfangen** ein.
2. Gib in den **Netzwerk**-Einstellungen der App dem Port `5594` (oder deinem gewählten Port) eine Nummer. Standard ist 5594, und der Port bleibt geschlossen, bis du ihn öffnest.
3. Mache den Port für deinen Git-Server erreichbar, zum Beispiel über einen Reverse Proxy, und trage die Adresse als **Öffentliche Adresse** ein.
4. Öffne die Verbindung, Reiter **Webhooks**, und klicke auf **In allen eingeschalteten Repositories einrichten**. Adresse und Geheimnis werden für die manuelle Einrichtung ebenfalls angezeigt.

Lieferungen werden mit dem Geheimnis der Verbindung geprüft (HMAC-Signatur, bei GitLab das Secret-Token).

## Home Assistant

- `sensor.renovate_status`: `idle`, `running` oder `error`, mit der nächsten Laufzeit.
- `sensor.renovate_open_pull_requests`: wie viele Pull Requests Renovate offen hat, pro Verbindung in den Attributen.
- `sensor.renovate_last_run`: wann der letzte Lauf endete und mit welchem Ergebnis.
- Das Ereignis `renovate_run_finished` nach jedem Lauf, mit `status`, `connection`, `pull_requests_created`, `pull_requests_updated` und `errors`.

Ein Automationsbeispiel steht in der [englischen Dokumentation](DOCS.md#home-assistant).

Die Sensoren werden über die Core-API erzeugt und haben keine eindeutige ID. Sie verschwinden beim Neustart von Home Assistant und kehren zurück, sobald die App sie wieder aktualisiert, wenige Sekunden nach ihrem Start.

## Ressourcen

Das Profil *Automatisch* schaut auf den Arbeitsspeicher des Geräts, auf dem Home Assistant läuft, nicht auf das, was die App nutzen darf: **Sparsam** unter 2 GB, **Ausgewogen** bis 6 GB und **Leistung** darüber. Auf einem Mini-PC oder Server mit viel Speicher bedeutet *Automatisch* deshalb *Leistung*; wähle *Sparsam* von Hand, wenn das Gerät für anderes frei bleiben soll. Sparsam bearbeitet jeweils drei Repositories mit 512 MB und sehr niedriger CPU-Priorität; die anderen Profile geben Renovate mehr Raum. Einzelne Werte überschreibst du unter *Ressourcen → Erweitert*. Die Einstellungsseite zeigt, was für dein Gerät gilt.

Endet ein Lauf mit *Renovate ist der Arbeitsspeicher ausgegangen*, wähle das Profil Sparsam oder erhöhe den Speicher pro Lauf.

## Konfiguration

Alles lässt sich in der Weboberfläche einstellen. Werte in der **App-Konfiguration** (Einstellungen → Apps → Renovate → Konfiguration) gewinnen und zeigen in der Oberfläche ein Schloss. Nutze die Konfiguration, wenn du dein Setup an einer Stelle beschreiben willst, und die Oberfläche für alles andere.

**Änderungen in der Konfiguration gelten innerhalb von Sekunden, ohne Neustart.** Home Assistant schreibt die gespeicherte Konfiguration in die App, die das bemerkt, die neuen Werte übernimmt und ihre Verbindungen aktualisiert. Nur *Zusätzliche Systempakete* und *CA-Zertifikat* werden beim Start der App gelesen; die Oberfläche zeigt dann **Neustart nötig**. Lässt sich ein Eintrag nicht übernehmen (abgelehntes Token, fehlendes Feld), nennen die Seiten Übersicht und Verbindungen, welcher und warum, und **Einstellungen → App-Konfiguration → Jetzt abgleichen** prüft jederzeit erneut.

### Verbindungen in der Konfiguration

```yaml
connections:
  - name: Home Gitea
    provider: gitea
    url: http://db21ed7f-gitea:3000
    token: !secret renovate_gitea_token
    repositories: sven/home-assistant-config, sven/esphome-devices
  - name: Bitbucket
    provider: bitbucket
    username: sven
    token: !secret renovate_bitbucket_token
```

`provider` ist `github`, `gitlab`, `gitea`, `forgejo`, `bitbucket`, `bitbucket-server`, `azure`, `gerrit` oder `scm-manager`. `username` brauchen nur `bitbucket` und `gerrit`. Verbindungen aus der Konfiguration nutzen ein Token; die Browser-Anmeldung ist eine Funktion des Assistenten.

Hier festgelegte Verbindungen werden bei jedem Start angelegt, aktualisiert und entfernt und sind in der Oberfläche schreibgeschützt. Mit `repositories` werden nur diese eingeschaltet; ohne wird jedes Repository verarbeitet, auf das das Konto pushen darf, eingegrenzt durch `include` und `exclude`.

### Eigene Renovate-Optionen

Lege eine JSON-Datei im Konfigurationsordner der App ab (`/addon_configs/<id>_renovate/`, erreichbar mit den Apps Samba oder File editor) und nenne sie unter *Renovate → Konfigurationsdatei im App-Ordner*. Ihr Inhalt wird über die Standardwerte der App gelegt. Pro Verbindung gibt es in den Einstellungen ein Feld für zusätzliche Optionen. Optionen, die die App selbst steuert (Plattform, Endpunkt, Repositories, Ordner), lassen sich nicht überschreiben.

Repositories behalten wie gewohnt ihre eigene `renovate.json`; sie entscheidet, *was* wie aktualisiert wird.

### Zusätzliche Werkzeuge

Das Image enthält Node.js, npm und Git. Für Lock-Dateien anderer Ökosysteme ruft Renovate weitere Werkzeuge auf. Trage ihre Alpine-Pakete unter *Erweitert → Zusätzliche Systempakete* ein, zum Beispiel `python3`, `py3-pip` oder `go`. Sie werden beim Start der App installiert.

### Zertifikate

Für einen Server mit Zertifikat deiner eigenen CA lege die CA-Datei in `/ssl` (oder den Konfigurationsordner der App) und trage ihren Namen unter *Erweitert → CA-Zertifikat* ein. Als letzter Ausweg akzeptiert *Zertifikate nicht prüfen* alles.

## Optionen

<!-- options:begin -->

### Renovate

Standardwerte für alle Repositories. Eine renovate.json im Repository kann die meisten überschreiben.

| Option | Beschreibung | Standard |
| --- | --- | --- |
| `renovate.dry_run`<br>**Probelauf** | Aus nimmt echte Änderungen vor. Die anderen Modi schauen nur: extract findet Abhängigkeiten, lookup prüft auch auf Updates, full simuliert alles. | `off` |
| `renovate.onboarding`<br>**Onboarding-Pull-Request** | Öffnet in Repositories ohne Konfiguration einen Pull Request „Configure Renovate“. Aus bedeutet, dass Renovate keine Konfiguration braucht, siehe unten. | `true` |
| `renovate.onboarding_preset`<br>**Onboarding-Preset** | Das Preset, das in den Onboarding-Pull-Request geschrieben wird. | `config:recommended` |
| `renovate.require_config`<br>**Konfigurationsdatei** | Erforderlich: nur Repositories mit Konfiguration werden verarbeitet. Optional: Repositories ohne Konfiguration laufen mit Standardwerten. Ignoriert: Dateien im Repository werden nicht gelesen. | `required` |
| `renovate.git_author`<br>**Commit-Autor** | Name und Adresse der Commits, als Name <Adresse>. Leer nutzt den Standard von Renovate. | automatisch |
| `renovate.default_extends`<br>**Standard-Presets** | Presets für alle Repositories, zum Beispiel group:allNonMajor. | keiner |
| `renovate.default_labels`<br>**Standard-Labels** | Labels, die jeder Pull Request erhält. | keiner |
| `renovate.pr_concurrent_limit`<br>**Gleichzeitig offene Pull Requests** | Maximum pro Repository. 0 bedeutet kein Limit. Leer nutzt den Standard von Renovate. | automatisch |
| `renovate.pr_hourly_limit`<br>**Neue Pull Requests pro Stunde** | Maximum pro Repository. 0 bedeutet kein Limit. Leer nutzt den Standard von Renovate. | automatisch |
| `renovate.github_com_token`<br>**Token für github.com** | Damit liest Renovate Release Notes und Changelogs von GitHub ohne Rate-Limit. Ein Token ohne Berechtigungen genügt. | – |
| `renovate.host_rules`<br>**Zugangsdaten für Registries** | Anmeldungen für private Paketquellen, zum Beispiel eine Docker-Registry oder einen npm-Proxy. | keiner |
| `renovate.config_file`<br>**Konfigurationsdatei im App-Ordner** | Eine JSON-Datei mit Renovate-Optionen im Konfigurationsordner der App (addon_configs). Wird über die obigen Standardwerte gelegt. | automatisch |

### Verlauf

Wie lange Läufe und ihre Protokolle aufbewahrt werden.

| Option | Beschreibung | Standard |
| --- | --- | --- |
| `history.keep_runs`<br>**Aufzubewahrende Läufe** | Ältere Läufe werden entfernt. | `100` |
| `history.keep_log_days`<br>**Tage für Protokolle** | Ältere Läufe werden samt Protokoll entfernt. | `30` |

### Ressourcen

Wie viel von diesem Gerät ein Lauf nutzen darf. Das automatische Profil passt sich dem Arbeitsspeicher an.

| Option | Beschreibung | Standard |
| --- | --- | --- |
| `resources.profile`<br>**Ressourcenprofil** | Sparsam für einen Raspberry Pi, Ausgewogen für die meisten Systeme, Leistung für starke Geräte. Automatisch wählt nach Arbeitsspeicher. | `auto` |
| `resources.max_concurrent_runs`<br>**Parallele Läufe** | Wie viele Verbindungen gleichzeitig verarbeitet werden. Überschreibt das Profil. | automatisch |
| `resources.memory_limit_mb`<br>**Speicher pro Lauf (MB)** | Obergrenze für den Speicher eines Renovate-Prozesses. Überschreibt das Profil. | automatisch |
| `resources.batch_size`<br>**Repositories pro Durchgang** | Renovate wird nach dieser Anzahl neu gestartet, das hält den Speicherbedarf niedrig. Überschreibt das Profil. | automatisch |
| `resources.cpu_priority`<br>**CPU-Rücksichtnahme** | 0 ist normal, 19 am rücksichtsvollsten. Höhere Werte halten Home Assistant flüssig. Überschreibt das Profil. | automatisch |
| `resources.run_timeout_minutes`<br>**Zeitlimit pro Lauf (Minuten)** | Ein Lauf, der länger dauert, wird gestoppt. | `90` |

### Zeitplan

Wann Renovate von selbst läuft.

| Option | Beschreibung | Standard |
| --- | --- | --- |
| `schedule.mode`<br>**Automatische Läufe** | Cron nutzt einen Zeitplan, Intervall wiederholt nach fester Zeit, Manuell startet nie von selbst. | `cron` |
| `schedule.cron`<br>**Cron-Zeitplan** | Fünf Felder: Minute Stunde Tag Monat Wochentag. 0 */6 * * * bedeutet alle sechs Stunden. | `0 */6 * * *` |
| `schedule.interval_minutes`<br>**Intervall (Minuten)** | Wird verwendet, wenn die automatischen Läufe auf Intervall stehen. | `360` |
| `schedule.run_on_start`<br>**Beim Start der App ausführen** | Startet kurz nach dem Start der App einen Lauf. | `false` |

### Webhooks

Der Git-Server löst Läufe aus, wenn etwas passiert.

| Option | Beschreibung | Standard |
| --- | --- | --- |
| `webhooks.enabled`<br>**Webhooks empfangen** | Öffnet einen Port, an den Git-Server Ereignisse senden können. | `false` |
| `webhooks.port`<br>**Port** | Aktiviere diesen Port zusätzlich in den Netzwerk-Einstellungen der App. | `5594` |
| `webhooks.public_url`<br>**Öffentliche Adresse** | Die Adresse, unter der dein Git-Server den Port erreicht, zum Beispiel https://hooks.example.org. Ohne sie lassen sich Webhooks nicht automatisch einrichten. | automatisch |
| `webhooks.debounce_seconds`<br>**Wartezeit vor dem Lauf (Sekunden)** | Ereignisse in dieser Zeit werden zu einem Lauf zusammengefasst. | `60` |
| `webhooks.ignore_own_events`<br>**Eigene Ereignisse von Renovate ignorieren** | Verhindert, dass Renovates eigene Pull Requests in einer Schleife neue Läufe starten. | `true` |

### Home Assistant

Was die App an Home Assistant meldet.

| Option | Beschreibung | Standard |
| --- | --- | --- |
| `home_assistant.sensors`<br>**Sensoren** | Erstellt sensor.renovate_status, sensor.renovate_open_pull_requests und sensor.renovate_last_run. | `true` |
| `home_assistant.events`<br>**Ereignisse** | Löst nach jedem Lauf das Ereignis renovate_run_finished aus, für Automationen. | `true` |
| `home_assistant.failure_notification`<br>**Bei Fehlern benachrichtigen** | Zeigt in Home Assistant eine Benachrichtigung, wenn ein Lauf fehlschlägt. | `false` |

### Darstellung

Sprache, Farben und Protokollierung.

| Option | Beschreibung | Standard |
| --- | --- | --- |
| `general.language`<br>**Sprache** | Automatisch folgt Home Assistant. | `auto` |
| `general.theme`<br>**Design** | Automatisch folgt Home Assistant, dann deinem System. | `auto` |
| `general.accent`<br>**Akzentfarbe** | Blau ist die Vorgabe. Home Assistant übernimmt die Primärfarbe deines Home-Assistant-Designs. | `blue` |
| `general.accent_color`<br>**Eigene Akzentfarbe** | Wird verwendet, wenn die Akzentfarbe auf „Eigene“ steht. Format #RRGGBB. | automatisch |
| `general.log_level`<br>**Protokollstufe der App** | Wie viel die App ins Protokoll schreibt. Den Detailgrad von Renovate selbst stellst du unter Erweitert ein. | `info` |
| `general.timezone`<br>**Zeitzone** | Wird für den Zeitplan verwendet, zum Beispiel Europe/Berlin. Leer nutzt die Zeitzone von Home Assistant. | automatisch |

### Erweitert

Für Sonderfälle: Zertifikate, zusätzliche Werkzeuge, Umgebungsvariablen.

| Option | Beschreibung | Standard |
| --- | --- | --- |
| `advanced.renovate_log_level`<br>**Protokollstufe von Renovate** | Detailgrad der Lauf-Protokolle. Debug ist sehr ausführlich. | `info` |
| `advanced.extra_packages`<br>**Zusätzliche Systempakete** | Alpine-Pakete, die beim Start der App installiert werden, zum Beispiel python3, py3-pip oder go. Nötig, wenn Renovate diese Werkzeuge ausführen muss, um Lock-Dateien zu aktualisieren. *(Nur in der App-Konfiguration)* | keiner |
| `advanced.extra_env`<br>**Zusätzliche Umgebungsvariablen** | Werden an jeden Renovate-Lauf übergeben, zum Beispiel Proxy- oder Registry-Einstellungen. | keiner |
| `advanced.ca_certificate`<br>**CA-Zertifikat** | Dateiname einer Zertifizierungsstelle in /ssl oder im App-Ordner. Nötig für Server mit selbst erstelltem Zertifikat. *(Nur in der App-Konfiguration)* | automatisch |
| `advanced.insecure_tls`<br>**Zertifikate nicht prüfen** | Akzeptiert jedes Zertifikat. Unsicher: besser das CA-Zertifikat hinterlegen. *(Nur in der App-Konfiguration)* | `false` |
| `advanced.github_client_id`<br>**GitHub-OAuth-Client-ID** | Nutze deine eigene GitHub-OAuth-App (mit aktiviertem Device Flow) für die Anmeldung per Code. *(Nur in der App-Konfiguration)* | automatisch |

<!-- options:end -->

## Fehlersuche

| Meldung im Lauf | Was zu tun ist |
| --- | --- |
| Der Git-Server hat das Token abgelehnt | Das Token ist abgelaufen oder widerrufen. Erstelle ein neues und ersetze es in den Einstellungen der Verbindung. |
| Der Server war nicht erreichbar | Prüfe die Adresse. Eine Home-Assistant-App ist unter ihrem internen Namen nur von innerhalb Home Assistants erreichbar. |
| Dem Zertifikat wird nicht vertraut | Hinterlege das CA-Zertifikat, siehe [Zertifikate](#zertifikate). |
| Der Server begrenzt die Anzahl der Anfragen | Hinterlege unter *Renovate → Token für github.com* ein Token oder führe seltener aus. |
| Renovate ist der Arbeitsspeicher ausgegangen | Nutze das Profil Sparsam, verringere die Durchgangsgröße oder erhöhe den Speicher pro Lauf. |
| Kein Repository eingeschaltet | Öffne die Verbindung und schalte Repositories ein. |
| Fertig mit Problemen | Öffne den Lauf und sieh dir die Repositories mit Fehlern an. |

Erhöhe den Detailgrad unter *Erweitert → Protokollstufe von Renovate* für einen Lauf auf `debug`, wenn du mehr brauchst. Debug-Protokolle sind groß.

## Sicherheit

- Die Oberfläche ist nur über den Ingress von Home Assistant erreichbar; jede andere Adresse im Netzwerk wird abgewiesen. Zustandsändernde Anfragen brauchen einen Header, den eine fremde Webseite nicht senden kann.
- Tokens liegen verschlüsselt in der Datenbank, der Schlüssel daneben (`/data/keys`). Ein Backup enthält beides, genau wie die App-Konfiguration.
- Der Server läuft mit den Rechten des Containers, weil Home Assistant die App-Konfiguration nur für root lesbar hält und die App ihr live folgt. **Renovate selbst startet immer als unprivilegierter Benutzer** und erhält nur die Variablen, die es braucht. Das Home-Assistant-Token erreicht es nie.
- Renovate führt Paketmanager auf deinen Repositories aus. Verbinde nur Repositories, denen du auf diesem Gerät vertraust, und lass *Skripte ignorieren* (Renovates Standard) aktiv.
