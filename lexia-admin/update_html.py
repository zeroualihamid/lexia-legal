file_path_src = "/Users/mac/Documents/repos/qclick-finance/qclick-chat/ns_group_platform.html"
file_path_dest = "/Users/mac/Documents/repos/qclick-finance/qclick-chat/public/ns_group_platform.html"

with open(file_path_src, "r") as f:
    content = f.read()

css_chunk = """
/* AI POPUP STYLES */
.ai-popup-trigger {
  cursor: pointer;
  color: var(--muted);
  transition: color 0.2s;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
}
.ai-popup-trigger:hover {
  color: var(--accent);
  background: var(--s3);
}
.ai-prompt-popup {
  display: none;
  position: absolute;
  top: 40px;
  right: 15px;
  width: 280px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  z-index: 100;
  box-shadow: 0 10px 25px rgba(0,0,0,0.15);
  flex-direction: column;
  gap: 8px;
}
.ai-prompt-popup.active {
  display: flex;
}
.ai-prompt-popup textarea {
  width: 100%;
  background: var(--s2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text);
  resize: vertical;
  min-height: 80px;
  font-family: inherit;
}
.ai-prompt-popup textarea:focus {
  outline: none;
  border-color: var(--accent);
}
.ai-popup-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.ai-popup-btn {
  background: var(--accent);
  color: #fff;
  border: none;
  padding: 5px 12px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s;
}
.ai-popup-btn:hover {
  background: #2a7ae0;
}
.ai-popup-btn.secondary {
  background: var(--s3);
  color: var(--text);
}
.ai-popup-btn.secondary:hover {
  background: var(--border);
}
</style>
"""

