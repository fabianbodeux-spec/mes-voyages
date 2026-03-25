#!/bin/bash

# Aller dans le dossier du script
cd "$(dirname "$0")"

# Vérifier si les dépendances sont installées
if [ ! -d "node_modules" ]; then
  echo "⚠️  Les dépendances ne sont pas installées."
  echo "    Veuillez d'abord exécuter installer.sh"
  read -p "Appuyez sur Entrée pour fermer..."
  exit 1
fi

# Lancer le serveur en arrière-plan
node server.js &
SERVER_PID=$!

# Attendre que le serveur démarre
sleep 1.5

# Ouvrir Safari
open -a Safari "http://localhost:3000"

echo ""
echo "✅ Application démarrée !"
echo "   Fermez cette fenêtre pour arrêter l'application."
echo ""

# Attendre que l'utilisateur ferme
wait $SERVER_PID
