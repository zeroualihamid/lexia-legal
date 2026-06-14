export const BANKING_QUESTIONS = [
    {
        id: 'financial',
        title: "Analyse Financière",
        questions: [
            "Donne moi le chiffre d'affaire 2025",
            "Quel est le chiffre d'affaire 2024 ?",
            "Analyse le fichier des commandes",
            "Montre moi les statistiques des ventes"
        ]
    },
    {
        id: 'banking',
        title: "Relevés Bancaires",
        questions: [
            "Relevé NSFactory",
            "Relevé NSMobili",
            "Dépenses NSFactory 2025",
            "Relevé bancaire janvier 2025",
            "Quelles sont les dépenses de NSMobili ?"
        ]
    },
    {
        id: 'personnel',
        title: "Charges et Personnel",
        questions: [
            "Charges personnel",
            "Quel est le total des charges ?",
            "Combien d'employés avons-nous ?",
            "Analyse les charges CSV"
        ]
    },
    {
        id: 'performance',
        title: "Analyse de Performance Bancaire",
        questions: [
            "Quelle est la contribution respective des Commissions et des Marges sur Intérêts Nets dans la formation du Produit Net Bancaire, et comment cette répartition reflète-t-elle le modèle économique de la banque ?",
            "Comment analysez-vous l'évolution du ratio Frais Généraux sur Produit Net Bancaire (coefficient d'exploitation) ? Quels sont les leviers d'optimisation identifiés ?",
            "Le Coût du Risque représente quel pourcentage du Produit Net Bancaire ? Cette proportion est-elle conforme aux normes prudentielles et aux standards du secteur bancaire ?",
            "Pouvez-vous justifier l'écart entre les Charges Nettes sur Créances Douteuses et le Coût du Risque global ? Y a-t-il des provisions hors créances douteuses ?"
        ]
    },
    {
        id: 'produits',
        title: "Produits Bancaires",
        questions: [
            "Quelle est la rentabilité respective des segments Clientèle Privée versus Clientèle Commerciale en termes de commissions et d'intérêts perçus ?",
            "Les produits sur Escompte de papier commercial représentent quelle part des Remplois Clientèles ? Comment évolue ce poste face à la digitalisation des paiements ?",
            "Concernant les opérations de Change : quelle est la répartition entre profits sur change manuel, opérations de devises contre intérêts, et opérations de change à terme avec achat différé de devises ?",
            "Les commissions sur services de banque électronique Telma génèrent quel volume ? Quelle est la stratégie de pricing sur les canaux digitaux ?",
            "Comment sont valorisées les Réévaluations de devises contre intérêts en fin d'exercice ? Quelle méthodologie comptable appliquez-vous (cours de clôture, cours moyen) ?"
        ]
    },
    {
        id: 'risques',
        title: "Crédits et Risques",
        questions: [
            "Quelle est la ventilation du portefeuille crédit entre Court Terme, Moyen Terme et Long Terme ? Comment cette structure impacte-t-elle la marge nette d'intérêts ?",
            "Les Crédits sur Comptes (découverts et facilités de caisse) présentent-ils un taux de défaillance supérieur aux autres catégories ? Comment sont provisionnés les dépassements non autorisés ?",
            "Pour les Crédits Documentaires Import et Export : quel est le taux de sinistralité et comment sont constituées les Contre-garanties Bancaires ?",
            "Les Intérêts sur Crédits Garantis accordés aux Agents de la fonction publique versus ceux aux Entreprises Privées : quelle différence de taux appliqué et de niveau de provisionnement ?",
            "Comment gérez-vous les Commissions sur Impayés Mis en Incidents et Anomalies de Remboursement ? Quelle est la procédure de recouvrement et le taux de récupération effectif ?"
        ]
    },
    {
        id: 'charges',
        title: "Charges d'Exploitation",
        questions: [
            "Les Frais de Personnel représentent quel pourcentage des Frais Généraux ? Incluent-ils la Gratification de treizième mois provisionnée mensuellement ?",
            "Concernant les Services Extérieurs : quelle est la ventilation entre Charges Liées aux Immeubles, Dépenses Informatiques, et Honoraires de Consultants ?",
            "Les Charges Monétiques liées au réseau Visa sont-elles compensées par les Cotisations sur Cartes et Factures de Terminaux de Paiement Électronique ? Quelle est la marge nette sur l'activité monétique ?",
            "Comment sont alloués les Frais Refacturés par les Sociétés du Groupe ? Existe-t-il une convention de refacturation validée ?"
        ]
    },
    {
        id: 'provisions',
        title: "Provisions et Amortissements",
        questions: [
            "Quelle méthodologie appliquez-vous pour les Dotations aux Provisions versus les Provisions d'Exploitation Bancaire ? Distinction entre provisions réglementées et provisions pour risques ?",
            "Les Dotations aux Amortissements : quelle est la durée d'amortissement moyenne de vos immobilisations corporelles et incorporelles ?",
            "Les Reprises sur Dotations aux Provisions d'Exploitation Bancaire montrent-elles une amélioration de la qualité du portefeuille ou un sous-provisionnement antérieur ?"
        ]
    },
    {
        id: 'tresorerie',
        title: "Trésorerie et Refinancement",
        questions: [
            "Concernant la gestion de Trésorerie : quelle est la répartition entre Placements interbancaires (Dépôts à Terme auprès d'autres banques, Appels d'Offre Négatifs, Titres de Créances Négociables), comptes Nostri (nos comptes chez les correspondants) et opérations avec Correspondants bancaires ?",
            "Le coût du Refinancement est-il inférieur aux intérêts perçus sur les Remplois Clientèles ? Quelle est la marge de transformation ?",
            "Les Dépôts à Terme de la clientèle : quelle maturité moyenne et quel taux moyen servi comparé aux Comptes d'Épargne ?"
        ]
    },
    {
        id: 'audit',
        title: "Audit et Contrôle Interne",
        questions: [
            "Comment sont réparties les opérations entre les différentes directions (Direction du Bénin, Direction Commerciale Entreprises, Direction des Affaires Juridiques, Direction Générale) ? Existe-t-elle une comptabilité analytique par centre de profit ?",
            "Les données non renseignées : représentent quelle proportion du total ? Quelle procédure de contrôle pour réduire les imputations manquantes ?",
            "Pour les Récupérations de Frais Téléphoniques, Récupérations de frais Swift, et Récupérations de Frais de Dossiers : sont-elles facturées au coût réel ou avec une marge ? Politique de refacturation ?",
            "Comment assurez-vous la traçabilité entre les flux de télétransmission bancaire (Etebac, Bmoinet) et la comptabilisation effective des opérations ?"
        ]
    },
    {
        id: 'strategique',
        title: "Stratégiques et Réglementaires",
        questions: [
            "Votre ratio Impôts sur le Revenu divisé par le Résultat avant impôt est-il conforme au taux légal d'imposition ? Quelle optimisation fiscale est appliquée ?",
            "Les Impôts et Taxes d'exploitation : quelle part représente la taxe sur les activités financières versus les autres taxes professionnelles ?",
            "La Communication Institutionnelle et Vie Sociale : quel est le budget annuel et le retour sur investissement mesuré en termes d'image de marque ?",
            "Comment anticipez-vous l'impact des normes comptables internationales IFRS 9 sur votre provisionnement (modèle de pertes attendues versus pertes avérées) ?",
            "Quelle est votre politique de tarification entre les Forfaits Packages et la tarification à l'acte ? Quel modèle génère le meilleur Produit Net Bancaire par client ?"
        ]
    },
    {
        id: 'gestion',
        title: "Contrôle de Gestion",
        questions: [
            "Quelle est la rentabilité par produit : Cautions et Lettres de Garantie versus Crédits Documentaires ? Analyse du rapport commissions perçues sur risque encouru ?",
            "Les Frais Internes Liés au Personnel : incluent-ils les coûts de formation et développement des compétences ? Budget alloué ?",
            "Les Dépenses de Développement : sont-elles immobilisées ou passées en charges ? Critères de distinction appliqués ?",
            "Pour les Locations de Terminaux de Paiement Électronique : quel est le taux de pénétration chez les commerçants et la rentabilité unitaire ?",
            "Les Frais d'Établissement des Cautions Actées : sont-ils proportionnels au montant garanti ou forfaitaires ? Politique tarifaire ?"
        ]
    },
    {
        id: 'clientele',
        title: "Clientèle et Segmentation",
        questions: [
            "Quelle est la contribution respective des Comptes à Vue, Comptes d'Épargne, et Dépôts à Terme dans vos ressources ? Coût moyen de la ressource ?",
            "Les Comptes Débiteurs (découverts) : quel pourcentage de votre clientèle ? Stratégie de limitation du risque ?",
            "Les produits d'Assurance (part banque) : s'agit-il de partenariats avec des assureurs ou de produits propriétaires ? Taux de pénétration ?",
            "Les Intérêts sur Clients Immobiliers (Entreprises en Construction versus Particuliers versus Commerciaux) : quelle segmentation de risque et de taux ?",
            "Comment mesurez-vous la rentabilité globale d'un client en intégrant l'ensemble des produits (commissions, intérêts, services) et le coût du risque associé ?"
        ]
    }
];