script_chunk = """
<script>
document.addEventListener('DOMContentLoaded', () => {
  const customPrompts = [
    { matcher: "EBITDA Consolidée", text: "Analyse la cascade de l'EBITDA et identifie le principal poste d'optimisation à prioriser ce trimestre pour améliorer la rentabilité globale." },
    { matcher: "NSFactory vs", text: "Compare les performances opérationnelles entre NSFactory et NSMobili et propose des actions concrètes pour équilibrer les marges." },
    { matcher: "Trésorerie par Compte", text: "Vérifie les liquidités actuelles réparties sur les comptes bancaires et alerte sur d'éventuels risques de découvert à court terme." },
    { matcher: "Performance Marketing", text: "Évalue le ROAS global des campagnes et suggère une réallocation tactique du budget entre les plateformes pour maximiser l'efficience." },
    { matcher: "Pixels & Conversions", text: "Analyse le taux de conversion issu du tracking pixel et propose des expériences d'A/B testing pour optimiser le parcours client." },
    { matcher: "Flux Trésorerie", text: "Projette l'évolution des flux de trésorerie sur les deux mois à venir en extrapolant les tendances de décaissement récentes." },
    { matcher: "Mouvements Récents", text: "Isole les éventuelles anomalies ou dépenses déviant de la norme dans l'historique des derniers mouvements bancaires de la semaine." },
    { matcher: "Répartition Catégories", text: "Identifie le poste de décaissement qui a le plus progressé ce mois-ci et propose une stratégie de réduction des coûts associés." },
    { matcher: "Bilan — ACTIF", text: "Calcule le ratio de liquidité générale et évalue l'équilibre structurel entre nos immobilisations et notre actif circulant." },
    { matcher: "Bilan — PASSIF", text: "Examine la structure actuelle de nos dettes et suggère des options de refinancement stratégique pour réduire le coût du capital." },
    { matcher: "Grand Livre Général", text: "Parcours les dernières écritures comptables et signale toute classification atypique ou imputations méritant révision." },
    { matcher: "Matières Premières", text: "Identifie la famille de matières premières constituant le centre de coût principal et propose des alternatives ou pistes d'achat anticipé." },
    { matcher: "MO par Processus", text: "Analyse la répartition de la main-d'oeuvre directe par tâche et localise le goulot d'étranglement qui ralentit la production." },
    { matcher: "Structure Coûts", text: "Compare notre répartition entre charges fixes, directes de production et variables avec les standards d'efficience industriels." },
    { matcher: "Coût de Revient par", text: "Identifie le produit sur lequel les coûts marginaux absorbent le plus de valeur, et propose de le remplacer ou l'optimiser." },
    { matcher: "Échelle de Prix", text: "Élabore un rétro-planning strict de révision tarifaire pour l'ensemble des articles positionnés en dessous du Prix de Vente Usine." },
    { matcher: "Analyse Détaillée Rentabilité", text: "Passe au crible l'ensemble de notre formule d'allocation de rentabilité et détecte s'il existe une dérive des coûts cachés." },
    { matcher: "TOP — Produits", text: "Détaille pourquoi ces produits en particulier performent au-dessus de la moyenne et formule une proposition pour capitaliser dessus." },
    { matcher: "ALERT", text: "Rédige une fiche d'action commando pour stopper net les hémorragies sur ces produits vendus à prix inférieur au coût de maintien." },
    { matcher: "Matrice d'Opportunité", text: "Identifie la short-list de 3 produits sur lesquels nous pourrions appliquer une hausse de +5% demain matin sans perturber le volume." },
    { matcher: "Campagnes Actives", text: "Repère immédiatement la campagne publicitaire dont le CPO s'envole et propose des micro-ciblages alternatifs pour y remédier." },
    { matcher: "Évolution Dépenses & ROAS", text: "Superpose nos investissements publicitaires avec notre rendement marginal pour nous situer précisément sur notre courbe d'élasticité." },
    { matcher: "Entonnoir de Conversion", text: "Quantifie l'attrition exacte à la phase Adds-to-Cart et articule une stratégie de remarketing avec offre irrésistible dédiée." },
    { matcher: "Sources de Trafic", text: "Évalue notre niveau de dépendance au trafic payant exclusif et donne trois quick-wins SEO mobilisables en un mois." },
    { matcher: "Devices", text: "Constate l'écart d'expérience mesuré entre la navigation mobile et desktop et en tire un protocole de correction UI prioritaire." },
    { matcher: "Pages les Plus Vues", text: "Surveille la page produit générant le plus de bounce rate et suggère une modification architecturale de l'information (social proof, UX)." },
    { matcher: "Cascade EBITDA Complète", text: "Analyse avec précision mathématique la déperdition entre marge commerciale brute et EBITDA net, en isolant le principal coupable." },
    { matcher: "Benchmarks Secteur", text: "Positionne nos métriques clés face aux ratios médians du secteur de l'aménagement, et fixe nous 3 cibles pour le semestre prochain." },
    { matcher: "Point Mort", text: "Calcule notre seuil de sécurité en volume de jours de fonctionnement si on fait face à une annulation de commandes de 20%." },
    { matcher: "Simulation EBITDA Mensuel", text: "Génère deux scénarios projectifs pour le trimestre à venir : un favorable (+10% volume premium) et un dégradé (+15% matière première)." },
    { matcher: "Graphe Industriel EBITDA", text: "Piste physiquement le circuit de valeur sur le diagramme industriel pour repérer si l'Overhead draine plus qu'il ne produit." },
    { matcher: "Décomposition Complète des Coûts", text: "Évalue la justification théorique du ratio des « Charges Fixes par m² » et son impact démesuré (ou sous-estimé) sur l'Armoire Strati." },
    { matcher: "CA Manqué", text: "Chiffre à la virgule près le coût d'opportunité que subit le groupe chaque semaine en reportant l'alignement tarifaire au PV Min." },
    { matcher: "Position vs Seuils de Prix", text: "Fragmente avec acuité notre catalogue en 3 offres catégorielles bien distinctes (Entry/Mid/Premium) et révèle le segment le moins exploité." },
    { matcher: "Classement Impact CA Total", text: "Calcule statistiquement le risque systémique qu'encourt le groupe s'il venait à perdre la dynamique sur l'un de ces 3 top produits." },
    { matcher: "Décomposition % PV Usine", text: "Vérifie si la poche mathématique consacrée au « Ratio Bénéfice » suffit effectivement pour constituer une réserve de réinvestissement industriel convenable mensuellement." },
    { matcher: "Ratio Fixe / m²", text: "Prouve analytiquement si notre politique d'allocation des frais d'atelier selon un ratio d'empreinte au sol par produit reste une méthodologie valable au vu de notre vélocité de fabrication réelle." }
  ];

  setTimeout(() => {
    document.querySelectorAll('.panel').forEach((panel) => {
      // Ensure panel has position relative for the absolute popup to tether correctly
      panel.style.position = 'relative';

      const titleEl = panel.querySelector('.panel-title');
      if(!titleEl) return;
      const titleText = titleEl.innerText || "";
      
      let defaultPrompt = "Analyse ces données et génère un résumé managérial stratégique mettant en évidence 3 pistes d'optimisation prioritaires.";
      for(let i=0; i<customPrompts.length; i++) {
        if(titleText.includes(customPrompts[i].matcher)) {
          defaultPrompt = customPrompts[i].text;
          break;
        }
      }

      const headEl = panel.querySelector('.panel-head');
      if(headEl) {
        // Wrap original content
        const wrapper = document.createElement('div');
        wrapper.style.display = 'flex';
        wrapper.style.alignItems = 'center';
        wrapper.style.gap = '8px';
        while(headEl.firstChild) {
          wrapper.appendChild(headEl.firstChild);
        }
        
        const trigger = document.createElement('div');
        trigger.className = 'ai-popup-trigger';
        trigger.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1.5"></circle><circle cx="12" cy="5" r="1.5"></circle><circle cx="12" cy="19" r="1.5"></circle></svg>`;
        trigger.title = "Modifier le Prompt IA";
        
        trigger.onclick = (e) => {
          e.stopPropagation();
          const popup = panel.querySelector('.ai-prompt-popup');
          document.querySelectorAll('.ai-prompt-popup').forEach(p => {
             if (p !== popup) p.classList.remove('active');
          });
          popup.classList.toggle('active');
        };
        
        headEl.appendChild(wrapper);
        headEl.appendChild(trigger);
        headEl.style.display = 'flex';
        headEl.style.justifyContent = 'space-between';
        headEl.style.alignItems = 'center';
      } else {
        // If no panel head (some just have panel-title in body)
        const trigger = document.createElement('div');
        trigger.className = 'ai-popup-trigger';
        trigger.style.position = 'absolute';
        trigger.style.top = '12px';
        trigger.style.right = '12px';
        trigger.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1.5"></circle><circle cx="12" cy="5" r="1.5"></circle><circle cx="12" cy="19" r="1.5"></circle></svg>`;
        trigger.title = "Modifier le Prompt IA";
        
        trigger.onclick = (e) => {
          e.stopPropagation();
          const popup = panel.querySelector('.ai-prompt-popup');
          document.querySelectorAll('.ai-prompt-popup').forEach(p => {
             if (p !== popup) p.classList.remove('active');
          });
          popup.classList.toggle('active');
        };
        panel.appendChild(trigger);
      }

      // Create the popup
      const popupBox = document.createElement('div');
      popupBox.className = 'ai-prompt-popup';
      popupBox.innerHTML = `
        <div style="font-size:11px; font-weight:700; color:var(--accent); display:flex; align-items:center; gap:5px">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
            Prompt de l'Agent IA
        </div>
        <textarea rows="4">${defaultPrompt}</textarea>
        <div class="ai-popup-actions">
          <button class="ai-popup-btn secondary" onclick="this.parentElement.parentElement.classList.remove('active')">Annuler</button>
          <button class="ai-popup-btn" onclick="this.parentElement.parentElement.classList.remove('active'); alert('Prompt prêt pour la prochaine interaction !')">Enregistrer</button>
        </div>
      `;
      
      // Stop clicks inside popup from bubbling to outside listener
      popupBox.onclick = (e) => e.stopPropagation();
      
      panel.appendChild(popupBox);
    });

    // Close popups when clicking outside
    document.addEventListener('click', () => {
       document.querySelectorAll('.ai-prompt-popup').forEach(p => p.classList.remove('active'));
    });
  }, 300);
});
</script>
</body>
"""

content = content.replace("</style>", css_chunk)
content = content.replace("</body>", script_chunk)

with open(file_path_dest, "w") as f:
    f.write(content)
