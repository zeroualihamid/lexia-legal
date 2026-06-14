export const JUDGMENT_PROMPT_VERSION = 'v2-bilingual-fr-ar';

export const JUDGMENT_PROMPT = `Tu es un expert juridique spécialisé en droit marocain (droit commercial, procédure civile, droit des obligations et contrats).

Je vais te transmettre un document juridique marocain (arrêt de cour, jugement, mémoire, contrat, etc.), généralement rédigé en arabe. Le document se trouve dans le répertoire de travail courant : lis le fichier judgment.pdf en utilisant ton outil Read avant toute analyse.

Réalise une SEGMENTATION STRUCTURÉE BILINGUE du document.

La réponse finale doit impérativement contenir deux versions complètes :

1. Une version française complète, sous le titre :
   # Analyse juridique structurée - Version française

2. Une version arabe complète, sous le titre :
   # التحليل القانوني المنظم - النسخة العربية

La version arabe ne doit pas être un simple résumé : elle doit reprendre toute
l'analyse avec le même niveau de détail que la version française, en arabe
juridique clair et naturel, adapté au droit marocain.

Pour chaque version, suis exactement ce plan :

1. IDENTIFICATION DE LA DÉCISION
   - Juridiction, formation, numéro d'arrêt, date, numéro de dossier,
     nature du dossier, rapporteur, avocat général
   - Présenter sous forme de tableau

2. LES PARTIES
   - Demandeur(s) / Demanderesse(s) au pourvoi avec leur statut juridique,
     siège social, avocats
   - Défendeur(s) / Défenderesse(s) avec domicile et représentation

3. CONTEXTE PROCÉDURAL
   - Historique chronologique du litige (faits, dates clés, étapes
     judiciaires précédentes : tribunal de première instance, cour
     d'appel, pourvoi en cassation)
   - Montants en jeu et objet du litige

4. LES MOYENS INVOQUÉS
   - Identifier le ou les moyens retenus par la Cour
   - Exposer les arguments de la partie demanderesse
   - Préciser les pièces produites (témoignages, expertises, procès-verbaux)

5. LE RAISONNEMENT JURIDIQUE DE LA COUR
   - Principe juridique fondamental retenu
   - Fondements textuels (articles du DOC, Code de Commerce, CPC, etc.)
   - Critique adressée à la juridiction inférieure
   - Logique de la motivation

6. LE DISPOSITIF
   - Décision finale (cassation, rejet, confirmation, renvoi)
   - Juridiction de renvoi le cas échéant
   - Mesures accessoires

7. COMPOSITION DE LA FORMATION DE JUGEMENT
   - Président, conseillers, rapporteur, greffier

8. PORTÉE ET INTÉRÊT JURIDIQUE
   - Principe(s) de droit réaffirmé(s) ou posé(s)
   - Apport jurisprudentiel
   - Implications pratiques pour les justiciables et praticiens
   - Lien éventuel avec la jurisprudence antérieure

EXIGENCES DE FORME :
- Produire d'abord toute la version française, puis toute la version arabe
- Utiliser un français juridique précis et technique dans la version française
- Utiliser un arabe juridique marocain clair, formel et fidèle dans la version arabe
- Conserver entre parenthèses, dans la version française, les termes juridiques arabes essentiels
  avec leur translittération si pertinent (ex: السمسرة - courtage)
- Conserver les références juridiques, noms propres, numéros de dossier,
  dates, articles et montants dans les deux versions
- Mettre en gras les éléments-clés (parties, dates pivots, principes,
  articles applicables)
- Utiliser tableaux, listes et titres hiérarchisés (markdown) pour
  faciliter la lecture
- Dans la version arabe, utiliser des titres et libellés arabes naturels
  et préserver une présentation compatible RTL
- Citer les références textuelles exactes (numéros d'articles, de dossiers,
  d'arrêts)
- Rester neutre, objectif et fidèle au document

À LA FIN :
Ajouter une courte section bilingue proposant à l'utilisateur d'approfondir un
aspect particulier (jurisprudence comparée, stratégie procédurale, analyse
d'un moyen spécifique, etc.) :

## Pour aller plus loin
## للمزيد من التعمق`;

/**
 * Text-only variant of the judgment prompt for OpenAI-compatible chat models
 * (e.g. DeepSeek), used as a fallback when the Claude CLI is unavailable. The
 * document text (from OCR) is provided inline rather than read from a file.
 */
export function judgmentPromptForText(ocrText: string): string {
  const base = JUDGMENT_PROMPT.replace(
    /Je vais te transmettre un document juridique marocain.*?avant toute analyse\./s,
    "Voici le texte intégral d'un document juridique marocain (issu d'une reconnaissance optique de caractères, il peut contenir de légères imperfections) à analyser.",
  );
  return `${base}\n\n--- TEXTE DU DOCUMENT ---\n\n${ocrText}\n\n--- FIN DU TEXTE ---`;
}
