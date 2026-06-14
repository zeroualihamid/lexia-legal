#!/usr/bin/env python3
"""
Script pour télécharger le modèle SentenceTransformer séparément.
Utilisez ce script si le téléchargement est bloqué dans le script principal.
"""

import sys
from sentence_transformers import SentenceTransformer

def download_model(model_name='paraphrase-multilingual-MiniLM-L12-v2'):
    """Télécharge le modèle SentenceTransformer."""
    print(f"Téléchargement du modèle: {model_name}")
    print("Taille approximative: ~471MB")
    print("Cela peut prendre plusieurs minutes selon votre connexion...")
    print("-" * 60)
    
    try:
        model = SentenceTransformer(model_name, device='cpu')
        print("\n✓ Modèle téléchargé avec succès!")
        print(f"✓ Modèle sauvegardé dans: ~/.cache/huggingface/hub/")
        return model
    except KeyboardInterrupt:
        print("\n\n⚠ Téléchargement interrompu par l'utilisateur")
        print("Le modèle partiel est sauvegardé dans le cache.")
        print("Vous pouvez relancer ce script pour reprendre le téléchargement.")
        sys.exit(1)
    except Exception as e:
        print(f"\n✗ Erreur lors du téléchargement: {e}")
        print("\nSolutions possibles:")
        print("1. Vérifiez votre connexion Internet")
        print("2. Réessayez plus tard (le serveur Hugging Face peut être surchargé)")
        print("3. Utilisez un VPN si vous êtes dans une région restreinte")
        sys.exit(1)

if __name__ == "__main__":
    model_name = sys.argv[1] if len(sys.argv) > 1 else 'paraphrase-multilingual-MiniLM-L12-v2'
    download_model(model_name)

