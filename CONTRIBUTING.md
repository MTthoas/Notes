# Contribuer à Studio

Merci de vouloir améliorer Studio ! Quelques règles simples.

## Comment proposer un changement

1. Crée une branche depuis `main` (`feat/…`, `fix/…`, `chore/…`).
2. Vérifie que `npm run verify` passe (types stricts, build, cache hors ligne, aucun secret).
3. Ouvre une pull request vers `main` et coche la case de l'accord de contribution.

Seul le propriétaire du dépôt fusionne les pull requests.

Une fonction visible mérite d'être annoncée : ajoute une entrée en tête de `NEWS` dans `src/features/news.ts` (identifiant stable, titre, deux phrases, icône, teinte). Elle sera présentée une fois à chaque personne après la mise à jour. Le titre de la pull request, au format Conventional Commits, alimente de son côté la liste « ce qui change » de la version.

## Accord de contribution

Studio appartient à **Matthias ([@MTthoas](https://github.com/MTthoas))**. Il est publié sous licence [GNU AGPL-3.0](LICENSE) et peut aussi être proposé sous d'autres licences, par exemple une licence commerciale. Pour que ce soit possible avec les contributions de chacun, toute contribution est faite aux conditions suivantes.

En proposant une contribution (code, texte, image, traduction…), tu acceptes que :

1. **Tu as le droit de la proposer** : tu en es l'auteur, ou son auteur t'y a autorisé, et elle ne contient pas de code soumis à une licence incompatible.
2. **Tu gardes tes droits d'auteur** sur ta contribution.
3. **Tu accordes à Matthias**, propriétaire de Studio, une licence mondiale, perpétuelle, irrévocable, gratuite et non exclusive pour utiliser, reproduire, modifier, distribuer et sous-licencier ta contribution, **y compris sous d'autres licences que l'AGPL-3.0**.
4. **Ta contribution est publiée sous AGPL-3.0**, comme le reste de Studio.
5. **Elle est fournie « en l'état »**, sans garantie d'aucune sorte.

Tu confirmes ton accord en cochant la case prévue dans la pull request.
