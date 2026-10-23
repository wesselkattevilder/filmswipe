# Filmswipe

Swipe samen door de films die nu in Nederland op Netflix, Videoland en Prime Video staan.

- **App:** https://wesselkattevilder.github.io/filmswipe/ — zet hem op je beginscherm.
- **Inloggen:** met Google (Firebase Authentication).
- **Opslag:** Firestore. Ieder heeft eigen swipes; in een *Samen*-groep verschijnen films die alle leden leuk vinden als **match**, en kun je ook samen op één telefoon swipen.
- **Filmlijst:** `data/catalog.json`, elke 1e van de maand automatisch ververst door `.github/workflows/catalog.yml` (secret `TMDB_API_KEY`). Handmatig: Actions → *Filmlijst bijwerken* → *Run workflow*.
- **Database-regels:** `firestore.rules` — plak deze in Firebase console → Firestore → Regels.

Data en posters: [TMDB](https://www.themoviedb.org). Deze app gebruikt de TMDB API maar is niet door TMDB goedgekeurd of gecertificeerd.