export const INDUSTRY_SECTORS = [
    {
        id: 'finance',
        title: "Finance & Banque",
        icon: 'performance',
        questions: [
            "Quelle est l'évolution du Produit Net Bancaire par ligne de métier sur les 3 dernières années ?",
            "Analysez le coefficient d'exploitation et identifiez les principaux leviers d'optimisation des coûts.",
            "Quelle est la répartition du portefeuille de crédits par niveau de risque et par secteur économique ?",
            "Quelle est la performance de nos investissements propres comparée aux indices de référence du marché ?",
            "Quel est l'impact des nouvelles régulations prudentielles sur nos fonds propres réglementaires ?"
        ]
    },
    {
        id: 'assurance',
        title: "Assurance",
        icon: 'risques',
        questions: [
            "Quel est le ratio combiné (Sinistralité + Frais) détaillé par type de contrat d'assurance ?",
            "Identifiez les facteurs clés influençant le taux de résiliation (churn) sur le segment habitation.",
            "Quelle est l'exposition globale de nos risques face aux catastrophes naturelles récentes ?",
            "Comment les variations des taux d'intérêt impactent-elles la marge technique de nos produits Vie ?",
            "Analyse de l'efficacité de la réassurance sur les sinistres de forte intensité."
        ]
    },
    {
        id: 'distribution',
        title: "Distribution & Retail",
        icon: 'produits',
        questions: [
            "Classez le Top 20 des produits par marge brute générée et par vitesse de rotation des stocks.",
            "Comparez la performance de vente par mètre carré entre nos différents formats de magasins.",
            "Quelle est la corrélation réelle entre nos campagnes promotionnelles et l'augmentation du panier moyen ?",
            "Analysez les ruptures de stock et leur impact estimé sur le chiffre d'affaires potentiel.",
            "Suivi des délais de paiement fournisseurs et optimisation du Besoin en Fonds de Roulement (BFR)."
        ]
    },
    {
        id: 'industrie',
        title: "Industrie & Manufacturing",
        icon: 'gestion',
        questions: [
            "Quelle est l'évolution du coût de revient unitaire en intégrant la volatilité des prix de l'énergie ?",
            "Analysez le Taux de Rendement Synthétique (TRS) par ligne de production et identifiez les goulots d'étranglement.",
            "Quel est l'impact de la maintenance préventive sur la réduction des arrêts de production non planifiés ?",
            "Visualisez la marge industrielle nette par site de production et par famille de produits.",
            "Quelle est la valorisation précise de nos stocks de matières premières et de produits semi-finis ?"
        ]
    },
    {
        id: 'immobilier',
        title: "Immobilier & Asset Management",
        icon: 'specifique',
        questions: [
            "Suivi du Taux d'Occupation Financier (TOF) par actif et par catégorie de locataires.",
            "Calculez la rentabilité locative nette (Yield) après déduction des charges non récupérables et des travaux.",
            "Analysez l'échéancier des baux (WALY) pour anticiper les vacances locatives majeures.",
            "Quelle est la performance ESG de notre patrimoine immobilier par rapport aux normes décret tertiaire ?",
            "Comparatif entre les valeurs d'expertise récentes et les valeurs de réalisation du portefeuille."
        ]
    }
];
