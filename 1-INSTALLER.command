#!/bin/bash

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     🌍  MES VOYAGES — Installation       ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Aller dans le dossier du script
cd "$(dirname "$0")"

# Vérifier si Node.js est installé
if ! command -v node &> /dev/null; then
  echo "📦 Node.js n'est pas installé. Installation via Homebrew..."
  echo ""

  # Vérifier si Homebrew est installé
  if ! command -v brew &> /dev/null; then
    echo "🍺 Installation de Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Ajouter Homebrew au PATH pour Apple Silicon
    if [ -f "/opt/homebrew/bin/brew" ]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
  fi

  brew install node
  echo ""
fi

echo "✅ Node.js $(node --version) détecté"
echo ""
echo "📥 Installation des dépendances..."
npm install --silent

if [ $? -eq 0 ]; then
  echo ""
  echo "╔══════════════════════════════════════════╗"
  echo "║  ✅  Installation terminée avec succès ! ║"
  echo "╠══════════════════════════════════════════╣"
  echo "║  👉  Double-cliquez sur demarrer.sh      ║"
  echo "║      pour lancer l'application           ║"
  echo "╚══════════════════════════════════════════╝"
  echo ""
else
  echo ""
  echo "❌ Une erreur s'est produite. Contactez le support."
  echo ""
fi

read -p "Appuyez sur Entrée pour fermer..."
